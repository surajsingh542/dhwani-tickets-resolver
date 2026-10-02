import fs from 'node:fs';
import path from 'node:path';
import { htmlToText, extractUrls } from './html.js';

const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);

const EXT_BY_TYPE = {
  'text/html': '.html', 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/svg+xml': '.svg', 'application/json': '.json', 'text/plain': '.txt', 'text/csv': '.csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/zip': '.zip',
};

/**
 * Google Docs/Sheets/Slides/Drive "view" links serve an app shell; their export endpoints serve the content
 * (works when the file is shared with "anyone with the link").
 */
function exportUrlFor(u) {
  let m;
  if ((m = u.match(/docs\.google\.com\/document\/d\/([\w-]+)/))) return `https://docs.google.com/document/d/${m[1]}/export?format=txt`;
  if ((m = u.match(/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/))) return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=xlsx`;
  if ((m = u.match(/docs\.google\.com\/presentation\/d\/([\w-]+)/))) return `https://docs.google.com/presentation/d/${m[1]}/export/pdf`;
  if ((m = u.match(/drive\.google\.com\/file\/d\/([\w-]+)/))) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  return null;
}

/**
 * Pulls everything we know about a ticket into tickets/<id>/ :
 *   ticket.md        — human/Claude-readable brief (title, description, checklist, discussion, activity, file index)
 *   detail.json      — raw get_task_detail response
 *   activity.json    — raw get_task_activity response
 *   attachments/     — files attached to the ticket
 *   links/           — embedded images and resources linked from description / checklist / discussion
 */
export async function buildTicketContext({ hub, item, ticketsDir, cfg, logger }) {
  const dir = path.join(ticketsDir, safe(item.id));
  const attDir = path.join(dir, 'attachments');
  const linkDir = path.join(dir, 'links');
  fs.mkdirSync(attDir, { recursive: true });
  fs.mkdirSync(linkDir, { recursive: true });

  const detail = await hub.getTaskDetail(item.id);
  let activity = [];
  try { activity = (await hub.getTaskActivity(item.id)) || []; } catch (e) { logger.warn(`${item.id}: activity unavailable — ${e.message}`); }
  fs.writeFileSync(path.join(dir, 'detail.json'), JSON.stringify(detail, null, 2));
  fs.writeFileSync(path.join(dir, 'activity.json'), JSON.stringify(activity, null, 2));

  const maxBytes = cfg.maxDownloadMb * 1024 * 1024;
  const files = [];
  const downloaded = new Set();

  for (const att of detail.attachments || []) {
    if (!att.file_url) continue;
    const dest = uniquePath(attDir, safe(att.file_name || path.basename(att.file_url)));
    try {
      await hub.download(att.file_url, dest, { maxBytes });
      files.push({ kind: 'attachment', source: att.file_url, local: dest });
      downloaded.add(hub.absoluteUrl(att.file_url));
    } catch (e) {
      files.push({ kind: 'attachment', source: att.file_url, error: e.message });
    }
  }

  const comments = detail.comments || [];
  const checklist = detail.checklist || [];
  const urls = extractUrls(
    detail.description,
    detail.description_raw,
    ...checklist.map((c) => c.text),
    ...comments.map((c) => c.content),
  );

  let n = 0;
  for (const u of urls) {
    const abs = safeAbs(hub, u);
    if (!abs || downloaded.has(abs)) continue;
    downloaded.add(abs);
    const isHub = hub.isHubUrl(abs);
    // Hub files are served from /files, /private/files, or the storage proxy (/api/method/multi_cloud_storage…generate_file).
    const isHubFile = isHub && /\/(private\/)?files\/|\/api\/method\/.*(file|download)/i.test(new URL(abs).pathname);
    if (isHub && !isHubFile) { files.push({ kind: 'link', source: abs, note: 'Hub page link (not downloaded)' }); continue; }
    if (!isHub && !cfg.fetchExternalLinks) { files.push({ kind: 'link', source: abs, note: 'external fetch disabled' }); continue; }

    const fetchUrl = exportUrlFor(abs) || abs;
    const parsed = new URL(abs);
    const name = parsed.searchParams.get('file_name') || decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname);
    const base = `${String(++n).padStart(2, '0')}_${safe(name)}`;
    const tmp = path.join(linkDir, base + '.download');
    try {
      const r = await hub.download(fetchUrl, tmp, { maxBytes, timeoutMs: 30000 });
      const type = r.contentType.split(';')[0].trim();
      const ext = path.extname(base) || EXT_BY_TYPE[type] || '';
      const dest = uniquePath(linkDir, base.endsWith(ext) ? base : base + ext);
      fs.renameSync(tmp, dest);
      const entry = { kind: isHubFile ? 'embedded-file' : 'link', source: abs, local: dest };
      if (type === 'text/html') {
        const txt = dest.replace(/\.html?$/, '') + '.txt';
        fs.writeFileSync(txt, htmlToText(fs.readFileSync(dest, 'utf8')));
        entry.text = txt;
        if (/accounts\.google\.com|ServiceLogin|Sign in/i.test(fs.readFileSync(txt, 'utf8').slice(0, 2000))) {
          entry.note = 'looks like a login page — the resource is not publicly accessible';
        }
      }
      files.push(entry);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      files.push({ kind: 'link', source: abs, error: e.message });
    }
  }

  const md = renderTicketMarkdown({ item, detail, activity, files, dir, cfg });
  const mdPath = path.join(dir, 'ticket.md');
  fs.writeFileSync(mdPath, md);
  const failed = files.filter((f) => f.error).length;
  logger.info(`${item.id}: context ready — ${files.filter((f) => f.local).length} file(s) downloaded, ${failed} failed → ${dir}`);
  return { dir, mdPath, detail, activity, files };
}

function safeAbs(hub, u) {
  try { return hub.absoluteUrl(u); } catch { return null; }
}

function uniquePath(dir, name) {
  let p = path.join(dir, name);
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${stem}_${i}${ext}`);
  return p;
}

function renderTicketMarkdown({ item, detail, activity, files, dir, cfg }) {
  const rel = (p) => path.relative(dir, p);
  const lines = [];
  lines.push(`# ${item.id}: ${detail.subject || item.subject}`, '');
  lines.push(`- **Project:** ${detail.project || cfg.project}`);
  lines.push(`- **Type:** ${detail.work_type || item.type}`);
  lines.push(`- **Priority:** ${detail.tracker_priority || item.priority}`);
  lines.push(`- **Stage:** ${detail.stage || item.stage}  |  **Status:** ${detail.status || item.status}`);
  if (detail.product) lines.push(`- **Product:** ${detail.product}`);
  if (detail.project_task) lines.push(`- **Activity:** ${detail.project_task}`);
  if (detail.assignee_names?.length) lines.push(`- **Assigned to:** ${detail.assignee_names.join(', ')}`);
  if (detail.exp_end_date) lines.push(`- **Expected by:** ${detail.exp_end_date}`);
  if (detail.parent_task) lines.push(`- **Parent ticket:** ${detail.parent_task}`);
  lines.push(`- **Hub:** ${cfg.hubBaseUrl}/hub/tasks?project=${encodeURIComponent(cfg.project)}`, '');

  lines.push('## Description', '', htmlToText(detail.description) || detail.description_raw || '_(empty)_', '');

  const checklist = detail.checklist || [];
  lines.push('## Checklist', '');
  if (checklist.length) for (const c of checklist) lines.push(`- [${c.done ? 'x' : ' '}] ${c.text}`);
  else lines.push('_(none)_');
  lines.push('');

  const comments = detail.comments || [];
  lines.push(`## Discussion (${comments.length})`, '');
  if (comments.length) for (const c of comments) lines.push(`### ${c.by || 'unknown'} — ${c.creation || ''}`, '', htmlToText(c.content), '');
  else lines.push('_(no comments)_', '');

  lines.push('## Files and linked resources', '');
  if (!files.length) lines.push('_(none)_');
  for (const f of files) {
    if (f.local) lines.push(`- [${f.kind}] \`${rel(f.local)}\`${f.text ? ` (text: \`${rel(f.text)}\`)` : ''} ← ${f.source}${f.note ? ` — ⚠ ${f.note}` : ''}`);
    else lines.push(`- [${f.kind}] ${f.source} — ${f.error ? `⚠ could not download: ${f.error}` : f.note}`);
  }
  lines.push('');

  if (Array.isArray(activity) && activity.length) {
    lines.push('## Activity (latest first)', '');
    for (const a of activity.slice(0, 40)) {
      const changes = (a.changes || []).map((c) => `${c.field}: "${c.from ?? ''}" → "${c.to ?? ''}"`).join('; ');
      lines.push(`- ${a.creation || a.when || ''} ${a.by || a.owner || ''}: ${changes || htmlToText(a.content || a.text || '') || a.type || ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
