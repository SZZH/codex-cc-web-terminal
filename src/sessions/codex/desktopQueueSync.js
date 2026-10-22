const eligible = (request) => request.executionRoute === "desktopQueue" && !request.turnId
  && ["queued", "unknown"].includes(request.state);
const version = (request) => JSON.stringify([request.state, request.updatedAt, request.upstreamQueueId, request.turnId]);

// Queue membership is independent of execution. Absence ends the queue receipt,
// while a later official clientId can still prove that Codex consumed the input.
export class DesktopQueueSync {
  constructor({ writer, pending, current, update, finish, intervalMs = 1000 }) {
    Object.assign(this, { writer, pending, current, update, finish, intervalMs });
    this.reads = new Map();
    this.closed = false;
  }

  sync(threadId, { invalidate = false } = {}) {
    if (this.closed) return Promise.resolve();
    let read = this.reads.get(threadId);
    if (!read) { read = { generation: 0, at: 0 }; this.reads.set(threadId, read); }
    if (invalidate) { read.generation += 1; read.at = 0; }
    if (read.promise) return read.promise;
    const candidates = this.pending(threadId).filter(eligible);
    if (!candidates.length) { this.reads.delete(threadId); return Promise.resolve(); }
    if (Date.now() - read.at < this.intervalMs) return Promise.resolve();
    read.at = Date.now();
    const generation = read.generation;
    const controller = new AbortController();
    read.controller = controller;
    const timer = setTimeout(() => controller.abort(), 3000);
    timer.unref?.();
    read.promise = (async () => {
      try {
        const queue = await this.writer.list(threadId, { signal: controller.signal });
        if (this.closed || controller.signal.aborted || read.generation !== generation) return;
        for (const candidate of candidates) {
          const current = this.current(threadId, candidate.id);
          if (!current || !eligible(current) || version(current) !== version(candidate)) continue;
          const present = queue.find((item) => item.clientUserMessageId === candidate.id);
          if (present) {
            if (current.state === "unknown" || current.upstreamQueueId !== present.id) this.update(threadId, candidate.id, {
              state: "queued", upstreamQueueId: present.id, error: null
            });
          } else if (current.state === "queued" && current.upstreamQueueId
            && !queue.some((item) => item.id === current.upstreamQueueId)) {
            this.update(threadId, candidate.id, { state: "removed", error: null });
            this.finish(threadId, candidate.id);
          }
        }
      } catch { /* Unavailable or partial reads are not evidence of queue removal. */ }
      finally {
        clearTimeout(timer);
        read.promise = null;
        read.controller = null;
        if (!this.pending(threadId).some(eligible)) this.reads.delete(threadId);
        else if (!this.closed && read.generation !== generation) void this.sync(threadId);
      }
    })();
    return read.promise;
  }

  disconnect() {
    for (const read of this.reads.values()) {
      read.generation += 1;
      read.at = 0;
      read.controller?.abort();
    }
  }

  shutdown() {
    this.closed = true;
    this.disconnect();
    this.reads.clear();
  }
}
