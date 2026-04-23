import { createCanonicalEvent } from "./types.js";

const COLLAB_FUNCTIONS = new Set(["spawn_agent", "wait_agent", "send_input", "close_agent"]);
const COMMAND_FUNCTIONS = new Set(["exec_command", "shell", "shell_command"]);

export function createCanonicalizerState() {
  return {
    bootstrapCompleted: false,
    activeTurnId: "",
    callKinds: new Map()
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function firstTextContent(content = []) {
  for (const part of asArray(content)) {
    if (part?.type === "output_text" || part?.type === "input_text") {
      return part.text ?? "";
    }
    if (part?.type === "text") {
      return part.text ?? "";
    }
  }
  return "";
}

function classifyFunctionKind(name = "") {
  if (COMMAND_FUNCTIONS.has(name)) {
    return "command";
  }
  if (name === "apply_patch") {
    return "file_change";
  }
  if (typeof name === "string" && name.startsWith("mcp__")) {
    return "mcp";
  }
  if (COLLAB_FUNCTIONS.has(name)) {
    return "collab";
  }
  return "dynamic";
}

function mapFunctionCallStart(record, state) {
  const payload = record.raw?.payload ?? {};
  const name = payload.name ?? payload.function_name ?? payload.call_name ?? "unknown";
  const callId = payload.call_id ?? payload.id ?? payload.tool_call_id ?? `${record.threadId}:${record.seq}`;
  const args = payload.arguments ?? payload.args ?? payload.input ?? null;
  const kind = classifyFunctionKind(name);
  state.callKinds.set(callId, { kind, name });

  if (kind === "command") {
    return createCanonicalEvent({
      threadId: record.threadId,
      turnId: record.turnId,
      seq: record.seq,
      eventType: "command_execution_started",
      eventTs: record.recordTs,
      sourceRecordId: record.id,
      payload: { callId, name, args }
    });
  }

  if (kind === "file_change") {
    return createCanonicalEvent({
      threadId: record.threadId,
      turnId: record.turnId,
      seq: record.seq,
      eventType: "file_change_started",
      eventTs: record.recordTs,
      sourceRecordId: record.id,
      payload: { callId, name, args }
    });
  }

  if (kind === "mcp") {
    return createCanonicalEvent({
      threadId: record.threadId,
      turnId: record.turnId,
      seq: record.seq,
      eventType: "mcp_tool_call_started",
      eventTs: record.recordTs,
      sourceRecordId: record.id,
      payload: { callId, name, args }
    });
  }

  if (kind === "collab") {
    return createCanonicalEvent({
      threadId: record.threadId,
      turnId: record.turnId,
      seq: record.seq,
      eventType: "collab_tool_call_started",
      eventTs: record.recordTs,
      sourceRecordId: record.id,
      payload: { callId, name, args }
    });
  }

  return createCanonicalEvent({
    threadId: record.threadId,
    turnId: record.turnId,
    seq: record.seq,
    eventType: "dynamic_tool_call_started",
    eventTs: record.recordTs,
    sourceRecordId: record.id,
    payload: { callId, name, args }
  });
}

function mapFunctionCallEnd(record, state) {
  const payload = record.raw?.payload ?? {};
  const callId = payload.call_id ?? payload.id ?? payload.tool_call_id ?? `${record.threadId}:${record.seq}`;
  const tracked = state.callKinds.get(callId);
  const name = payload.name ?? payload.function_name ?? payload.call_name ?? tracked?.name ?? "unknown";
  const output = payload.output ?? payload.result ?? payload.content ?? null;
  const status = payload.status ?? "completed";
  const kind = tracked?.kind ?? classifyFunctionKind(name);

  if (kind === "command") {
    return createCanonicalEvent({
      threadId: record.threadId,
      turnId: record.turnId,
      seq: record.seq,
      eventType: "command_execution_completed",
      eventTs: record.recordTs,
      sourceRecordId: record.id,
      payload: { callId, name, output, status }
    });
  }

  if (kind === "file_change") {
    return createCanonicalEvent({
      threadId: record.threadId,
      turnId: record.turnId,
      seq: record.seq,
      eventType: "file_change_completed",
      eventTs: record.recordTs,
      sourceRecordId: record.id,
      payload: { callId, name, output, status }
    });
  }

  if (kind === "mcp") {
    return createCanonicalEvent({
      threadId: record.threadId,
      turnId: record.turnId,
      seq: record.seq,
      eventType: "mcp_tool_call_completed",
      eventTs: record.recordTs,
      sourceRecordId: record.id,
      payload: { callId, name, output, status }
    });
  }

  if (kind === "collab") {
    return createCanonicalEvent({
      threadId: record.threadId,
      turnId: record.turnId,
      seq: record.seq,
      eventType: "collab_tool_call_completed",
      eventTs: record.recordTs,
      sourceRecordId: record.id,
      payload: { callId, name, output, status }
    });
  }

  return createCanonicalEvent({
    threadId: record.threadId,
    turnId: record.turnId,
    seq: record.seq,
    eventType: "dynamic_tool_call_completed",
    eventTs: record.recordTs,
    sourceRecordId: record.id,
    payload: { callId, name, output, status }
  });
}

function resolveTurnId(record, state) {
  const payload = record.raw?.payload ?? {};
  const explicit = record.turnId ?? payload.turn_id ?? payload.turnId ?? "";
  if (explicit) {
    return String(explicit);
  }
  return state.activeTurnId || null;
}

function makeEvent(record, state, input) {
  const turnId = input.turnId ?? resolveTurnId(record, state);
  return createCanonicalEvent({
    threadId: record.threadId,
    turnId,
    seq: record.seq,
    eventTs: record.recordTs,
    sourceRecordId: record.id,
    ...input
  });
}

export function canonicalizeRawRecord(record, state = createCanonicalizerState()) {
  const type = record.recordType;
  const subtype = record.recordSubtype;
  const payload = record.raw?.payload ?? {};

  if (type === "session_meta") {
    return [
      makeEvent(record, state, {
        eventType: "thread_metadata_initialized",
        payload
      })
    ];
  }

  if (type === "turn_context") {
    return [
      makeEvent(record, state, {
        eventType: "runtime_context_recorded",
        payload
      })
    ];
  }

  if (type === "event_msg") {
    if (subtype === "task_started") {
      const turnId = String(payload.turn_id || payload.turnId || record.turnId || "");
      if (turnId) {
        state.activeTurnId = turnId;
        return [
          makeEvent(record, state, {
            turnId,
            eventType: "turn_started",
            payload
          })
        ];
      }
      return [];
    }

    if (subtype === "user_message") {
      state.bootstrapCompleted = true;
      const turnId = String(payload.turn_id || payload.turnId || record.turnId || state.activeTurnId || `turn:${record.seq}`);
      state.activeTurnId = turnId;
      const text = payload.text ?? payload.message ?? firstTextContent(payload.content);
      return [
        makeEvent(record, state, {
          turnId,
          eventType: "turn_started",
          payload: { source: "user_message" }
        }),
        makeEvent(record, state, {
          turnId,
          eventType: "user_message_recorded",
          payload: { text, content: payload.content ?? [] }
        })
      ];
    }

    if (subtype === "task_complete") {
      const turnId = String(payload.turn_id || payload.turnId || record.turnId || state.activeTurnId || "");
      if (turnId && state.activeTurnId === turnId) {
        state.activeTurnId = "";
      }
      return [
        makeEvent(record, state, {
          turnId,
          eventType: "turn_completed",
          payload
        })
      ];
    }

    if (subtype === "task_failed") {
      const turnId = String(payload.turn_id || payload.turnId || record.turnId || state.activeTurnId || "");
      if (turnId && state.activeTurnId === turnId) {
        state.activeTurnId = "";
      }
      return [
        makeEvent(record, state, {
          turnId,
          eventType: "turn_failed",
          payload
        })
      ];
    }

    if (subtype === "turn_aborted") {
      const turnId = String(payload.turn_id || payload.turnId || record.turnId || state.activeTurnId || "");
      if (turnId && state.activeTurnId === turnId) {
        state.activeTurnId = "";
      }
      return [
        makeEvent(record, state, {
          turnId,
          eventType: "turn_aborted",
          payload
        })
      ];
    }

    if (subtype === "agent_reasoning") {
      return [
        makeEvent(record, state, {
          eventType: "reasoning_summary_recorded",
          payload: { summary: payload.summary ?? payload.text ?? "" }
        })
      ];
    }

    if (subtype === "agent_message") {
      const phase = payload.phase ?? "commentary";
      const text = payload.text ?? payload.message ?? "";
      if (phase === "final_answer") {
        return [
          makeEvent(record, state, {
            eventType: "agent_message_recorded",
            payload: { text, source: "fallback_final_answer", phase }
          })
        ];
      }

      return [
        makeEvent(record, state, {
          eventType: "reasoning_summary_recorded",
          payload: { summary: text, source: "commentary", phase }
        })
      ];
    }

    if (subtype === "exec_command_begin") {
      state.callKinds.set(payload.call_id, { kind: "command", name: "exec_command" });
      return [
        makeEvent(record, state, {
          turnId: String(payload.turn_id || record.turnId || state.activeTurnId || ""),
          eventType: "command_execution_started",
          payload: {
            callId: payload.call_id,
            name: "exec_command",
            args: payload.command ?? payload.parsed_cmd ?? null,
            cwd: payload.cwd ?? null
          }
        })
      ];
    }

    if (subtype === "exec_command_end") {
      state.callKinds.set(payload.call_id, { kind: "command", name: "exec_command" });
      return [
        makeEvent(record, state, {
          turnId: String(payload.turn_id || record.turnId || state.activeTurnId || ""),
          eventType: "command_execution_completed",
          payload: {
            callId: payload.call_id,
            name: "exec_command",
            output: payload.formatted_output ?? payload.aggregated_output ?? payload.stdout ?? payload.stderr ?? "",
            status: payload.status ?? "completed",
            exitCode: payload.exit_code ?? null,
            cwd: payload.cwd ?? null,
            command: payload.command ?? null
          }
        })
      ];
    }

    if (subtype === "patch_apply_begin") {
      state.callKinds.set(payload.call_id, { kind: "file_change", name: "apply_patch" });
      return [
        makeEvent(record, state, {
          turnId: String(payload.turn_id || record.turnId || state.activeTurnId || ""),
          eventType: "file_change_started",
          payload: {
            callId: payload.call_id,
            name: "apply_patch",
            args: payload.changes ?? null
          }
        })
      ];
    }

    if (subtype === "patch_apply_end") {
      state.callKinds.set(payload.call_id, { kind: "file_change", name: "apply_patch" });
      return [
        makeEvent(record, state, {
          turnId: String(payload.turn_id || record.turnId || state.activeTurnId || ""),
          eventType: "file_change_completed",
          payload: {
            callId: payload.call_id,
            name: "apply_patch",
            output: payload.changes ?? null,
            status: payload.status ?? "completed"
          }
        })
      ];
    }

    if (subtype === "token_count") {
      return [
        makeEvent(record, state, {
          eventType: "usage_metrics_recorded",
          payload
        })
      ];
    }
  }

  if (type === "response_item") {
    if (subtype === "message") {
      const role = payload.role ?? record.raw?.role ?? "assistant";
      const text = firstTextContent(payload.content);
      const phase = payload.phase ?? null;
      if (role === "assistant" && normalizeString(phase) === "commentary") {
        return [];
      }
      if (role === "assistant" && text) {
        return [
          makeEvent(record, state, {
            eventType: "agent_message_recorded",
            payload: { text, source: "primary_output_text", role, phase }
          })
        ];
      }
      if (role === "user") {
        if (!state.bootstrapCompleted || !resolveTurnId(record, state)) {
          return [];
        }
        // response_item user messages are fallback echoes only; keep them out when the explicit user event is present
        return [];
      }
    }

    if (subtype === "reasoning") {
      const events = [];
      const summaryText = Array.isArray(payload.summary)
        ? payload.summary.map((item) => item?.text || item || "").join("\n")
        : payload.summary;
      if (summaryText) {
        events.push(
          makeEvent(record, state, {
            eventType: "reasoning_summary_recorded",
            payload: { summary: summaryText }
          })
        );
      }
      if (payload.content) {
        events.push(
          makeEvent(record, state, {
            eventType: "reasoning_raw_recorded",
            payload: { content: payload.content }
          })
        );
      }
      return events;
    }

    if (subtype === "function_call") {
      return [mapFunctionCallStart(record, state)];
    }

    if (subtype === "function_call_output") {
      return [mapFunctionCallEnd(record, state)];
    }

    if (subtype === "custom_tool_call") {
      const callId = payload.call_id ?? payload.id ?? `${record.threadId}:${record.seq}`;
      state.callKinds.set(callId, { kind: "dynamic", name: payload.name ?? "custom_tool_call" });
      return [
        makeEvent(record, state, {
          eventType: "dynamic_tool_call_started",
          payload: {
            callId,
            name: payload.name ?? "custom_tool_call",
            args: payload.input ?? payload.arguments ?? null
          }
        })
      ];
    }

    if (subtype === "custom_tool_call_output") {
      const callId = payload.call_id ?? payload.id ?? `${record.threadId}:${record.seq}`;
      const tracked = state.callKinds.get(callId);
      return [
        makeEvent(record, state, {
          eventType: "dynamic_tool_call_completed",
          payload: {
            callId,
            name: payload.name ?? tracked?.name ?? "custom_tool_call",
            output: payload.output ?? payload.result ?? null,
            status: payload.status ?? "completed"
          }
        })
      ];
    }
  }

  if (type === "message_part") {
    const part = record.raw?.part ?? {};
    const role = record.raw?.role ?? "assistant";
    const text = part.text ?? "";
    const phase = record.raw?.phase ?? "completed";
    const partType = String(part.type || "").toLowerCase();

    if (role === "assistant" && partType === "text" && text) {
      return [
        createCanonicalEvent({
          threadId: record.threadId,
          turnId: record.turnId,
          seq: record.seq,
          eventType: "agent_message_recorded",
          eventTs: record.recordTs,
          sourceRecordId: record.id,
          payload: {
            text,
            source: phase === "streaming" ? "primary_output_text" : "primary_output_text",
            phase
          }
        })
      ];
    }

    if (partType === "event" && (part.summary || part.text)) {
      return [
        createCanonicalEvent({
          threadId: record.threadId,
          turnId: record.turnId,
          seq: record.seq,
          eventType: "reasoning_summary_recorded",
          eventTs: record.recordTs,
          sourceRecordId: record.id,
          payload: {
            summary: part.summary ?? part.text ?? "",
            source: "message_part",
            rawType: part.rawType ?? ""
          }
        })
      ];
    }

    if (String(part.rawType || "").toLowerCase().includes("error")) {
      return [
        createCanonicalEvent({
          threadId: record.threadId,
          turnId: record.turnId,
          seq: record.seq,
          eventType: "reasoning_summary_recorded",
          eventTs: record.recordTs,
          sourceRecordId: record.id,
          payload: { summary: part.summary ?? part.text ?? "", source: "message_part" }
        })
      ];
    }
  }

  if (type === "item.completed") {
    const item = record.raw?.item ?? {};
    const itemType = normalizeString(item.type);
    const text = item.text ?? item.message ?? firstTextContent(item.content);

    if (itemType === "usermessage") {
      return [
        createCanonicalEvent({
          threadId: record.threadId,
          turnId: record.turnId,
          seq: record.seq,
          eventType: "user_message_recorded",
          eventTs: record.recordTs,
          sourceRecordId: record.id,
          payload: { text, content: item.content ?? [] }
        })
      ];
    }

    if ((itemType === "agentmessage" || itemType === "message") && text) {
      return [
        createCanonicalEvent({
          threadId: record.threadId,
          turnId: record.turnId,
          seq: record.seq,
          eventType: "agent_message_recorded",
          eventTs: record.recordTs,
          sourceRecordId: record.id,
          payload: { text, source: "primary_output_text", phase: item.phase ?? null }
        })
      ];
    }

    if (itemType === "reasoning") {
      return [
        createCanonicalEvent({
          threadId: record.threadId,
          turnId: record.turnId,
          seq: record.seq,
          eventType: "reasoning_summary_recorded",
          eventTs: record.recordTs,
          sourceRecordId: record.id,
          payload: {
            summary: Array.isArray(item.summary_text) ? item.summary_text.join("\n") : item.summary_text ?? ""
          }
        })
      ];
    }
  }

  return [];
}

export function canonicalizeRawRecords(records = [], state = createCanonicalizerState()) {
  return records.flatMap((record) => canonicalizeRawRecord(record, state));
}

function normalizeString(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
