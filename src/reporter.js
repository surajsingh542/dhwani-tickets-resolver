import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';

/** Per-project record of every ticket outcome; survives restarts and feeds the reports. */
export class StateStore {
  constructor(file) {
    this.file = file;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { tickets: {} };
  }
  get(id) { return this.data.tickets[id]; }
  set(id, record) {
    this.data.tickets[id] = { ...record, updatedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
  all() { return Object.values(this.data.tickets); }
}

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF9A1F40' } };

async function writeSheet(file, sheetName, columns, rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'auto-ticket-resolver';
  const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 18 }));
  for (const r of rows) ws.addRow(r);
  ws.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  ws.eachRow((row, i) => { if (i > 1) row.alignment = { vertical: 'top', wrapText: true }; });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  await wb.xlsx.writeFile(file);
}

const perRepo = (r, fn) => (r.repos || []).map(fn).join('\n');
const numbered = (arr) => (arr || []).map((q, i) => `${i + 1}. ${q}`).join('\n');
const tests = (t) => [...(t?.commands || [])].join('\n');
const reqs = (r) => (r || []).map((x) => `${x.met ? '✔' : '✘'} ${x.requirement}${x.evidence ? ` — ${x.evidence}` : ''}`).join('\n');

export const REPORT_FILES = {
  preexisting: 'preexisting_failures.xlsx',
  resolved: 'resolved_tickets.xlsx',
  clarification: 'clarification_needed_tickets.xlsx',
  notResolved: 'not_resolved_tickets.xlsx',
};

/** Rewrites all three workbooks from state, so they are always current even if the run stops midway. */
export async function writeReports(state, reportsDir, cfg) {
  fs.mkdirSync(reportsDir, { recursive: true });
  const everything = state.all().sort((a, b) => String(a.processedAt).localeCompare(String(b.processedAt)));
  const all = everything.filter((r) => r.kind !== 'preexisting');
  const pre = everything.filter((r) => r.kind === 'preexisting');
  const base = (r) => ({
    id: r.id, title: r.subject, type: r.type, priority: r.priority, stageBefore: r.stageBefore,
    folder: r.ticketDir, processedAt: r.processedAt,
  });

  await writeSheet(
    path.join(reportsDir, REPORT_FILES.resolved),
    'Resolved',
    [
      { header: 'Ticket ID', key: 'id', width: 20 }, { header: 'Title', key: 'title', width: 45 },
      { header: 'Type', key: 'type', width: 16 }, { header: 'Priority', key: 'priority', width: 10 },
      { header: 'Stage before', key: 'stageBefore', width: 14 }, { header: 'Hub stage now', key: 'stageAfter', width: 14 },
      { header: 'Ticket branch (pushed)', key: 'branch', width: 24 }, { header: 'Repositories', key: 'repos', width: 22 },
      { header: 'Commit', key: 'commit', width: 24 }, { header: `Merged into ${cfg.baseBranch} (local)`, key: 'merge', width: 24 },
      { header: 'Files changed', key: 'files', width: 40 }, { header: 'Summary', key: 'summary', width: 60 },
      { header: 'Root cause', key: 'rootCause', width: 40 }, { header: 'Requirements check', key: 'reqs', width: 60 },
      { header: 'Tests run', key: 'tests', width: 40 }, { header: 'Test result', key: 'testResult', width: 40 },
      { header: 'Self-review', key: 'verified', width: 12 }, { header: 'Hub update', key: 'hub', width: 30 },
      { header: 'Merge conflicts resolved', key: 'conflicts', width: 30 }, { header: 'Notes', key: 'notes', width: 40 }, { header: 'Ticket folder', key: 'folder', width: 40 },
      { header: 'Processed at', key: 'processedAt', width: 22 },
    ],
    all.filter((r) => r.outcome === 'resolved').map((r) => ({
      ...base(r), stageAfter: r.stageAfter, branch: r.branch, repos: perRepo(r, (x) => x.name),
      commit: perRepo(r, (x) => `${x.name}: ${x.commit?.slice(0, 10)}`), merge: perRepo(r, (x) => `${x.name}: ${x.mergeCommit?.slice(0, 10) || '—'}`),
      files: perRepo(r, (x) => x.files.map((f) => `${x.name}/${f}`).join('\n')), summary: r.result?.summary,
      rootCause: r.result?.root_cause, reqs: reqs(r.result?.requirements_check), tests: tests(r.result?.tests),
      testResult: [
        r.result?.tests?.details,
        r.testCommandResult,
        r.result?.tests?.preexisting_failures?.length ? `Pre-existing failures (also fail without this change): ${r.result.tests.preexisting_failures.join('; ')}` : '',
      ].filter(Boolean).join('\n'),
      verified: r.verified === undefined ? 'skipped' : r.verified ? 'yes' : 'no', hub: r.hubUpdate, notes: r.result?.notes,
      conflicts: (r.resolvedConflicts || []).join('\n'),
      notes: [r.result?.notes, ...(r.warnings || []).map((w) => `⚠ ${w}`)].filter(Boolean).join('\n'),
    })),
  );

  await writeSheet(
    path.join(reportsDir, REPORT_FILES.clarification),
    'Clarification needed',
    [
      { header: 'Ticket ID', key: 'id', width: 20 }, { header: 'Title', key: 'title', width: 45 },
      { header: 'Type', key: 'type', width: 16 }, { header: 'Priority', key: 'priority', width: 10 },
      { header: 'Stage before', key: 'stageBefore', width: 14 }, { header: 'Hub stage now', key: 'stageAfter', width: 14 },
      { header: 'Why it was skipped', key: 'why', width: 50 }, { header: 'Missing context', key: 'missing', width: 50 },
      { header: 'Questions raised', key: 'questions', width: 70 }, { header: 'Posted to discussion', key: 'posted', width: 14 },
      { header: 'Hub update', key: 'hub', width: 30 }, { header: 'Downloaded context', key: 'folder', width: 40 },
      { header: 'Processed at', key: 'processedAt', width: 22 },
    ],
    all.filter((r) => r.outcome === 'needs_clarification' || r.outcome === 'no_change_needed').map((r) => ({
      ...base(r), stageAfter: r.stageAfter, why: `${r.outcome === 'no_change_needed' ? 'No change needed — ' : ''}${r.result?.summary || ''}`, missing: r.result?.missing_context,
      questions: numbered(r.result?.questions), posted: r.commentPosted ? 'yes' : 'no', hub: r.hubUpdate,
    })),
  );

  await writeSheet(
    path.join(reportsDir, REPORT_FILES.notResolved),
    'Not resolved',
    [
      { header: 'Ticket ID', key: 'id', width: 20 }, { header: 'Title', key: 'title', width: 45 },
      { header: 'Type', key: 'type', width: 16 }, { header: 'Priority', key: 'priority', width: 10 },
      { header: 'Stage', key: 'stageBefore', width: 14 }, { header: 'Reason', key: 'reason', width: 70 },
      { header: 'Claude summary', key: 'summary', width: 60 }, { header: 'Branch', key: 'branch', width: 24 },
      { header: 'Ticket folder', key: 'folder', width: 40 }, { header: 'Processed at', key: 'processedAt', width: 22 },
    ],
    all.filter((r) => r.outcome === 'failed' || r.outcome === 'interrupted').map((r) => ({
      ...base(r), reason: [r.error, ...(r.warnings || []).map((w) => `⚠ ${w}`)].filter(Boolean).join('\n'), summary: r.result?.summary,
      branch: r.branchKept ? `${r.branch} (kept in ${(r.repos || []).map((x) => x.name).join(', ') || 'repo'})` : '',
    })),
  );

  await writeSheet(
    path.join(reportsDir, REPORT_FILES.preexisting),
    'Pre-existing failures',
    [
      { header: 'Failure', key: 'failure', width: 60 }, { header: 'Reported while working on', key: 'tickets', width: 24 },
      { header: 'Outcome', key: 'outcome', width: 18 }, { header: 'Branch (pushed)', key: 'branch', width: 34 },
      { header: 'Commit', key: 'commit', width: 24 }, { header: `Merged into ${cfg.baseBranch} (local)`, key: 'merge', width: 24 },
      { header: 'Root cause', key: 'rootCause', width: 50 }, { header: 'What was changed', key: 'summary', width: 60 },
      { header: 'Files changed', key: 'files', width: 40 }, { header: 'Tests', key: 'tests', width: 40 },
      { header: 'Questions (if unclear)', key: 'questions', width: 50 }, { header: 'Reason (if not fixed)', key: 'error', width: 50 },
      { header: 'Folder', key: 'folder', width: 40 }, { header: 'Processed at', key: 'processedAt', width: 22 },
    ],
    pre.map((r) => ({
      failure: r.failure, tickets: (r.reportedBy || []).join(', '),
      outcome: { resolved: 'fixed', needs_clarification: 'needs clarification', no_change_needed: 'no change needed', failed: 'not fixed', interrupted: 'interrupted (retried next run)' }[r.outcome] || r.outcome,
      branch: r.outcome === 'resolved' || r.branchKept ? r.branch : '',
      commit: perRepo(r, (x) => `${x.name}: ${x.commit?.slice(0, 10)}`), merge: perRepo(r, (x) => `${x.name}: ${x.mergeCommit?.slice(0, 10) || '—'}`),
      rootCause: r.result?.root_cause, summary: r.result?.summary, files: perRepo(r, (x) => x.files.map((f) => `${x.name}/${f}`).join('\n')),
      tests: [tests(r.result?.tests), r.result?.tests?.details].filter(Boolean).join('\n'), questions: numbered(r.result?.questions),
      error: r.error, folder: r.ticketDir, processedAt: r.processedAt,
    })),
  );
}
