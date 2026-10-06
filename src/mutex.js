/**
 * A FIFO lock: run(fn) waits for every earlier caller to finish. `waiting` is how many callers are queued, for
 * "waiting for the merge queue (2 ahead)" style status.
 */
export class Mutex {
  constructor() {
    this.tail = Promise.resolve();
    this.waiting = 0;
  }

  run(fn) {
    this.waiting++;
    const result = this.tail.then(() => { this.waiting--; return fn(); });
    this.tail = result.catch(() => {});
    return result;
  }
}
