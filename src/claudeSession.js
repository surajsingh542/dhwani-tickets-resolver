import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';

/** Claude refused the turn because the account's session/usage limit is reached — not the ticket's fault. */
export class UsageLimitError extends Error {
  constructor(text) {
    super(`Claude usage limit reached: ${text}`);
    this.usageLimit = true;
    this.resetsAt = parseResetTime(text);
  }
}

/** The Claude Code process died (crash / signal / unexpected exit) — the session must be restarted. */
export const isSessionCrash = (e) =>
  /terminated by signal|SIGSEGV|SIGABRT|SIGKILL|Segmentation fault|has crashed|process exited|exited with code|session ended unexpectedly|ProcessTransport|write after end|EPIPE/i.test(String(e?.message || e));

export const isUsageLimit = (text) => /hit your (session|usage|weekly|daily)? ?limit|usage limit (reached|exceeded)|limit reached.*resets|resets .*\d(am|pm)/i.test(String(text));

/**
 * "…resets 2:20pm (Asia/Kolkata)" / "resets at 14:00" / "resets in 3h 20m" → Date (next occurrence), or null.
 * Clock times are taken in this machine's time zone (the CLI reports the user's local zone).
 */
export function parseResetTime(text, now = new Date()) {
  const s = String(text);
  const rel = s.match(/resets? in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i);
  if (rel && (rel[1] || rel[2])) return new Date(now.getTime() + ((+rel[1] || 0) * 60 + (+rel[2] || 0)) * 60000);
  const m = s.match(/resets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let h = +m[1];
  const min = +(m[2] || 0);
  if (m[3]) h = (h % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0);
  if (h > 23 || min > 59) return null;
  const t = new Date(now);
  t.setHours(h, min, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t;
}

/** Push-driven async iterable: the single streaming-input prompt that keeps one session alive for the whole run. */
class InputQueue {
  constructor() { this.items = []; this.waiters = []; this.closed = false; }
  push(item) {
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

// Git and forge commands the orchestrator owns. Read-only git (status, diff, log, show, blame) stays allowed.
const FORBIDDEN_BASH = [
  /\bgit\b(?:\s+-\S+(?:\s+\S+)?)*\s+(push|checkout|switch|merge|rebase|reset|commit|cherry-pick|revert|stash|tag|branch\s+-[dDmMfc]|remote\s+(add|set-url|remove)|worktree|restore\s+--staged|clean)\b/,
  /\b(gh|glab)\s+(pr|mr)\b/,
];

// Bench commands that run code from the bench working copy or change the shared site/database/assets.
const BENCH_STATEFUL = /\bbench\b[^|;&]*\b(run-tests|run-ui-tests|run-parallel-tests|migrate|build|install-app|uninstall-app|reinstall|restore|update|execute|console|drop-site|new-site|set-config|clear-cache|clear-website-cache|import-doc|export-fixtures)\b/;

function resolveClaudeExecutable(explicit) {
  if (explicit) return explicit;
  try { return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim() || undefined; } catch { return undefined; }
}

export function buildSystemAppend({ baseBranch, ticketsRoot, reposDescription, perTicket = false }) {
  return `
You are running inside an automated ticket-resolution pipeline for this repository. ${perTicket ? 'This conversation\nis about one ticket (plus any follow-up turns for it).' : 'Tickets arrive one at a time\nin this same conversation.'} Context for each ticket (description, checklist, discussion, attachments, linked
resources) has been downloaded to a folder under ${ticketsRoot}; read it — including images, PDFs and spreadsheets —
before deciding anything.

Your working directory contains these git repositories (a ticket may need changes in one or several of them):
${reposDescription || '  - (the working directory itself)'}

Searching: scope Grep/Glob/find to the repository you are working in (pass its path), not to the top-level folder.
Never search or read inside dependency or runtime folders — node_modules, env/venv/.venv (or any folder containing
pyvenv.cfg), site-packages, __pycache__, dist/build, a Frappe bench's sites/ and logs/ — unless the ticket is
specifically about a dependency. They are huge and are not part of this project's code.

Rules for every ticket:
- The orchestrator has already checked out the ticket's branch (created from "${baseBranch}") in every repository. Do NOT run git
  checkout/switch/commit/push/merge/rebase/reset/stash or create PRs/MRs — the orchestrator commits, pushes the ticket
  branch and merges it locally. Read-only git (status, diff, log, show, blame) is fine.
- Only change what the ticket needs. Follow the repository's conventions and its CLAUDE.md, if any.
- Run every command in the foreground and wait for it — do not start background jobs, monitors or wake-ups, and never
  finish your reply while anything is still running. Your reply is taken as final the moment you stop; the work is
  committed straight after. Test commands may take up to 30 minutes each.
- Verify the fix for real: run the relevant existing tests, add or update tests that cover the change, and run the
  build/lint if the project has one. Reproduce bugs before fixing when feasible. Do not claim tests passed unless you ran them.
- "tests.passed" is about your change: true when everything your change touches passes. A failure that you proved
  also happens without your change goes in "preexisting_failures" instead of making "passed" false.
- If a repository you changed has a .pre-commit-config.yaml, run \`pre-commit run --files <the files you changed>\` in it
  before finishing and fix anything it reports (formatters rewriting files is fine — keep their changes).
- Do not open personal files outside the repositories and the ticket folders (e.g. ~/Documents, ~/Downloads, other
  projects). When you need sample data (images, documents, records), generate synthetic samples, use the ticket's
  attachments, or use fixtures in the repository. Never copy real personal data (account numbers, IDs, names) into code,
  tests, commit messages or notes.
- Changing read-only repositories is never acceptable, even indirectly; if a command such as \`bench migrate\` rewrites
  files in them, the orchestrator restores them after the ticket — that is expected, do not try to work around it.
- Remove scratch files you created. Never write secrets or the ticket folder into the repository.
- If the ticket is ambiguous, contradictory, missing information you cannot infer from the repo and the ticket
  context (e.g. unclear expected behaviour, missing designs or credentials, inaccessible linked documents that are
  essential), do not guess: make no code changes and report status "needs_clarification" with specific questions.
  Never invent requirements, scope or acceptance criteria the ticket does not state or clearly imply.
- If what the ticket asks for is already the behaviour (for example already fixed, or the latest discussion says the
  current behaviour is intended), make no changes and report "no_change_needed"; put what you checked and why in the
  summary — it is posted to the ticket for a person to confirm.
${perTicket ? `- Other tickets may already be merged into ${baseBranch}; treat them as background only.` : `- Earlier tickets in this conversation are already merged into ${baseBranch}; treat them as background only.`}

End every reply with exactly one JSON object between the markers below (nothing after the end marker):
<<<RESULT_JSON
{
  "status": "resolved" | "needs_clarification" | "no_change_needed" | "failed",
  "summary": "what was wrong and what you changed, 2-5 sentences",
  "root_cause": "for bugs; otherwise empty",
  "repos_changed": ["repository folder name", "..."],
  "files_changed": ["repo/path", "..."],
  "tests": { "commands": ["..."], "passed": true | false, "details": "what was run and the outcome",
             "preexisting_failures": ["test that also fails WITHOUT your change (you verified this)", "..."] },
  "requirements_check": [ { "requirement": "checklist item / acceptance point", "met": true | false, "evidence": "..." } ],
  "questions": ["specific question for the ticket owner", "..."],
  "missing_context": "what information is missing or inaccessible (needs_clarification only)",
  "notes": "risks, follow-ups, assumptions"
}
RESULT_JSON>>>
`.trim();
}

/**
 * A Claude Code session. Each `send()` is a new user turn in the same conversation; `fresh()` starts a new
 * conversation (one per ticket by default, so tickets do not carry each other's context).
 * Uses the locally installed and logged-in `claude` CLI.
 */
export class ClaudeSession {
  constructor({ cwd, additionalDirectories, model, executable, baseBranch, ticketsRoot, reposDescription, protectedDirs, logger, label, perTicket = false }) {
    // A label ("W2") prefixes this session's log lines when several sessions run at once.
    const tag = label ? `[${label}] ` : '';
    this.logger = label
      ? { info: (m) => logger.info(tag + m), warn: (m) => logger.warn(tag + m), error: (m) => logger.error(tag + m), claude: (m) => logger.claude(tag + m) }
      : logger;
    // What this session may edit / run right now. Parallel mode switches it between "develop in my worktree" and
    // "verify in the bench working copy" (see setMode).
    this.mode = { deny: protectedDirs?.deny || [], allow: protectedDirs?.allow || [], blockBench: false, why: '' };
    this.input = new InputQueue();
    this.pending = null;
    this.sessionId = null;
    this.totalCostUsd = 0;
    this.dead = null;

    const env = {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'auto-ticket-resolver/1.0.0',
      // Frappe test suites routinely exceed the default 2/10-minute Bash limits.
      BASH_DEFAULT_TIMEOUT_MS: process.env.BASH_DEFAULT_TIMEOUT_MS || String(30 * 60000),
      BASH_MAX_TIMEOUT_MS: process.env.BASH_MAX_TIMEOUT_MS || String(30 * 60000),
    };
    // Use the CLI's own login rather than a stray API key in the environment.
    if (!process.env.USE_ANTHROPIC_API_KEY) delete env.ANTHROPIC_API_KEY;
    delete env.HUB_COOKIE;

    this.options = {
        cwd,
        additionalDirectories,
        model,
        pathToClaudeCodeExecutable: resolveClaudeExecutable(executable),
        env,
        // Background/scheduling tools would let a turn end before its work does.
        disallowedTools: ['Monitor', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'RemoteTrigger', 'PushNotification'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: buildSystemAppend({ baseBranch, ticketsRoot, reposDescription, perTicket }), snapshot: true },
        title: 'auto-ticket-resolver',
        hooks: {
          PreToolUse: [
            {
              // File-editing tools may not touch read-only repositories (framework / other apps).
              matcher: 'Edit|Write|MultiEdit|NotebookEdit',
              hooks: [
                async (input) => {
                  const file = path.resolve(String(input.tool_input?.file_path || input.tool_input?.notebook_path || ''));
                  const inside = (dir) => file === dir || file.startsWith(dir + path.sep);
                  const { deny = [], allow = [], why } = this.mode;
                  if (!deny.some(inside) || allow.some(inside)) return { continue: true };
                  this.logger.warn(`Blocked edit outside the allowed folders: ${file}`);
                  if (why) {
                    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } };
                  }
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'deny',
                      permissionDecisionReason: 'This file belongs to a read-only repository. Change only the writable repositories listed in your instructions; if the fix needs this repository, report "failed" and say why.',
                    },
                  };
                },
              ],
            },
            {
              matcher: 'Bash',
              hooks: [
                async (input) => {
                  const cmd = String(input.tool_input?.command || '');
                  if (this.mode.blockBench && BENCH_STATEFUL.test(cmd)) {
                    this.logger.warn(`Blocked bench command during parallel development: ${cmd.slice(0, 160)}`);
                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason:
                          'The bench runs the bench working copy, not your worktree, and is shared with other tickets running in parallel. ' +
                          'Bench tests/migrate/build run in the verification step, when your change is moved into the bench. For now, use checks that work on the worktree itself.',
                      },
                    };
                  }
                  if (input.tool_input?.run_in_background) {
                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason: 'Background commands are disabled in this pipeline. Run it in the foreground (timeout up to 1800000 ms) and wait for it.',
                      },
                    };
                  }
                  const hit = FORBIDDEN_BASH.find((re) => re.test(cmd));
                  if (!hit) return { continue: true };
                  this.logger.warn(`Blocked command in Claude session: ${cmd}`);
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'deny',
                      permissionDecisionReason:
                        'Branching, committing, pushing and merging are handled by the orchestrator. Leave changes uncommitted in the working tree.',
                    },
                  };
                },
              ],
            },
          ],
        },
        stderr: (d) => { if (/error/i.test(d)) this.logger.warn(`claude stderr: ${d.trim().slice(0, 500)}`); },
      };
    this.restarts = 0;
    this.start();
  }

  /** Starts (or, after a crash, restarts) the Claude Code process behind this session. A restart is a new conversation. */
  start() {
    // Each process gets its own generation: a process that is shutting down can never touch its successor's state.
    const gen = (this.gen || 0) + 1;
    this.gen = gen;
    this.input = new InputQueue();
    this.pending = null;
    this.dead = null;
    this.sessionId = null;
    this.used = false;
    this.running = true;
    this.costBefore = (this.costBefore || 0) + (this.sessionCost || 0);
    this.sessionCost = 0;
    const q = query({ prompt: this.input, options: this.options });
    this.q = q;
    this.loop = this.consume(q, gen).catch((e) => {
      if (gen !== this.gen) return; // an old, deliberately closed process
      this.dead = e;
      if (this.pending) { this.pending.reject(e); this.pending = null; }
    });
  }

  /** Ends this conversation and its Claude Code process now. The next send() starts a fresh one. */
  end() {
    if (!this.running) return;
    this.gen = (this.gen || 0) + 1; // detach the old process before closing it
    this.running = false;
    this.input?.close();
    try { this.q?.close(); } catch { /* already gone */ }
    this.q = null;
    if (this.sessionId) this.logger.info(`Claude session closed: ${this.sessionId}`);
    this.costBefore = (this.costBefore || 0) + (this.sessionCost || 0);
    this.sessionCost = 0;
    this.sessionId = null;
  }

  /** Starts a new, empty conversation (new Claude Code process) if the current one has been used. */
  fresh() {
    if (this.running && !this.used && !this.dead) return;
    this.end();
    this.start();
  }

  /** Replaces a crashed Claude Code process with a fresh one. */
  restart() {
    this.end();
    this.restarts++;
    this.logger.warn(`Restarting the Claude session (restart #${this.restarts}) after: ${String(this.dead?.message || 'crash').split('\n')[0].slice(0, 160)}`);
    this.start();
  }

  async consume(q, gen) {
    for await (const msg of q) {
      if (gen !== this.gen) return; // superseded: ignore anything the old process still says
      if (msg.session_id && !this.sessionId) {
        this.sessionId = msg.session_id;
        this.logger.info(`Claude session started: ${this.sessionId}`);
      }
      if (msg.type === 'assistant') {
        for (const block of msg.message?.content || []) {
          if (block.type === 'text' && block.text.trim()) this.logger.claude(block.text.trim().slice(0, 1500));
          else if (block.type === 'tool_use') this.logger.claude(`→ ${block.name} ${summarizeToolInput(block.input)}`);
        }
      } else if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
        this.logger.info('Claude session context was compacted.');
      } else if (msg.type === 'result') {
        this.sessionCost = msg.total_cost_usd ?? this.sessionCost;
        this.totalCostUsd = this.costBefore + this.sessionCost;
        const p = this.pending;
        this.pending = null;
        if (!p) continue;
        if (msg.subtype === 'success' && !msg.is_error) p.resolve(msg.result || '');
        else {
          const text = `${(msg.errors || []).join('; ')} ${msg.result || ''}`.trim();
          p.reject(isUsageLimit(text) ? new UsageLimitError(text) : new Error(`Claude turn ended with ${msg.subtype}: ${text}`));
        }
      }
    }
    throw new Error('Claude session ended unexpectedly.');
  }

  /** Sends one user turn and resolves with the final assistant text of that turn. */
  async send(text, { timeoutMs } = {}) {
    if (!this.running) this.start();
    if (this.dead) throw this.dead;
    this.used = true;
    if (this.pending?.drain) {
      // A timed-out turn was interrupted; wait for its result so it is not mistaken for this turn's.
      await Promise.race([this.pending.drained, new Promise((r) => setTimeout(r, 120000))]);
      this.pending = null;
    }
    if (this.pending) throw new Error('A Claude turn is already in progress.');
    const done = new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
    this.input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
    if (!timeoutMs) return done;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(async () => {
        this.logger.warn('Claude turn timed out — interrupting.');
        try { await this.q.interrupt(); } catch { /* ignore */ }
        reject(new Error(`Claude turn exceeded ${Math.round(timeoutMs / 60000)} minutes`));
      }, timeoutMs);
    });
    try { return await Promise.race([done, timeout]); }
    finally {
      clearTimeout(timer);
      // An interrupted turn still emits a result; let it drain without a waiter.
      if (this.pending && !this.pending.drain) {
        let release;
        const drained = new Promise((r) => { release = r; });
        this.pending = { drain: true, drained, resolve: release, reject: release };
      }
    }
  }

  /** Changes what this session may edit and run from its next tool call on. */
  setMode(mode) {
    this.mode = { deny: [], allow: [], blockBench: false, why: '', ...mode };
  }

  close() {
    this.gen = (this.gen || 0) + 1;
    this.running = false;
    this.input?.close();
    try { this.q.close(); } catch { /* ignore */ }
  }
}

function summarizeToolInput(input) {
  if (!input) return '';
  if (input.command) return String(input.command).slice(0, 200);
  if (input.file_path) return input.file_path;
  if (input.pattern) return `pattern=${input.pattern}`;
  return JSON.stringify(input).slice(0, 200);
}

/** First balanced {...} object in `text`, honouring JSON strings and escapes. */
function firstJsonObject(text) {
  const begin = text.indexOf('{');
  if (begin < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = begin; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(begin, i + 1);
  }
  return null;
}

/**
 * Pulls the result object out of Claude's reply. Tolerant of a mangled end marker (models sometimes close the block
 * with another "<<<RESULT_JSON>>>"), a ```json fence instead, or no markers at all: every candidate start is tried,
 * last first, and the first one followed by a valid result object wins.
 */
export function parseResult(text) {
  const t = String(text);
  const starts = [];
  for (const re of [/<<<RESULT_JSON/g, /```json/g]) for (const m of t.matchAll(re)) starts.push(m.index);
  for (const m of t.matchAll(/"status"\s*:/g)) { const brace = t.lastIndexOf('{', m.index); if (brace >= 0) starts.push(brace); }
  for (const from of [...new Set(starts)].sort((a, b) => b - a)) {
    const raw = firstJsonObject(t.slice(from));
    if (!raw) continue;
    try {
      const j = JSON.parse(raw);
      if (!j || typeof j !== 'object' || !j.status) continue;
      j.status = String(j.status).toLowerCase();
      j.questions = Array.isArray(j.questions) ? j.questions : [];
      j.files_changed = Array.isArray(j.files_changed) ? j.files_changed : [];
      j.tests = j.tests || {};
      j.requirements_check = Array.isArray(j.requirements_check) ? j.requirements_check : [];
      return j;
    } catch { /* try the next candidate */ }
  }
  return null;
}
