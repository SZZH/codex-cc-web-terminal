import { CANONICAL_EVENT_KIND_SET } from "./eventKinds.js";

export function isCanonicalEventKind(value) {
  return typeof value === "string" && CANONICAL_EVENT_KIND_SET.has(value);
}

export function isCanonicalEvent(value) {
  if (!value || typeof value !== "object") {
    return false;
  }

  return (
    typeof value.id === "string" &&
    Number.isInteger(value.seq) &&
    typeof value.provider === "string" &&
    typeof value.threadId === "string" &&
    typeof value.ts === "string" &&
    isCanonicalEventKind(value.kind) &&
    value.payload != null &&
    typeof value.payload === "object"
  );
}

export function assertCanonicalEvent(value, context = "canonical event") {
  if (!isCanonicalEvent(value)) {
    throw new TypeError(`Invalid ${context}`);
  }

  return value;
}
