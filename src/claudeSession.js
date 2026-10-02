import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';

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

function resolveClaudeExecutable(explicit) {
  if (explicit) return explicit;
  try { return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim() || undefined; } catch { return undefined; }
}

export function buildSystemAppend({ baseBranch, ticketsRoot, reposDescription }) {
  return `
You are running inside an automated ticket-resolution pipeline for this repository. Tickets arrive one at a time
in this same conversation. Context for each ticket (description, checklist, discussion, attachments, linked
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
- Earlier tickets in this conversation are already merged into ${baseBranch}; treat them as background only.

End every reply with exactly one JSON object between the markers below (nothing after the end marker):
<<<RESULT_JSON
{
  "status": "resolved" | "needs_clarification" | "failed",
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
 * One Claude Code session for the whole run. Each `send()` is a new user turn in the same conversation.
 * Uses the locally installed and logged-in `claude` CLI.
 */
export class ClaudeSession {
  constructor({ cwd, additionalDirectories, model, executable, baseBranch, ticketsRoot, reposDescription, protectedDirs, logger }) {
    this.logger = logger;
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

    this.q = query({
      prompt: this.input,
      options: {
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
        systemPrompt: { type: 'preset', preset: 'claude_code', append: buildSystemAppend({ baseBranch, ticketsRoot, reposDescription }), snapshot: true },
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
                  const { deny = [], allow = [] } = protectedDirs || {};
                  if (!deny.some(inside) || allow.some(inside)) return { continue: true };
                  this.logger.warn(`Blocked edit of read-only repository file: ${file}`);
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
      },
    });

    this.loop = this.consume().catch((e) => {
      this.dead = e;
      if (this.pending) { this.pending.reject(e); this.pending = null; }
    });
  }

  async consume() {
    for await (const msg of this.q) {
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
        this.totalCostUsd = msg.total_cost_usd ?? this.totalCostUsd;
        const p = this.pending;
        this.pending = null;
        if (!p) continue;
        if (msg.subtype === 'success' && !msg.is_error) p.resolve(msg.result || '');
        else p.reject(new Error(`Claude turn ended with ${msg.subtype}: ${(msg.errors || []).join('; ') || msg.result || ''}`));
      }
    }
    throw new Error('Claude session ended unexpectedly.');
  }

  /** Sends one user turn and resolves with the final assistant text of that turn. */
  async send(text, { timeoutMs } = {}) {
    if (this.dead) throw this.dead;
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

  close() {
    this.input.close();
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

/** Pulls the result object out of Claude's reply; tolerant of a mangled end marker or a ```json fence instead. */
export function parseResult(text) {
  const t = String(text);
  const marker = t.lastIndexOf('<<<RESULT_JSON');
  const fence = t.lastIndexOf('```json');
  const from = marker >= 0 ? marker : fence >= 0 ? fence : t.lastIndexOf('"status"') >= 0 ? t.lastIndexOf('{', t.lastIndexOf('"status"')) : -1;
  if (from < 0) return null;
  const raw = firstJsonObject(t.slice(from));
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (!j.status) return null;
    j.status = String(j.status).toLowerCase();
    j.questions = Array.isArray(j.questions) ? j.questions : [];
    j.files_changed = Array.isArray(j.files_changed) ? j.files_changed : [];
    j.tests = j.tests || {};
    j.requirements_check = Array.isArray(j.requirements_check) ? j.requirements_check : [];
    return j;
  } catch {
    return null;
  }
}
