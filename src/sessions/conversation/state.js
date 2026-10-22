import { nowIso } from "../shared/text.js";
import { applyDelta as applyTurnDelta, createEmptyConversationState as createLegacyTurnState } from "../normalize/turnState.js";
import { THREAD_ITEM_KIND, TURN_STATUS } from "../../threads/itemTaxonomy.js";

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

function mapThreadTurnItemToBodyBlock(item = {}) {
  if (item.kind === THREAD_ITEM_KIND.IMAGE_VIEW) {
    const url = String(item.payload?.url || "").trim();
    if (!url) {
      return null;
    }
    return {
      id: String(item.id || ""),
      kind: "image",
      text: "",
      payload: item.payload || {},
      ts: item.updatedAt || item.createdAt || nowIso()
    };
  }
  if (item.kind !== THREAD_ITEM_KIND.AGENT_MESSAGE && item.kind !== THREAD_ITEM_KIND.PLAN) {
    return null;
  }
  const text = String(item.text || item.summary || item.payload?.text || "").trim();
  if (!text) {
    return null;
  }
  return {
    id: String(item.id || ""),
    kind: "markdown",
    text,
    payload: item.payload || {},
    ts: item.updatedAt || item.createdAt || nowIso()
  };
}

function mapThreadTurnItemToProcessEvent(item = {}) {
  if (
    item.kind === THREAD_ITEM_KIND.USER_MESSAGE ||
    item.kind === THREAD_ITEM_KIND.AGENT_MESSAGE ||
    item.kind === THREAD_ITEM_KIND.PLAN
  ) {
    return null;
  }
  const summary = String(item.summary || item.text || item.kind || "事件").trim();
  if (!summary) {
    return null;
  }
  return {
    id: String(item.id || ""),
    type: String(item.kind || "event"),
    title: String(item.kind || "event"),
    summary,
    content: String(item.text || "").trim(),
    payload: item.payload || {},
    ts: item.updatedAt || item.createdAt || nowIso()
  };
}

function mapThreadTurnStatus(status = "") {
  const normalized = String(status || "").trim();
  if (normalized === TURN_STATUS.FAILED) {
    return "failed";
  }
  if (normalized === TURN_STATUS.ABORTED) {
    return "interrupted";
  }
  if (normalized === TURN_STATUS.COMPLETED) {
    return "completed";
  }
  return "running";
}

export function buildConversationStateFromThreadSnapshot(snapshot = {}, options = {}) {
  const turns = Array.isArray(snapshot?.turns)
    ? snapshot.turns.map((turn) => {
        const items = Array.isArray(turn?.items) ? turn.items : [];
        const userItem = items.find((item) => item?.kind === THREAD_ITEM_KIND.USER_MESSAGE);
        const userText = String(userItem?.text || "").trim();
        const userPayload = userItem?.payload && typeof userItem.payload === "object" ? userItem.payload : {};
        return {
          id: String(turn?.id || ""),
          user: userText || Array.isArray(userPayload.content) && userPayload.content.length
            ? {
                id: String(userItem?.id || `${turn?.id || "turn"}-user`),
                text: userText,
                ts: turn?.startedAt || userItem?.updatedAt || userItem?.createdAt || nowIso(),
                content: Array.isArray(userPayload.content) ? JSON.parse(JSON.stringify(userPayload.content)) : [],
                images: Array.isArray(userPayload.images) ? JSON.parse(JSON.stringify(userPayload.images)) : [],
                local_images: Array.isArray(userPayload.local_images) ? JSON.parse(JSON.stringify(userPayload.local_images)) : []
              }
            : null,
          assistant: {
            status: mapThreadTurnStatus(turn?.status),
            error: turn?.error ? JSON.parse(JSON.stringify(turn.error)) : null,
            startedAt: turn?.startedAt || "",
            finishedAt: turn?.completedAt || "",
            process: items.map(mapThreadTurnItemToProcessEvent).filter(Boolean),
            body: items.map(mapThreadTurnItemToBodyBlock).filter(Boolean)
          }
        };
      })
    : [];

  const hasContent = turns.length > 0;
  const activeTurnId =
    String(snapshot?.activeTurnId || "").trim() ||
    turns.find((turn) => String(turn?.assistant?.status || "").trim() === "running")?.id ||
    "";

  return createConversationState({
    ...options,
    threadId: String(snapshot?.threadId || options.threadId || ""),
    turns,
    backgroundAgents: Array.isArray(options.backgroundAgents) ? options.backgroundAgents : [],
    status: hasContent ? "completed" : "idle",
    activeTurnId,
    updatedAt: snapshot?.updatedAt || options.updatedAt || nowIso(),
    version: Number(snapshot?.version || options.version || (hasContent ? 1 : 0))
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
