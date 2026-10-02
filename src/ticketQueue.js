/**
 * Turns the raw project task list into the ordered work queue:
 *   P0 Bug → P0 Enhancement → P0 Change Request → P0 Feature → P0 Task → P1 … → P2 …
 * Only tickets whose stage/status is one of the pick statuses (Open / Reopen) are taken,
 * and tickets with no priority are never picked.
 */

export const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Spelling variants seen across Dhwani projects, keyed by normalised canonical type.
const TYPE_ALIASES = {
  bug: ['bug', 'bugs', 'defect', 'issue'],
  enhancement: ['enhancement', 'enhancements', 'improvement'],
  changerequest: ['changerequest', 'changerequests', 'cr'],
  feature: ['feature', 'features', 'newfeature'],
  task: ['task', 'tasks'],
};

export function fieldsOf(row) {
  return {
    id: row.name,
    subject: row.subject || row.title || '',
    priority: row.custom_priority ?? row.tracker_priority ?? row.priority ?? '',
    type: row.custom_work_type ?? row.work_type ?? row.type ?? '',
    stage: row.custom_tracker_status ?? row.stage ?? '',
    status: row.status ?? '',
    created: row.creation || '',
    assignees: row.assignee_names || row.assignees || [],
    assigneeEmails: row.assignees || [],
    createdBy: row.created_by || row.owner || '',
    createdByName: row.created_by_name || row.owner_name || '',
  };
}

/**
 * True when the person (email + name) matches one of the filter values: an email or a full name (case-insensitive),
 * or "me" for the logged-in user. An empty filter matches everyone.
 */
export function matchesPeople(filter, people, me) {
  if (!filter?.length) return true;
  const wanted = filter.map((v) => (v.trim().toLowerCase() === 'me' ? String(me || '').toLowerCase() : v.trim().toLowerCase())).filter(Boolean);
  return people.some(({ email, name }) => wanted.includes(String(email || '').toLowerCase()) || wanted.includes(String(name || '').toLowerCase()));
}

export function passesPeopleFilters(f, cfg, me) {
  const assignees = f.assigneeEmails.map((email, i) => ({ email, name: (f.assignees || [])[i] }));
  return (
    matchesPeople(cfg.assigneeFilter, assignees, me) &&
    matchesPeople(cfg.createdByFilter, [{ email: f.createdBy, name: f.createdByName }], me)
  );
}

export function priorityKey(value, priorities) {
  const m = String(value ?? '').match(/p\s*-?\s*(\d)/i);
  if (!m) return null;
  const p = `P${m[1]}`;
  return priorities.includes(p) ? p : null;
}

export function typeRank(value, typeOrder) {
  const n = norm(value);
  if (!n) return -1;
  for (let i = 0; i < typeOrder.length; i++) {
    const canon = norm(typeOrder[i]);
    const aliases = TYPE_ALIASES[canon] || [canon];
    if (n === canon || aliases.includes(n)) return i;
  }
  return -1;
}

// The Hub stage (custom_tracker_status) is authoritative; Frappe's own Task.status stays "Open" through most
// stages (In Progress, To Test, …), so it is only consulted when a ticket has no stage at all.
export function isPickable(f, pickStatuses) {
  const allowed = new Set(pickStatuses.map(norm));
  return allowed.has(norm(f.stage || f.status));
}

/**
 * @returns {{ queue: object[], skipped: {id, subject, reason}[] }}
 */
export function buildQueue(rows, cfg, me) {
  const queue = [];
  const skipped = [];
  let filteredOut = 0;
  for (const row of rows || []) {
    const f = fieldsOf(row);
    if (!isPickable(f, cfg.pickStatuses)) continue; // not Open/Reopen: not our concern, don't report
    if (!passesPeopleFilters(f, cfg, me)) { filteredOut++; continue; } // --assignee / --created-by
    const p = priorityKey(f.priority, cfg.priorities);
    if (!p) { skipped.push({ ...f, reason: f.priority ? `priority "${f.priority}" not in ${cfg.priorities.join('/')}` : 'no priority assigned' }); continue; }
    const t = typeRank(f.type, cfg.typeOrder);
    if (t < 0) { skipped.push({ ...f, reason: `type "${f.type || '(none)'}" not in ${cfg.typeOrder.join('/')}` }); continue; }
    queue.push({ ...f, priorityKey: p, typeRank: t, row });
  }
  queue.sort(
    (a, b) =>
      cfg.priorities.indexOf(a.priorityKey) - cfg.priorities.indexOf(b.priorityKey) ||
      a.typeRank - b.typeRank ||
      // The task list carries no creation date; Hub IDs (TASK-YYYY-NNNNN) are sequential, so oldest first.
      String(a.id).localeCompare(String(b.id), undefined, { numeric: true }),
  );
  return { queue, skipped, filteredOut };
}

/** Distinct values per field — used by `inspect` to check the config matches what the Hub actually returns. */
export function distinctValues(rows) {
  const out = { priority: {}, type: {}, stage: {}, status: {}, assignee: {}, createdBy: {} };
  const bump = (k, v) => { out[k][v] = (out[k][v] || 0) + 1; };
  for (const row of rows || []) {
    const f = fieldsOf(row);
    for (const k of ['priority', 'type', 'stage', 'status']) bump(k, f[k] || '(empty)');
    if (!f.assigneeEmails.length) bump('assignee', '(unassigned)');
    f.assigneeEmails.forEach((e, i) => bump('assignee', `${(f.assignees || [])[i] || e} <${e}>`));
    bump('createdBy', f.createdBy ? `${f.createdByName || f.createdBy} <${f.createdBy}>` : '(unknown)');
  }
  return out;
}

/** Finds the Hub's exact spelling of a stage ("To Test", "Review") among the available options. */
export function matchStage(wanted, options) {
  const w = norm(wanted);
  const opts = (options || []).map((o) => (typeof o === 'string' ? o : o?.value || o?.name || o?.label)).filter(Boolean);
  return opts.find((o) => norm(o) === w) || opts.find((o) => norm(o).startsWith(w) || w.startsWith(norm(o))) || null;
}
