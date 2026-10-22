import {
  buildConversationDeltaPayload,
  buildConversationSnapshotPayload,
  buildLegacyConversationSnapshotPayload
} from "./protocol.js";
import {
  applyConversationDeltas as applyConversationStateDeltas,
  createConversationState
} from "./state.js";
import { deriveConversationStateFromThreadSnapshot } from "../../threads/index.js";
import { nowIso } from "../shared/text.js";
import { getThreadProjection, syncProjectedThreadState } from "./legacyThreadProjection.js";

export function ensureConversationState(manager, session, { status = "" } = {}) {
  if (!session) {
    return createConversationState();
  }
  if (session.threadSnapshot) {
    session.conversationState = deriveConversationStateFromThreadSnapshot(session.threadSnapshot, {
      sessionId: String(session.id || ""),
      threadId: String(session.resumeSessionId || session.threadSnapshot?.threadId || ""),
      status: status || session.conversationState?.status || "idle"
    });
    return session.conversationState;
  }
  session.conversationState = createConversationState({
    ...(session.conversationState || {}),
    sessionId: String(session.id || ""),
    threadId: String(session.resumeSessionId || session.conversationState?.threadId || ""),
    status: status || session.conversationState?.status || "idle",
    updatedAt: session.updatedAt || session.conversationState?.updatedAt || nowIso()
  });
  return session.conversationState;
}

export function syncConversationStateFromThreadSnapshot(manager, session, { status = "" } = {}) {
  if (!session) {
    return createConversationState();
  }
  const snapshot = manager.ensureThreadSnapshot(session);
  session.conversationState = deriveConversationStateFromThreadSnapshot(snapshot, {
    sessionId: String(session.id || ""),
    threadId: String(session.resumeSessionId || snapshot?.threadId || ""),
    status: status || session.conversationState?.status || "idle"
  });
  return session.conversationState;
}

export function seedConversationStateFromHistory(manager, session, provider = null) {
  if (!session) {
    return createConversationState();
  }
  if (!session.resumeSessionId) {
    return manager.ensureConversationState(session);
  }
  if ((session.conversationState?.turns || []).length > 0) {
    return manager.ensureConversationState(session);
  }
  const resolvedProvider = provider || manager.getProvider(session.provider);
  try {
    const historical = manager.historyService.getHistoricalMessages(resolvedProvider, session.resumeSessionId);
    session.conversationState = createConversationState({
      ...(historical?.conversation || {}),
      sessionId: String(session.id || ""),
      threadId: String(session.resumeSessionId || ""),
      updatedAt: session.updatedAt || nowIso()
    });
    return session.conversationState;
  } catch {
    return manager.ensureConversationState(session);
  }
}

export function applyConversationDeltas(manager, session, deltas = [], { broadcast: shouldBroadcast = true } = {}) {
  if (!session) {
    return [];
  }
  const previous = createConversationState(session.conversationState);
  const normalizedDeltas = (Array.isArray(deltas) ? deltas : []).filter(Boolean);
  const { state, applied } = applyConversationStateDeltas(previous, normalizedDeltas);
  session.conversationState = createConversationState({
    ...state,
    sessionId: String(session.id || state.sessionId || ""),
    threadId: String(session.resumeSessionId || state.threadId || "")
  });
  if (shouldBroadcast) {
    manager.broadcastConversationDelta(session, applied);
  }
  return applied;
}

export function broadcastDerivedConversationDelta(manager, session, previousState = null) {
  if (!session) {
    return;
  }
  const before = createConversationState(previousState || {});
  const after = manager.ensureConversationState(session);
  if (before.version === after.version) {
    return;
  }
  manager.broadcastConversationDelta(session, [
    {
      delta: {
        kind: "conversation_replaced",
        conversation: after,
        sessionId: after.sessionId,
        threadId: after.threadId,
        timestamp: after.updatedAt
      },
      fromVersion: before.version,
      toVersion: after.version,
      timestamp: after.updatedAt
    }
  ]);
}

export function broadcastConversationSnapshot(manager, session) {
  if (!session) {
    return;
  }
  manager.syncConversationStateFromThreadSnapshot(session);
  const sessionView = manager.serialize(session);
  const snapshotPayload = buildConversationSnapshotPayload(session, sessionView);
  manager.broadcast(session, snapshotPayload);
  manager.broadcast(
    session,
    buildLegacyConversationSnapshotPayload(session, {
      fromVersion: snapshotPayload.conversation?.version || 0,
      toVersion: snapshotPayload.conversation?.version || 0
    })
  );
}

export function broadcastConversationDelta(manager, session, applied = []) {
  if (!session) {
    return;
  }
  manager.syncConversationStateFromThreadSnapshot(session);
  const payload = buildConversationDeltaPayload(session, applied);
  if (!payload) {
    return;
  }
  manager.broadcast(session, payload);
  manager.broadcast(
    session,
    buildLegacyConversationSnapshotPayload(session, {
      fromVersion: payload.fromVersion,
      toVersion: payload.toVersion
    })
  );
}

export function getConversationSnapshot(manager, id) {
  const session = manager.get(id);
  if (!session) {
    return null;
  }
  manager.ensureConversationState(session);
  manager.ensureThreadSnapshot(session);
  getThreadProjection(session);
  syncProjectedThreadState(session, { previousSnapshot: session.threadSnapshot });
  return buildConversationSnapshotPayload(session, manager.serialize(session));
}
