import {
  createRawRecord,
  canonicalizeRawRecord,
  createCanonicalizerState
} from "../../threads/index.js";
import { createCanonicalEventFromLegacy } from "../../canonical/index.js";
import { createLegacyThreadProjection } from "../../projector/index.js";
import { nowIso } from "../shared/text.js";

function buildThreadTurnSignature(turn = null) {
  if (!turn || typeof turn !== "object") {
    return "";
  }
  const items = Array.isArray(turn.items)
    ? turn.items.map((item) => ({
        id: String(item?.id || ""),
        kind: String(item?.kind || ""),
        text: String(item?.text || ""),
        type: String(item?.type || ""),
        status: String(item?.status || "")
      }))
    : [];
  return JSON.stringify({
    id: String(turn.id || ""),
    status: String(turn.status || ""),
    items
  });
}

function hasThreadSnapshotMeaningfulAdvance(incomingSnapshot, currentSnapshot) {
  if (!incomingSnapshot || typeof incomingSnapshot !== "object") {
    return false;
  }
  if (!currentSnapshot || typeof currentSnapshot !== "object") {
    return true;
  }

  const incomingTurns = Array.isArray(incomingSnapshot.turns) ? incomingSnapshot.turns : [];
  const currentTurns = Array.isArray(currentSnapshot.turns) ? currentSnapshot.turns : [];

  if (incomingTurns.length !== currentTurns.length) {
    return true;
  }

  const currentById = new Map(currentTurns.map((turn) => [String(turn?.id || "").trim(), turn]));
  for (const incomingTurn of incomingTurns) {
    const incomingTurnId = String(incomingTurn?.id || "").trim();
    const currentTurn = currentById.get(incomingTurnId);
    if (!currentTurn) {
      return true;
    }
    if (buildThreadTurnSignature(incomingTurn) !== buildThreadTurnSignature(currentTurn)) {
      return true;
    }
  }

  return false;
}

function parseSnapshotUpdatedAt(snapshot) {
  const value = String(snapshot?.updatedAt || "").trim();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function snapshotHasTurn(snapshot, turnId = "") {
  const targetTurnId = String(turnId || "").trim();
  if (!targetTurnId) {
    return false;
  }
  return Array.isArray(snapshot?.turns) && snapshot.turns.some((turn) => String(turn?.id || "").trim() === targetTurnId);
}

export function buildThreadProjection(session) {
  const projection = createLegacyThreadProjection({
    threadId: String(session?.resumeSessionId || session?.threadSnapshot?.threadId || session?.id || ""),
    snapshot: session?.threadSnapshot || null
  });
  session.threadProjection = projection;
  return projection;
}

export function getThreadProjection(session) {
  if (session?.threadProjection) {
    return session.threadProjection;
  }
  return buildThreadProjection(session);
}

export function syncProjectedThreadState(session, { previousSnapshot = null } = {}) {
  const projection = getThreadProjection(session);
  const projected = projection.getLegacyState(previousSnapshot || session.threadSnapshot || null);
  session.threadSnapshot = projected.threadSnapshot;
  session.liveOverlay = projected.liveOverlay;
  return projected;
}

export function ensureThreadSnapshot(manager, session) {
  if (!session) {
    return null;
  }
  session.threadSnapshot ||= {
    threadId: String(session.resumeSessionId || session.id || ""),
    metadata: {
      name: session.name || "",
      preview: session.inputPreview || "",
      model: session.model || "",
      cwd: session.cwd || "",
      source: session.provider || ""
    },
    turns: [],
    runtime: { latestTurnContext: null },
    metrics: { latestUsage: null },
    version: 0,
    lastEventSeq: 0,
    updatedAt: session.updatedAt || nowIso(),
    activeTurnId: null
  };
  session.threadSnapshot.threadId = String(session.resumeSessionId || session.threadSnapshot.threadId || session.id || "");
  session.threadSnapshot.metadata = {
    ...session.threadSnapshot.metadata,
    name: session.name || "",
    preview: session.inputPreview || "",
    model: session.model || "",
    cwd: session.cwd || "",
    source: session.provider || ""
  };
  return session.threadSnapshot;
}

export function seedThreadSnapshotFromHistory(manager, session, provider = null) {
  if (!session) {
    return;
  }
  const current = manager.ensureThreadSnapshot(session);
  if ((current?.turns || []).length > 0) {
    buildThreadProjection(session);
    syncProjectedThreadState(session, { previousSnapshot: current });
    return;
  }
  if (!session.resumeSessionId) {
    buildThreadProjection(session);
    session.liveOverlay = null;
    return;
  }
  const resolvedProvider = provider || manager.getProvider(session.provider);
  try {
    const historical = manager.historyService.getHistoricalMessages(resolvedProvider, session.resumeSessionId);
    if (historical?.threadSnapshot) {
      session.threadSnapshot = {
        ...historical.threadSnapshot,
        metadata: {
          ...(historical.threadSnapshot.metadata || {}),
          name: session.name || historical.threadSnapshot.metadata?.name || "",
          preview: session.inputPreview || historical.threadSnapshot.metadata?.preview || "",
          model: session.model || historical.threadSnapshot.metadata?.model || "",
          cwd: session.cwd || historical.threadSnapshot.metadata?.cwd || "",
          source: session.provider || historical.threadSnapshot.metadata?.source || ""
        }
      };
      buildThreadProjection(session);
      syncProjectedThreadState(session, { previousSnapshot: session.threadSnapshot });
    }
  } catch {
    const ensured = manager.ensureThreadSnapshot(session);
    buildThreadProjection(session);
    syncProjectedThreadState(session, { previousSnapshot: ensured });
  }
}

export function applyThreadRawRecord(manager, session, record, { turnId = "" } = {}) {
  if (!session || !record) {
    return null;
  }
  const snapshot = manager.ensureThreadSnapshot(session);
  const rawRecord = createRawRecord({
    id: `raw:${session.id}:${snapshot.lastEventSeq + 1}`,
    threadId: String(session.resumeSessionId || snapshot.threadId || session.id || ""),
    turnId: String(turnId || record?.turnId || record?.turn_id || record?.payload?.turn_id || session.currentTurnId || snapshot.activeTurnId || ""),
    source: "session_manager",
    raw: record,
    seq: snapshot.lastEventSeq + 1,
    recordTs: record?.timestamp || record?.payload?.timestamp || nowIso()
  });
  const canonicalizerState = session.threadCanonicalizerState || createCanonicalizerState();
  session.threadCanonicalizerState = canonicalizerState;
  const events = canonicalizeRawRecord(rawRecord, canonicalizerState);
  if (!events.length) {
    return null;
  }
  const projection = getThreadProjection(session);
  for (const event of events) {
    const canonicalEvent = createCanonicalEventFromLegacy(event, {
      provider: session.provider,
      providerThreadId: String(session.resumeSessionId || snapshot.threadId || session.id || "")
    });
    if (!canonicalEvent) {
      continue;
    }
    projection.projector.applyEvent(canonicalEvent);
  }
  syncProjectedThreadState(session, { previousSnapshot: snapshot });
  manager.syncConversationStateFromThreadSnapshot(session);
  return session.threadSnapshot;
}

export function scheduleConversationHistoryResync(manager, session, { attempts = 12, delayMs = 2_000 } = {}) {
  if (!session?.resumeSessionId) {
    return;
  }
  const providerId = String(session.provider || "").trim();
  const resumeSessionId = String(session.resumeSessionId || "").trim();
  const sessionId = String(session.id || "");
  if (!providerId || !resumeSessionId || !sessionId) {
    return;
  }

  for (let index = 0; index < attempts; index += 1) {
    const waitMs = delayMs * (index + 1);
    setTimeout(() => {
      const live = manager.sessions.get(sessionId);
      if (!live || live.status === "exited") {
        return;
      }
      let historical;
      try {
        historical = manager.historyService.getHistoricalMessages(manager.getProvider(providerId), resumeSessionId);
      } catch {
        return;
      }
      const currentSnapshot = manager.ensureThreadSnapshot(live);
      const incomingSnapshot = historical?.threadSnapshot || null;
      const currentUpdatedAt = parseSnapshotUpdatedAt(currentSnapshot);
      const incomingUpdatedAt = parseSnapshotUpdatedAt(incomingSnapshot);
      const protectedTurnId = String(
        live.currentTurnId ||
        currentSnapshot?.activeTurnId ||
        live.conversationState?.activeTurnId ||
        ""
      ).trim();
      if (protectedTurnId && snapshotHasTurn(currentSnapshot, protectedTurnId) && !snapshotHasTurn(incomingSnapshot, protectedTurnId)) {
        return;
      }
      if (incomingUpdatedAt && currentUpdatedAt && incomingUpdatedAt < currentUpdatedAt) {
        return;
      }
      const shouldReplace =
        Number(incomingSnapshot?.lastEventSeq || 0) > Number(currentSnapshot?.lastEventSeq || 0) ||
        Number(incomingSnapshot?.version || 0) > Number(currentSnapshot?.version || 0) ||
        hasThreadSnapshotMeaningfulAdvance(incomingSnapshot, currentSnapshot);
      if (!shouldReplace) {
        return;
      }
      if (incomingSnapshot) {
        live.threadSnapshot = incomingSnapshot;
        buildThreadProjection(live);
        syncProjectedThreadState(live, { previousSnapshot: incomingSnapshot });
        if (!live.liveOverlay && historical.liveOverlay) {
          live.liveOverlay = historical.liveOverlay;
        }
      }
      manager.syncConversationStateFromThreadSnapshot(live);
      live.updatedAt = nowIso();
      manager.broadcastConversationSnapshot(live);
    }, waitMs).unref?.();
  }
}
