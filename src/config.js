import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const list = (v, fallback) =>
  (v ?? fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const bool = (v, fallback) => {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

const int = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Accepts either a full Cookie header ("sid=...; system_user=yes; ...") or a bare sid value.
 */
export function normalizeCookie(raw) {
  if (!raw) return '';
  const c = String(raw).trim().replace(/^cookie:\s*/i, '');
  return c.includes('=') ? c : `sid=${c}`;
}

export function readCookieFile(file) {
  return normalizeCookie(fs.readFileSync(path.resolve(file), 'utf8'));
}

/** Builds the run configuration from .env, overridden by explicit values (CLI flags / API body). */
export function buildConfig(overrides = {}) {
  const env = process.env;
  const cfg = {
    hubBaseUrl: (env.HUB_BASE_URL || 'https://hub.dhwaniris.com').replace(/\/+$/, ''),
    cookie: normalizeCookie(env.HUB_COOKIE || (env.HUB_COOKIE_FILE ? fs.readFileSync(env.HUB_COOKIE_FILE, 'utf8') : '')),
    project: env.HUB_PROJECT || '',
    repoPath: env.REPO_PATH || '',
    // Main repo of the project, e.g. the Frappe app folder name ("icicif"); others are secondary.
    mainApp: env.MAIN_APP || '',
    baseBranch: env.BASE_BRANCH || 'development',
    gitRemote: env.GIT_REMOTE || 'origin',
    branchPrefix: env.BRANCH_PREFIX || '',
    workspaceDir: path.resolve(env.WORKSPACE_DIR || './workspace'),

    // Optional people filters (email, full name or "me"; comma-separated). Both given = ticket must match both.
    assigneeFilter: list(env.ASSIGNEE, ''),
    createdByFilter: list(env.CREATED_BY, ''),
    priorities: list(env.PRIORITIES, 'P0,P1,P2').map((p) => (/^(none|no[ _-]?priority)$/i.test(p) ? 'NONE' : p.toUpperCase())),
    typeOrder: list(env.TYPE_ORDER, 'Bug,Enhancement,Change Request,Feature,Task').map((t) => (/^(none|no[ _-]?type)$/i.test(t) ? 'NONE' : t)),
    pickStatuses: list(env.PICK_STATUSES, 'Open,Reopen,Reopened,Re-open,Re-opened'),
    resolvedStage: env.RESOLVED_STAGE || 'To Test',
    clarificationStage: env.CLARIFICATION_STAGE || 'Review',

    hubWrite: bool(env.HUB_WRITE, true),
    postClarificationComment: bool(env.POST_CLARIFICATION_COMMENT, true),
    postResolutionComment: bool(env.POST_RESOLUTION_COMMENT, false),
    // After the tickets, fix test failures Claude proved pre-existing (each on its own branch).
    fixPreexisting: bool(env.FIX_PREEXISTING_FAILURES, true),
    // After each item, re-run bench migrate/build on the base branch when the item touched schema or front-end files.
    benchSync: bool(env.BENCH_SYNC, true),
    onlyPreexisting: false,

    claudeModel: env.CLAUDE_MODEL || undefined,
    claudeExecutable: env.CLAUDE_EXECUTABLE || undefined,
    verifyPass: bool(env.VERIFY_PASS, true),
    testCommand: env.TEST_COMMAND || '',
    // Per-repo overrides, keyed by the repo folder name relative to REPO_PATH, e.g. {"backend":"pytest","web":"npm test"}
    testCommands: env.TEST_COMMANDS ? JSON.parse(env.TEST_COMMANDS) : {},
    testTimeoutMinutes: int(env.TEST_TIMEOUT_MINUTES, 20),
    maxFixAttempts: int(env.MAX_FIX_ATTEMPTS, 1),
    ticketTimeoutMinutes: int(env.TICKET_TIMEOUT_MINUTES, 60),
    // Develop several tickets at once in separate git worktrees; bench verification and merges stay one at a time.
    parallel: bool(env.PARALLEL, false),
    // A new Claude conversation for every ticket (tickets are independent; saves tokens). false = one for the whole run.
    sessionPerTicket: bool(env.SESSION_PER_TICKET, true),
    maxConcurrent: int(env.MAX_CONCURRENT, 3),
    // Parallel mode: time box for Claude's bench-verification turn in the merge queue (everyone else waits on it).
    laneVerifyMinutes: int(env.LANE_VERIFY_MINUTES, 30),
    // When Claude's usage limit is hit: pause until the reported reset time, then continue (false = stop the run).
    waitOnUsageLimit: bool(env.WAIT_ON_USAGE_LIMIT, true),
    progressIntervalMinutes: int(env.PROGRESS_INTERVAL_MINUTES, 5),

    maxDownloadMb: int(env.MAX_DOWNLOAD_MB, 25),
    fetchExternalLinks: bool(env.FETCH_EXTERNAL_LINKS, true),

    owner: 'cli',
    dryRun: false,
    limit: 0,
    only: [],
    force: false,
  };

  // --types / --priorities narrow the configured lists but keep their pick order (Bug before Enhancement, P0 before P1).
  const { types, priorities, stages, ...rest } = overrides;
  // --stages replaces the pickable stages for this run (e.g. Open,Reopened,Planned).
  if (stages?.length) cfg.pickStatuses = stages.map((x) => x.trim()).filter(Boolean);
  overrides = rest;
  if (types?.length) {
    // "none" / "no type" = tickets without a type; they come after the listed types.
    const wanted = types.map((t) => (/^(none|no[ _-]?type|untyped|blank|empty)$/i.test(t.trim()) ? 'NONE' : t));
    cfg.typeOrder = selectSubset([...cfg.typeOrder.filter((t) => t !== 'NONE'), 'NONE'], wanted);
  }
  if (priorities?.length) {
    // "none" / "no priority" = tickets without a priority; unless placed explicitly they come after the others.
    const wanted = priorities.map((p) => (/^(none|no[ _-]?priority|unprioriti[sz]ed|blank|empty)$/i.test(p.trim()) ? 'NONE' : p.toUpperCase()));
    cfg.priorities = selectSubset([...cfg.priorities.filter((p) => p !== 'NONE'), 'NONE'], wanted);
  }

  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined && v !== null && v !== '') cfg[k] = v;
  }
  if (overrides.cookie) cfg.cookie = normalizeCookie(overrides.cookie);
  if (cfg.repoPath) cfg.repoPath = path.resolve(cfg.repoPath);
  cfg.workspaceDir = path.resolve(cfg.workspaceDir);
  return cfg;
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '');

/** The entries of `ordered` named in `wanted` (case/plural-insensitive), in `ordered`'s order; unknown ones appended. */
export function selectSubset(ordered, wanted) {
  const want = new Map(wanted.map((w) => [norm(w), w.trim()]));
  const picked = ordered.filter((o) => want.delete(norm(o)));
  return [...picked, ...want.values()];
}

export function validateConfig(cfg, { needRepo = true } = {}) {
  const errors = [];
  if (!cfg.cookie) errors.push('Hub session cookie is missing (HUB_COOKIE, HUB_COOKIE_FILE, --cookie-file or the dashboard field).');
  if (!cfg.project) errors.push('Project is missing (e.g. ICIC/P382-02).');
  if (needRepo) {
    if (!cfg.repoPath) errors.push('Local repository path is missing.');
    else if (!fs.existsSync(cfg.repoPath) || !fs.statSync(cfg.repoPath).isDirectory()) errors.push(`${cfg.repoPath} does not exist or is not a folder.`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
}

/** Project-scoped workspace so several projects can be run side by side. */
export function projectWorkspace(cfg) {
  const slug = cfg.project.replace(/[^A-Za-z0-9._-]+/g, '_');
  const root = path.join(cfg.workspaceDir, slug);
  return {
    root,
    tickets: path.join(root, 'tickets'),
    preexisting: path.join(root, 'preexisting-failures'),
    reports: path.join(root, 'reports'),
    logs: path.join(root, 'logs'),
    stateFile: path.join(root, 'state.json'),
  };
}
