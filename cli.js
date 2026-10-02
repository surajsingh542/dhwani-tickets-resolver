#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { buildConfig, readCookieFile } from './src/config.js';
import { TicketResolver } from './src/resolver.js';

const USAGE = `
Usage:
  node cli.js inspect --project ICIC/P382-02 [--cookie-file cookie.txt]
      Log in, list the distinct priority/type/stage values and the pick order. Changes nothing.

  node cli.js preview --project ICIC/P382-02 [--cookie-file cookie.txt] [--limit N]
      Dry run: build the ticket queue and download every ticket's context. No Claude, git or Hub writes.

  node cli.js run --project ICIC/P382-02 --repo /path/to/repo [--main-app icicif] [--cookie-file cookie.txt]
                  [--limit N] [--only ID1,ID2] [--force] [--no-hub-write] [--test-command "npm test"]
                  [--progress-interval MINUTES]   (progress summary on the terminal; default 5, 0 = off)
                  [--assignee "a@x.com,Full Name,me"] [--created-by "b@x.com"]
      --assignee / --created-by take emails, full names or "me" (comma-separated). Given together a ticket must
      match both; omit them to consider every ticket. They work with inspect and preview too.
      Resolve tickets end to end. --repo may be one repo or a folder (e.g. a Frappe bench) with many repos at any depth;
      --main-app names the primary repo by folder name (e.g. the Frappe app) — other repos become secondary.

  node cli.js fix-failures --project ICIC/P382-02 --repo /path [--main-app icicif] [--cookie-file cookie.txt]
      Only fix the test failures that earlier runs proved pre-existing (each on branch fix/preexisting-<test>).
      \`run\` does this automatically after the tickets unless --no-fix-preexisting is given.

The cookie can also come from HUB_COOKIE / HUB_COOKIE_FILE in .env. Avoid pasting it on the command line.
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: 'string' },
    repo: { type: 'string' },
    'main-app': { type: 'string' },
    assignee: { type: 'string' },
    'created-by': { type: 'string' },
    'cookie-file': { type: 'string' },
    limit: { type: 'string' },
    only: { type: 'string' },
    force: { type: 'boolean' },
    'no-hub-write': { type: 'boolean' },
    'test-command': { type: 'string' },
    model: { type: 'string' },
    'progress-interval': { type: 'string' },
    'no-fix-preexisting': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const command = positionals[0];
if (values.help || !['inspect', 'preview', 'run', 'fix-failures'].includes(command)) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

const cfg = buildConfig({
  project: values.project,
  repoPath: values.repo,
  mainApp: values['main-app'],
  assigneeFilter: values.assignee ? values.assignee.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  createdByFilter: values['created-by'] ? values['created-by'].split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  cookie: values['cookie-file'] ? readCookieFile(values['cookie-file']) : undefined,
  limit: values.limit ? Number(values.limit) : undefined,
  only: values.only ? values.only.split(',').map((s) => s.trim()) : undefined,
  force: values.force,
  hubWrite: values['no-hub-write'] ? false : undefined,
  testCommand: values['test-command'],
  claudeModel: values.model,
  progressIntervalMinutes: values['progress-interval'] !== undefined ? Number(values['progress-interval']) : undefined,
  dryRun: command === 'preview',
  fixPreexisting: values['no-fix-preexisting'] ? false : undefined,
  onlyPreexisting: command === 'fix-failures' ? true : undefined,
});

const resolver = new TicketResolver(cfg);
process.on('SIGINT', () => {
  if (resolver.stopRequested) process.exit(130);
  resolver.requestStop();
  console.log('Press Ctrl+C again to exit immediately.');
});

try {
  if (command === 'inspect') {
    const r = await resolver.inspect();
    console.log(JSON.stringify({ ...r, sampleRow: undefined }, null, 2));
    console.log('\nSample ticket row (field names):', Object.keys(r.sampleRow || {}).join(', '));
  } else {
    await resolver.run();
  }
  process.exit(0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
