function makeId(prefix = "part") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function asText(value) {
  return String(value ?? "").trim();
}

function safeObject(value) {
  return value && typeof value === "object" ? value : {};
}

export function createUiPart({
  sessionId = "",
  role = "assistant",
  partType = "unknown",
  payload = {},
  ts = new Date().toISOString(),
  phase = "final",
  source = "legacy_data",
  rawType = ""
} = {}) {
  return {
    id: makeId("ui"),
    sessionId,
    role,
    partType,
    payload: safeObject(payload),
    ts,
    phase,
    source,
    rawType
  };
}

export function normalizeLegacyDataEvent(payload, sessionId = "") {
  const text = String(payload?.data || "");
  if (!text.trim()) {
    return [];
  }
  return [
    createUiPart({
      sessionId,
      role: "assistant",
      partType: "markdown",
      payload: { text },
      phase: "streaming",
      source: "legacy_data",
      rawType: "data"
    })
  ];
}

export function normalizeMessagePartEvent(payload, sessionId = "") {
  const part = safeObject(payload?.part);
  const role = asText(payload?.role) || "assistant";
  const partType = asText(part.type);
  const ts = asText(payload?.timestamp) || new Date().toISOString();

  if (partType === "image" && asText(part.url)) {
    return [
      createUiPart({
        sessionId,
        role,
        partType: "image",
        payload: {
          url: asText(part.url),
          alt: asText(part.alt) || "image"
        },
        ts,
        phase: "final",
        source: "message_part",
        rawType: "message_part"
      })
    ];
  }

  return [
    createUiPart({
      sessionId,
      role,
      partType: "unknown",
      payload: { raw: payload },
      ts,
      phase: "final",
      source: "message_part",
      rawType: "message_part"
    })
  ];
}

function normalizeEventMsgPayload(eventMsg, sessionId = "") {
  const msg = safeObject(eventMsg);
  const rawType = asText(msg.type) || "event_msg";
  const delta = asText(msg.delta);
  const text = asText(msg.message || msg.text);

  switch (rawType) {
    case "agent_message":
      return [
        createUiPart({
          sessionId,
          role: "assistant",
          partType: "markdown",
          payload: { text: text || JSON.stringify(msg) },
          phase: "final",
          source: "event_msg",
          rawType
        })
      ];
    case "agent_message_delta":
      return [
        createUiPart({
          sessionId,
          role: "assistant",
          partType: "markdown",
          payload: { text: delta || text },
          phase: "streaming",
          source: "event_msg",
          rawType
        })
      ];
    case "token_count":
      return [
        createUiPart({
          sessionId,
          role: "system",
          partType: "token_count",
          payload: msg,
          source: "event_msg",
          rawType
        })
      ];
    case "agent_reasoning":
    case "agent_reasoning_delta":
    case "agent_reasoning_raw_content":
    case "agent_reasoning_raw_content_delta":
      return [
        createUiPart({
          sessionId,
          role: "assistant",
          partType: "reasoning",
          payload: msg,
          phase: rawType.endsWith("_delta") ? "streaming" : "final",
          source: "event_msg",
          rawType
        })
      ];
    case "exec_command_output_delta":
    case "exec_command_begin":
    case "exec_command_end":
      return [
        createUiPart({
          sessionId,
          role: "system",
          partType: "exec_output",
          payload: msg,
          source: "event_msg",
          rawType
        })
      ];
    case "error":
    case "warning":
      return [
        createUiPart({
          sessionId,
          role: "system",
          partType: "error",
          payload: msg,
          source: "event_msg",
          rawType
        })
      ];
    default:
      return [
        createUiPart({
          sessionId,
          role: rawType === "user_message" ? "user" : "system",
          partType: "unknown",
          payload: msg,
          source: "event_msg",
          rawType
        })
      ];
  }
}

function normalizeResponseItemPayload(payload, sessionId = "") {
  const item = safeObject(payload?.item || payload);
  const rawType = asText(item.type);
  if (!rawType) {
    return [];
  }

  if (rawType === "message") {
    const role = asText(item.role) || "assistant";
    const textParts = Array.isArray(item.content)
      ? item.content
          .filter((contentItem) => asText(contentItem?.type) === "output_text")
          .map((contentItem) => asText(contentItem?.text))
          .filter(Boolean)
      : [];
    if (textParts.length > 0) {
      return [
        createUiPart({
          sessionId,
          role,
          partType: "markdown",
          payload: { text: textParts.join("\n") },
          source: "response_item",
          rawType
        })
      ];
    }
  }

  if (rawType === "image_generation_call") {
    const url = asText(item.result);
    if (url) {
      return [
        createUiPart({
          sessionId,
          role: "assistant",
          partType: "image",
          payload: { url, alt: asText(item.revised_prompt) || "generated image" },
          source: "response_item",
          rawType
        })
      ];
    }
  }

  if (rawType === "function_call" || rawType === "custom_tool_call") {
    return [
      createUiPart({
        sessionId,
        role: "system",
        partType: "tool_call",
        payload: item,
        source: "response_item",
        rawType
      })
    ];
  }

  if (rawType === "function_call_output" || rawType === "custom_tool_call_output") {
    return [
      createUiPart({
        sessionId,
        role: "system",
        partType: "tool_result",
        payload: item,
        source: "response_item",
        rawType
      })
    ];
  }

  if (rawType === "reasoning") {
    return [
      createUiPart({
        sessionId,
        role: "assistant",
        partType: "reasoning",
        payload: item,
        source: "response_item",
        rawType
      })
    ];
  }

  return [
    createUiPart({
      sessionId,
      role: "system",
      partType: "unknown",
      payload: item,
      source: "response_item",
      rawType
    })
  ];
}

export function normalizeServerPayload(payload, sessionId = "") {
  const type = asText(payload?.type);
  if (!type) {
    return [];
  }
  if (type === "data") {
    return normalizeLegacyDataEvent(payload, sessionId);
  }
  if (type === "message_part") {
    return normalizeMessagePartEvent(payload, sessionId);
  }
  if (type === "event_msg") {
    return normalizeEventMsgPayload(payload?.payload || payload?.msg || payload, sessionId);
  }
  if (type === "response_item") {
    return normalizeResponseItemPayload(payload?.payload || payload, sessionId);
  }
  return [];
}

