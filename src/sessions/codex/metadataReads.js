import { throwIfReadAborted, waitForHistoryRead } from "./readCancellation.js";

/** Shares only unfinished metadata reads; value caching belongs to the reader. */
export class CodexMetadataReads {
  constructor({ load, publish }) {
    this.load = load;
    this.publish = publish;
    this.entries = new Map();
  }

  invalidate(threadId) {
    // Existing waiters keep their result, but this entry can no longer publish.
    this.entries.delete(threadId);
  }

  read(threadId, { signal } = {}) {
    throwIfReadAborted(signal);
    let entry = this.entries.get(threadId);
    if (!entry) {
      entry = { controller: new AbortController(), waiters: 0, settled: false };
      this.entries.set(threadId, entry);
      entry.promise = Promise.resolve().then(() => {
        throwIfReadAborted(entry.controller.signal);
        return this.load(threadId, { signal: entry.controller.signal });
      }).then((thread) => {
        throwIfReadAborted(entry.controller.signal);
        if (this.entries.get(threadId) === entry) this.publish(thread);
        return thread;
      }).finally(() => {
        entry.settled = true;
        if (this.entries.get(threadId) === entry) this.entries.delete(threadId);
      });
    }

    entry.waiters += 1;
    let waiting = true;
    const leave = () => {
      if (!waiting) return;
      waiting = false;
      signal?.removeEventListener("abort", leave);
      entry.waiters -= 1;
      if (!entry.waiters && !entry.settled) {
        if (this.entries.get(threadId) === entry) this.entries.delete(threadId);
        entry.controller.abort();
      }
    };
    signal?.addEventListener("abort", leave, { once: true });
    return waitForHistoryRead(() => entry.promise, signal).finally(leave);
  }
}
