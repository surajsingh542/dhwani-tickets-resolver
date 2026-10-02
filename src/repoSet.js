import fs from 'node:fs';
import path from 'node:path';
import { Git } from './git.js';

// Never worth descending into: dependency trees, virtualenvs, Frappe bench runtime folders, build output.
const SKIP_DIRS = new Set([
  // JS / other package managers
  '.git', 'node_modules', 'bower_components', 'vendor', '.yarn', '.pnpm-store', 'jspm_packages', 'Pods', '.dart_tool', '.gradle',
  // Python
  'env', 'venv', '.venv', 'virtualenv', 'site-packages', '__pycache__', '.tox', '.nox', '.eggs', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  // Frappe bench runtime
  'sites', 'logs',
  // build output / caches / editors
  'dist', 'build', 'coverage', 'target', '.next', '.nuxt', '.cache', '.idea', '.vscode', 'chromium',
]);

/** Dependency folders by name, plus Python virtualenvs under any name (they contain pyvenv.cfg). */
const isSkippable = (dir, name) => SKIP_DIRS.has(name) || fs.existsSync(path.join(dir, name, 'pyvenv.cfg'));
const MAX_DEPTH = 8;

/**
 * Every git repository under `root`, at any depth — including repos nested inside other repos, which is how a
 * Frappe bench lays out its apps (bench/apps/<app>/.git). Symlinks are not followed.
 */
export function discoverRepos(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (fs.existsSync(path.join(dir, '.git'))) found.push(dir);
    if (depth >= MAX_DEPTH) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || isSkippable(dir, e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return found.sort();
}

/** Frappe benches under `root`: a folder with apps/ and sites/ plus a Procfile or sites/apps.txt. */
export function discoverBenches(root) {
  const benches = [];
  const walk = (dir, depth) => {
    const has = (p) => fs.existsSync(path.join(dir, p));
    if (has('apps') && has('sites') && (has('Procfile') || has('sites/apps.txt'))) {
      const sites = fs.readdirSync(path.join(dir, 'sites'), { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, 'sites', e.name, 'site_config.json')))
        .map((e) => e.name);
      benches.push({ dir, sites });
      return;
    }
    if (depth >= 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory() && !isSkippable(dir, e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
  };
  walk(root, 0);
  return benches;
}

/**
 * Every repository the tickets may touch, handled as one unit per ticket: the ticket branch is opened in each
 * writable repo (one that has the base branch), and only repos that end up with changes are committed, pushed
 * (ticket branch only) and merged into the local base branch. Repos without the base branch are read-only context.
 *
 * `mainApp` (a folder name such as "icicif", or a path relative to the root) is the Frappe case: the main app is the
 * only writable repo — the only one pulled, branched, committed, pushed and merged. Everything else is read-only context.
 */
export class RepoSet {
  constructor({ root, baseBranch, remote, mainApp, snapshotDir, logger }) {
    this.snapshotDir = snapshotDir;
    this.root = root;
    this.base = baseBranch;
    this.logger = logger;
    this.mainAppName = mainApp || '';
    this.repos = discoverRepos(root).map((dir) => ({
      dir,
      name: path.relative(root, dir) || path.basename(dir),
      git: new Git({ repoPath: dir, baseBranch, remote, logger }),
    }));
    this.readOnlyRepos = [];
    this.benches = discoverBenches(root);
    this.main = null;
  }

  get readOnly() { return this.readOnlyRepos.map((r) => r.name); }

  findMain() {
    if (!this.mainAppName) return null;
    const want = this.mainAppName.replace(/\/+$/, '');
    const matches = this.repos.filter((r) => r.name === want || path.basename(r.dir) === want || r.dir === path.resolve(want));
    if (!matches.length) {
      throw new Error(`Main app "${want}" not found under ${this.root}. Repositories found: ${this.repos.map((r) => r.name).join(', ')}`);
    }
    if (matches.length > 1) throw new Error(`Main app "${want}" is ambiguous: ${matches.map((r) => r.name).join(', ')} — pass the relative path instead.`);
    return matches[0];
  }

  /** Read-only repo. Your own uncommitted work there is never reset; its state is fingerprinted so changes can be noticed. */
  async addReadOnly(r) {
    r.dirtyAtStart = !(await r.git.isClean());
    if (r.dirtyAtStart) {
      r.fingerprint = await r.git.fingerprint();
      if (this.snapshotDir) r.snapshot = await r.git.snapshot(path.join(this.snapshotDir, r.name.replace(/[^A-Za-z0-9._-]+/g, '_')));
    }
    this.readOnlyRepos.push(r);
  }

  /** Folders Claude must not edit: read-only repos, minus anything inside a writable repo (e.g. bench/apps/<main>). */
  protectedDirs() {
    return { deny: this.readOnlyRepos.map((r) => r.dir), allow: this.repos.map((r) => r.dir) };
  }

  /**
   * Read-only repos that held your changes at start and have changed since (Claude, or tools like `bench migrate`
   * rewriting framework files) are restored to their start-of-run snapshot. Returns { restored, failed } repo names.
   */
  async restoreDirtyReadOnly() {
    const restored = [];
    const failed = [];
    for (const r of this.readOnlyRepos) {
      if (!r.dirtyAtStart || (await r.git.fingerprint()) === r.fingerprint) continue;
      const files = await r.git.changedFiles().catch(() => []);
      const ok = r.snapshot ? await r.git.restoreSnapshot(r.snapshot).catch(() => false) : false;
      (ok ? restored : failed).push(r.name);
      this.logger[ok ? 'warn' : 'error'](`${r.name}: changed during the ticket (${files.slice(0, 5).join(', ')}${files.length > 5 ? ', …' : ''}) — ${ok ? 'restored to its state at the start of the run' : 'could NOT be restored'}.`);
    }
    return { restored, failed };
  }

  async preflight() {
    if (!this.repos.length) throw new Error(`No git repositories found in ${this.root}.`);
    this.main = this.findMain();

    const dirty = [];
    const usable = [];
    for (const r of this.repos) {
      r.originalBranch = await r.git.currentBranch().catch(() => null);
      if (this.main && r !== this.main) {
        // With a main app (the Frappe case) only the main app is pulled, branched, committed, pushed and merged.
        await this.addReadOnly(r);
        continue;
      }
      if (await r.git.branchExists(this.base)) {
        if (await r.git.isClean()) usable.push(r);
        else dirty.push(r.name);
      } else {
        await this.addReadOnly(r);
      }
    }
    if (this.main && !usable.includes(this.main)) {
      throw new Error(dirty.includes(this.main.name)
        ? `Main app ${this.main.name} has uncommitted changes — commit or stash them first.`
        : `Main app ${this.main.name} has no "${this.base}" branch.`);
    }
    if (dirty.length) throw new Error(`These repositories have uncommitted changes — commit or stash them first: ${dirty.join(', ')}`);
    if (!usable.length) throw new Error(`None of the repositories in ${this.root} has a "${this.base}" branch.`);

    // Remote access + pull of origin/<base>. If any writable repo fails, put the ones prepared so far back and stop.
    this.repos = [];
    for (const r of usable) {
      try {
        await r.git.preflight();
        this.repos.push(r);
      } catch (e) {
        for (const x of [...this.repos, r]) if (x.originalBranch) await x.git.tryRun('checkout', x.originalBranch);
        this.repos = [];
        throw e;
      }
    }

    const ro = this.readOnlyRepos.map((r) => r.name + (r.dirtyAtStart ? ' (has local changes, left untouched)' : ''));
    if (ro.length) this.logger.info(`Read-only context: ${ro.join(', ')}`);
    this.logger.info(`Writable repositories (${this.repos.length}): ${this.repos.map((r) => `${r.name}${r === this.main ? ' [MAIN]' : ''} (was on ${r.originalBranch})`).join(', ')}`);
    for (const b of this.benches) this.logger.info(`Frappe bench: ${b.dir} (sites: ${b.sites.join(', ') || 'none'})`);
  }

  describe() {
    const lines = [];
    if (this.main) {
      lines.push(
        `  MAIN APP — the only repository you may change: ${this.main.name} → ${this.main.dir}`,
        '  Everything else below is read-only context (framework and other apps). If a ticket truly cannot be fixed inside the',
        '  main app, report "failed" and explain which other repository would need the change.',
      );
    }
    for (const r of this.repos) if (r !== this.main) lines.push(`  - ${r.name} → ${r.dir}`);
    if (this.readOnlyRepos.length) {
      lines.push(`  Read-only (read for context, do NOT modify — edits there are discarded):`);
      for (const r of this.readOnlyRepos) lines.push(`  - ${r.name} → ${r.dir}`);
    }
    for (const b of this.benches) {
      const app = this.main ? path.basename(this.main.dir) : '<app>';
      lines.push(
        `  Frappe bench at ${b.dir} — sites: ${b.sites.join(', ') || '(none found)'}. Apps live in ${path.join(b.dir, 'apps')}.`,
        `    Run Frappe tests from the bench folder, e.g. \`cd ${b.dir} && bench --site ${b.sites[0] || '<site>'} run-tests --app ${app} [--module <module>]\`` +
          ' (needs the site\'s database/redis running and allow_tests enabled). After changing DocType JSON or patches, run `bench --site <site> migrate`;' +
          ' after JS/CSS changes, `bench build --app ' + app + '`. If the environment cannot run them, say so in tests.details.',
      );
    }
    return lines.join('\n');
  }

  /** `conflictResolver(repo)` returns the onConflict handler for that repo (Claude). */
  async startTicketBranch(branch, conflictResolver) {
    const created = {};
    for (const r of this.repos) {
      try {
        created[r.name] = (await r.git.startTicketBranch(branch, { onConflict: conflictResolver?.(r) })).created;
      } catch (e) {
        await this.abandon(branch, created);
        throw new Error(`${r.name}: ${e.message}`);
      }
    }
    return created;
  }

  /** Pull origin/<base> into every writable repo's local base branch (see Git.pullBase). */
  async pullBase(conflictResolver) {
    for (const r of this.repos) await r.git.pullBase({ onConflict: conflictResolver?.(r) });
  }

  async changedRepos() {
    const out = [];
    for (const r of this.repos) if (await r.git.hasChanges()) out.push(r);
    return out;
  }

  /** Saves each changed writable repo's working tree as <dir>/previous_attempt_<repo>.patch. Returns the files written. */
  async savePatches(dir) {
    const saved = [];
    if (!dir) return saved;
    for (const r of this.repos) {
      if (!(await r.git.hasChanges())) continue;
      const patch = await r.git.workingTreePatch();
      if (!patch.trim()) continue;
      const file = path.join(dir, `previous_attempt_${r.name.replace(/[^A-Za-z0-9._-]+/g, '_')}.patch`);
      fs.writeFileSync(file, patch);
      saved.push(file);
    }
    return saved;
  }

  /** Back to the base branch everywhere; discards uncommitted work and deletes branches this ticket created. */
  async abandon(branch, created = {}) {
    await this.revertReadOnly();
    await this.restoreDirtyReadOnly();
    for (const r of this.repos) {
      await r.git.abandonTicketBranch(branch, { deleteBranch: Boolean(created[r.name]) }).catch((e) => this.logger.warn(`${r.name}: ${e.message}`));
    }
  }

  /** For repos the ticket did not touch: return to base and drop the empty ticket branch. */
  async releaseUnchanged(branch, changed, created) {
    const keep = new Set(changed.map((r) => r.name));
    for (const r of this.repos) {
      if (keep.has(r.name)) continue;
      await r.git.run('checkout', this.base);
      if (created[r.name] && (await r.git.commitsAheadOfBase(branch)) === 0) await r.git.tryRun('branch', '-D', branch);
    }
  }

  /**
   * Read-only repos that were clean at start: anything changed there came from the ticket and cannot be shipped,
   * so it is reverted. Repos that already had your changes at start are never touched. Returns the repos reverted.
   */
  async revertReadOnly() {
    const touched = [];
    for (const r of this.readOnlyRepos) {
      if (r.dirtyAtStart || !(await r.git.hasChanges())) continue;
      touched.push(r.name);
      await r.git.tryRun('checkout', '--', '.');
      await r.git.tryRun('clean', '-fd');
    }
    if (touched.length) this.logger.warn(`Reverted edits in read-only repo(s): ${touched.join(', ')}`);
    return touched;
  }

  async checkoutBaseEverywhere() {
    for (const r of this.repos) await r.git.tryRun('checkout', this.base);
  }

  /** End of run: put every writable repo back on the branch it was on before the run. */
  async restoreOriginalBranches() {
    for (const r of this.repos) {
      if (!r.originalBranch || r.originalBranch === 'HEAD') continue;
      if (!(await r.git.isClean())) { this.logger.warn(`${r.name}: not clean, leaving it on its current branch.`); continue; }
      const res = await r.git.tryRun('checkout', r.originalBranch);
      if (res.ok) this.logger.info(`${r.name}: back on ${r.originalBranch} (ticket work is on local ${this.base}).`);
      else this.logger.warn(`${r.name}: could not switch back to ${r.originalBranch}: ${res.out}`);
    }
  }
}
