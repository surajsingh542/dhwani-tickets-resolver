import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { buildConfig, projectWorkspace, readCookieFile } from './src/config.js';
import { TicketResolver } from './src/resolver.js';
import { REPORT_FILES } from './src/reporter.js';
import { listLocks } from './src/lock.js';
import { HubClient } from './src/hubClient.js';
import { norm } from './src/ticketQueue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let active = null; // { resolver, cfg, promise }

const configFrom = (body = {}, extra = {}) =>
  buildConfig({
    project: body.project,
    repoPath: body.repoPath,
    mainApp: body.mainApp,
    assigneeFilter: body.assignee ? String(body.assignee).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    createdByFilter: body.createdBy ? String(body.createdBy).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    cookie: body.cookie || (body.cookieFile ? readCookieFile(body.cookieFile) : undefined),
    claudeModel: body.model,
    limit: body.limit ? Number(body.limit) : undefined,
    only: body.only ? String(body.only).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    force: body.force ? true : undefined,
    hubWrite: body.hubWrite === false ? false : undefined,
    testCommand: body.testCommand,
    fixPreexisting: body.fixPreexisting === false ? false : undefined,
    progressIntervalMinutes: body.progressIntervalMinutes !== undefined && body.progressIntervalMinutes !== '' ? Number(body.progressIntervalMinutes) : undefined,
    parallel: body.parallel ? true : undefined,
    sessionPerTicket: body.sessionPerTicket === false ? false : undefined,
    maxConcurrent: body.maxConcurrent ? Number(body.maxConcurrent) : undefined,
    types: Array.isArray(body.types) && body.types.length ? body.types : undefined,
    stages: Array.isArray(body.stages) && body.stages.length ? body.stages : undefined,
    priorities: Array.isArray(body.priorities) && body.priorities.length ? body.priorities : undefined,
    owner: 'dashboard',
    ...extra,
  });

// Defaults from .env so the form can be prefilled (never the cookie).
app.get('/api/defaults', (_req, res) => {
  const c = buildConfig();
  res.json({ stages: c.pickStatuses, sessionPerTicket: c.sessionPerTicket, types: [...new Set([...c.typeOrder, 'NONE'])], typesOn: c.typeOrder, priorities: [...new Set([...c.priorities, 'P0', 'P1', 'P2', 'NONE'])], prioritiesOn: c.priorities, parallel: c.parallel, maxConcurrent: c.maxConcurrent, project: c.project, repoPath: c.repoPath, mainApp: c.mainApp, model: c.claudeModel || '', cookieFile: process.env.HUB_COOKIE_FILE || '', baseBranch: c.baseBranch, testCommand: c.testCommand, hasCookie: Boolean(c.cookie) });
});

app.post('/api/inspect', async (req, res) => {
  try {
    res.json(await new TicketResolver(configFrom(req.body)).inspect());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/runs', (req, res) => {
  if (active && active.resolver.status.phase !== 'finished') return res.status(409).json({ error: 'A run is already in progress.' });
  try {
    const cfg = configFrom(req.body, { dryRun: Boolean(req.body.dryRun), onlyPreexisting: Boolean(req.body.onlyPreexisting) });
    const resolver = new TicketResolver(cfg);
    const promise = resolver.run().catch(() => {});
    active = { resolver, cfg, promise };
    res.status(202).json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/runs/current', (_req, res) => {
  if (!active) return res.json({ phase: 'idle' });
  const { resolver, cfg } = active;
  res.json({ ...resolver.status, project: cfg.project, repoPath: cfg.repoPath, dryRun: cfg.dryRun });
});

// The project's real Hub options: stages, priorities and types (the Hub's option lists plus any value actually used on
// the project's tickets, e.g. "DevOps"), with the configured pick values mapped onto them (spelling variants dropped).
let optionsCache = { key: '', at: 0, data: null };
app.post('/api/stages', async (req, res) => {
  try {
    const cfg = configFrom(req.body);
    if (!cfg.cookie) throw new Error('no Hub cookie yet');
    const key = `${cfg.hubBaseUrl}|${cfg.project}|${cfg.cookie.slice(-12)}`;
    if (optionsCache.key !== key || Date.now() - optionsCache.at > 10 * 60000) {
      const hub = new HubClient({ baseUrl: cfg.hubBaseUrl, cookie: cfg.cookie, logger: console });
      await hub.init();
      const val = (x) => (typeof x === 'string' ? x : x?.value || x?.name || x?.label);
      const stages = ((await hub.getPipelineStages()) || []).map(val).filter(Boolean);
      const rows = (await hub.getProjectTasks(cfg.project).catch(() => [])) || [];
      const detail = rows.length ? await hub.getTaskDetail(rows[0].name).catch(() => ({})) : {};
      const used = (field) => rows.map((r) => r[field]).filter((v) => v && String(v).trim());
      const uniq = (list) => { const seen = new Set(); return list.filter((v) => !seen.has(norm(v)) && seen.add(norm(v))); };
      optionsCache = {
        key, at: Date.now(),
        data: {
          stages,
          priorities: uniq([...(detail.priority_options || []).map(val), ...used('custom_priority')].filter(Boolean)),
          types: uniq([...(detail.work_type_options || []).map(val), ...used('custom_work_type')].filter(Boolean)),
        },
      };
    }
    const { stages, priorities, types } = optionsCache.data;
    const wantStage = new Set(cfg.pickStatuses.map(norm));
    // Configured pick order first, then whatever else the Hub has; "NONE" (no priority / no type) last.
    const ordered = (configured, hubList) => {
      const known = configured.filter((c) => c !== 'NONE');
      const extra = hubList.filter((h) => !known.some((k) => norm(k) === norm(h)));
      return [...known.filter((k) => hubList.some((h) => norm(h) === norm(k)) || !hubList.length), ...extra, 'NONE'];
    };
    res.json({
      stages,
      picked: stages.filter((x) => wantStage.has(norm(x))),
      priorities: ordered(cfg.priorities, priorities),
      prioritiesOn: cfg.priorities,
      types: ordered(cfg.typeOrder, types),
      typesOn: cfg.typeOrder,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Runs holding locks right now — including ones started from the terminal.
app.get('/api/locks', (_req, res) => {
  const byPid = {};
  for (const l of listLocks()) (byPid[l.pid] ||= { pid: l.pid, owner: l.owner, startedAt: l.startedAt, paths: [] }).paths.push(l.path);
  res.json(Object.values(byPid).map((r) => ({ ...r, mine: r.pid === process.pid })));
});

app.post('/api/runs/current/stop', (_req, res) => {
  active?.resolver.requestStop();
  res.json({ ok: true });
});

// Server-sent events: the live run log.
app.get('/api/runs/current/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  if (!active) { res.write('data: (no run yet)\n\n'); return; }
  const logger = active.resolver.logger;
  for (const line of logger.history) res.write(`data: ${JSON.stringify(line)}\n\n`);
  const onLine = (line) => res.write(`data: ${JSON.stringify(line)}\n\n`);
  logger.on('line', onLine);
  req.on('close', () => logger.off('line', onLine));
});

app.get('/api/reports/:kind', (req, res) => {
  const file = REPORT_FILES[req.params.kind];
  const project = req.query.project || active?.cfg.project || buildConfig().project;
  if (!file || !project) return res.status(404).json({ error: 'Unknown report or project.' });
  const full = path.join(projectWorkspace(buildConfig({ project })).reports, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Report not generated yet.' });
  res.download(full);
});

const port = Number(process.env.PORT || 3000);
// Localhost only: the server holds a Hub session and drives an agent with full access to the repo.
app.listen(port, '127.0.0.1', () => console.log(`Auto Ticket Resolver dashboard: http://127.0.0.1:${port}`));
