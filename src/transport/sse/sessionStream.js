import { createSseStreamWriter } from "./streamWriter.js";
import { createCanonicalEvent } from "../../canonical/createCanonicalEvent.js";
import { createCanonicalEventFromLegacy } from "../../canonical/fromLegacyEvent.js";
import { CANONICAL_EVENT_KINDS } from "../../canonical/eventKinds.js";
import { normalizeImageAttachmentReferences } from "../../sessions/shared/imageAttachments.js";
import {
  buildThreadTransportOverlay
} from "../../sessions/conversation/protocol.js";

function noop() {}

const DIRECT_TYPED_EVENT_TYPES = new Set([
  "message.delta",
  "message.completed",
  "reasoning.started",
  "reasoning.delta",
  "reasoning.completed",
  "process.started",
  "process.delta",
  "process.completed",
  "thread.status.updated",
  "thread.metrics.updated",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "transport.error",
  "session.updated"
]);

const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "aborted", "interrupted"]);
const TERMINAL_DELTA_KINDS = new Set(["turn_completed", "turn_status_changed"]);

function createCloseSignal() {
  const listeners = new Set();

  return {
    on(eventName, listener) {
      if (eventName === "close" && typeof listener === "function") {
        listeners.add(listener);
      }
    },
    emit() {
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // Ignore close listener failures during teardown.
        }
      }
      listeners.clear();
    }
  };
}

function normalizeInputEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }

  const type = String(event.type || "").trim();
  if (type === "input") {
    const attachments = normalizeImageAttachmentReferences(Object.hasOwn(event, "attachments") ? event.attachments : []);
    return {
      type,
      data: String(event.data ?? event.input ?? ""),
      ...(attachments.length ? { attachments } : {})
    };
  }

  if (type === "resize") {
    return {
      type,
      cols: event.cols,
      rows: event.rows
    };
  }

  if (type === "interrupt") {
    return {
      type,
      reason: String(event.reason || "user_interrupt")
    };
  }

  return null;
}

export function normalizeSessionInputEvents(body = {}) {
  if (Array.isArray(body?.events)) {
    return body.events.map(normalizeInputEvent).filter(Boolean);
  }

  const directEvent = normalizeInputEvent(body);
  if (directEvent) {
    return [directEvent];
  }

  const normalized = [];
  if (body && (body.cols != null || body.rows != null)) {
    normalized.push({
      type: "resize",
      cols: body.cols,
      rows: body.rows
    });
  }

  const input = body?.input ?? body?.data;
  const attachments = normalizeImageAttachmentReferences(Object.hasOwn(body || {}, "attachments") ? body.attachments : []);
  if ((input != null && String(input) !== "") || attachments.length) {
    normalized.push({
      type: "input",
      data: String(input ?? ""),
      ...(attachments.length ? { attachments } : {})
    });
  }

  return normalized;
}

export function applySessionInputEvents(sessionManager, sessionId, events = []) {
  let lastInputTurnId = "";
  for (const event of events) {
    if (!event) {
      continue;
    }
    if (event.type === "resize") {
      sessionManager.resize(sessionId, event.cols, event.rows);
      continue;
    }
    if (event.type === "input") {
      const turnId = event.attachments?.length
        ? sessionManager.write(sessionId, event.data || "", { attachments: event.attachments })
        : sessionManager.write(sessionId, event.data || "");
      if (turnId) {
        lastInputTurnId = String(turnId);
      }
      continue;
    }
    if (event.type === "interrupt") {
      sessionManager.interrupt(sessionId);
    }
  }
  return { lastInputTurnId };
}

function findTurnById(turns, turnId) {
  if (!Array.isArray(turns) || !turnId) {
    return null;
  }

  return turns.find((turn) => String(turn?.id || "") === turnId) || null;
}

function isTerminalTurnStatus(status) {
  return TERMINAL_TURN_STATUSES.has(String(status || "").trim().toLowerCase());
}

function payloadDeltaReferencesTurn(delta, trackedTurnId) {
  if (!delta || typeof delta !== "object" || !trackedTurnId) {
    return false;
  }
  return [delta.turnId, delta.turn_id, delta.clientTurnId, delta.localTurnId]
    .map((value) => String(value || "").trim())
    .some((value) => value === trackedTurnId);
}

function resolveTrackedTurnIds(session, trackedTurnId = "") {
  const id = String(trackedTurnId || "").trim();
  if (!id) {
    return [];
  }
  const ids = new Set([id]);
  const aliases = session?.turnIdAliases instanceof Map ? session.turnIdAliases : null;
  if (aliases) {
    const direct = String(aliases.get(id) || "").trim();
    if (direct) {
      ids.add(direct);
    }
    for (const [clientId, serverId] of aliases.entries()) {
      if (String(serverId || "").trim() === id) {
        ids.add(String(clientId || "").trim());
      }
    }
  }
  return [...ids].filter(Boolean);
}

function payloadReferencesAnyTurn(payload, trackedTurnIds = []) {
  if (!payload || typeof payload !== "object" || !trackedTurnIds.length) {
    return false;
  }

  const payloadTurnId = String(payload.turnId || payload?.turn?.id || payload?.payload?.turnId || payload?.payload?.turn_id || "").trim();
  if (payloadTurnId && trackedTurnIds.includes(payloadTurnId)) {
    return true;
  }

  if (Array.isArray(payload?.deltas) && payload.deltas.some((delta) => trackedTurnIds.some((turnId) => payloadDeltaReferencesTurn(delta, turnId)))) {
    return true;
  }

  return trackedTurnIds.some((turnId) =>
    Boolean(
      findTurnById(payload?.conversation?.turns, turnId) ||
        findTurnById(payload?.snapshot?.turns, turnId) ||
        findTurnById(payload?.turns, turnId) ||
        findTurnById(payload?.threadSnapshot?.turns, turnId) ||
        findTurnById(payload?.thread?.snapshot?.turns, turnId)
    )
  );
}

function payloadCompletesTrackedTurn(payload, trackedTurnIds = []) {
  if (!payload || typeof payload !== "object" || !trackedTurnIds.length) {
    return false;
  }
  const type = String(payload.type || "").trim();
  if ((type === "turn.completed" || type === "turn.failed" || type === "turn.interrupted") && payloadReferencesAnyTurn(payload, trackedTurnIds)) {
    return true;
  }
  if (type !== "conversation.delta" || !Array.isArray(payload.deltas)) {
    return false;
  }
  return payload.deltas.some((delta) => (
    (
      String(delta?.kind || "").trim() === "conversation_replaced"
        ? trackedTurnIds.some((turnId) =>
            findTurnById(delta?.conversation?.turns, turnId) &&
            isTerminalTurnStatus(findTurnById(delta?.conversation?.turns, turnId)?.assistant?.status || findTurnById(delta?.conversation?.turns, turnId)?.status)
          )
        : TERMINAL_DELTA_KINDS.has(String(delta?.kind || "").trim()) &&
          trackedTurnIds.some((turnId) => payloadDeltaReferencesTurn(delta, turnId)) &&
          isTerminalTurnStatus(delta?.status)
    )
  ));
}

function collectCompletedTurnIds(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const type = String(payload.type || "").trim();
  const ids = [];
  const pushId = (value) => {
    const id = String(value || "").trim();
    if (id && !ids.includes(id)) {
      ids.push(id);
    }
  };
  if (type === "turn.completed" || type === "turn.failed" || type === "turn.interrupted") {
    pushId(payload.turnId || payload?.payload?.turnId || payload?.payload?.turn_id);
  }
  if (type === "conversation.delta" && Array.isArray(payload.deltas)) {
    for (const delta of payload.deltas) {
      if (String(delta?.kind || "").trim() === "conversation_replaced") {
        for (const turn of Array.isArray(delta?.conversation?.turns) ? delta.conversation.turns : []) {
          if (isTerminalTurnStatus(turn?.assistant?.status || turn?.status)) {
            pushId(turn?.id);
          }
        }
        continue;
      }
      if (!TERMINAL_DELTA_KINDS.has(String(delta?.kind || "").trim()) || !isTerminalTurnStatus(delta?.status)) {
        continue;
      }
      pushId(delta.turnId);
      pushId(delta.turn_id);
      pushId(delta.clientTurnId);
      pushId(delta.localTurnId);
    }
  }
  return ids;
}

function filterConversationDeltaForTrackedTurns(payload, trackedTurnIds = []) {
  if (!payload || typeof payload !== "object" || !trackedTurnIds.length || !Array.isArray(payload.deltas)) {
    return null;
  }
  const deltas = payload.deltas.filter((delta) => {
    if (String(delta?.kind || "").trim() === "conversation_replaced") {
      return false;
    }
    return trackedTurnIds.some((turnId) => payloadDeltaReferencesTurn(delta, turnId));
  });
  if (!deltas.length) {
    return null;
  }
  return {
    type: payload.type,
    protocolVersion: payload.protocolVersion,
    timestamp: payload.timestamp,
    sessionId: payload.sessionId,
    threadId: payload.threadId,
    fromVersion: payload.fromVersion,
    toVersion: payload.toVersion,
    conversationStatus: payload.conversationStatus,
    continuation: payload.continuation || null,
    liveOverlay: payload.liveOverlay || null,
    deltas
  };
}

function buildTransportFrames(payload, { session = null, trackedTurnId = "" } = {}) {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const type = String(payload.type || "").trim();
  const sessionId = String(session?.id || "");
  const threadId = String(session?.resumeSessionId || session?.threadSnapshot?.threadId || "");
  const trackedTurnIds = resolveTrackedTurnIds(session, trackedTurnId);
  if (type === "conversation.snapshot") {
    return [];
  }
  if (type === "conversation.delta") {
    const filtered = filterConversationDeltaForTrackedTurns(payload, trackedTurnIds);
    return filtered ? [{ kind: "typed", data: filtered }] : [];
  }

  if (DIRECT_TYPED_EVENT_TYPES.has(type)) {
    const isTurnScopedTypedEvent =
      type.startsWith("message.") ||
      type.startsWith("reasoning.") ||
      type.startsWith("process.") ||
      type.startsWith("turn.");
    if (isTurnScopedTypedEvent && !payloadReferencesAnyTurn(payload, trackedTurnIds)) {
      return [];
    }
    return [{ kind: "typed", data: payload }];
  }

  if (type === "message_part") {
    const partType = String(payload?.part?.type || "").trim().toLowerCase();
    const text = String(payload?.part?.text || "");
    const turnId = String(
      payload?.turnId ||
      trackedTurnId ||
      ""
    ).trim();
    if (!turnId || !trackedTurnIds.includes(turnId)) {
      return [];
    }
    if ((partType === "text" || partType === "markdown") && text.trim() && turnId) {
      return [{
        kind: "typed",
        data: {
          type: String(payload?.phase || "").trim().toLowerCase() === "streaming" ? "message.delta" : "message.completed",
          sessionId,
          threadId,
          turnId,
          role: String(payload?.role || "assistant"),
          text,
          format: String(payload?.part?.format || "markdown"),
          ts: payload?.timestamp || undefined,
          phase: payload?.phase || undefined
        }
      }];
    }
    if (["tool", "event", "subagent", "reference"].includes(partType) && turnId) {
      const summary = String(
        payload?.part?.summary ||
        payload?.part?.text ||
        payload?.part?.payload?.summary ||
        payload?.part?.payload?.message ||
        payload?.part?.rawType ||
        partType
      ).trim();
      if (summary) {
        const phase = String(payload?.phase || "").trim().toLowerCase();
        return [{
          kind: "typed",
          data: {
            type: phase === "streaming" ? "process.started" : "process.completed",
            sessionId,
            threadId,
            turnId,
            role: String(payload?.role || "assistant"),
            processId: String(
              payload?.part?.payload?.id ||
              payload?.part?.payload?.callId ||
              payload?.part?.payload?.call_id ||
              payload?.part?.payload?.command ||
              payload?.part?.rawType ||
              partType
            ),
            processType: String(payload?.part?.rawType || partType),
            summary,
            payload: payload?.part?.payload || {},
            ts: payload?.timestamp || undefined,
            phase: payload?.phase || undefined
          }
        }];
      }
    }
    const overlay = buildThreadTransportOverlay(session, payload, { trackedTurnId });
    return overlay ? [{ kind: "overlay", data: overlay }] : [];
  }

  const legacyCanonicalEvent = createCanonicalEventFromLegacy(payload, {
    provider: session?.provider || "",
    providerThreadId: String(session?.resumeSessionId || session?.threadSnapshot?.threadId || "")
  });
  if (legacyCanonicalEvent) {
    return [{ kind: "canonical", data: legacyCanonicalEvent }];
  }

  if (type === "exit") {
    const snapshot = session?.threadSnapshot || null;
    const turnId = String(trackedTurnId || snapshot?.activeTurnId || "");
    if (!turnId) {
      return [];
    }
    return [
      {
        kind: "canonical",
        data: createCanonicalEvent({
          id: `canonical:${session?.id || "session"}:exit:${snapshot?.lastEventSeq || 0}`,
          seq: Number(snapshot?.lastEventSeq || 0),
          provider: String(session?.provider || "unknown"),
          providerThreadId: String(session?.resumeSessionId || snapshot?.threadId || ""),
          threadId: String(session?.resumeSessionId || snapshot?.threadId || ""),
          turnId,
          ts: payload?.timestamp,
          kind: CANONICAL_EVENT_KINDS.TURN_INTERRUPTED,
          payload: {
            exitCode: payload?.exitCode ?? null,
            reason: "session.exit"
          }
        })
      }
    ];
  }

  return [];
}

export function openSessionSseStream({
  req,
  res,
  sessionManager,
  sessionId,
  keepaliveMs = 15000,
  terminalCloseDelayMs = 1500,
  onBeforeClose = noop,
  onPayload = noop
}) {
  const writer = createSseStreamWriter(res);
  const closeSignal = createCloseSignal();
  let closed = false;
  let trackedTurnId = "";
  let terminalCloseTimer = null;
  let terminalClosePending = false;
  const completedTurnIds = new Set();
  const pendingPayloads = [];

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    clearTimeout(terminalCloseTimer);
    clearInterval(keepaliveTimer);
    closeSignal.emit();
    try {
      onBeforeClose();
    } catch {
      // Ignore cleanup failures to avoid trapping the response open.
    }
    writer.close();
  };

  const scheduleTerminalClose = () => {
    if (closed) {
      return;
    }
    terminalClosePending = true;
    clearTimeout(terminalCloseTimer);
    terminalCloseTimer = setTimeout(() => {
      terminalClosePending = false;
      close();
    }, Math.max(0, Number(terminalCloseDelayMs) || 0));
    terminalCloseTimer.unref?.();
  };

  const processPayload = (payload) => {
    let shouldScheduleTerminalClose = false;
    const session = sessionManager.get(sessionId);
    const trackedTurnIds = resolveTrackedTurnIds(session, trackedTurnId);
    const payloadTouchesTrackedTurn = payloadReferencesAnyTurn(payload, trackedTurnIds);
    if (payloadTouchesTrackedTurn) {
      clearTimeout(terminalCloseTimer);
      if (terminalClosePending) {
        shouldScheduleTerminalClose = true;
      }
    }
    if (!shouldScheduleTerminalClose && payloadCompletesTrackedTurn(payload, trackedTurnIds)) {
      shouldScheduleTerminalClose = true;
    }
    const frames = buildTransportFrames(payload, { session, trackedTurnId });
    for (const frame of frames) {
      if (frame.kind === "snapshot") {
        writer.sendSnapshot(frame.data);
        continue;
      }
      if (frame.kind === "typed") {
        writer.sendTypedEvent(frame.data);
        continue;
      }
      if (frame.kind === "overlay") {
        writer.sendOverlay(frame.data);
        continue;
      }
      if (frame.kind === "canonical") {
        writer.sendCanonicalEvent(frame.data);
      }
    }
    if (shouldScheduleTerminalClose) {
      scheduleTerminalClose();
    }
  };

  const client = {
    send(raw) {
      let payload = raw;
      let shouldScheduleTerminalClose = false;
      if (typeof raw === "string") {
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = { type: "message", raw };
        }
      }
      try {
        onPayload(payload, {
          close,
          closeAfterSend() {
            shouldScheduleTerminalClose = true;
          }
        });
      } catch {
        // Ignore payload hook failures to avoid breaking the stream.
      }
      for (const turnId of collectCompletedTurnIds(payload)) {
        completedTurnIds.add(turnId);
      }
      if (shouldScheduleTerminalClose) {
        scheduleTerminalClose();
      }
      if (!trackedTurnId) {
        pendingPayloads.push(payload);
        return;
      }
      processPayload(payload);
    },
    on(eventName, handler) {
      closeSignal.on(eventName, handler);
    }
  };

  const keepaliveTimer = setInterval(() => {
    if (!closed) {
      writer.sendKeepalive();
    }
  }, Math.max(1, Number(keepaliveMs) || 15000));
  keepaliveTimer.unref?.();

  req.on("close", close);
  req.on("aborted", close);
  res.on("close", close);
  res.on("finish", close);

  writer.open();
  try {
    sessionManager.attachClient(sessionId, client, { skipInitialSnapshot: true });
  } catch (error) {
    close();
    throw error;
  }

  return {
    close,
    setTrackedTurnId(turnId) {
      trackedTurnId = String(turnId || "").trim();
      if (!trackedTurnId) {
        return;
      }
      for (const payload of pendingPayloads.splice(0)) {
        processPayload(payload);
      }
      if (completedTurnIds.has(trackedTurnId)) {
        scheduleTerminalClose();
      }
    },
    sendError(error) {
      writer.sendError(error);
    }
  };
}
