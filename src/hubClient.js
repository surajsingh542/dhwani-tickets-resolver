import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const TT = 'dris_helpdesk.api.task_tracker';

/**
 * Thin client for the DhwaniRIS Hub (Frappe app `dris_helpdesk`).
 * Uses the same whitelisted methods the Hub SPA calls, authenticated with the user's session cookie.
 */
export class HubClient {
  constructor({ baseUrl, cookie, logger }) {
    this.baseUrl = baseUrl;
    this.origin = new URL(baseUrl).origin;
    this.cookie = cookie;
    this.logger = logger;
    this.csrfToken = null;
  }

  headers(extra = {}) {
    const h = { Cookie: this.cookie, Accept: 'application/json', ...extra };
    if (this.csrfToken) h['X-Frappe-CSRF-Token'] = this.csrfToken;
    return h;
  }

  /** Frappe needs a CSRF token for POSTs made with a session cookie; the Hub page embeds it. */
  async init() {
    const res = await fetch(`${this.baseUrl}/hub/tasks`, { headers: { Cookie: this.cookie }, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      throw new Error('Hub redirected to the login page — the session cookie is invalid or expired.');
    }
    const html = await res.text();
    const m = html.match(/csrf_token"\]\s*=\s*"([^"]+)"/);
    this.csrfToken = m && m[1] !== 'None' ? m[1] : null;
    this.user = await this.call('frappe.auth.get_logged_user', {}, { method: 'GET' });
    if (!this.user || this.user === 'Guest') throw new Error('The session cookie is not logged in (user is Guest).');
    return this.user;
  }

  async call(method, args = {}, { method: httpMethod = 'POST' } = {}) {
    const url = new URL(`${this.baseUrl}/api/method/${method}`);
    let res;
    if (httpMethod === 'GET') {
      for (const [k, v] of Object.entries(args)) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
      res = await fetch(url, { headers: this.headers() });
    } else {
      res = await fetch(url, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(args),
      });
    }
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = null; }

    // Some read endpoints are whitelisted for GET only.
    if (res.status === 405 && httpMethod === 'POST') return this.call(method, args, { method: 'GET' });
    if (!res.ok || !body) throw new Error(`${method} failed (HTTP ${res.status}): ${frappeError(body) || text.slice(0, 300)}`);
    return body.message;
  }

  getProjectTasks(project) { return this.call(`${TT}.get_project_tasks`, { project, archived: 'all' }); }
  getTaskDetail(name) { return this.call(`${TT}.get_task_detail`, { name }); }
  getTaskActivity(name) { return this.call(`${TT}.get_task_activity`, { name }); }
  getPipelineStages() { return this.call(`${TT}.get_pipeline_stages`, {}); }
  updateTask(name, changes) { return this.call(`${TT}.update_task`, { name, changes: JSON.stringify(changes) }); }
  addComment(name, content) { return this.call(`${TT}.add_task_comment`, { name, content }); }

  absoluteUrl(u) {
    return new URL(u, this.baseUrl + '/').toString();
  }

  isHubUrl(u) {
    try { return new URL(u, this.baseUrl + '/').origin === this.origin; } catch { return false; }
  }

  /**
   * Downloads a URL to `dest`. The session cookie is only sent to the Hub's own origin.
   * Returns { path, contentType, bytes }.
   */
  async download(rawUrl, dest, { maxBytes, timeoutMs = 60000 } = {}) {
    const url = this.absoluteUrl(rawUrl);
    const headers = this.isHubUrl(url) ? { Cookie: this.cookie } : { 'User-Agent': 'Mozilla/5.0 auto-ticket-resolver' };
    const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (maxBytes && len > maxBytes) throw new Error(`too large (${Math.round(len / 1e6)} MB)`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let bytes = 0;
    const counter = async function* (src) {
      for await (const chunk of src) {
        bytes += chunk.length;
        if (maxBytes && bytes > maxBytes) throw new Error('too large');
        yield chunk;
      }
    };
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(dest));
    return { path: dest, contentType: res.headers.get('content-type') || '', bytes, finalUrl: res.url };
  }
}

function frappeError(body) {
  if (!body) return '';
  if (body._server_messages) {
    try {
      return JSON.parse(body._server_messages)
        .map((m) => { try { return JSON.parse(m).message; } catch { return m; } })
        .join(' | ')
        .replace(/<[^>]+>/g, '');
    } catch { /* fall through */ }
  }
  return body.exception || body.exc_type || body.message || '';
}
