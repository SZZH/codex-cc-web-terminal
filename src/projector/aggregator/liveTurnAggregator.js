import { CANONICAL_EVENT_KINDS } from "../../canonical/index.js";
import { createLiveTurnOverlay } from "../snapshot.js";

function mergeLiveText(previousText, nextText) {
  const prev = String(previousText || "");
  const next = String(nextText || "");

  if (!prev) {
    return next;
  }
  if (!next) {
    return prev;
  }
  if (next === prev) {
    return prev;
  }
  if (next.startsWith(prev)) {
    return next;
  }
  if (prev.startsWith(next)) {
    return prev;
  }
  return `${prev}${next}`;
}

function ensureTool(overlay, payload, ts) {
  const callId = String(payload.callId ?? "");
  let tool = overlay.tools.find((item) => item.callId === callId);

  if (!tool) {
    tool = {
      kind: "ToolCall",
      id: `tool:${callId || overlay.tools.length + 1}`,
      callId,
      toolName: payload.toolName ?? "unknown",
      status: "running",
      summary: payload.inputSummary ?? "",
      createdAt: ts,
      updatedAt: ts
    };
    overlay.tools.push(tool);
  }

  return tool;
}

export function createLiveTurnAggregator({ threadId, turnId }) {
  let overlay = createLiveTurnOverlay({ threadId, turnId });
  const messages = new Map();

  function applyMessage(event) {
    const payload = event.payload || {};
    const key = String(payload.messageId || "");
    // Deltas without an item ID can precede the first authoritative completed item.
    if (key && !messages.has(key) && messages.size === 1 && messages.has("") && !messages.get("").completed) {
      messages.set(key, messages.get(""));
      messages.delete("");
    }
    const previous = messages.get(key);
    const completed = event.kind === CANONICAL_EVENT_KINDS.MESSAGE_COMPLETED;
    if (!completed && previous?.completed) return;
    messages.set(key, {
      text: completed ? String(payload.text ?? "") : `${previous?.text || ""}${String(payload.text ?? "")}`,
      completed
    });
    overlay.message = {
      text: [...messages.values()].map((message) => message.text).join("\n\n"),
      seq: event.seq
    };
  }

  return {
    getOverlay() {
      return overlay.turnId ? overlay : null;
    },

    reset(next = {}) {
      messages.clear();
      overlay = createLiveTurnOverlay({
        threadId: next.threadId ?? threadId,
        turnId: next.turnId ?? turnId
      });
      return overlay;
    },

    applyEvent(event) {
      // Aggregator 只维护 active turn 的临时 overlay，不直接写 history snapshot。
      if (!event.turnId || event.turnId !== overlay.turnId) {
        return overlay;
      }

      const ts = event.ts;
      const payload = event.payload ?? {};

      switch (event.kind) {
        case CANONICAL_EVENT_KINDS.MESSAGE_DELTA:
        case CANONICAL_EVENT_KINDS.MESSAGE_COMPLETED:
          applyMessage(event);
          break;
        case CANONICAL_EVENT_KINDS.REASONING_DELTA:
        case CANONICAL_EVENT_KINDS.REASONING_COMPLETED:
          overlay.reasoning = {
            text: mergeLiveText(overlay.reasoning?.text, payload.text),
            seq: event.seq
          };
          break;
        case CANONICAL_EVENT_KINDS.TOOL_STARTED: {
          ensureTool(overlay, payload, ts);
          break;
        }
        case CANONICAL_EVENT_KINDS.TOOL_PROGRESS: {
          const tool = ensureTool(overlay, payload, ts);
          tool.summary = payload.progressText ?? tool.summary;
          tool.updatedAt = ts;
          break;
        }
        case CANONICAL_EVENT_KINDS.TOOL_COMPLETED:
        case CANONICAL_EVENT_KINDS.TOOL_FAILED: {
          const tool = ensureTool(overlay, payload, ts);
          tool.status = payload.status ?? (event.kind === CANONICAL_EVENT_KINDS.TOOL_FAILED ? "failed" : "completed");
          tool.summary = payload.outputSummary ?? payload.message ?? tool.summary;
          tool.updatedAt = ts;
          break;
        }
        case CANONICAL_EVENT_KINDS.ARTIFACT_CREATED:
        case CANONICAL_EVENT_KINDS.ARTIFACT_UPDATED:
          overlay.artifacts.push({
            kind: "Artifact",
            id: `artifact:${payload.artifactId ?? event.seq}`,
            artifactKind: payload.artifactKind ?? "other",
            label: payload.label,
            url: payload.url,
            metadata: payload.metadata ? { ...payload.metadata } : undefined,
            createdAt: ts,
            updatedAt: ts
          });
          break;
        default:
          break;
      }

      return overlay;
    }
  };
}
