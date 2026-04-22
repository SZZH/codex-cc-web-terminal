import { nowIso } from "../shared/text.js";
import { createConversationState } from "./state.js";
import { deriveConversationStateFromThreadSnapshot } from "../../threads/legacyConversation.js";

export const CONVERSATION_PROTOCOL_VERSION = 1;

function normalizeBuffer(value) {
  return String(value || "");
}

function buildContinuationRuntime(session, sessionView = null, conversation = null) {
  const normalizedConversation = createConversationState(conversation || session?.conversationState || {});
  return {
    threadId: String(session?.resumeSessionId || normalizedConversation?.threadId || ""),
    sessionId: String(session?.id || normalizedConversation?.sessionId || ""),
    status: String(session?.status || normalizedConversation?.status || "idle"),
    session: sessionView || undefined,
    buffer: normalizeBuffer(session?.buffer),
    liveOverlay: session?.liveOverlay || null
  };
}

export function buildConversationSnapshotPayload(session, sessionView = null) {
  const conversation = session?.threadSnapshot
    ? deriveConversationStateFromThreadSnapshot(session.threadSnapshot, {
        sessionId: String(session?.id || ""),
        threadId: String(session?.resumeSessionId || session?.threadSnapshot?.threadId || ""),
        status: session?.conversationState?.status || "idle"
      })
    : createConversationState({
        ...(session?.conversationState || {}),
        sessionId: String(session?.id || session?.conversationState?.sessionId || ""),
        threadId: String(session?.resumeSessionId || session?.conversationState?.threadId || "")
      });

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
  const conversation = session?.threadSnapshot
    ? deriveConversationStateFromThreadSnapshot(session.threadSnapshot, {
        sessionId: String(session?.id || ""),
        threadId: String(session?.resumeSessionId || session?.threadSnapshot?.threadId || ""),
        status: session?.conversationState?.status || "idle"
      })
    : createConversationState({
        ...(session?.conversationState || {}),
        sessionId: String(session?.id || session?.conversationState?.sessionId || ""),
        threadId: String(session?.resumeSessionId || session?.conversationState?.threadId || "")
      });
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
  const conversation = session?.threadSnapshot
    ? deriveConversationStateFromThreadSnapshot(session.threadSnapshot, {
        sessionId: String(session?.id || ""),
        threadId: String(session?.resumeSessionId || session?.threadSnapshot?.threadId || ""),
        status: session?.conversationState?.status || "idle"
      })
    : createConversationState({
        ...(session?.conversationState || {}),
        sessionId: String(session?.id || session?.conversationState?.sessionId || ""),
        threadId: String(session?.resumeSessionId || session?.conversationState?.threadId || "")
      });
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
  const conversation = session?.threadSnapshot
    ? deriveConversationStateFromThreadSnapshot(session.threadSnapshot, {
        sessionId: String(session?.id || ""),
        threadId: String(session?.resumeSessionId || session?.threadSnapshot?.threadId || ""),
        status: session?.conversationState?.status || "idle"
      })
    : createConversationState({
        ...(session?.conversationState || {}),
        sessionId: String(session?.id || session?.conversationState?.sessionId || ""),
        threadId: String(session?.resumeSessionId || session?.conversationState?.threadId || "")
      });
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
