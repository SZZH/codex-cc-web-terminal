import { nowIso } from "../shared/text.js";
import { createConversationState } from "./state.js";
import { deriveConversationStateFromThreadSnapshot } from "../../threads/legacyConversation.js";

export const CONVERSATION_PROTOCOL_VERSION = 1;

function normalizeBuffer(value) {
  return String(value || "");
}

function deriveConversation(session) {
  if (session?.threadSnapshot) {
    return deriveConversationStateFromThreadSnapshot(session.threadSnapshot, {
      sessionId: String(session?.id || ""),
      threadId: String(session?.resumeSessionId || session?.threadSnapshot?.threadId || ""),
      status: session?.conversationState?.status || "idle"
    });
  }

  return createConversationState({
    ...(session?.conversationState || {}),
    sessionId: String(session?.id || session?.conversationState?.sessionId || ""),
    threadId: String(session?.resumeSessionId || session?.conversationState?.threadId || "")
  });
}

function buildContinuationRuntime(session, sessionView = null, conversation = null) {
  const normalizedConversation = createConversationState(conversation || deriveConversation(session));
  return {
    threadId: String(session?.resumeSessionId || normalizedConversation?.threadId || ""),
    sessionId: String(session?.id || normalizedConversation?.sessionId || ""),
    status: String(session?.status || normalizedConversation?.status || "idle"),
    session: sessionView || undefined,
    buffer: normalizeBuffer(session?.buffer),
    liveOverlay: session?.liveOverlay || null
  };
}

function resolveThreadRuntime(session, payload = {}) {
  const conversation = payload?.conversation || deriveConversation(session);
  const threadSnapshot = payload?.threadSnapshot || payload?.thread?.snapshot || session?.threadSnapshot || null;
  const continuation =
    payload?.continuation ||
    payload?.thread?.continuation ||
    buildContinuationRuntime(session, payload?.session || undefined, conversation);
  const threadId = String(
    payload?.threadId ||
      continuation?.threadId ||
      threadSnapshot?.threadId ||
      session?.resumeSessionId ||
      conversation?.threadId ||
      ""
  );
  const sessionId = String(
    payload?.sessionId || continuation?.sessionId || session?.id || conversation?.sessionId || ""
  );

  return {
    threadId,
    sessionId,
    threadSnapshot,
    continuation,
    conversation
  };
}

function pickTurnById(turns, turnId) {
  if (!Array.isArray(turns)) {
    return [];
  }
  const targetTurnId = String(turnId || "").trim();
  if (!targetTurnId) {
    return turns;
  }
  return turns.filter((turn) => String(turn?.id || "").trim() === targetTurnId);
}

function buildSlimConversation(conversation, turnId) {
  const normalizedConversation = createConversationState(conversation || {});
  const turns = pickTurnById(normalizedConversation.turns, turnId);
  const normalizedActiveTurnId = String(normalizedConversation.activeTurnId || "").trim();
  return {
    sessionId: String(normalizedConversation.sessionId || ""),
    threadId: String(normalizedConversation.threadId || ""),
    version: Number(normalizedConversation.version || 0),
    status: String(normalizedConversation.status || "idle"),
    updatedAt: String(normalizedConversation.updatedAt || ""),
    backgroundAgents: Array.isArray(normalizedConversation.backgroundAgents)
      ? normalizedConversation.backgroundAgents
      : [],
    turns,
    activeTurnId: normalizedActiveTurnId && normalizedActiveTurnId === String(turnId || "").trim() ? normalizedActiveTurnId : ""
  };
}

function buildSlimThreadSnapshot(snapshot, turnId) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }
  const normalizedActiveTurnId = String(snapshot.activeTurnId || "").trim();
  return {
    threadId: String(snapshot.threadId || ""),
    version: Number(snapshot.version || 0),
    updatedAt: String(snapshot.updatedAt || ""),
    activeTurnId: normalizedActiveTurnId && normalizedActiveTurnId === String(turnId || "").trim() ? normalizedActiveTurnId : "",
    metadata: snapshot.metadata && typeof snapshot.metadata === "object" ? { ...snapshot.metadata } : {},
    backgroundAgents: Array.isArray(snapshot.backgroundAgents) ? snapshot.backgroundAgents : [],
    turns: pickTurnById(snapshot.turns, turnId),
  };
}

export function buildThreadTransportSnapshot(session, payload = {}, { trackedTurnId = "" } = {}) {
  const runtime = resolveThreadRuntime(session, payload);
  const targetTurnId = String(
    trackedTurnId || runtime.threadSnapshot?.activeTurnId || runtime.conversation?.activeTurnId || ""
  ).trim();
  const slimSnapshot = buildSlimThreadSnapshot(runtime.threadSnapshot, targetTurnId);
  const slimConversation = buildSlimConversation(runtime.conversation, targetTurnId);
  return {
    type: "thread.snapshot",
    threadId: runtime.threadId,
    sessionId: runtime.sessionId,
    status: String(
      runtime.conversation?.status ||
        payload?.conversationStatus ||
        runtime.continuation?.status ||
        session?.status ||
        "idle"
    ),
    version: Number(
      runtime.threadSnapshot?.version ||
        runtime.conversation?.version ||
        payload?.toVersion ||
        payload?.version ||
        0
    ),
    timestamp: payload?.timestamp || nowIso(),
    partial: true,
    turnId: targetTurnId,
    snapshot: slimSnapshot,
    conversation: slimConversation,
    liveOverlay: payload?.liveOverlay || session?.liveOverlay || null
  };
}

export function buildThreadTransportOverlay(session, payload = {}, { trackedTurnId = "" } = {}) {
  const runtime = resolveThreadRuntime(session, payload);
  const part = payload?.part && typeof payload.part === "object" ? { ...payload.part } : null;
  if (!part) {
    return null;
  }

  return {
    threadId: runtime.threadId,
    sessionId: runtime.sessionId,
    turnId: String(
      payload?.turnId || trackedTurnId || runtime.threadSnapshot?.activeTurnId || runtime.conversation?.activeTurnId || ""
    ),
    role: String(payload?.role || "assistant"),
    phase: String(payload?.phase || "streaming"),
    timestamp: payload?.timestamp || nowIso(),
    parts: [part]
  };
}

export function buildConversationSnapshotPayload(session, sessionView = null) {
  const conversation = deriveConversation(session);

  return {
    type: "conversation.snapshot",
    protocolVersion: CONVERSATION_PROTOCOL_VERSION,
    timestamp: nowIso(),
    session: sessionView || undefined,
    sessionId: conversation.sessionId,
    threadId: conversation.threadId,
    conversation,
    continuation: buildContinuationRuntime(session, sessionView, conversation),
    thread: {
      snapshot: session?.threadSnapshot || null,
      continuation: buildContinuationRuntime(session, sessionView, conversation)
    },
    buffer: normalizeBuffer(session?.buffer),
    turns: conversation.turns,
    backgroundAgents: conversation.backgroundAgents,
    threadSnapshot: session?.threadSnapshot || null,
    liveOverlay: session?.liveOverlay || null
  };
}

export function buildConversationDeltaPayload(session, appliedDeltas = []) {
  const normalizedApplied = (Array.isArray(appliedDeltas) ? appliedDeltas : []).filter(Boolean);
  if (!normalizedApplied.length) {
    return null;
  }
  const conversation = deriveConversation(session);
  return {
    type: "conversation.delta",
    protocolVersion: CONVERSATION_PROTOCOL_VERSION,
    timestamp: nowIso(),
    sessionId: conversation.sessionId,
    threadId: conversation.threadId,
    fromVersion: normalizedApplied[0].fromVersion,
    toVersion: normalizedApplied[normalizedApplied.length - 1].toVersion,
    conversationStatus: conversation.status,
    conversation,
    continuation: buildContinuationRuntime(session, null, conversation),
    thread: {
      snapshot: session?.threadSnapshot || null,
      continuation: buildContinuationRuntime(session, null, conversation)
    },
    threadSnapshot: session?.threadSnapshot || null,
    liveOverlay: session?.liveOverlay || null,
    deltas: normalizedApplied.map((entry) => ({
      ...entry.delta,
      version: entry.toVersion,
      timestamp: entry.delta?.timestamp || entry.timestamp
    }))
  };
}

export function buildLegacySnapshotPayload(session, sessionView = null) {
  const conversation = deriveConversation(session);
  return {
    type: "snapshot",
    protocolVersion: CONVERSATION_PROTOCOL_VERSION,
    timestamp: nowIso(),
    session: sessionView || undefined,
    sessionId: conversation.sessionId,
    threadId: conversation.threadId,
    version: conversation.version,
    continuation: buildContinuationRuntime(session, sessionView, conversation),
    thread: {
      snapshot: session?.threadSnapshot || null,
      continuation: buildContinuationRuntime(session, sessionView, conversation)
    },
    buffer: normalizeBuffer(session?.buffer),
    turns: conversation.turns,
    backgroundAgents: conversation.backgroundAgents,
    conversation
  };
}

export function buildLegacyConversationSnapshotPayload(session, { fromVersion = null, toVersion = null } = {}) {
  const conversation = deriveConversation(session);
  const normalizedToVersion = Number.isFinite(Number(toVersion)) ? Number(toVersion) : conversation.version;
  const normalizedFromVersion = Number.isFinite(Number(fromVersion))
    ? Number(fromVersion)
    : Math.max(0, normalizedToVersion - 1);
  return {
    type: "conversation_snapshot",
    protocolVersion: CONVERSATION_PROTOCOL_VERSION,
    timestamp: nowIso(),
    sessionId: conversation.sessionId,
    threadId: conversation.threadId,
    fromVersion: normalizedFromVersion,
    toVersion: normalizedToVersion,
    version: normalizedToVersion,
    continuation: buildContinuationRuntime(session, null, conversation),
    thread: {
      snapshot: session?.threadSnapshot || null,
      continuation: buildContinuationRuntime(session, null, conversation)
    },
    turns: conversation.turns,
    backgroundAgents: conversation.backgroundAgents,
    conversation
  };
}
