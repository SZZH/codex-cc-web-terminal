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

  if ((partType === "text" || partType === "markdown") && asText(part.text)) {
    return [
      createUiPart({
        sessionId,
        role,
        partType: "markdown",
        payload: {
          text: asText(part.text)
        },
        ts,
        phase: asText(payload?.phase) || "streaming",
        source: "message_part",
        rawType: "message_part"
      })
    ];
  }

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
  const text = asText(msg.message || msg.text);

  switch (rawType) {
    case "user_message":
      if (!text) {
        return [];
      }
      return [
        createUiPart({
          sessionId,
          role: "user",
          partType: "text",
          payload: { text },
          phase: "final",
          source: "event_msg",
          rawType
        })
      ];
    case "agent_message":
      if (asText(msg.phase) && asText(msg.phase).toLowerCase() !== "final_answer") {
        return [];
      }
      if (!text) {
        return [];
      }
      return [
        createUiPart({
          sessionId,
          role: "assistant",
          partType: "markdown",
          payload: { text },
          phase: "final",
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
      return [];
  }
}

function normalizeResponseItemPayload(payload, sessionId = "") {
  return [];
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
