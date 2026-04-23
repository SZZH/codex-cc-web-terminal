import { createSseStreamWriter } from "./streamWriter.js";
import { createCanonicalEvent } from "../../canonical/createCanonicalEvent.js";
import { createCanonicalEventFromLegacy } from "../../canonical/fromLegacyEvent.js";
import { CANONICAL_EVENT_KINDS } from "../../canonical/eventKinds.js";
import {
  buildThreadTransportOverlay,
  buildThreadTransportSnapshot
} from "../../sessions/conversation/protocol.js";

function noop() {}

const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "aborted", "interrupted"]);
const TERMINAL_PAYLOAD_TYPES = new Set(["turn_completed", "turn_failed", "turn_aborted"]);

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
    return {
      type,
      data: String(event.data ?? event.input ?? "")
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
  if (input != null && String(input) !== "") {
    normalized.push({
      type: "input",
      data: String(input)
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
      const turnId = sessionManager.write(sessionId, event.data || "");
      if (turnId) {
        lastInputTurnId = String(turnId);
      }
      continue;
    }
    if (event.type === "interrupt") {
      sessionManager.write(sessionId, "\u001b");
    }
  }
  return { lastInputTurnId };
}

function isTerminalTurnStatus(status) {
  return TERMINAL_TURN_STATUSES.has(String(status || "").trim().toLowerCase());
}

function findTurnById(turns, turnId) {
  if (!Array.isArray(turns) || !turnId) {
    return null;
  }

  return turns.find((turn) => String(turn?.id || "") === turnId) || null;
}

function isPayloadTerminalForTurn(payload, trackedTurnId) {
  if (!payload || typeof payload !== "object" || !trackedTurnId) {
    return false;
  }

  const payloadType = String(payload.type || "").trim();
  const payloadTurnId = String(payload.turnId || payload?.payload?.turnId || payload?.payload?.turn_id || "");
  if (TERMINAL_PAYLOAD_TYPES.has(payloadType) && payloadTurnId === trackedTurnId) {
    return true;
  }
  if (payloadType === "thread.snapshot" && payloadTurnId === trackedTurnId && isTerminalTurnStatus(payload?.status)) {
    return true;
  }

  const conversationTurn =
    findTurnById(payload?.conversation?.turns, trackedTurnId) ||
    findTurnById(payload?.snapshot?.turns, trackedTurnId) ||
    findTurnById(payload?.turns, trackedTurnId) ||
    findTurnById(payload?.threadSnapshot?.turns, trackedTurnId) ||
    findTurnById(payload?.thread?.snapshot?.turns, trackedTurnId);

  return isTerminalTurnStatus(conversationTurn?.status);
}

function isSessionTerminalForTurn(session, trackedTurnId) {
  if (!session || !trackedTurnId) {
    return false;
  }

  const threadTurn = findTurnById(session?.threadSnapshot?.turns, trackedTurnId);
  if (isTerminalTurnStatus(threadTurn?.status)) {
    return true;
  }

  const conversationTurn = findTurnById(session?.conversationState?.turns, trackedTurnId);
  const assistantStatus = String(conversationTurn?.assistant?.status || "").trim().toLowerCase();
  return isTerminalTurnStatus(conversationTurn?.status) || isTerminalTurnStatus(assistantStatus);
}

function buildTransportFrames(payload, { session = null, trackedTurnId = "" } = {}) {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const type = String(payload.type || "").trim();
  if (type === "conversation.snapshot" || type === "conversation.delta") {
    return [{ kind: "snapshot", data: buildThreadTransportSnapshot(session, payload, { trackedTurnId }) }];
  }

  if (type === "message_part") {
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
  onBeforeClose = noop,
  onPayload = noop
}) {
  const writer = createSseStreamWriter(res);
  const closeSignal = createCloseSignal();
  let closed = false;
  let trackedTurnId = "";

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(keepaliveTimer);
    closeSignal.emit();
    try {
      onBeforeClose();
    } catch {
      // Ignore cleanup failures to avoid trapping the response open.
    }
    writer.close();
  };

  const client = {
    send(raw) {
      let payload = raw;
      let shouldCloseAfterSend = false;
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
            shouldCloseAfterSend = true;
          }
        });
      } catch {
        // Ignore payload hook failures to avoid breaking the stream.
      }
      if (!shouldCloseAfterSend && isPayloadTerminalForTurn(payload, trackedTurnId)) {
        shouldCloseAfterSend = true;
      }
      const session = sessionManager.get(sessionId);
      const frames = buildTransportFrames(payload, { session, trackedTurnId });
      for (const frame of frames) {
        if (frame.kind === "snapshot") {
          writer.sendSnapshot(frame.data);
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
      if (shouldCloseAfterSend) {
        close();
      }
    },
    on(eventName, handler) {
      closeSignal.on(eventName, handler);
    }
  };

  const keepaliveTimer = setInterval(() => {
    if (!closed) {
      writer.sendKeepalive();
    }
  }, Math.max(1000, Number(keepaliveMs) || 15000));
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
      const session = sessionManager.get(sessionId);
      if (isSessionTerminalForTurn(session, trackedTurnId)) {
        close();
      }
    },
    sendError(error) {
      writer.sendError(error);
    }
  };
}
