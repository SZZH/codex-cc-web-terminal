import { createCanonicalEvent } from "./createCanonicalEvent.js";
import { CANONICAL_EVENT_KINDS } from "./eventKinds.js";
import { resolveProviderId } from "../providers/index.js";

function toToolPayload(payload = {}, defaults = {}) {
  return {
    callId: payload.callId ?? "",
    toolName: payload.name ?? defaults.toolName ?? "unknown",
    toolKind: defaults.toolKind ?? payload.toolKind ?? "dynamic",
    inputSummary:
      payload.args == null
        ? ""
        : typeof payload.args === "string"
          ? payload.args
          : JSON.stringify(payload.args),
    progressText: payload.summary ?? payload.text ?? "",
    outputSummary:
      payload.output == null
        ? ""
        : typeof payload.output === "string"
          ? payload.output
          : JSON.stringify(payload.output),
    status: payload.status ?? defaults.status
  };
}

function normalizeKind(legacyEvent) {
  switch (String(legacyEvent?.eventType || "")) {
    case "thread_metadata_initialized":
      return CANONICAL_EVENT_KINDS.THREAD_METADATA_UPDATED;
    case "turn_started":
      return CANONICAL_EVENT_KINDS.TURN_STARTED;
    case "turn_completed":
      return CANONICAL_EVENT_KINDS.TURN_COMPLETED;
    case "turn_failed":
      return CANONICAL_EVENT_KINDS.TURN_FAILED;
    case "turn_aborted":
      return CANONICAL_EVENT_KINDS.TURN_INTERRUPTED;
    case "user_message_recorded":
      return CANONICAL_EVENT_KINDS.USER_MESSAGE;
    case "agent_message_recorded":
      return String(legacyEvent?.payload?.phase || "").toLowerCase() === "streaming"
        ? CANONICAL_EVENT_KINDS.MESSAGE_DELTA
        : CANONICAL_EVENT_KINDS.MESSAGE_COMPLETED;
    case "reasoning_summary_recorded":
    case "reasoning_raw_recorded":
      return CANONICAL_EVENT_KINDS.REASONING_DELTA;
    case "command_execution_started":
    case "file_change_started":
    case "mcp_tool_call_started":
    case "dynamic_tool_call_started":
    case "collab_tool_call_started":
      return CANONICAL_EVENT_KINDS.TOOL_STARTED;
    case "command_execution_completed":
    case "file_change_completed":
    case "mcp_tool_call_completed":
    case "dynamic_tool_call_completed":
    case "collab_tool_call_completed":
      return CANONICAL_EVENT_KINDS.TOOL_COMPLETED;
    default:
      return null;
  }
}

function normalizePayload(legacyEvent, canonicalKind) {
  const payload = legacyEvent?.payload ?? {};
  switch (canonicalKind) {
    case CANONICAL_EVENT_KINDS.THREAD_METADATA_UPDATED:
      return payload;
    case CANONICAL_EVENT_KINDS.USER_MESSAGE:
      return {
        text: payload.text ?? "",
        content: Array.isArray(payload.content) ? [...payload.content] : []
      };
    case CANONICAL_EVENT_KINDS.MESSAGE_DELTA:
    case CANONICAL_EVENT_KINDS.MESSAGE_COMPLETED:
      return {
        text: payload.text ?? "",
        ...(payload.messageId ? { messageId: payload.messageId } : {}),
        source: payload.source ?? "primary_output_text",
        phase: payload.phase ?? null
      };
    case CANONICAL_EVENT_KINDS.REASONING_DELTA:
      return {
        text: payload.summary ?? payload.text ?? "",
        content: payload.content
      };
    case CANONICAL_EVENT_KINDS.TOOL_STARTED:
      if (legacyEvent.eventType === "command_execution_started") {
        return toToolPayload(payload, { toolKind: "command" });
      }
      if (legacyEvent.eventType === "file_change_started") {
        return toToolPayload(payload, { toolKind: "file_change" });
      }
      if (legacyEvent.eventType === "mcp_tool_call_started") {
        return toToolPayload(payload, { toolKind: "mcp" });
      }
      if (legacyEvent.eventType === "collab_tool_call_started") {
        return toToolPayload(payload, { toolKind: "collab" });
      }
      return toToolPayload(payload, { toolKind: "dynamic" });
    case CANONICAL_EVENT_KINDS.TOOL_COMPLETED:
      if (legacyEvent.eventType === "command_execution_completed") {
        return toToolPayload(payload, { toolKind: "command", status: payload.status ?? "completed" });
      }
      if (legacyEvent.eventType === "file_change_completed") {
        return toToolPayload(payload, { toolKind: "file_change", status: payload.status ?? "completed" });
      }
      if (legacyEvent.eventType === "mcp_tool_call_completed") {
        return toToolPayload(payload, { toolKind: "mcp", status: payload.status ?? "completed" });
      }
      if (legacyEvent.eventType === "collab_tool_call_completed") {
        return toToolPayload(payload, { toolKind: "collab", status: payload.status ?? "completed" });
      }
      return toToolPayload(payload, { toolKind: "dynamic", status: payload.status ?? "completed" });
    default:
      return payload;
  }
}

export function createCanonicalEventFromLegacy(legacyEvent, { provider = "", providerThreadId = "" } = {}) {
  const canonicalKind = normalizeKind(legacyEvent);
  if (!canonicalKind) {
    return null;
  }

  return createCanonicalEvent({
    id: String(legacyEvent?.id || `canonical:${legacyEvent?.threadId || providerThreadId}:${legacyEvent?.seq || 0}:${canonicalKind}`),
    seq: Number(legacyEvent?.seq || 0),
    provider: resolveProviderId(provider, provider || "unknown"),
    providerThreadId: String(providerThreadId || legacyEvent?.threadId || ""),
    providerTurnId: legacyEvent?.turnId ? String(legacyEvent.turnId) : undefined,
    threadId: String(legacyEvent?.threadId || providerThreadId || ""),
    turnId: legacyEvent?.turnId == null ? null : String(legacyEvent.turnId),
    ts: legacyEvent?.eventTs || legacyEvent?.createdAt,
    kind: canonicalKind,
    payload: normalizePayload(legacyEvent, canonicalKind)
  });
}
