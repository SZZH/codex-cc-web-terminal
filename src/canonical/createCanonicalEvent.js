import { assertCanonicalEvent, isCanonicalEventKind } from "./guards.js";

function toIsoString(value) {
  if (!value) {
    return new Date().toISOString();
  }

  return value instanceof Date ? value.toISOString() : String(value);
}

export function createCanonicalEvent(input) {
  const event = {
    id: String(input.id),
    seq: Number(input.seq),
    provider: String(input.provider),
    providerThreadId: input.providerThreadId ? String(input.providerThreadId) : undefined,
    providerTurnId: input.providerTurnId ? String(input.providerTurnId) : undefined,
    threadId: String(input.threadId),
    turnId: input.turnId == null ? null : String(input.turnId),
    ts: toIsoString(input.ts),
    kind: String(input.kind),
    payload: input.payload && typeof input.payload === "object" ? { ...input.payload } : {}
  };

  if (!Number.isInteger(event.seq)) {
    throw new TypeError("Canonical event seq must be an integer");
  }

  if (!isCanonicalEventKind(event.kind)) {
    throw new TypeError(`Unknown canonical event kind: ${event.kind}`);
  }

  return assertCanonicalEvent(event);
}
