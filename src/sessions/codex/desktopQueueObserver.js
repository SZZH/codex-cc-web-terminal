import { createHash } from "node:crypto";
import { REQUEST_TERMINAL_STATES } from "./requestStore.js";

export function matchesDesktopQueueTurn(turn, requests) {
  return requests.some((request) => ["desktopQueue", "desktopSteer"].includes(request.executionRoute) &&
    (request.turnId === turn.id || turn.items?.some((item) => item.type === "userMessage" && item.clientId === request.id)));
}

export function observedDesktopQueueTurn(turn) {
  if (!["interrupted", "aborted", "cancelled"].includes(turn.status) || turn.completedAt) return turn;
  return { ...turn, status: "unknown", statusConfirmed: false, statusSource: "unconfirmed-history" };
}

export function requestTerminalTurn(turn, request) {
  if (!turn || turn.statusSource === "notification" ||
    !["desktopQueue", "desktopSteer"].includes(request?.executionRoute)) return turn;
  return observedDesktopQueueTurn(turn).status === "unknown" ? undefined : turn;
}

export class DesktopQueueObserver {
  constructor({ reader, publish }) {
    this.reader = reader;
    this.publish = publish;
    this.signatures = new Map();
  }

  forget(threadId) { this.signatures.delete(threadId); }

  emitChanged(threadId, key, type, payload) {
    let signatures = this.signatures.get(threadId);
    if (!signatures) { signatures = new Map(); this.signatures.set(threadId, signatures); }
    const signature = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    if (signatures.get(key) === signature) return;
    signatures.delete(key);
    signatures.set(key, signature);
    while (signatures.size > 128) signatures.delete(signatures.keys().next().value);
    this.publish(threadId, type, payload);
  }

  async observe(threadId, turns, requests, isCurrent = () => true) {
    const pending = requests.filter((request) => ["desktopQueue", "desktopSteer"].includes(request.executionRoute) &&
      !REQUEST_TERMINAL_STATES.has(request.state));
    for (const candidate of turns) {
      if (!isCurrent()) return;
      if (!matchesDesktopQueueTurn(candidate, pending)) continue;
      const turn = observedDesktopQueueTurn(candidate);
      const { items: summaryItems = [], ...metadata } = turn;
      this.emitChanged(threadId, `${turn.id}:turn`, "turn.upsert", { turn: metadata });
      if (!isCurrent()) return;
      const recent = typeof this.reader.listItems === "function"
        ? (await this.reader.listItems(threadId, turn.id, { limit: 30, sortDirection: "desc" })).items || [] : [];
      if (!isCurrent()) return;
      const recentIds = new Set(recent.map((item) => item.id));
      for (const item of summaryItems) if (item.type === "userMessage" && !recentIds.has(item.id)) {
        if (!isCurrent()) return;
        this.emitChanged(threadId, `${turn.id}:item:${item.id}`, "item.upsert", { turnId: turn.id, item });
      }
      for (const item of recent) {
        if (!isCurrent()) return;
        this.emitChanged(threadId, `${turn.id}:item:${item.id}`, "item.upsert", { turnId: turn.id, item });
      }
    }
  }
}
