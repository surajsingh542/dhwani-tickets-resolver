import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

/** Console + file logger that also emits every line, so the dashboard can stream it. */
export class Logger extends EventEmitter {
  constructor({ logDir, secrets = [] } = {}) {
    super();
    this.secrets = secrets.filter((s) => s && s.length > 6);
    this.history = [];
    if (logDir) {
      fs.mkdirSync(logDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      this.file = path.join(logDir, `run-${stamp}.log`);
    }
  }

  redact(text) {
    let out = String(text);
    for (const s of this.secrets) out = out.split(s).join('[REDACTED]');
    return out;
  }

  log(level, msg, extra) {
    const line = this.redact(
      `${new Date().toISOString()} [${level}] ${msg}${extra !== undefined ? ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`,
    );
    (level === 'ERROR' ? console.error : console.log)(line);
    if (this.file) fs.appendFileSync(this.file, line + '\n');
    this.history.push(line);
    if (this.history.length > 2000) this.history.shift();
    this.emit('line', line);
  }

  info(m, e) { this.log('INFO', m, e); }
  warn(m, e) { this.log('WARN', m, e); }
  error(m, e) { this.log('ERROR', m, e); }
  claude(m) { this.log('CLAUDE', m); }
}
