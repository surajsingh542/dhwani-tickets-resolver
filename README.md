# Auto Ticket Resolver

Picks tickets from a DhwaniRIS Hub project, gathers each ticket's full context, resolves the tickets one by one
in **a single Claude Code session** running in your local code folder, then pushes each ticket branch, merges it
into your **local** `development` branch, and updates the Hub. Results go into Excel reports.

The repo path can be **one git repository** or **a folder holding several repositories**, found at any depth,
including repos nested inside other repos. For example `backend/` + `frontend/`, or a Frappe bench whose apps
each have their own git (`bench/apps/<app>/.git`). Dependency and runtime folders such as `node_modules`, `env`,
`sites` and `logs` are skipped.

- **Without `--main-app`:** every repo that has a `development` branch is writable. Each repo a ticket changes
  gets its own commit, ticket-branch push and local merge.
- **With `--main-app <folder>`, the Frappe case** (e.g. `--main-app icicif`): only the main app is pulled, branched,
  committed, pushed and merged. The framework and the other apps are read-only context. Claude's edit tools are
  blocked there, and stray edits are reverted in repos that were clean. Repos that already hold your uncommitted
  work are never reset: if one changes during a ticket, the run stops so you can check it.
- When a Frappe bench is found, Claude is told its sites and how to run `bench run-tests`, `migrate` and `build`.
- At the end of a run, each writable repo is switched back to the branch it was on before. The ticket work is on
  the local `development` branch.

## How it works

1. **Queue.** Takes tickets whose Hub stage is **Open / Reopen**, in this order:
   P0 Bug → P0 Enhancement → P0 Change Request → P0 Feature → P0 Task → the same for P1 → then P2.
   Tickets with no priority are never picked. Within one bucket, older tickets go first.
2. **Context.** For each ticket it creates `workspace/<project>/tickets/<ticket-id>/` with:
   - `ticket.md`: title, metadata, description, checklist, full discussion, activity, and a file index
   - `attachments/`: every file attached to the ticket
   - `links/`: embedded images and Hub files, plus any URL in the description, checklist or comments (Google
     Docs/Sheets/Slides/Drive links are fetched through their export URLs when shared publicly; HTML pages also get a `.txt` copy)
   - `detail.json` and `activity.json`: the raw Hub responses
   - `claude_replies.md`: every prompt and reply for the ticket, for auditing
3. **Resolve.** It pulls `origin/development` into the local `development` (fast-forward when possible, otherwise a
   local merge; a conflict or a failed fetch stops the run), then creates branch `<ticket-id>` from `development` in every repo and sends the ticket to the Claude session.
   Claude reads the context (including images and PDFs), implements the change, adds tests and runs them.
   By default, a second turn makes Claude review its own diff against every requirement before anything is committed.
4. **Gate.** You can set `TEST_COMMAND` (for example `npm test`), or per-repo commands in `TEST_COMMANDS`. The
   orchestrator runs it in every changed repo on the ticket branch, and Claude gets `MAX_FIX_ATTEMPTS` tries to fix
   failures. It runs again on `development` after the merge; if it fails there, the merge is undone.
5. **Ship (local).** In each changed repo, the orchestrator commits, then pushes **only the ticket branch** to `origin`
   and merges it into your local `development` with `--no-ff`. It never pushes `development` and never opens a merge
   request. Repos the ticket didn't change go back to `development`, and their empty ticket branch is deleted. Each
   ticket is all-or-nothing: if a push, merge or post-merge test fails in any repo, every merge for that ticket is undone.
6. **Hub.**
   - Resolved tickets move to stage **To Test**.
   - Tickets that are ambiguous or lack context get their questions posted to the ticket's **Discussion** and move
     to stage **Review**. They are skipped, and their working-tree changes are discarded.
7. **Reports** in `workspace/<project>/reports/`. They are rewritten after every ticket, so they stay current even if a run stops early:
   - `resolved_tickets.xlsx`: branch, commit, merge commit, files, summary, root cause, requirements check, tests
   - `clarification_needed_tickets.xlsx`: why the ticket was skipped, the missing context, the questions asked, and whether they were posted
   - `not_resolved_tickets.xlsx`: failures (test failures, merge conflicts, push errors, …) with the reason
   - `preexisting_failures.xlsx`: test failures Claude proved already existed on `development` (see step 8)
8. **Pre-existing failures.** When Claude finds a failing test that also fails *without* its change, it reports it
   separately, so the ticket isn't blocked. After the tickets, each such failure is fixed on its own branch,
   `fix/preexisting-<test>`, created from `development`. It goes through the same pipeline: reproduce it, fix the root
   cause without weakening the test, pre-commit, self-review, test gate, push the branch, merge it into local
   `development`. If the correct behaviour is a product decision, it is recorded with questions instead.
   `--no-fix-preexisting` skips this step; `node cli.js fix-failures …` runs only this step.

`workspace/<project>/state.json` records the outcome of every ticket, so a re-run skips tickets already handled
(`--force` redoes them). Each run writes a log file to `workspace/<project>/logs/`.

## Safety rails

- Every repo must be clean at start, so your own uncommitted work is never mixed in. Repos with no `development`
  branch are listed as read-only and left alone.
- Inside the Claude session, a `PreToolUse` hook blocks `git push/checkout/switch/merge/rebase/reset/commit/stash/…`
  and `gh/glab pr|mr`. Only the orchestrator moves branches. Read-only git (`status`, `diff`, `log`, `show`) is allowed.
- The push function refuses `development`, `main`, `master` and similar protected names, and only pushes `refs/heads/<ticket-branch>`.
- The session cookie is only sent to the Hub's own origin (never to external links), is redacted from logs, and is
  not passed into the Claude session's environment.
- The dashboard binds to `127.0.0.1` only.
- Claude runs with `bypassPermissions` so it can work unattended. Run it only on repos and machines you trust it with.

## Setup

```bash
npm install
cp .env.example .env        # set HUB_PROJECT, REPO_PATH, optionally TEST_COMMAND
# Put the Hub cookie in a file (not on the command line):
#   DevTools → Network → any hub.dhwaniris.com request → Request Headers → Cookie
echo 'sid=xxxxxxxx; system_user=yes; ...' > cookie.txt     # or just the sid value
```

Claude runs through your installed and logged-in `claude` CLI (found with `which claude`, or set `CLAUDE_EXECUTABLE`).
An `ANTHROPIC_API_KEY` in your environment is ignored unless you set `USE_ANTHROPIC_API_KEY=1`.

## Usage

```bash
# 1. Check the Hub's values match the config (priority/type/stage spellings, pick order). Changes nothing.
node cli.js inspect --project ICIC/P382-02 --cookie-file cookie.txt

# 2. Dry run: download every queued ticket's context to workspace/, without Claude, git or Hub writes.
node cli.js preview --project ICIC/P382-02 --cookie-file cookie.txt

# 3. Resolve. Try one ticket first, without touching the Hub:
node cli.js run --project ICIC/P382-02 --repo ~/code/icic --cookie-file cookie.txt --limit 1 --no-hub-write
# --repo can be a single repo or a parent folder such as ~/code/icic containing backend/ and frontend/
# Frappe bench: name the app the tickets belong to
node cli.js run --project ICIC/P382-02 --repo ~/Dhwani/ICICIF --main-app icicif --cookie-file cookie.txt --limit 1 --no-hub-write
# Then the full run:
node cli.js run --project ICIC/P382-02 --repo ~/code/icic --cookie-file cookie.txt --test-command "npm test"
```

Other flags: `--only ID1,ID2`, `--force`, `--model <id>`, `--progress-interval <minutes>`. Press Ctrl+C once to stop after the current ticket, twice to exit immediately.

### Dashboard

```bash
npm start   # http://127.0.0.1:3000
```

The dashboard has a form for the project, repo path and cookie, buttons for inspect / dry run / start / stop,
a live queue with per-ticket outcomes, a streaming log, and links to download the three reports.

## Configuration (.env)

| Variable | Default | Purpose |
|---|---|---|
| `ASSIGNEE` / `CREATED_BY` | empty | Only tickets assigned to / created by these people (`--assignee`, `--created-by`; email, name or `me`; both = AND) |
| `PRIORITIES` | `P0,P1,P2` | Priorities to pick, in order |
| `TYPE_ORDER` | `Bug,Enhancement,Change Request,Feature,Task` | Order of ticket types within a priority |
| `PICK_STATUSES` | `Open,Reopen,Reopened,Re-open,Re-opened` | Hub stages that make a ticket pickable |
| `RESOLVED_STAGE` / `CLARIFICATION_STAGE` | `To Test` / `Review` | Stages to set (matched against the Hub's stage list) |
| `MAIN_APP` | empty | Main repo by folder name (Frappe app); only it is pulled/branched/pushed/merged |
| `BASE_BRANCH`, `GIT_REMOTE`, `BRANCH_PREFIX` | `development`, `origin`, empty | Git layout |
| `TEST_COMMAND` | empty | Hard test gate, run in each changed repo before and after the merge |
| `TEST_COMMANDS` | empty | Per-repo override as JSON, e.g. `{"backend":"pytest","web":"npm test"}` |
| `VERIFY_PASS` | `true` | Claude self-review turn before commit |
| `HUB_WRITE` | `true` | Set `false` to never change the Hub |
| `BENCH_SYNC` | `true` | After each ticket, `bench migrate`/`build` on `development` when it touched schema or front-end files |
| `FIX_PREEXISTING_FAILURES` | `true` | Fix pre-existing test failures after the tickets (`--no-fix-preexisting`) |
| `POST_CLARIFICATION_COMMENT` / `POST_RESOLUTION_COMMENT` | `true` / `false` | Discussion comments |
| `CLAUDE_MODEL` | CLI default | Model for the session |
| `TICKET_TIMEOUT_MINUTES` | `60` | Each Claude turn is interrupted after this long |
| `PROGRESS_INTERVAL_MINUTES` | `5` | Progress summary on the terminal every N minutes (`--progress-interval`, `0` = off) |

## Hub API used

These are the same `dris_helpdesk` methods the Hub web app calls (`/api/method/...`), authenticated with your session
cookie and the CSRF token embedded in `/hub/tasks`:
`task_tracker.get_project_tasks`, `get_task_detail`, `get_task_activity`, `get_pipeline_stages`,
`update_task` (`custom_tracker_status`), `add_task_comment`.
