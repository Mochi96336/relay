/** setTimeout and clearTimeout that fire only when the test says so. */
export function manualTimers() {
  let nextId = 1;
  const tasks = new Map<number, () => void>();
  return {
    setTimeoutFn(callback: () => void) {
      const id = nextId;
      nextId += 1;
      tasks.set(id, callback);
      return id;
    },
    clearTimeoutFn(id: number) {
      tasks.delete(id);
    },
    runNext() {
      const entry = tasks.entries().next().value as [number, () => void] | undefined;
      if (!entry) return false;
      const [id, callback] = entry;
      tasks.delete(id);
      callback();
      return true;
    },
    /** Runs timers, including ones they schedule, until none is left or `limit` ran. */
    drain(limit = 100) {
      let count = 0;
      while (count < limit && this.runNext()) count += 1;
      return count;
    },
    pending() {
      return tasks.size;
    },
  };
}
