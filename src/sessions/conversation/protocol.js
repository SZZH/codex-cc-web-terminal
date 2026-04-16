import { nowIso } from "../shared/text.js";
import { createConversationState } from "./state.js";

export const CONVERSATION_PROTOCOL_VERSION = 1;

function normalizeBuffer(value) {
  return String(value || "");
}

export function buildConversationSnapshotPayload(session, sessionView = null) {
  const conversation = createConversationState({
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
    buffer: normalizeBuffer(session?.buffer),
    turns: conversation.turns,
    backgroundAgents: conversation.backgroundAgents
  };
}

export function buildConversationDeltaPayload(session, appliedDeltas = []) {
  const normalizedApplied = (Array.isArray(appliedDeltas) ? appliedDeltas : []).filter(Boolean);
  if (!normalizedApplied.length) {
    return null;
  }
  const conversation = createConversationState({
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
    deltas: normalizedApplied.map((entry) => ({
      ...entry.delta,
      version: entry.toVersion,
      timestamp: entry.delta?.timestamp || entry.timestamp
    }))
  };
}

export function buildLegacySnapshotPayload(session, sessionView = null) {
  const conversation = createConversationState({
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
    buffer: normalizeBuffer(session?.buffer),
    turns: conversation.turns,
    backgroundAgents: conversation.backgroundAgents,
    conversation
  };
}

export function buildLegacyConversationSnapshotPayload(session, { fromVersion = null, toVersion = null } = {}) {
  const conversation = createConversationState({
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
    turns: conversation.turns,
    backgroundAgents: conversation.backgroundAgents,
    conversation
  };
}
