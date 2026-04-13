function makeId(prefix = "part") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function asText(value) {
  return String(value ?? "").trim();
}

function safeObject(value) {
  return value && typeof value === "object" ? value : {};
}

function normalizeKind(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function collectText(node) {
  if (node == null) {
    return [];
  }
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    return [String(node)];
  }
  if (Array.isArray(node)) {
    return node.flatMap((item) => collectText(item));
  }
  if (typeof node !== "object") {
    return [];
  }

  const keys = [
    "summary",
    "text",
    "message",
    "title",
    "description",
    "command",
    "tool_name",
    "toolName",
    "path",
    "status",
    "phase",
    "result",
    "output",
    "reasoning",
    "value",
    "content",
    "payload"
  ];
  const out = [];
  for (const key of keys) {
    if (!(key in node)) {
      continue;
    }
    out.push(...collectText(node[key]));
  }
  return out;
}

function summarizeNode(node, maxLen = 220) {
  const text = collectText(node)
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return "";
  }
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLen - 3)).trimEnd()}...`;
}

function inferPartType(rawType, fallback = "event") {
  const kind = normalizeKind(rawType);
  if (!kind) {
    return fallback;
  }
  if (kind.includes("commandexecution") || kind.includes("toolcall") || kind.includes("mcptool")) {
    return "tool";
  }
  if (kind.includes("subagent") || kind.includes("collab")) {
    return "subagent";
  }
  if (kind.includes("reference") || kind.includes("citation")) {
    return "reference";
  }
  return fallback;
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
  const rawType = asText(part.rawType || part.type);
  const rawKind = normalizeKind(rawType);
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

  if (rawKind === "usermessage" || rawKind === "user") {
    const userText = asText(part.text) || summarizeNode(part.payload || part, 220);
    if (!userText) {
      return [];
    }
    return [
      createUiPart({
        sessionId,
        role: "user",
        partType: "text",
        payload: { text: userText },
        ts,
        phase: "final",
        source: "message_part",
        rawType
      })
    ];
  }

  if (partType === "tool" || partType === "subagent" || partType === "reference" || partType === "event") {
    const summary = asText(part.summary) || summarizeNode(part.payload || part, 280) || rawType || partType;
    const normalizedPartType = inferPartType(rawType, partType || "event");
    return [
      createUiPart({
        sessionId,
        role,
        partType: normalizedPartType,
        payload: {
          summary,
          rawType,
          payload: safeObject(part.payload)
        },
        ts,
        phase: asText(payload?.phase) || "final",
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
  const rawKind = normalizeKind(rawType);
  const text = asText(msg.message || msg.text);

  switch (rawKind) {
    case "usermessage":
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
    case "agentmessage": {
      const phase = asText(msg.phase).toLowerCase();
      if (!text) {
        return [];
      }
      if (phase && phase !== "final_answer") {
        return [
          createUiPart({
            sessionId,
            role: "assistant",
            partType: inferPartType(rawType, "event"),
            payload: {
              summary: text,
              rawType,
              payload: {
                phase
              }
            },
            phase: "final",
            source: "event_msg",
            rawType
          })
        ];
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
    }
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
  const item = safeObject(payload?.item || payload);
  const ts = asText(item?.timestamp || payload?.timestamp) || new Date().toISOString();
  const role = asText(item?.role || payload?.role) || "assistant";

  const collectText = (node) => {
    if (node == null) {
      return [];
    }
    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
      return [String(node)];
    }
    if (Array.isArray(node)) {
      return node.flatMap((child) => collectText(child));
    }
    if (typeof node !== "object") {
      return [];
    }

    const directText = asText(node.text || node.message || node.value);
    const nested = [
      ...collectText(node.content),
      ...collectText(node.output),
      ...collectText(node.result),
      ...collectText(node.parts)
    ];
    return [directText, ...nested].filter(Boolean);
  };

  const rawType = asText(item?.type || payload?.type || "response_item");
  const rawKind = normalizeKind(rawType);
  const inferPartType = () => {
    if (
      rawKind.includes("commandexecution") ||
      rawKind.includes("filechange") ||
      rawKind.includes("toolcall") ||
      rawKind.includes("mcptool")
    ) {
      return "tool";
    }
    if (rawKind.includes("subagent") || rawKind.includes("collab")) {
      return "subagent";
    }
    if (rawKind.includes("reference") || rawKind.includes("citation")) {
      return "reference";
    }
    return "event";
  };
  const text = collectText(item).join("\n").trim();
  if (rawKind === "usermessage" || rawKind === "user") {
    if (!text) {
      return [];
    }
    return [
      createUiPart({
        sessionId,
        role: "user",
        partType: "text",
        payload: { text },
        ts,
        phase: "final",
        source: "response_item",
        rawType
      })
    ];
  }
  if (rawKind && rawKind !== "agentmessage") {
    const summary = text || summarizeNode(item, 280) || rawType;
    return [
      createUiPart({
        sessionId,
        role: role === "user" ? "user" : role === "system" ? "system" : "assistant",
        partType: inferPartType(),
        payload: {
          summary,
          rawType,
          payload: item
        },
        ts,
        phase: asText(item?.phase || payload?.phase) || "final",
        source: "response_item",
        rawType
      })
    ];
  }
  if (!text) {
    return [];
  }

  return [
    createUiPart({
      sessionId,
      role: role === "user" ? "user" : role === "system" ? "system" : "assistant",
      partType: "markdown",
      payload: { text },
      ts,
      phase: asText(item?.phase || payload?.phase) || "final",
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
