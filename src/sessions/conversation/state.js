import { nowIso } from "../shared/text.js";
import { applyDelta as applyTurnDelta, createEmptyConversationState as createLegacyTurnState } from "../normalize/turnState.js";

export const CONVERSATION_SCHEMA_VERSION = 1;

function normalizeTimestamp(value, fallback = nowIso()) {
  const parsed = Date.parse(String(value || ""));
  if (Number.isNaN(parsed)) {
    const fallbackParsed = Date.parse(String(fallback || ""));
    if (!Number.isNaN(fallbackParsed)) {
      return new Date(fallbackParsed).toISOString();
    }
    return nowIso();
  }
  return new Date(parsed).toISOString();
}

export function normalizeConversationStatus(value, fallback = "idle") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["idle", "running", "completed", "failed", "interrupted"].includes(normalized)) {
    return normalized;
  }
  if (["done", "success", "succeeded", "finished"].includes(normalized)) {
    return "completed";
  }
  if (["error", "aborted", "abort"].includes(normalized)) {
    return "failed";
  }
  return fallback;
}

function cloneLegacyArrays(state) {
  const legacy = state || createLegacyTurnState();
  return {
    turns: Array.isArray(legacy.turns) ? [...legacy.turns] : [],
    backgroundAgents: Array.isArray(legacy.backgroundAgents) ? [...legacy.backgroundAgents] : [],
    activeTurnId: String(legacy.activeTurnId || "")
  };
}

export function createConversationState({
  sessionId = "",
  threadId = "",
  status = "idle",
  turns = [],
  backgroundAgents = [],
  activeTurnId = "",
  version = 0,
  updatedAt = nowIso()
} = {}) {
  return {
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    sessionId: String(sessionId || ""),
    threadId: String(threadId || ""),
    version: Math.max(0, Number(version) || 0),
    status: normalizeConversationStatus(status, "idle"),
    updatedAt: normalizeTimestamp(updatedAt),
    turns: Array.isArray(turns) ? [...turns] : [],
    backgroundAgents: Array.isArray(backgroundAgents) ? [...backgroundAgents] : [],
    activeTurnId: String(activeTurnId || "")
  };
}

export function createConversationStateFromLegacy(legacyState, options = {}) {
  const legacy = cloneLegacyArrays(legacyState);
  return createConversationState({
    ...options,
    turns: legacy.turns,
    backgroundAgents: legacy.backgroundAgents,
    activeTurnId: legacy.activeTurnId
  });
}

function deriveStatusFromDelta(currentStatus, delta) {
  const kind = String(delta?.kind || "").trim();
  if (!kind) {
    return currentStatus;
  }
  if (kind === "turn_created") {
    return "running";
  }
  if (kind === "turn_status_changed") {
    return normalizeConversationStatus(delta?.status, currentStatus);
  }
  if (kind === "turn_completed") {
    return normalizeConversationStatus(delta?.status, "completed");
  }
  if (kind === "session_status_changed") {
    return normalizeConversationStatus(delta?.status, currentStatus);
  }
  return currentStatus;
}

export function applyConversationDelta(state, delta, { incrementVersion = true } = {}) {
  const base = createConversationState(state);
  if (!delta || typeof delta !== "object") {
    return base;
  }

  if (String(delta.kind || "") === "conversation_replaced") {
    return createConversationState({
      ...base,
      ...delta.conversation,
      sessionId: String(delta?.conversation?.sessionId || base.sessionId || ""),
      threadId: String(delta?.conversation?.threadId || base.threadId || ""),
      version: incrementVersion ? base.version + 1 : Number(delta?.conversation?.version || base.version || 0),
      updatedAt: normalizeTimestamp(delta?.timestamp || delta?.conversation?.updatedAt || base.updatedAt)
    });
  }

  const nextLegacy = applyTurnDelta(
    {
      turns: base.turns,
      backgroundAgents: base.backgroundAgents,
      activeTurnId: base.activeTurnId
    },
    delta
  );
  const nextStatus = deriveStatusFromDelta(base.status, delta);
  return createConversationState({
    sessionId: String(delta.sessionId || base.sessionId || ""),
    threadId: String(delta.threadId || base.threadId || ""),
    version: incrementVersion ? base.version + 1 : base.version,
    status: nextStatus,
    updatedAt: normalizeTimestamp(delta.timestamp || base.updatedAt),
    turns: nextLegacy.turns,
    backgroundAgents: nextLegacy.backgroundAgents,
    activeTurnId: nextLegacy.activeTurnId
  });
}

export function applyConversationDeltas(state, deltas = [], options = {}) {
  let next = createConversationState(state);
  const applied = [];
  for (const delta of Array.isArray(deltas) ? deltas : []) {
    const previousVersion = next.version;
    next = applyConversationDelta(next, delta, options);
    applied.push({
      delta,
      fromVersion: previousVersion,
      toVersion: next.version,
      timestamp: next.updatedAt
    });
  }
  return { state: next, applied };
}

export function buildConversationStateFromHistory(historyPayload, options = {}) {
  if (historyPayload?.conversation && typeof historyPayload.conversation === "object") {
    return createConversationState({
      ...historyPayload.conversation,
      ...options
    });
  }
  const turns = Array.isArray(historyPayload?.turns) ? historyPayload.turns : [];
  const backgroundAgents = Array.isArray(historyPayload?.backgroundAgents) ? historyPayload.backgroundAgents : [];
  const hasContent = turns.length > 0 || backgroundAgents.length > 0;
  return createConversationState({
    ...options,
    turns,
    backgroundAgents,
    status: hasContent ? "completed" : "idle",
    version: hasContent ? 1 : 0
  });
}

function summarizeConversationContent(state = {}) {
  const conversation = createConversationState(state);
  let completedTurns = 0;
  let processCount = 0;
  let processChars = 0;
  let bodyCount = 0;
  let bodyChars = 0;

  for (const turn of conversation.turns) {
    const assistant = turn?.assistant || {};
    if (normalizeConversationStatus(assistant.status, "") === "completed") {
      completedTurns += 1;
    }
    for (const event of Array.isArray(assistant.process) ? assistant.process : []) {
      processCount += 1;
      processChars += String(event?.summary || event?.content || event?.title || "").trim().length;
    }
    for (const block of Array.isArray(assistant.body) ? assistant.body : []) {
      bodyCount += 1;
      bodyChars += String(block?.text || block?.payload?.url || block?.payload?.alt || "").trim().length;
    }
  }

  return {
    turnCount: conversation.turns.length,
    completedTurns,
    processCount,
    processChars,
    bodyCount,
    bodyChars,
    backgroundAgentCount: conversation.backgroundAgents.length
  };
}

export function compareConversationContent(left = {}, right = {}) {
  const leftSummary = summarizeConversationContent(left);
  const rightSummary = summarizeConversationContent(right);
  const comparisonOrder = [
    "turnCount",
    "completedTurns",
    "bodyCount",
    "bodyChars",
    "processCount",
    "processChars",
    "backgroundAgentCount"
  ];

  for (const key of comparisonOrder) {
    const diff = Number(leftSummary[key] || 0) - Number(rightSummary[key] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export function toLegacyConversationState(state) {
  const base = createConversationState(state);
  return {
    turns: base.turns,
    backgroundAgents: base.backgroundAgents,
    activeTurnId: base.activeTurnId
  };
}
