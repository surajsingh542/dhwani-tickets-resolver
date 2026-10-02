import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { HubClient } from './hubClient.js';
import { RepoSet } from './repoSet.js';
import { ClaudeSession, parseResult } from './claudeSession.js';
import { buildQueue, distinctValues, matchStage } from './ticketQueue.js';
import { buildTicketContext } from './contextBuilder.js';
import { StateStore, writeReports } from './reporter.js';
import { Logger } from './logger.js';
import { projectWorkspace, validateConfig } from './config.js';

const MAX_INLINE_BRIEF = 60000;
const DONE_OUTCOMES = new Set(['resolved', 'needs_clarification']);

export class TicketResolver extends EventEmitter {
  constructor(cfg, { logger } = {}) {
    super();
    this.cfg = cfg;
    this.ws = projectWorkspace(cfg);
    this.logger = logger || new Logger({ logDir: this.ws.logs, secrets: cfg.cookie.split(/;\s*/).map((p) => p.split('=')[1]) });
    this.hub = new HubClient({ baseUrl: cfg.hubBaseUrl, cookie: cfg.cookie, logger: this.logger });
    this.state = new StateStore(this.ws.stateFile);
    this.stopRequested = false;
    this.reportChain = Promise.resolve();
    this.status = { phase: 'idle', current: null, queue: [], done: [], startedAt: null, finishedAt: null, error: null };
  }

  requestStop() {
    this.stopRequested = true;
    this.logger.warn('Stop requested — finishing the current ticket, then stopping.');
  }

  async connect() {
    const user = await this.hub.init();
    this.logger.info(`Logged in to ${this.cfg.hubBaseUrl} as ${user}`);
    try { this.pipelineStages = (await this.hub.getPipelineStages()) || []; } catch { this.pipelineStages = []; }
    return user;
  }

  /** Raw values the Hub returns — run this first to confirm priority/type/stage spellings match the config. */
  async inspect() {
    validateConfig(this.cfg, { needRepo: false });
    await this.connect();
    const rows = await this.hub.getProjectTasks(this.cfg.project);
    const { queue, skipped, filteredOut } = buildQueue(rows, this.cfg, this.hub.user);
    return {
      filters: { assignee: this.cfg.assigneeFilter, createdBy: this.cfg.createdByFilter, filteredOut },
      totalTickets: rows.length,
      pipelineStages: this.pipelineStages,
      distinct: distinctValues(rows),
      queue: queue.map(({ row, ...q }) => q),
      skipped,
      sampleRow: rows[0] || null,
    };
  }

  async run() {
    const cfg = this.cfg;
    validateConfig(cfg, { needRepo: !cfg.dryRun });
    this.status = { ...this.status, phase: 'starting', startedAt: new Date().toISOString() };
    let session;
    let repos;
    try {
      await this.connect();
      if (!cfg.dryRun) {
        repos = new RepoSet({
          root: cfg.repoPath, baseBranch: cfg.baseBranch, remote: cfg.gitRemote, mainApp: cfg.mainApp, logger: this.logger,
          snapshotDir: path.join(this.ws.root, 'snapshots', new Date().toISOString().replace(/[:.]/g, '-')),
        });
        await repos.preflight();
      }

      const rows = await this.hub.getProjectTasks(cfg.project);
      let { queue, skipped, filteredOut } = buildQueue(rows, cfg, this.hub.user);
      const people = [cfg.assigneeFilter?.length && `assignee ∈ {${cfg.assigneeFilter.join(', ')}}`, cfg.createdByFilter?.length && `created by ∈ {${cfg.createdByFilter.join(', ')}}`].filter(Boolean);
      if (people.length) this.logger.info(`Filters: ${people.join(' AND ')} — ${filteredOut} open ticket(s) excluded.`);
      this.logger.info(`${rows.length} tickets in ${cfg.project}; ${queue.length} pickable, ${skipped.length} open but skipped (no/unknown priority or type).`);
      for (const s of skipped) this.logger.info(`  skip ${s.id} — ${s.reason}`);

      if (cfg.onlyPreexisting) queue = [];
      if (cfg.only?.length) queue = queue.filter((q) => cfg.only.includes(q.id));
      if (!cfg.force) {
        const before = queue.length;
        queue = queue.filter((q) => !DONE_OUTCOMES.has(this.state.get(q.id)?.outcome));
        if (before !== queue.length) this.logger.info(`${before - queue.length} ticket(s) already handled in an earlier run (use --force to redo).`);
      }
      if (cfg.limit > 0) queue = queue.slice(0, cfg.limit);

      this.status.queue = queue.map((q) => ({ id: q.id, subject: q.subject, priority: q.priorityKey, type: q.type, stage: q.stage }));
      this.emit('queue', this.status.queue);
      queue.forEach((q, i) => this.logger.info(`  ${i + 1}. [${q.priorityKey} ${q.type}] ${q.id} — ${q.subject} (${q.stage || q.status})`));
      const wantFailures = !cfg.dryRun && (cfg.fixPreexisting || cfg.onlyPreexisting);
      if (!queue.length && !(wantFailures && this.pendingPreexisting().length)) { this.logger.info('Nothing to do.'); return this.finish({ repos }); }

      if (!cfg.dryRun) {
        session = new ClaudeSession({
          cwd: cfg.repoPath,
          additionalDirectories: [this.ws.tickets, this.ws.preexisting],
          model: cfg.claudeModel,
          executable: cfg.claudeExecutable,
          baseBranch: cfg.baseBranch,
          ticketsRoot: this.ws.tickets,
          reposDescription: repos.describe(),
          protectedDirs: repos.protectedDirs(),
          logger: this.logger,
        });
      }

      this.status.phase = 'running';
      this.startProgressReports(session);
      for (const item of queue) {
        if (this.stopRequested) break;
        this.status.current = { id: item.id, subject: item.subject, step: 'context', startedAt: Date.now() };
        this.emit('ticket:start', item.id);
        this.currentTestSummary = null;
        const record = await this.processTicket(item, { session, repos });
        this.status.done.push({ id: item.id, subject: item.subject, outcome: record.outcome, error: record.error });
        this.emit('ticket:done', record);
      }

      // Then the failures Claude proved pre-existing while working on tickets (this run's and earlier runs').
      if (wantFailures && !this.stopRequested) await this.fixPreexistingFailures({ session, repos });
      return this.finish({ session, repos });
    } catch (e) {
      this.logger.error(`Run aborted: ${e.message}`);
      this.status.error = e.message;
      await this.finish({ session, repos });
      throw e;
    }
  }

  async finish({ session, repos } = {}) {
    if (this.progressTimer) clearInterval(this.progressTimer);
    session?.close();
    if (repos) await repos.restoreOriginalBranches();
    if (!this.cfg.dryRun) await this.queueReportWrite();
    this.status.phase = 'finished';
    this.status.current = null;
    this.status.finishedAt = new Date().toISOString();
    const counts = this.status.done.reduce((a, d) => ({ ...a, [d.outcome]: (a[d.outcome] || 0) + 1 }), {});
    this.logger.info(`Run finished: ${JSON.stringify(counts)}${session ? ` — Claude cost ≈ $${session.totalCostUsd.toFixed(2)}` : ''}`);
    if (!this.cfg.dryRun) this.logger.info(`Reports: ${this.ws.reports}`);
    this.emit('done', this.status);
    return this.status;
  }

  /** Prints a progress summary every PROGRESS_INTERVAL_MINUTES (0 disables). */
  startProgressReports(session) {
    const minutes = Number(this.cfg.progressIntervalMinutes);
    if (!(minutes > 0)) return;
    this.runStartedAt = Date.now();
    this.logger.on('line', (line) => { if (line.includes('[CLAUDE]')) this.lastClaudeLine = line; });
    this.progressTimer = setInterval(() => this.logger.info(this.progressReport(session)), minutes * 60000);
    this.progressTimer.unref?.();
  }

  progressReport(session) {
    const fmt = (ms) => {
      const m = Math.round(ms / 60000);
      return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
    };
    const total = this.status.queue.length;
    const done = this.status.done;
    const count = (o) => done.filter((d) => d.outcome === o).length;
    const elapsed = Date.now() - this.runStartedAt;
    const remaining = total - done.length;
    const eta = done.length ? fmt((elapsed / done.length) * remaining) : 'n/a until the first ticket finishes';
    const cur = this.status.current;
    const last = this.lastClaudeLine ? this.lastClaudeLine.replace(/^\S+ \[CLAUDE\] /, '').split('\n')[0].slice(0, 160) : '—';
    return [
      '',
      `┌─ Progress — ${new Date().toLocaleTimeString()} · running ${fmt(elapsed)}`,
      `│  Tickets: ${done.length}/${total} done — ✅ ${count('resolved')} resolved · ❓ ${count('needs_clarification')} clarification · ❌ ${count('failed')} not resolved · ${remaining} left`,
      cur ? `│  Now: ${cur.id} — ${String(cur.subject).slice(0, 80)}` : '│  Now: (between tickets)',
      cur ? `│       step: ${cur.step} · on this ticket for ${fmt(Date.now() - cur.startedAt)}` : null,
      `│  Last Claude activity: ${last}`,
      `│  ETA: ${eta}${session ? ` · Claude cost so far ≈ $${session.totalCostUsd.toFixed(2)}` : ''}`,
      '└─',
    ].filter((l) => l !== null).join('\n');
  }

  step(s) { if (this.status.current) this.status.current.step = s; this.logger.info(`  · ${s}`); }

  async processTicket(item, { session, repos }) {
    const cfg = this.cfg;
    const branch = `${cfg.branchPrefix}${item.id}`.replace(/[^A-Za-z0-9._/-]+/g, '-');
    const record = {
      id: item.id, subject: item.subject, type: item.type, priority: item.priorityKey, stageBefore: item.stage || item.status,
      branch, processedAt: new Date().toISOString(),
    };
    this.logger.info(`━━ ${item.id} [${item.priorityKey} ${item.type}] ${item.subject}`);

    let ctx;
    try {
      ctx = await buildTicketContext({ hub: this.hub, item, ticketsDir: this.ws.tickets, cfg, logger: this.logger });
      record.ticketDir = ctx.dir;
      this.currentTicketDir = ctx.dir;
      item.createdBy = item.createdBy || ctx.detail.created_by || ctx.detail.owner || '';
    } catch (e) {
      return this.save({ ...record, outcome: 'failed', error: `Could not fetch ticket context: ${e.message}` });
    }
    if (cfg.dryRun) {
      this.logger.info(`  dry run: context saved to ${ctx.dir}; not resolving.`);
      return { ...record, outcome: 'previewed' };
    }
    const stageOptions = ctx.detail.stage_options?.length ? ctx.detail.stage_options : this.pipelineStages;

    const out = await this.workItem({
      session, repos, item, record, branch, workDir: ctx.dir,
      prompt: this.ticketPrompt(item, ctx, branch),
      verifyPrompt: this.verifyPrompt(item),
      commitTitle: `${item.id}: ${item.subject}`,
      onClarification: (rec, result, abandon) => this.handleClarification(item, rec, result, stageOptions, abandon),
    });
    if (out.outcome !== 'resolved') return out;

    const { result } = out;
    this.step(`hub: stage → ${cfg.resolvedStage}${cfg.hubWrite ? "" : " (skipped: --no-hub-write)"}`);
    const hubNotes = [await this.setStage(item.id, cfg.resolvedStage, stageOptions, record)];
    if (cfg.postResolutionComment) {
      hubNotes.push(await this.comment(item.id, `🤖 Resolved on branch \`${branch}\` in ${record.repos.map((r) => r.name).join(', ')} (merged into ${cfg.baseBranch}).\n\n${result.summary || ''}`, item.createdBy));
    }
    return this.save({ ...record, result, outcome: 'resolved', hubUpdate: hubNotes.filter(Boolean).join('; ') });
  }

  /**
   * The shared resolve → pre-commit → self-review → test gate → commit → push → pull → merge pipeline, used for Hub
   * tickets and for pre-existing failures. Failures are saved here; on success returns { outcome: 'resolved', result }
   * for the caller to finish (Hub update) and save.
   */
  async workItem(args) {
    this.touched = new Set();
    try {
      return await this.workItemInner(args);
    } finally {
      // Whatever happened, leave the bench matching the code now on the base branch, and read-only repos as they were.
      await this.syncBench(args.repos, args.record).catch((e) => this.logger.warn(`bench sync skipped: ${e.message}`));
      await this.restoreReadOnly(args.repos, args.record);
      if (args.record.warnings?.length) this.state.set(args.record.id, { ...this.state.get(args.record.id), warnings: args.record.warnings });
    }
  }

  /** Restores read-only repos that changed (e.g. `bench migrate` rewriting framework files). Never stops the run. */
  async restoreReadOnly(repos, record) {
    const { failed } = await repos.restoreDirtyReadOnly().catch((e) => ({ failed: [`(${e.message})`] }));
    await repos.revertReadOnly().catch(() => {});
    if (failed.length) {
      const w = `${failed.join(', ')} changed during this item and could not be restored to its start-of-run state — check it by hand`;
      record.warnings = [...new Set([...(record.warnings || []), w])];
    }
  }

  /**
   * Keeps the Frappe bench in step with the code after each item: `bench migrate` when the item touched schema-like
   * files (DocType JSON, patches, fixtures, workspaces/sidebars, hooks.py), `bench build --app <main>` when it touched
   * front-end files. Runs on whatever is checked out now (the base branch). Failures are warnings only.
   */
  async syncBench(repos, record) {
    if (!this.cfg.benchSync || !repos?.benches?.length || !this.touched?.size) return;
    const files = [...this.touched];
    const needsMigrate = files.some((f) => /(^|\/)doctype\/.*\.json$|patches\.txt$|(^|\/)fixtures\/|workspace_sidebar\/|(^|\/)workspace\/|(^|\/)hooks\.py$|(^|\/)patches\//.test(f));
    const needsBuild = files.some((f) => /(^|\/)public\/.*\.(js|ts|vue|scss|css)$|\.bundle\.(js|ts|css|scss)$/.test(f));
    if (!needsMigrate && !needsBuild) return;
    const app = repos.main ? path.basename(repos.main.dir) : null;
    for (const bench of repos.benches) {
      const run = async (label, cmd) => {
        this.step(`bench: ${label}`);
        const r = await repos.repos[0].git.runShell(`cd ${JSON.stringify(bench.dir)} && ${cmd}`, 30 * 60000);
        if (!r.ok) {
          const w = `bench ${label} failed after this item: ${r.output.split('\n').slice(-3).join(' ')}`;
          this.logger.warn(w);
          record.warnings = [...(record.warnings || []), w];
        }
      };
      if (needsMigrate) for (const site of bench.sites) await run(`migrate (${site})`, `bench --site ${site} migrate`);
      if (needsBuild && app) await run(`build --app ${app}`, `bench build --app ${app}`);
    }
  }

  async workItemInner({ session, repos, item, record, branch, workDir, prompt, verifyPrompt, commitTitle, onClarification }) {
    const cfg = this.cfg;
    // Every ticket starts from the latest origin/<base>. If that is impossible, stop the run instead of building on a stale base.
    this.step(`git: pull ${cfg.gitRemote}/${cfg.baseBranch}`);
    try {
      await repos.pullBase(this.conflictResolver(session, item));
    } catch (e) {
      this.stopRequested = true;
      await repos.checkoutBaseEverywhere();
      return this.save({ ...record, outcome: 'failed', error: `Stopped the run — ${e.message}` });
    }

    let created;
    try {
      this.step(`git: branch ${branch} from ${cfg.baseBranch} in ${repos.repos.length} repo(s)`);
      created = await repos.startTicketBranch(branch, this.conflictResolver(session, item));
    } catch (e) {
      await repos.checkoutBaseEverywhere();
      return this.save({ ...record, outcome: 'failed', error: e.message });
    }

    const abandon = async (outcome, extra) => {
      for (const r of await repos.changedRepos().catch(() => [])) for (const f of await r.git.changedFiles()) this.touched.add(f);
      // Never throw away code silently: keep it as a patch the next attempt (or you) can apply.
      const patches = outcome === 'failed' ? await repos.savePatches(workDir).catch(() => []) : [];
      if (patches.length) this.logger.info(`  saved this attempt's changes: ${patches.join(', ')}`);
      await repos.abandon(branch, created);
      return this.save({ ...record, outcome, ...extra, ...(patches.length ? { savedPatches: patches } : {}) });
    };
    const timeoutMs = cfg.ticketTimeoutMinutes * 60000;

    try {
      this.step('claude: analysing and resolving');
      let result = await this.ask(session, prompt, timeoutMs);

      if (result.status === 'resolved') result = await this.applyPreCommit(session, repos, result, timeoutMs);

      if (result.status === 'resolved' && cfg.verifyPass) {
        this.step('claude: self-review against requirements');
        result = await this.ask(session, verifyPrompt, timeoutMs);
        record.verified = result.status === 'resolved' && result.requirements_check.every((r) => r.met !== false) && result.tests?.passed !== false;
      }

      if (result.status === 'needs_clarification') return onClarification(record, result, abandon);
      if (result.status !== 'resolved') return abandon('failed', { result, error: `Claude could not resolve it: ${result.summary || result.status}` });
      if (result.tests?.passed === false) return abandon('failed', { result, error: `Claude reported failing tests: ${result.tests.details || ''}` });

      await this.restoreReadOnly(repos, record);
      const touchedReadOnly = await repos.revertReadOnly();
      if (touchedReadOnly.length) {
        return abandon('failed', { result, error: `The fix needs changes in ${touchedReadOnly.join(', ')}, which has no "${cfg.baseBranch}" branch — create one there and re-run.` });
      }
      let changed = await repos.changedRepos();
      if (!changed.length) return abandon('failed', { result, error: 'Claude reported resolved but made no code changes.' });

      // Orchestrator-side test gate in every changed repo, with a chance for Claude to fix failures.
      for (let attempt = 0; ; attempt++) {
        const failures = await this.runTests(changed, 'ticket branch');
        if (!failures.length) break;
        if (attempt >= cfg.maxFixAttempts) return abandon('failed', { result, error: failures.map((f) => `${f.repo}: \`${f.cmd}\` failed\n${tail(f.output, 2000)}`).join('\n\n') });
        this.step('claude: fixing test failures');
        result = await this.ask(session, `The project tests failed after your change. Fix the cause (do not weaken or skip tests), re-run them, and reply with the RESULT_JSON again.\n\n${failures.map((f) => `Repo ${f.repo} (${f.dir}) — \`${f.cmd}\`:\n\`\`\`\n${tail(f.output, 6000)}\n\`\`\``).join('\n\n')}`, timeoutMs);
        if (result.status !== 'resolved') return abandon('failed', { result, error: `Could not fix failing tests: ${result.summary || ''}` });
        changed = await repos.changedRepos();
      }

      await repos.releaseUnchanged(branch, changed, created);
      record.repos = [];
      const message = `${commitTitle}\n\n${result.summary || ''}\n\nResolved by auto-ticket-resolver.\n\nCo-Authored-By: Claude <noreply@anthropic.com>`;
      for (const r of changed) {
        const files = await r.git.changedFiles();
        this.step(`git[${r.name}]: commit ${files.length} file(s)`);
        let c = await r.git.commitAll(message);
        for (let attempt = 0; !c.ok && attempt < cfg.maxFixAttempts; attempt++) {
          this.step(`claude: fixing pre-commit hook failures in ${r.name}`);
          result = await this.ask(session, `Committing in ${r.name} (${r.dir}) was rejected by the repository's pre-commit hooks. Fix what they report (formatting changes they made are already in the working tree), run \`pre-commit run --files <changed files>\` until it passes, and reply with the RESULT_JSON again. Do not commit.\n\n\`\`\`\n${tail(c.output, 6000)}\n\`\`\``, timeoutMs);
          if (result.status !== 'resolved') break;
          c = await r.git.commitAll(message);
        }
        if (!c.ok) {
          for (const done of record.repos) await done.repo.git.tryRun('reset', '--soft', 'HEAD~1');
          return abandon('failed', { result, error: `${r.name}: pre-commit hooks rejected the commit:\n${tail(c.output, 2000)}` });
        }
        record.repos.push({ name: r.name, dir: r.dir, files, commit: c.sha, repo: r });
        for (const f of files) this.touched.add(f);
      }

      for (const r of changed) {
        this.step(`git[${r.name}]: push ${branch} to ${cfg.gitRemote}`);
        try { await r.git.pushTicketBranch(branch); } catch (e) {
          await repos.checkoutBaseEverywhere();
          return this.save({ ...record, result, outcome: 'failed', branchKept: true, error: `${r.name}: committed on ${branch} but push failed: ${e.message}` });
        }
      }

      const merged = [];
      const undoMerges = async () => { for (const m of merged) await m.repo.git.undoMerge(m.before); };
      const resolver = this.conflictResolver(session, item);
      for (const r of changed) {
        // The ticket may have taken a while: merge onto the latest origin/<base>.
        this.step(`git[${r.name}]: pull ${cfg.gitRemote}/${cfg.baseBranch} before merging`);
        try { await r.git.pullBase({ onConflict: resolver(r) }); } catch (e) {
          await undoMerges();
          await repos.checkoutBaseEverywhere();
          this.stopRequested = true;
          return this.save({ ...record, result, outcome: 'failed', branchKept: true, error: `Stopped the run — ${e.message} (ticket branch ${branch} is pushed but not merged)` });
        }
        this.step(`git[${r.name}]: merge ${branch} into local ${cfg.baseBranch}`);
        const m = await r.git.mergeIntoBase(branch, `Merge ${branch}: ${commitTitle.replace(/^[^:]+: /, '')}`, { onConflict: resolver(r) });
        if (!m.ok) {
          await undoMerges();
          await repos.checkoutBaseEverywhere();
          return this.save({ ...record, result, outcome: 'failed', branchKept: true, error: `${r.name}: merge into ${cfg.baseBranch} failed (merges for this ticket undone): ${tail(m.error, 1500)}` });
        }
        merged.push({ repo: r, before: m.before, sha: m.sha });
        if (m.resolvedConflicts) record.resolvedConflicts = [...(record.resolvedConflicts || []), ...m.resolvedConflicts.map((f) => `${r.name}/${f}`)];
      }

      const postFailures = await this.runTests(changed, cfg.baseBranch);
      if (postFailures.length) {
        await undoMerges();
        return this.save({ ...record, result, outcome: 'failed', branchKept: true, error: `Tests failed on ${cfg.baseBranch} after merge; merges undone:\n${postFailures.map((f) => `${f.repo}: ${tail(f.output, 1500)}`).join('\n')}` });
      }
      for (const m of merged) record.repos.find((x) => x.name === m.repo.name).mergeCommit = m.sha;
      if (this.currentTestSummary) record.testCommandResult = `${this.currentTestSummary}; passed again on ${cfg.baseBranch} after merge`;

      return { outcome: 'resolved', result };
    } catch (e) {
      this.logger.error(`${item.id}: ${e.message}`);
      return abandon('failed', { error: e.message });
    }
  }

  /** Pre-existing failures reported in ticket results that have not been resolved/clarified yet, de-duplicated. */
  pendingPreexisting() {
    const byKey = new Map();
    for (const rec of this.state.all()) {
      if (rec.kind === 'preexisting') continue;
      for (const raw of rec.result?.tests?.preexisting_failures || []) {
        const text = String(raw).trim();
        if (!text) continue;
        const key = text.split(/\s+\(/)[0].replace(/\s+/g, ' ').toLowerCase();
        const entry = byKey.get(key) || { key, text, tickets: [], ticketDirs: [] };
        if (!entry.tickets.includes(rec.id)) { entry.tickets.push(rec.id); if (rec.ticketDir) entry.ticketDirs.push(rec.ticketDir); }
        if (text.length > entry.text.length) entry.text = text;
        byKey.set(key, entry);
      }
    }
    return [...byKey.values()]
      .map((f) => {
        let slug = f.key.replace(/^.*?(\btest_)/, '$1').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unnamed';
        if (slug.length > 60) slug = slug.slice(0, 61).replace(/-[^-]*$/, ''); // cut at a word boundary
        return { ...f, id: `PREEXISTING-${slug}`, slug, subject: `Pre-existing test failure: ${f.text.split(/\s+\(/)[0].slice(0, 120)}` };
      })
      .filter((f) => this.cfg.force || !DONE_OUTCOMES.has(this.state.get(f.id)?.outcome));
  }

  /** Fixes each pre-existing failure on its own branch, through the same pipeline as tickets (no Hub involved). */
  async fixPreexistingFailures({ session, repos }) {
    const failures = this.pendingPreexisting();
    if (!failures.length) return;
    this.logger.info(`━━━━ ${failures.length} pre-existing failure(s) to fix: ${failures.map((f) => f.slug).join(', ')}`);
    for (const f of failures) {
      if (this.stopRequested) break;
      this.status.queue.push({ id: f.id, subject: f.subject, priority: '—', type: 'Pre-existing failure', stage: '' });
      this.status.current = { id: f.id, subject: f.subject, step: 'context', startedAt: Date.now() };
      this.currentTestSummary = null;
      const record = await this.processPreexisting(f, { session, repos });
      this.status.done.push({ id: f.id, subject: f.subject, outcome: record.outcome, error: record.error });
      this.emit('ticket:done', record);
    }
  }

  async processPreexisting(f, { session, repos }) {
    const cfg = this.cfg;
    const branch = `fix/preexisting-${f.slug}`.slice(0, 80);
    const dir = path.join(this.ws.preexisting, f.slug);
    fs.mkdirSync(dir, { recursive: true });
    this.currentTicketDir = dir;
    fs.writeFileSync(path.join(dir, 'failure.md'), [
      `# ${f.subject}`, '', `Reported as failing *without* the ticket's change while working on: ${f.tickets.join(', ')}`, '',
      '## Report', '', f.text, '', '## Ticket folders', '', ...f.ticketDirs.map((d) => `- ${d}`), '',
    ].join('\n'));
    const record = {
      id: f.id, kind: 'preexisting', subject: f.subject, failure: f.text, reportedBy: f.tickets, type: 'Pre-existing failure',
      priority: '', stageBefore: '', branch, ticketDir: dir, processedAt: new Date().toISOString(),
    };
    this.logger.info(`━━ ${f.id} (reported by ${f.tickets.join(', ')})`);
    const out = await this.workItem({
      session, repos, item: { id: f.id, subject: f.subject }, record, branch, workDir: dir,
      prompt: this.preexistingPrompt(f, dir, branch),
      verifyPrompt: this.verifyPrompt({ id: f.id }),
      commitTitle: `Fix pre-existing failure: ${f.text.split(/\s+\(/)[0].slice(0, 100)}`,
      onClarification: (rec, result, abandon) => abandon('needs_clarification', { result }),
    });
    if (out.outcome !== 'resolved') return out;
    return this.save({ ...record, result: out.result, outcome: 'resolved', hubUpdate: 'n/a (not a Hub ticket)' });
  }

  preexistingPrompt(f, dir, branch) {
    return `New work item: a test failure that already exists on \`${this.cfg.baseBranch}\` (it is not caused by any ticket).
Branch \`${branch}\` is checked out from \`${this.cfg.baseBranch}\`. Folder: ${dir} (failure.md).

Reported while working on ${f.tickets.join(', ')}:
  ${f.text}

1. Reproduce it first: run just that test (on this branch, before changing anything). If it does not fail any more,
   change nothing and report status "failed" with a summary starting "NOT REPRODUCIBLE" (say what you ran).
2. Find the root cause: is the application code wrong, or is the test out of date with intended behaviour?
   Use git log/blame on both to see which side changed last and why.
3. Fix the real cause. Never delete, skip or weaken the test to make it pass. If you change the test, explain why the
   old expectation no longer matches the intended behaviour.
4. If which behaviour is correct is a product decision you cannot settle from the code, history and tickets, report
   "needs_clarification" with precise questions — no changes.
5. Run the test, the rest of its module and the repository's pre-commit hooks; leave changes uncommitted and finish
   with the RESULT_JSON block (requirements_check: "the test passes", "no behaviour regressions", …).`;
  }

  /**
   * onConflict handler factory: Claude resolves a merge conflict in place (git has left the merge in progress), then
   * the orchestrator verifies no markers remain and commits the merge.
   */
  conflictResolver(session, item) {
    return (repo) => async ({ files, output, situation, repoDir }) => {
      this.step(`claude: resolving merge conflict in ${repo.name}`);
      const prompt = `A merge conflict needs resolving before work on ${item.id} can continue.

Repository: ${repo.name} (${repoDir})
Situation: ${situation}.
Conflicted files: ${files.join(', ')}

git has left the merge in progress. For each conflicted file:
1. Read both sides (\`git diff\` shows the conflict; \`git log --oneline -5 MERGE_HEAD\` and \`git log --oneline -5 HEAD\` show what each side did).
2. Edit the file so both sides' intent is kept — never just drop one side unless one change genuinely supersedes the other — and remove every conflict marker.
3. Run the tests that cover these files, and the repository's pre-commit hooks on them if it has any.
Do not run git merge/commit/checkout/reset/stash — only edit files; the orchestrator commits the merge.
If you cannot resolve it safely, report "failed" and explain why. Reply with the RESULT_JSON (summary = how you resolved each file).

git's output:
\`\`\`
${tail(output, 4000)}
\`\`\``;
      const r = await this.ask(session, prompt, this.cfg.ticketTimeoutMinutes * 60000);
      return r.status === 'resolved';
    };
  }

  /**
   * Runs each changed repo's pre-commit hooks (formatters + linters) on the changed files. Formatter rewrites stay in
   * the working tree; anything still failing goes back to Claude to fix.
   */
  async applyPreCommit(session, repos, result, timeoutMs) {
    for (let attempt = 0; ; attempt++) {
      const failures = [];
      for (const r of await repos.changedRepos()) {
        const res = await r.git.runPreCommit();
        if (!res) continue;
        this.step(`pre-commit[${r.name}]: ${res.ok ? 'passed' : 'failing'}`);
        if (!res.ok) failures.push({ repo: r, output: res.output });
      }
      if (!failures.length || attempt >= this.cfg.maxFixAttempts) return result;
      this.step('claude: fixing pre-commit findings');
      result = await this.ask(session, `The repository's pre-commit hooks were run on your changed files. Formatter rewrites are already applied in the working tree (keep them); these checks still fail — fix them, re-run \`pre-commit run --files <changed files>\` until it passes, re-run the affected tests, and reply with the RESULT_JSON again.\n\n${failures.map((f) => `${f.repo.name} (${f.repo.dir}):\n\`\`\`\n${tail(f.output, 5000)}\n\`\`\``).join('\n\n')}`, timeoutMs);
      if (result.status !== 'resolved') return result;
    }
  }

  /** TEST_COMMAND (or the repo's entry in TEST_COMMANDS) in each changed repo. Returns the failures. */
  async runTests(repos, where) {
    const failures = [];
    const passed = [];
    for (const r of repos) {
      const cmd = this.cfg.testCommands[r.name] ?? this.cfg.testCommand;
      if (!cmd) continue;
      this.step(`tests[${r.name}] on ${where}: ${cmd}`);
      const t = await r.git.runShell(cmd, this.cfg.testTimeoutMinutes * 60000);
      if (t.ok) passed.push(`${r.name}: \`${cmd}\``);
      else failures.push({ repo: r.name, dir: r.dir, cmd, output: t.output });
    }
    if (!failures.length && passed.length && where !== this.cfg.baseBranch) this.currentTestSummary = `passed — ${passed.join(', ')}`;
    return failures;
  }

  async handleClarification(item, record, result, stageOptions, abandon) {
    const cfg = this.cfg;
    const notes = [];
    if (cfg.postClarificationComment && result.questions.length) {
      this.step('hub: posting questions to discussion');
      const body = [
        `${item.createdBy ? `@${item.createdBy} ` : ''}🤖 Auto Ticket Resolver — clarification needed before this ticket can be worked on:`,
        '',
        ...result.questions.map((q, i) => `${i + 1}. ${q}`),
        ...(result.missing_context ? ['', `Missing context: ${result.missing_context}`] : []),
        '',
        'Please answer here and move the ticket back to Open/Reopen so it is picked up again.',
      ].join('\n');
      const r = await this.comment(item.id, body, item.createdBy);
      notes.push(r);
      record.commentPosted = r.startsWith('comment posted');
    }
    this.step(`hub: stage → ${cfg.clarificationStage}${cfg.hubWrite ? "" : " (skipped: --no-hub-write)"}`);
    notes.push(await this.setStage(item.id, cfg.clarificationStage, stageOptions, record));
    return abandon('needs_clarification', { result, hubUpdate: notes.filter(Boolean).join('; ') });
  }

  async setStage(id, wanted, options, record) {
    const stage = matchStage(wanted, options);
    if (!stage) return `⚠ stage "${wanted}" not found (available: ${(options || []).map((o) => (typeof o === 'string' ? o : o?.value || o?.name)).join(', ') || 'unknown'})`;
    if (!this.cfg.hubWrite) return `stage change to "${stage}" skipped (HUB_WRITE=false)`;
    try {
      await this.hub.updateTask(id, { custom_tracker_status: stage });
      record.stageAfter = stage;
      return `stage → ${stage}`;
    } catch (e) {
      this.logger.error(`${id}: could not set stage ${stage}: ${e.message}`);
      return `⚠ stage update failed: ${e.message}`;
    }
  }

  /** Posts to the ticket's discussion, tagging its creator (@email) so they are notified. */
  async comment(id, content, creator) {
    if (!this.cfg.hubWrite) return 'comment skipped (HUB_WRITE=false)';
    const body = creator && !content.includes(`@${creator}`) ? `@${creator} ${content}` : content;
    try {
      const res = await this.hub.addComment(id, body);
      const notified = res?.mentioned || [];
      if (creator) this.logger.info(`  hub: ${notified.length ? `notified ${notified.join(', ')}` : `tagged @${creator}, but the Hub reported nobody notified`}`);
      return notified.length ? `comment posted (notified ${notified.join(', ')})` : 'comment posted';
    }
    catch (e) { this.logger.error(`${id}: could not post comment: ${e.message}`); return `⚠ comment failed: ${e.message}`; }
  }

  /** Keeps every exchange with Claude next to the ticket's context, for auditing. */
  recordReply(prompt, reply) {
    if (!this.currentTicketDir) return;
    const entry = `\n\n## ${new Date().toISOString()}\n\n### Prompt\n\n${prompt.split('---------------- ticket.md')[0].trim()}\n\n### Reply\n\n${reply}\n`;
    fs.appendFileSync(`${this.currentTicketDir}/claude_replies.md`, entry);
  }

  async ask(session, prompt, timeoutMs) {
    let reply = await session.send(prompt, { timeoutMs });
    this.recordReply(prompt, reply);
    let result = parseResult(reply);
    if (!result) {
      const retry = 'Your last reply did not end with a valid <<<RESULT_JSON … RESULT_JSON>>> block. Reply now with only that block for the current ticket.';
      reply = await session.send(retry, { timeoutMs: 5 * 60000 });
      this.recordReply(retry, reply);
      result = parseResult(reply);
    }
    if (!result) throw new Error('Claude did not return a parseable result.');
    this.logger.info(`  claude → ${result.status}: ${String(result.summary || '').slice(0, 300)}`);
    return result;
  }

  ticketPrompt(item, ctx, branch) {
    let brief = fs.readFileSync(ctx.mdPath, 'utf8');
    if (brief.length > MAX_INLINE_BRIEF) brief = brief.slice(0, MAX_INLINE_BRIEF) + `\n\n…(truncated — read the full file at ${ctx.mdPath})`;
    const previous = fs.readdirSync(ctx.dir).filter((f) => /^previous_attempt_.*\.patch$/.test(f));
    const previousNote = previous.length
      ? `\nAn earlier attempt at this ticket was interrupted after its work was done; its changes are saved as ${previous.map((f) => `${ctx.dir}/${f}`).join(', ')}.\n` +
        'Review that patch critically. If it is sound, apply it with `git apply <patch>` in the matching repository and verify it (tests, hooks) instead of starting over; otherwise do your own fix.\n'
      : '';
    return `New ticket: ${item.id} (${item.priorityKey} ${item.type}). Branch \`${branch}\` is checked out from \`${this.cfg.baseBranch}\` in every repository.

${previousNote}Ticket folder: ${ctx.dir}
  - ticket.md (below), detail.json, activity.json
  - attachments/ and links/ — open every image, PDF, spreadsheet or document there that is relevant (use the Read tool for images/PDFs).

1. Understand the ticket fully from the title, description, checklist, discussion (latest comments may override the description) and the files.
2. Decide whether it is clear enough to implement. If not, report needs_clarification with precise questions — no code changes.
3. Otherwise work out which repositories the ticket touches (it may be more than one), locate the relevant code, implement the change, add/update tests, run tests/build/lint, and confirm every checklist item and acceptance point is met.
4. Leave the changes uncommitted and finish with the RESULT_JSON block.

---------------- ticket.md ----------------
${brief}`;
  }

  verifyPrompt(item) {
    return `Before ${item.id} is committed, review your work critically as a strict reviewer would:
- Run \`git status\` and \`git diff\` in every repository you changed and read the complete change.
- Re-read the ticket (description, checklist, latest discussion) and check each requirement against the diff.
- Check edge cases and that nothing unrelated changed; remove debug code and scratch files.
- Confirm the tests you ran exercise this change; re-run them now.
Fix anything missing and re-test. Then reply with the RESULT_JSON block: status "resolved" only if every requirement is met and tests pass,
with requirements_check filled in. Use "needs_clarification" if review revealed a real ambiguity, or "failed" if it cannot be completed — in both cases the orchestrator discards the working-tree changes.`;
  }

  queueReportWrite() {
    this.reportChain = this.reportChain
      .then(() => writeReports(this.state, this.ws.reports, this.cfg))
      .catch((e) => this.logger.error(`Report write failed: ${e.message}`));
    return this.reportChain;
  }

  save(record) {
    if (record.repos) record.repos = record.repos.map(({ repo, ...rest }) => rest);
    if (this.currentTestSummary && !record.testCommandResult) record.testCommandResult = this.currentTestSummary;
    this.state.set(record.id, record);
    this.queueReportWrite();
    const icon = { resolved: '✅', needs_clarification: '❓', failed: '❌' }[record.outcome] || '•';
    this.logger.info(`${icon} ${record.id}: ${record.outcome}${record.error ? ` — ${record.error.split('\n')[0]}` : ''}`);
    return record;
  }
}

const tail = (s, n) => (String(s).length > n ? '…' + String(s).slice(-n) : String(s));
