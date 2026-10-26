const PENDING_STATES = new Set(["accepted", "running", "unknown"]);
const UNFINISHED_TURNS = new Set(["unknown", "inProgress", "running"]);
const STARTED_TURNS = new Set(["inProgress", "running", "completed", "failed"]);

function timestamp(value) {
  if (typeof value !== "number" && typeof value !== "string" || typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  const milliseconds = Number.isFinite(number) ? number < 1e12 ? number * 1000 : number : Date.parse(value);
  return Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds <= 8.64e15 ? milliseconds : null;
}

function started(turn) {
  return turn.statusConfirmed !== false && (STARTED_TURNS.has(turn.status) ||
    ["interrupted", "aborted"].includes(turn.status) && timestamp(turn.completedAt) !== null);
}

// A later official turn proves that an older execution no longer owns the
// thread. It does not prove how that execution ended or whether its input ran.
export class CodexSupersededRequests {
  #latestByThread = new Map();

  forget(threadId) { this.#latestByThread.delete(threadId); }

  observe(threadId, turns = [], requests = []) {
    if (!threadId || !Array.isArray(turns)) return [];
    const current = new Map();
    let latest = this.#latestByThread.get(threadId);
    for (const turn of turns) {
      if (!turn?.id || turn.threadId && turn.threadId !== threadId) continue;
      current.set(turn.id, turn);
      const startedAt = timestamp(turn.startedAt);
      if (startedAt !== null && started(turn) && (!latest || startedAt > latest.startedAt)) {
        latest = { id: turn.id, startedAt };
      }
    }
    if (!latest) return [];
    // Keep only lifecycle evidence, never history items or request content.
    this.#latestByThread.delete(threadId);
    this.#latestByThread.set(threadId, latest);
    while (this.#latestByThread.size > 128) this.#latestByThread.delete(this.#latestByThread.keys().next().value);
    return (Array.isArray(requests) ? requests : []).flatMap((request) => {
      if (!request?.id || !request.turnId || !PENDING_STATES.has(request.state) ||
        request.threadId && request.threadId !== threadId) return [];
      const target = current.get(request.turnId);
      const startedAt = timestamp(target?.startedAt);
      if (!target || target.id === latest.id || !UNFINISHED_TURNS.has(target.status) ||
        startedAt === null || startedAt >= latest.startedAt) return [];
      return [{ requestId: request.id, turnId: target.id, supersededByTurnId: latest.id }];
    });
  }
}
