import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Outside any repository on purpose: a lock file inside a repo would make it look dirty.
export const LOCK_DIR = path.join(os.homedir(), '.cache', 'auto-ticket-resolver', 'locks');

const keyFile = (target) => {
  let real = target;
  try { real = fs.realpathSync(target); } catch { /* not created yet */ }
  return { real, file: path.join(LOCK_DIR, `${createHash('sha1').update(real).digest('hex').slice(0, 16)}.lock`) };
};

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/** Every lock currently held by a live process. */
export function listLocks() {
  let files = [];
  try { files = fs.readdirSync(LOCK_DIR).filter((f) => f.endsWith('.lock')); } catch { return []; }
  return files
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(LOCK_DIR, f), 'utf8')); } catch { return null; } })
    .filter((l) => l && alive(l.pid));
}

/**
 * Locks every path in `targets` (repository folders, the project workspace) for this process, atomically per path.
 * A lock held by a dead process is taken over. If any path is held by a live run, everything acquired so far is
 * released and this throws, naming the holder. Returns a release() function.
 */
export function acquireLocks(targets, { owner }) {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const held = [];
  const release = () => {
    for (const file of held.splice(0)) {
      try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.rmSync(file); } catch { /* gone */ }
    }
  };
  for (const target of [...new Set(targets)]) {
    const { real, file } = keyFile(target);
    const info = { path: real, pid: process.pid, owner, startedAt: new Date().toISOString(), host: os.hostname() };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(file, JSON.stringify(info), { flag: 'wx' });
        held.push(file);
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') { release(); throw e; }
        let other = null;
        try { other = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* half-written or removed */ }
        if (other && other.pid === process.pid) { held.push(file); break; }
        if (other && alive(other.pid)) {
          release();
          throw new Error(
            `${real} is in use by another run (${other.owner}, pid ${other.pid}, started ${other.startedAt}). ` +
              'Wait for it to finish or stop it first.',
          );
        }
        fs.rmSync(file, { force: true }); // stale: its process is gone
      }
    }
  }
  const onExit = () => release();
  process.once('exit', onExit);
  return () => { process.off('exit', onExit); release(); };
}
