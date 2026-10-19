/** Timers on a hand-advanced clock: advance(ms) runs everything due, in order. */
export class FakeClock {
  now = 0;
  nextId = 1;
  timers = new Map<number, { at: number; intervalMs: number | null; callback: () => void }>();

  setTimeout = (callback: () => void, delayMs = 0) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delayMs, intervalMs: null, callback });
    return id;
  };

  clearTimeout = (id: number) => {
    this.timers.delete(id);
  };

  setInterval = (callback: () => void, intervalMs = 0) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + intervalMs, intervalMs, callback });
    return id;
  };

  clearInterval = (id: number) => {
    this.timers.delete(id);
  };

  advance(ms: number) {
    const target = this.now + ms;
    while (true) {
      let nextId: number | null = null;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at < nextAt) {
          nextId = id;
          nextAt = timer.at;
        }
      }
      if (nextId === null || nextAt > target) break;

      this.now = nextAt;
      const timer = this.timers.get(nextId);
      if (!timer) continue;
      if (timer.intervalMs === null) this.timers.delete(nextId);
      else timer.at += timer.intervalMs;
      timer.callback();
    }
    this.now = target;
  }
}
