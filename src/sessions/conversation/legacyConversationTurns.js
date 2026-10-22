import crypto from "node:crypto";

import { createConversationState } from "./state.js";
import { normalizeRecordToDeltas } from "../normalize/turnDeltas.js";
import { nowIso } from "../shared/text.js";
import { buildThreadProjection, syncProjectedThreadState } from "./legacyThreadProjection.js";

export function createConversationTurn(manager, session, userText, timestamp = nowIso(), { activate = true, images = [] } = {}) {
  if (!session) {
    return null;
  }
  session.turnSequence = Math.max(0, Number(session.turnSequence) || 0) + 1;
  const suffix = typeof crypto.randomUUID === "function" ? crypto.randomUUID().slice(0, 8) : String(Date.now());
  const turnId = `${session.id}-turn-${Date.now()}-${session.turnSequence}-${suffix}`;
  if (activate) {
    session.currentTurnId = turnId;
    session.activePendingTurnId = turnId;
  }
  session.pendingLocalTurnIds ||= new Set();
  session.pendingLocalTurnIds.add(turnId);
  const previous = createConversationState(session.conversationState);
  manager.applyThreadRawRecord(
    session,
    {
      type: "event_msg",
      timestamp,
      payload: {
        type: "user_message",
        message: userText,
        content: [
          ...(userText ? [{ type: "input_text", text: userText }] : []),
          ...images.map((image) => ({ type: "local_image", path: image.path, name: image.name }))
        ],
        ...(images.length ? { local_images: images.map((image) => ({ path: image.path, name: image.name })) } : {})
      }
    },
    { turnId }
  );
  manager.broadcastDerivedConversationDelta(session, previous);
  return turnId;
}

export function bindConversationTurnAlias(manager, session, clientTurnId = "", serverTurnId = "", { source = "unknown" } = {}) {
  const clientId = String(clientTurnId || "").trim();
  const serverId = String(serverTurnId || "").trim();
  if (!session || !clientId || !serverId) {
    return false;
  }
  if (clientId === serverId) {
    return true;
  }

  session.turnIdAliases ||= new Map();
  session.turnAliasSources ||= new Map();
  const existingServer = session.turnIdAliases.get(clientId);
  const existingClient = [...session.turnIdAliases.entries()].find(
    ([leftClientId, rightServerId]) => rightServerId === serverId && leftClientId !== clientId
  )?.[0];
  if ((existingServer && existingServer !== serverId) || existingClient) {
    console.warn(
      `[conversation] turn alias conflict sessionId=${session.id || ""} clientTurnId=${clientId} serverTurnId=${serverId}`
    );
    return false;
  }

  session.turnIdAliases.set(clientId, serverId);
  session.turnAliasSources.set(`${clientId}->${serverId}`, String(source || "unknown"));
  session.pendingLocalTurnIds?.delete(clientId);
  session.pendingLocalTurnIds?.add(serverId);

  const renameTurns = (turns = []) =>
    (Array.isArray(turns) ? turns : []).map((turn) =>
      String(turn?.id || "").trim() === clientId
        ? {
            ...turn,
            id: serverId
          }
        : turn
    );

  if (session.threadSnapshot) {
    session.threadSnapshot = {
      ...session.threadSnapshot,
      activeTurnId: String(session.threadSnapshot.activeTurnId || "") === clientId ? serverId : session.threadSnapshot.activeTurnId,
      turns: renameTurns(session.threadSnapshot.turns)
    };
    buildThreadProjection(session);
    syncProjectedThreadState(session, { previousSnapshot: session.threadSnapshot });
  }

  if (session.conversationState) {
    session.conversationState = createConversationState({
      ...session.conversationState,
      activeTurnId: String(session.conversationState.activeTurnId || "") === clientId ? serverId : session.conversationState.activeTurnId,
      turns: renameTurns(session.conversationState.turns)
    });
  }

  if (String(session.currentTurnId || "") === clientId) {
    session.currentTurnId = serverId;
  }
  if (String(session.activePendingTurnId || "") === clientId) {
    session.activePendingTurnId = serverId;
  }
  session.queuedTurnIds = (Array.isArray(session.queuedTurnIds) ? session.queuedTurnIds : []).map((turnId) =>
    String(turnId || "") === clientId ? serverId : turnId
  );
  return true;
}

export function applyConversationRecord(manager, session, record, { turnId = session?.currentTurnId || session?.threadSnapshot?.activeTurnId || session?.conversationState?.activeTurnId || "" } = {}) {
  if (!session || !turnId) {
    return [];
  }
  const previous = createConversationState(session.conversationState);
  const explicitDeltas = normalizeRecordToDeltas(record, { turnId }).map((delta) => ({
    ...delta,
    sessionId: String(session.id || ""),
    threadId: String(session.resumeSessionId || session.conversationState?.threadId || ""),
    clientTurnId: String(record?.clientTurnId || ""),
    aliasSource: String(record?.aliasSource || "")
  }));
  manager.applyThreadRawRecord(session, record, { turnId });
  manager.syncConversationStateFromThreadSnapshot(session);
  if (explicitDeltas.length) {
    const after = createConversationState(session.conversationState);
    const finalVersion = Math.max(after.version, previous.version + explicitDeltas.length);
    const applied = explicitDeltas.map((delta, index) => ({
      delta,
      fromVersion: previous.version + index,
      toVersion: index === explicitDeltas.length - 1 ? finalVersion : previous.version + index + 1,
      timestamp: delta.timestamp || delta.block?.ts || delta.event?.ts || record?.timestamp || after.updatedAt
    }));
    manager.broadcastConversationDelta(session, applied);
  } else {
    manager.broadcastDerivedConversationDelta(session, previous);
  }
  if (String(record?.phase || "").toLowerCase() !== "streaming") {
    manager.broadcastConversationSnapshot(session);
  }
  return explicitDeltas;
}

export function hasConversationTurn(manager, session, turnId = "") {
  const targetTurnId = String(turnId || "").trim();
  if (!session || !targetTurnId) {
    return false;
  }
  return Boolean(
    (Array.isArray(session.threadSnapshot?.turns) &&
      session.threadSnapshot.turns.some((turn) => String(turn?.id || "").trim() === targetTurnId)) ||
      (Array.isArray(session.conversationState?.turns) &&
        session.conversationState.turns.some((turn) => String(turn?.id || "").trim() === targetTurnId))
  );
}

export function finalizeConversationTurn(manager, session, status = "completed", timestamp = nowIso(), options = {}) {
  const hasExplicitTurnId = Object.prototype.hasOwnProperty.call(options || {}, "turnId");
  const targetTurnId = String(
    hasExplicitTurnId
      ? options?.turnId || ""
      : session?.currentTurnId || session?.threadSnapshot?.activeTurnId || session?.conversationState?.activeTurnId || ""
  ).trim();
  if (!targetTurnId) {
    return false;
  }
  if (hasExplicitTurnId && !manager.hasConversationTurn(session, targetTurnId)) {
    return false;
  }
  const previous = createConversationState(session.conversationState);
  manager.applyThreadRawRecord(
    session,
    {
      type: "event_msg",
      timestamp,
      payload: {
        type: status === "failed" ? "task_failed" : status === "aborted" || status === "interrupted" ? "turn_aborted" : "task_complete",
        status,
        ...(status === "failed" ? { error: options.error || { message: "Codex execution failed." } } : {})
      }
    },
    { turnId: targetTurnId }
  );
  if (String(session.currentTurnId || "").trim() === targetTurnId) {
    session.currentTurnId = "";
  }
  if (String(session.activePendingTurnId || "").trim() === targetTurnId) {
    session.activePendingTurnId = "";
  }
  session.pendingLocalTurnIds?.delete(targetTurnId);
  manager.broadcastDerivedConversationDelta(session, previous);
  manager.broadcastConversationSnapshot(session);
  return true;
}

export function updateConversationTurnStatus(manager, session, status = "running", timestamp = nowIso()) {
  const targetTurnId = String(session?.currentTurnId || session?.threadSnapshot?.activeTurnId || session?.conversationState?.activeTurnId || "");
  if (!targetTurnId) {
    return;
  }
  manager.syncConversationStateFromThreadSnapshot(session, { status });
}
