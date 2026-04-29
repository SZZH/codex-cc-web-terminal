import { SSE_TRANSPORT_EVENTS, serializeSseFrame } from "./eventSerializer.js";

function noop() {}

function normalizeTypedTransportPayload(payload = {}) {
  const type = String(payload?.type || "").trim();
  const typedEvents = new Set([
    "thread.snapshot",
    "thread.overlay",
    "canonical.event",
    "keepalive",
    "error",
    "message.delta",
    "message.completed",
    "reasoning.started",
    "reasoning.delta",
    "reasoning.completed",
    "process.started",
    "process.delta",
    "process.completed",
    "session.updated",
    "thread.status.updated",
    "thread.metrics.updated",
    "turn.started",
    "turn.completed",
    "turn.failed",
    "turn.interrupted",
    "transport.error"
  ]);

  if (!typedEvents.has(type)) {
    throw new Error(`Unsupported typed SSE payload: ${type || "unknown"}`);
  }

  if (type === "thread.snapshot") {
    return {
      event: SSE_TRANSPORT_EVENTS.SNAPSHOT,
      payload,
      id: payload.version || undefined
    };
  }

  if (type === "thread.overlay") {
    return {
      event: SSE_TRANSPORT_EVENTS.OVERLAY,
      payload,
      id: payload?.message?.seq ?? payload?.reasoning?.seq
    };
  }

  if (type === "message.delta" || type === "message.completed") {
    return {
      event: type,
      payload,
      id: payload?.ts || undefined
    };
  }

  if (type === "reasoning.started" || type === "reasoning.delta" || type === "reasoning.completed") {
    return {
      event: type,
      payload,
      id: payload?.ts || undefined
    };
  }

  if (type === "process.started" || type === "process.delta" || type === "process.completed") {
    return {
      event: type,
      payload,
      id: payload?.ts || undefined
    };
  }

  if (type === "session.updated") {
    return {
      event: "session.updated",
      payload,
      id: payload?.session?.updatedAt || undefined
    };
  }

  if (type === "turn.completed") {
    return {
      event: type,
      payload,
      id: payload?.turnId || payload?.ts || undefined
    };
  }

  if (type === "turn.started" || type === "turn.failed" || type === "turn.interrupted") {
    return {
      event: type,
      payload,
      id: payload?.turnId || payload?.ts || undefined
    };
  }

  if (type === "thread.status.updated" || type === "thread.metrics.updated") {
    return {
      event: type,
      payload,
      id: payload?.ts || undefined
    };
  }

  if (type === "transport.error" || type === "error") {
    return {
      event: SSE_TRANSPORT_EVENTS.ERROR,
      payload,
      id: payload?.ts || undefined
    };
  }

  if (type === "keepalive") {
    return {
      event: SSE_TRANSPORT_EVENTS.KEEPALIVE,
      payload,
      id: undefined
    };
  }

  return {
    event: SSE_TRANSPORT_EVENTS.CANONICAL_EVENT,
    payload,
    id: payload?.seq || undefined
  };
}

export function createSseStreamWriter(target = {}) {
  const write = typeof target.write === "function" ? target.write.bind(target) : noop;
  const flushHeaders =
    typeof target.flushHeaders === "function" ? target.flushHeaders.bind(target) : noop;
  const end = typeof target.end === "function" ? target.end.bind(target) : noop;

  return {
    open() {
      flushHeaders();
    },

    send({ event, data, id }) {
      // Transport 层只负责发帧，不负责决定 snapshot/overlay 如何生成。
      write(serializeSseFrame({ event, data, id }));
    },

    sendTypedEvent(payload) {
      const normalized = normalizeTypedTransportPayload(payload);
      this.send({
        event: normalized.event,
        data: normalized.payload,
        id: normalized.id
      });
    },

    sendSnapshot(snapshot) {
      this.send({
        event: SSE_TRANSPORT_EVENTS.SNAPSHOT,
        data: snapshot,
        id: snapshot?.version
      });
    },

    sendOverlay(overlay) {
      this.send({
        event: SSE_TRANSPORT_EVENTS.OVERLAY,
        data: overlay,
        id: overlay?.message?.seq ?? overlay?.reasoning?.seq
      });
    },

    sendCanonicalEvent(event) {
      this.send({
        event: SSE_TRANSPORT_EVENTS.CANONICAL_EVENT,
        data: event,
        id: event?.seq
      });
    },

    sendKeepalive() {
      this.send({
        event: SSE_TRANSPORT_EVENTS.KEEPALIVE,
        data: { ok: true }
      });
    },

    sendError(error) {
      this.send({
        event: SSE_TRANSPORT_EVENTS.ERROR,
        data: {
          message: error?.message ?? String(error ?? "Unknown SSE transport error")
        }
      });
    },

    close() {
      end();
    }
  };
}
