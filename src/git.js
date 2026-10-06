import fs from 'node:fs';
import path from 'node:path';
import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const execP = promisify(exec);

/**
 * All branch movement, commits, pushes and merges happen here — never inside the Claude session.
 * Pushing is restricted to ticket branches; the base branch (development) and main/master are never pushed.
 */
export class Git {
  constructor({ repoPath, baseBranch, remote, logger }) {
    this.cwd = repoPath;
    this.base = baseBranch;
    this.remote = remote;
    this.logger = logger;
    this.protected = new Set([baseBranch, 'main', 'master', 'develop', 'staging', 'production', 'release']);
  }

  async run(...args) {
    const { stdout } = await execFileP('git', args, { cwd: this.cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  }

  async tryRun(...args) {
    try { return { ok: true, out: await this.run(...args) }; }
    catch (e) { return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}`.trim() || e.message }; }
  }

  async currentBranch() { return this.run('rev-parse', '--abbrev-ref', 'HEAD'); }
  async isClean() { return (await this.run('status', '--porcelain')) === ''; }
  async branchExists(b) { return (await this.tryRun('rev-parse', '--verify', '--quiet', `refs/heads/${b}`)).ok; }
  async head() { return this.run('rev-parse', 'HEAD'); }

  async preflight() {
    if (!(await this.isClean())) {
      throw new Error(`Repository ${this.cwd} has uncommitted changes. Commit or stash them first so ticket work is not mixed with yours.`);
    }
    if (!(await this.branchExists(this.base))) throw new Error(`Base branch "${this.base}" does not exist locally in ${this.cwd}.`);
    const remotes = await this.run('remote');
    if (!remotes.split('\n').includes(this.remote)) throw new Error(`Git remote "${this.remote}" not found.`);
    // Ticket branches must be pushable; find out now rather than after Claude has done the work.
    const reach = await this.tryRun('-c', 'credential.interactive=never', 'ls-remote', '--heads', this.remote);
    if (!reach.ok) {
      throw new Error(`Cannot authenticate to "${this.remote}" for ${this.cwd}: ${reach.out.replace(/ghs_[\w.-]+|ghp_[\w]+|x-access-token:[^@]+@/g, '***').split('\n').slice(-2).join(' ')}`);
    }
    try {
      await this.pullBase();
    } catch (e) {
      // No Claude session exists yet at start-up; the pull before the first ticket retries with Claude resolving it.
      if (!/conflicts/.test(e.message)) throw e;
      this.logger.warn(`${e.message} — Claude will resolve this before the first ticket.`);
    }
  }

  /**
   * Brings the local base branch up to date with <remote>/<base>. Fast-forwards when possible; once local ticket merges
   * exist (they are never pushed) the remote changes are merged in instead. On a conflict, `onConflict` (Claude) gets
   * to resolve it; without one, or if it cannot, the merge is undone and this throws. A failed fetch throws.
   */
  async pullBase({ onConflict } = {}) {
    await this.run('checkout', this.base);
    let fetch;
    for (let attempt = 1; attempt <= 3; attempt++) {
      fetch = await this.tryRun('-c', 'credential.interactive=never', 'fetch', this.remote, this.base);
      if (fetch.ok) break;
      if (attempt < 3) { this.logger.warn(`${this.cwd}: fetch failed (attempt ${attempt}/3), retrying in ${attempt * 15}s`); await new Promise((r) => setTimeout(r, attempt * 15000)); }
    }
    if (!fetch.ok) throw new Error(`Could not fetch ${this.remote}/${this.base} in ${this.cwd}: ${fetch.out.split('\n').slice(-2).join(' ')}`);
    const upstream = `refs/remotes/${this.remote}/${this.base}`;
    const behind = Number(await this.run('rev-list', '--count', `HEAD..${upstream}`));
    if (!behind) return { updated: false };
    if ((await this.tryRun('merge-base', '--is-ancestor', 'HEAD', upstream)).ok) {
      await this.run('merge', '--ff-only', upstream);
      this.logger.info(`${this.cwd}: ${this.base} fast-forwarded ${behind} commit(s) from ${this.remote}.`);
      return { updated: true };
    }
    const m = await this.mergeResolving([upstream], {
      message: `Merge ${this.remote}/${this.base} into local ${this.base}`,
      onConflict,
      situation: `pulling ${behind} new commit(s) of ${this.remote}/${this.base} ("theirs") into the local ${this.base} branch ("ours"), which already holds this run's merged ticket branches`,
    });
    if (!m.ok) throw new Error(`Pulling ${this.remote}/${this.base} into local ${this.base} conflicts in ${this.cwd}: ${m.error.split('\n').slice(-3).join(' ')}`);
    this.logger.info(`${this.cwd}: merged ${behind} new commit(s) from ${this.remote}/${this.base} into local ${this.base}${m.resolvedConflicts ? ` (conflicts resolved in ${m.resolvedConflicts.join(', ')})` : ''}.`);
    return { updated: true };
  }

  /** Files git reports as unmerged in an in-progress merge. */
  async conflictedFiles() {
    const out = await this.run('diff', '--name-only', '--diff-filter=U');
    return out ? out.split('\n') : [];
  }

  /** Of `files`, those still containing conflict markers. */
  filesWithConflictMarkers(files) {
    return files.filter((f) => {
      try { return /^(<{7}|>{7})( |$)/m.test(fs.readFileSync(path.join(this.cwd, f), 'utf8')); } catch { return false; }
    });
  }

  /** Concludes an in-progress merge; pre-commit formatter rewrites are staged and the commit retried. */
  async commitMerge(message, attempts = 3) {
    let output = '';
    for (let i = 0; i < attempts; i++) {
      await this.run('add', '-A');
      const r = await this.tryRun('commit', '--no-edit', '-m', message);
      if (r.ok) return { ok: true, sha: await this.head() };
      output = r.out;
      if (!/files were modified by this hook|reformatted|fixed/i.test(output)) break;
    }
    return { ok: false, output };
  }

  /**
   * `git merge <args>`; on conflicts hands the in-progress merge to `onConflict({ files, output, situation, repoDir })`,
   * which must edit the files to resolve them and return true. The merge is then committed. If there is no resolver,
   * it gives up, or markers remain, the merge is aborted and HEAD restored. Returns { ok, before, sha | error }.
   */
  async mergeResolving(args, { message, onConflict, situation }) {
    const before = await this.head();
    const m = await this.tryRun('merge', '--no-edit', '-m', message, ...args);
    if (m.ok) return { ok: true, before, sha: await this.head() };
    const files = await this.conflictedFiles();
    let error = m.out;
    if (files.length && onConflict) {
      this.logger.info(`${this.cwd}: merge conflict in ${files.join(', ')} — asking Claude to resolve it.`);
      try {
        if (await onConflict({ files, output: m.out, situation, repoDir: this.cwd })) {
          const left = this.filesWithConflictMarkers(files);
          if (left.length) error = `conflict markers still present in ${left.join(', ')}`;
          else {
            const c = await this.commitMerge(message);
            if (c.ok) return { ok: true, before, sha: c.sha, resolvedConflicts: files };
            error = `merge commit rejected: ${c.output}`;
          }
        } else error = `Claude could not resolve the conflict in ${files.join(', ')}`;
      } catch (e) { error = e.message; }
    }
    await this.tryRun('merge', '--abort');
    await this.tryRun('reset', '--hard', before);
    return { ok: false, before, error };
  }

  /** Creates the ticket branch from the base branch. A branch left over from an earlier attempt (e.g. a reopened ticket) is reused and brought up to date. */
  async remoteBranchExists(branch) {
    const r = await this.tryRun('-c', 'credential.interactive=never', 'ls-remote', '--heads', this.remote, branch);
    return r.ok && r.out.trim() !== '';
  }

  /**
   * A ticket branch left by an earlier, interrupted attempt: deleted when it holds nothing beyond the base branch
   * (so the ticket starts fresh). Returns 'none' | 'removed-empty' | 'kept'.
   */
  async tidyLeftoverBranch(branch) {
    if (!(await this.branchExists(branch))) return 'none';
    if ((await this.commitsAheadOfBase(branch)) === 0) {
      const r = await this.tryRun('branch', '-D', branch);
      if (r.ok) { this.logger.info(`${this.cwd}: removed empty leftover branch ${branch}`); return 'removed-empty'; }
    }
    return 'kept';
  }

  async startTicketBranch(branch, { onConflict } = {}) {
    if (this.protected.has(branch)) throw new Error(`Refusing to use protected branch name "${branch}".`);
    await this.run('checkout', this.base);
    await this.tidyLeftoverBranch(branch);
    if (await this.branchExists(branch)) {
      await this.run('checkout', branch);
      const m = await this.mergeResolving([this.base], {
        message: `Merge ${this.base} into ${branch}`,
        onConflict,
        situation: `bringing the existing ticket branch ${branch} ("ours", from an earlier attempt) up to date with ${this.base} ("theirs")`,
      });
      if (!m.ok) throw new Error(`Existing branch ${branch} conflicts with ${this.base}: ${m.error}`);
      if (!(await this.remoteBranchExists(branch))) {
        // Never pushed (e.g. parked work of an interrupted run): turn it back into uncommitted changes on top of the
        // base, so it is checked and committed once, through the hooks, like any fresh ticket.
        await this.run('reset', '--mixed', this.base);
        this.logger.info(`${this.cwd}: ${branch} had unpushed work from an earlier attempt — continuing from it as uncommitted changes`);
        return { created: true };
      }
      return { created: false };
    }
    await this.run('checkout', '-b', branch, this.base);
    return { created: true };
  }

  async hasChanges() { return !(await this.isClean()); }

  /** Identifies the exact working-tree state (tracked diff + untracked files), to notice changes in repos we must not reset. */
  async fingerprint() {
    const { stdout: status } = await execFileP('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: this.cwd, maxBuffer: 64 * 1024 * 1024 });
    const { stdout: diff } = await execFileP('git', ['diff', 'HEAD', '--binary'], { cwd: this.cwd, maxBuffer: 256 * 1024 * 1024 });
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(status).update('\0').update(diff).digest('hex');
  }

  /**
   * Exact snapshot of the working tree without changing it: tracked edits as a stash commit (`git stash create`),
   * untracked files copied to `backupDir`. Used for read-only repos that hold your own uncommitted work.
   */
  async snapshot(backupDir) {
    const stash = (await this.tryRun('stash', 'create')).out || '';
    const { stdout } = await execFileP('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: this.cwd, maxBuffer: 64 * 1024 * 1024 });
    const untracked = stdout.split('\0').filter(Boolean);
    for (const f of untracked) {
      fs.mkdirSync(path.dirname(path.join(backupDir, f)), { recursive: true });
      fs.copyFileSync(path.join(this.cwd, f), path.join(backupDir, f));
    }
    return { stash: /^[0-9a-f]{40}$/.test(stash) ? stash : '', untracked, backupDir, fingerprint: await this.fingerprint() };
  }

  /** Puts the working tree back exactly as `snapshot()` found it. Returns true when the result matches the snapshot. */
  async restoreSnapshot(snap) {
    await this.run('checkout', '--', '.');
    await this.tryRun('clean', '-fd');
    if (snap.stash) await this.run('stash', 'apply', snap.stash);
    for (const f of snap.untracked) {
      fs.mkdirSync(path.dirname(path.join(this.cwd, f)), { recursive: true });
      fs.copyFileSync(path.join(snap.backupDir, f), path.join(this.cwd, f));
    }
    return (await this.fingerprint()) === snap.fingerprint;
  }

  async changedFiles() {
    // -z keeps each entry's leading status columns intact (run() trims) and handles odd file names.
    const { stdout } = await execFileP('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: this.cwd, maxBuffer: 64 * 1024 * 1024 });
    const entries = stdout.split('\0').filter(Boolean);
    const files = [];
    for (let i = 0; i < entries.length; i++) {
      files.push(entries[i].slice(3));
      if (/^[RC]/.test(entries[i])) i++; // rename/copy: the next entry is the original path
    }
    return files;
  }

  /**
   * Commits everything. Pre-commit formatters (ruff-format, prettier, …) abort a commit after rewriting files; those
   * rewrites are staged and the commit retried. Returns { ok, sha } or { ok: false, output } when a hook keeps failing.
   */
  async commitAll(message, { attempts = 3 } = {}) {
    let output = '';
    for (let i = 0; i < attempts; i++) {
      await this.run('add', '-A');
      const r = await this.tryRun('commit', '-m', message);
      if (r.ok) return { ok: true, sha: await this.head() };
      output = r.out;
      if (!/files were modified by this hook|reformatted|fixed/i.test(output)) break;
      this.logger.info(`${this.cwd}: pre-commit hooks reformatted files — staging them and committing again.`);
    }
    await this.tryRun('reset', '-q'); // leave the changes unstaged in the working tree for a fix-up turn
    return { ok: false, output };
  }

  /** The working tree's changes (including new files) as a binary patch against HEAD. Nothing is modified. */
  async workingTreePatch() {
    const { stdout: untracked } = await execFileP('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: this.cwd });
    const files = untracked.split('\0').filter(Boolean);
    if (files.length) await execFileP('git', ['add', '-N', '--', ...files], { cwd: this.cwd }); // intent-to-add, so they show in the diff
    const { stdout } = await execFileP('git', ['diff', 'HEAD', '--binary'], { cwd: this.cwd, maxBuffer: 256 * 1024 * 1024 });
    if (files.length) await execFileP('git', ['reset', '-q', '--', ...files], { cwd: this.cwd });
    return stdout;
  }

  async diffStatVsBase(branch) { return this.run('diff', '--stat', `${this.base}...${branch}`); }
  async commitsAheadOfBase(branch) { return Number(await this.run('rev-list', '--count', `${this.base}..${branch}`)); }

  async pushTicketBranch(branch) {
    if (this.protected.has(branch)) throw new Error(`Refusing to push protected branch "${branch}".`);
    return this.run('push', '-u', this.remote, `refs/heads/${branch}:refs/heads/${branch}`);
  }

  /** Merges the ticket branch into the local base branch only (Claude resolves conflicts). Returns { ok, sha | error, before }. */
  async mergeIntoBase(branch, message, { onConflict } = {}) {
    await this.run('checkout', this.base);
    return this.mergeResolving(['--no-ff', branch], {
      message,
      onConflict,
      situation: `merging the ticket branch ${branch} ("theirs") into the local ${this.base} branch ("ours")`,
    });
  }

  /** The repository's own pre-commit runner (from .git/hooks/pre-commit or PATH), or null when the repo has none. */
  async preCommitCommand() {
    if (this.preCommit !== undefined) return this.preCommit;
    this.preCommit = null;
    if (!fs.existsSync(path.join(this.cwd, '.pre-commit-config.yaml'))) return null;
    const candidates = [];
    try {
      const hooksDir = (await this.tryRun('rev-parse', '--git-path', 'hooks')).out || '.git/hooks';
      const hook = fs.readFileSync(path.resolve(this.cwd, hooksDir, 'pre-commit'), 'utf8');
      const py = hook.match(/INSTALL_PYTHON=['"]?([^'"\s]+)/);
      if (py) candidates.push([py[1], '-m', 'pre_commit']);
    } catch { /* no installed hook */ }
    candidates.push(['pre-commit']);
    for (const c of candidates) {
      try { await execFileP(c[0], [...c.slice(1), '--version'], { cwd: this.cwd }); this.preCommit = c; break; } catch { /* try next */ }
    }
    return this.preCommit;
  }

  /**
   * Runs the repo's pre-commit hooks on the changed files (twice, so formatter rewrites settle). Nothing is staged.
   * Returns null when the repo has no pre-commit, else { ok, output }.
   */
  async runPreCommit() {
    const cmd = await this.preCommitCommand();
    if (!cmd) return null;
    const files = (await this.changedFiles()).filter((f) => fs.existsSync(path.join(this.cwd, f)));
    if (!files.length) return { ok: true, output: '' };
    let last;
    for (let i = 0; i < 2; i++) {
      try {
        const { stdout, stderr } = await execFileP(cmd[0], [...cmd.slice(1), 'run', '--files', ...files], { cwd: this.cwd, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60000 });
        return { ok: true, output: `${stdout}${stderr}` };
      } catch (e) {
        last = `${e.stdout || ''}${e.stderr || ''}` || e.message;
      }
    }
    return { ok: false, output: last };
  }

  async undoMerge(before) {
    await this.run('checkout', this.base);
    await this.run('reset', '--hard', before);
  }

  /** Throws away uncommitted work of a skipped ticket and returns to the base branch. */
  async abandonTicketBranch(branch, { deleteBranch }) {
    await this.tryRun('reset', '--hard');
    await this.tryRun('clean', '-fd');
    await this.run('checkout', this.base);
    if (deleteBranch) await this.tryRun('branch', '-D', branch);
  }

  /**
   * A separate working copy of this repository at `dir` on `branch` (git worktree), created from `base`. If the
   * branch already exists it is checked out there as-is. A stale worktree at `dir` (e.g. from a crashed run) is
   * removed first.
   */
  async addWorktree(dir, branch, base) {
    if (fs.existsSync(dir)) await this.removeWorktree(dir);
    await this.tryRun('worktree', 'prune');
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (await this.branchExists(branch)) {
      await this.run('worktree', 'add', dir, branch);
      return { created: false };
    }
    await this.run('worktree', 'add', '-b', branch, dir, base);
    return { created: true };
  }

  async removeWorktree(dir) {
    await this.tryRun('worktree', 'remove', '--force', dir);
    fs.rmSync(dir, { recursive: true, force: true });
    await this.tryRun('worktree', 'prune');
  }

  /** Runs the project's test command (TEST_COMMAND) in the repo. */
  async runShell(command, timeoutMs) {
    try {
      const { stdout, stderr } = await execP(command, { cwd: this.cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
      return { ok: true, output: `${stdout}\n${stderr}`.trim() };
    } catch (e) {
      return { ok: false, output: `${e.stdout || ''}\n${e.stderr || ''}\n${e.killed ? '(timed out)' : ''}`.trim() || e.message };
    }
  }
}
