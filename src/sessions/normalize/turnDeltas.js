import crypto from "node:crypto";

import { buildEventPartFromItem } from "../history/historicalPayloads.js";
import { nowIso, normalizeSymbolToken } from "../shared/text.js";

function ensureId(prefix = "id") {
  if (typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function resolveTimestamp(value) {
  const parsed = Date.parse(String(value || ""));
  if (Number.isNaN(parsed)) {
    return nowIso();
  }
  return new Date(parsed).toISOString();
}

function normalizeBackgroundStatus(value) {
  const key = normalizeSymbolToken(value);
  if (!key) {
    return "running";
  }
  if (["completed", "done", "finished", "success"].some((item) => key.includes(item))) {
    return "done";
  }
  if (["failed", "error", "interrupted"].some((item) => key.includes(item))) {
    return "failed";
  }
  return "running";
}

function normalizeProcessType(value, fallback = "system") {
  const key = normalizeSymbolToken(value);
  if (!key) {
    return fallback;
  }
  if (["reasoning", "commentary", "thinking"].some((item) => key.includes(item))) {
    return "reasoning";
  }
  if (["toolcall", "commandexecution", "mcptool", "tool"].some((item) => key.includes(item))) {
    return "tool_call";
  }
  if (["toolresult", "tooloutput", "functioncalloutput"].some((item) => key.includes(item))) {
    return "tool_result";
  }
  if (key.includes("subagent")) {
    return key.includes("update") || key.includes("notification") ? "subagent_update" : "subagent_spawn";
  }
  if (["reference", "citation"].some((item) => key.includes(item))) {
    return "reference";
  }
  if (["status", "turncompleted", "turnaborted", "turnfailed"].some((item) => key.includes(item))) {
    return "status";
  }
  if (["artifact", "filechange", "patch", "image"].some((item) => key.includes(item))) {
    return "artifact";
  }
  return fallback;
}

function normalizeBodyKind(value) {
  const key = normalizeSymbolToken(value);
  if (key === "image") {
    return "image";
  }
  if (key === "fileref" || key === "filereference") {
    return "file_ref";
  }
  return "markdown";
}

function compactText(value) {
  return String(value || "").trim();
}

function cloneContent(value) {
  return JSON.parse(JSON.stringify(Array.isArray(value) ? value : []));
}

function normalizeMessageContentParts(content = []) {
  const parts = [];
  for (const item of Array.isArray(content) ? content : []) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const type = normalizeSymbolToken(item.type);
    if (!type) {
      continue;
    }
    if (type === "outputtext" || type === "inputtext" || type === "text") {
      const text = compactText(item.text || item.value);
      if (!text) {
        continue;
      }
      parts.push({ type: "text", text });
      continue;
    }
    const url = compactText(item.image_url || item.url || item.path);
    if (!url) {
      continue;
    }
    if (["outputimage", "image", "localimage", "inputimage"].includes(type)) {
      parts.push({
        type: "image",
        url,
        alt: compactText(item.alt || item.name) || "image"
      });
    }
  }
  return parts;
}

function buildBackgroundAgentDelta({ agentId, agentPath = "", nickname = "", role = "", status = "running", ts = nowIso(), relatedTurnIds = [] } = {}) {
  const stableId = compactText(agentId || agentPath || nickname);
  if (!stableId) {
    return null;
  }
  return {
    kind: "background_agent_upserted",
    agent: {
      agentId: stableId,
      agentPath: compactText(agentPath),
      nickname: compactText(nickname),
      role: compactText(role),
      status: normalizeBackgroundStatus(status),
      startedAt: resolveTimestamp(ts),
      updatedAt: resolveTimestamp(ts),
      relatedTurnIds: [...new Set((relatedTurnIds || []).filter(Boolean).map((item) => String(item)))]
    }
  };
}

export function createTurnCreatedDelta(turnId, userTextOrInput, timestamp = nowIso(), extra = {}) {
  const input =
    userTextOrInput && typeof userTextOrInput === "object"
      ? userTextOrInput
      : {
          text: userTextOrInput,
          ...extra
        };
  return {
    kind: "turn_created",
    turnId: String(turnId),
    timestamp: resolveTimestamp(timestamp),
    user: {
      id: String(input.id || ensureId("user")),
      text: compactText(input.text),
      ts: resolveTimestamp(input.ts || timestamp),
      content: Array.isArray(input.content) ? cloneContent(input.content) : [],
      images: Array.isArray(input.images) ? cloneContent(input.images) : [],
      local_images: Array.isArray(input.local_images) ? cloneContent(input.local_images) : []
    }
  };
}

export function createTurnStatusDelta(turnId, status, timestamp = nowIso()) {
  return {
    kind: "turn_status_changed",
    turnId: String(turnId),
    status: compactText(status) || "running",
    timestamp: resolveTimestamp(timestamp)
  };
}

export function createTurnCompletedDelta(turnId, status = "completed", timestamp = nowIso()) {
  return {
    kind: "turn_completed",
    turnId: String(turnId),
    status: compactText(status) || "completed",
    timestamp: resolveTimestamp(timestamp)
  };
}

function createBodyDelta(turnId, { text = "", kind = "markdown", payload = {}, ts = nowIso(), mergeMode = "paragraph" } = {}) {
  return {
    kind: "body_appended",
    turnId: String(turnId),
    block: {
      id: ensureId("body"),
      kind: normalizeBodyKind(kind),
      text: String(text || ""),
      payload: payload && typeof payload === "object" ? payload : {},
      ts: resolveTimestamp(ts),
      mergeMode
    }
  };
}

function createProcessDelta(turnId, { type = "system", title = "", summary = "", content = "", payload = {}, ts = nowIso(), phase = "completed" } = {}) {
  return {
    kind: "process_appended",
    turnId: String(turnId),
    event: {
      id: ensureId("process"),
      type: normalizeProcessType(type, "system"),
      title: compactText(title) || compactText(summary) || "过程事件",
      summary: compactText(summary),
      content: compactText(content),
      payload: payload && typeof payload === "object" ? payload : {},
      phase: compactText(phase) || "completed",
      ts: resolveTimestamp(ts)
    }
  };
}

function createSubagentDeltas(turnId, { agentId = "", agentPath = "", nickname = "", role = "", status = "running", content = "", ts = nowIso(), payload = {}, type = "subagent_spawn" } = {}) {
  const processDelta = createProcessDelta(turnId, {
    type,
    title: nickname || agentPath || agentId || "subagent",
    summary: compactText(status) || "running",
    content,
    payload: {
      ...payload,
      agentId: compactText(agentId || agentPath),
      agentPath: compactText(agentPath),
      agentNickname: compactText(nickname),
      agentRole: compactText(role),
      status: normalizeBackgroundStatus(status)
    },
    ts,
    phase: normalizeBackgroundStatus(status) === "running" ? "streaming" : "completed"
  });
  const backgroundDelta = buildBackgroundAgentDelta({
    agentId: compactText(agentId || agentPath),
    agentPath,
    nickname,
    role,
    status,
    ts,
    relatedTurnIds: [turnId]
  });
  return backgroundDelta ? [processDelta, backgroundDelta] : [processDelta];
}

function normalizeMessagePartRecord(record, turnId) {
  const part = record?.part || {};
  const partType = compactText(part.type).toLowerCase();
  const ts = record?.timestamp || nowIso();
  const rawType = compactText(part.rawType || part.type);
  if ((partType === "text" || partType === "markdown") && compactText(part.text)) {
    const phase = compactText(record?.phase || "completed").toLowerCase() || "completed";
    return [
      createBodyDelta(turnId, {
        text: String(part.text || ""),
        kind: part.format || "markdown",
        payload: { phase },
        ts,
        mergeMode: phase === "streaming" ? "stream_append" : "stream_replace"
      })
    ];
  }
  if (partType === "image" && compactText(part.url)) {
    return [
      createBodyDelta(turnId, {
        kind: "image",
        text: "",
        payload: {
          url: compactText(part.url),
          alt: compactText(part.alt) || "image"
        },
        ts,
        mergeMode: "none"
      })
    ];
  }
  if (partType === "subagent" || normalizeSymbolToken(rawType).includes("subagent")) {
    const nested = part.payload || {};
    return createSubagentDeltas(turnId, {
      agentId: nested.agentId || nested.agent_id || nested.agentPath || nested.agent_path || nested.path || "",
      agentPath: nested.agentPath || nested.agent_path || nested.path || "",
      nickname: nested.agentNickname || nested.agent_nickname || "",
      role: nested.agentRole || nested.agent_role || "",
      status: nested.status || nested.phase || "running",
      content: compactText(part.summary || part.text || nested.content || nested.summary || nested.message),
      ts,
      payload: nested,
      type: "subagent_update"
    });
  }
  if (["tool", "reference", "event"].includes(partType)) {
    return [
      createProcessDelta(turnId, {
        type: partType,
        title: compactText(part.summary) || compactText(rawType),
        summary: compactText(part.summary),
        content: compactText(part.text || part.summary),
        payload: part.payload || {},
        ts,
        phase: record?.phase || "completed"
      })
    ];
  }
  return [];
}

function normalizeEventMsgRecord(record, turnId) {
  const payload = record?.payload || {};
  const type = normalizeSymbolToken(payload.type);
  const ts = record?.timestamp || payload?.timestamp || nowIso();
  if (type === "usermessage") {
    return [];
  }
  if (type === "agentmessage") {
    const phase = normalizeSymbolToken(payload.phase);
    const text = compactText(payload.message || payload.text);
    if (!text) {
      return [];
    }
    if (!phase || phase === "finalanswer") {
      return [createBodyDelta(turnId, { text, ts, payload: { phase: "completed" }, mergeMode: "paragraph" })];
    }
    return [
      createProcessDelta(turnId, {
        type: phase === "commentary" ? "reasoning" : "status",
        title: phase === "commentary" ? "思考" : payload.phase || "agent_message",
        summary: text,
        content: text,
        payload,
        ts,
        phase: payload.phase || "completed"
      })
    ];
  }
  if (type === "taskcomplete" || type === "turncompleted") {
    return [createTurnCompletedDelta(turnId, payload.status || "completed", ts)];
  }
  if (type === "taskfailed") {
    return [createTurnCompletedDelta(turnId, payload.status || "failed", ts)];
  }
  if (type === "agentreasoning") {
    const text = compactText(payload.text || payload.message);
    if (!text) {
      return [];
    }
    return [
      createProcessDelta(turnId, {
        type: "reasoning",
        title: "思考",
        summary: text,
        content: text,
        payload,
        ts
      })
    ];
  }
  if (type === "turnaborted") {
    return [createProcessDelta(turnId, {
      type: "status",
      title: "已中断",
      summary: compactText(payload.reason) || "interrupted",
      content: compactText(payload.reason),
      payload,
      ts,
      phase: "interrupted"
    })];
  }
  if (type === "tokencount" || type === "usermessage") {
    return [];
  }
  if (type.includes("subagent")) {
    return createSubagentDeltas(turnId, {
      agentId: payload.agent_id || payload.agentId || payload.agent_path || payload.agentPath || "",
      agentPath: payload.agent_path || payload.agentPath || "",
      nickname: payload.agent_nickname || payload.agentNickname || "",
      role: payload.agent_role || payload.agentRole || "",
      status: payload.status || "running",
      content: compactText(payload.message || payload.text || payload.summary),
      ts,
      payload,
      type: "subagent_update"
    });
  }
  return [];
}

function normalizeResponseItemRecord(record, turnId) {
  const payload = record?.payload || record?.item || {};
  const type = normalizeSymbolToken(payload.type);
  const ts = record?.timestamp || payload?.timestamp || nowIso();
  if (type === "message" && normalizeSymbolToken(payload.role) === "assistant") {
    const content = cloneContent(payload.content);
    const renderableParts = normalizeMessageContentParts(content);
    const text = Array.isArray(content)
      ? content.map((item) => compactText(item?.text || item?.value)).filter(Boolean).join("\n")
      : compactText(payload.text || payload.message);
    if (!text) {
      if (renderableParts.length === 0) {
        return [];
      }
    }
    const phase = normalizeSymbolToken(payload.phase);
    if (phase === "commentary") {
      return [createProcessDelta(turnId, {
        type: "reasoning",
        title: "思考",
        summary: text,
        content: text,
        payload,
        ts,
        phase: "commentary"
      })];
    }
    const deltas = [];
    for (const part of renderableParts) {
      if (part.type !== "image") {
        continue;
      }
      deltas.push(
        createBodyDelta(turnId, {
          kind: "image",
          ts,
          payload: {
            url: part.url,
            alt: part.alt,
            phase: "completed",
            content
          },
          mergeMode: "paragraph"
        })
      );
    }
    if (text) {
      deltas.push(
        createBodyDelta(turnId, {
          text,
          ts,
          payload: { phase: "completed", content },
          mergeMode: "paragraph"
        })
      );
    }
    return deltas;
  }
  if (type === "reasoning") {
    const text = Array.isArray(payload.summary)
      ? payload.summary.map((item) => compactText(item?.text || item?.summary_text || item?.value)).filter(Boolean).join("\n")
      : compactText(payload.text || payload.summary);
    if (!text) {
      return [];
    }
    return [createProcessDelta(turnId, {
      type: "reasoning",
      title: "思考",
      summary: text,
      content: text,
      payload,
      ts
    })];
  }
  if (type === "functioncall" || type === "toolcall") {
    const title = compactText(payload.name || payload.tool_name) || "工具调用";
    return [createProcessDelta(turnId, {
      type: "tool_call",
      title,
      summary: compactText(payload.arguments),
      content: compactText(payload.arguments),
      payload,
      ts,
      phase: "started"
    })];
  }
  if (type === "functioncalloutput" || type === "toolresult") {
    const text = compactText(payload.output || payload.text || payload.result);
    return [createProcessDelta(turnId, {
      type: "tool_result",
      title: "工具结果",
      summary: text,
      content: text,
      payload,
      ts
    })];
  }
  return [];
}

function normalizeItemCompletedRecord(record, turnId) {
  const item = record?.item || {};
  const ts = record?.timestamp || item?.timestamp || nowIso();
  if (normalizeSymbolToken(item.type) === "agentmessage") {
    const text = compactText(item.text);
    if (!text) {
      return [];
    }
    return [createBodyDelta(turnId, { text, ts, payload: { phase: "completed" }, mergeMode: "stream_replace" })];
  }
  const eventPart = buildEventPartFromItem(item);
  if (!eventPart) {
    return [];
  }
  if (eventPart.type === "subagent") {
    return createSubagentDeltas(turnId, {
      agentId: eventPart.payload?.path || eventPart.payload?.id || "",
      agentPath: eventPart.payload?.path || "",
      nickname: eventPart.payload?.agentNickname || "",
      role: eventPart.payload?.agentRole || "",
      status: eventPart.payload?.status || "running",
      content: compactText(eventPart.summary),
      payload: eventPart.payload,
      ts,
      type: "subagent_spawn"
    });
  }
  return [createProcessDelta(turnId, {
    type: eventPart.type === "tool" ? "tool_call" : eventPart.type,
    title: compactText(eventPart.summary),
    summary: compactText(eventPart.summary),
    content: compactText(eventPart.summary),
    payload: eventPart.payload,
    ts
  })];
}

function normalizeSubagentNotificationRecord(record, turnId) {
  const payload = record?.payload || record || {};
  const statusObject = payload.status && typeof payload.status === "object" ? payload.status : {};
  const [statusKey, statusContent] = Object.entries(statusObject)[0] || ["running", ""];
  return createSubagentDeltas(turnId, {
    agentId: payload.agent_id || payload.agentId || payload.agent_path || payload.agentPath || "",
    agentPath: payload.agent_path || payload.agentPath || "",
    nickname: payload.agent_nickname || payload.agentNickname || "",
    role: payload.agent_role || payload.agentRole || "",
    status: statusKey,
    content: compactText(statusContent),
    payload,
    ts: record?.timestamp || nowIso(),
    type: "subagent_update"
  });
}

export function normalizeRecordToDeltas(record, { turnId } = {}) {
  if (!record || !turnId) {
    return [];
  }
  const type = compactText(record.type);
  if (type === "message_part") {
    return normalizeMessagePartRecord(record, turnId);
  }
  if (type === "event_msg") {
    return normalizeEventMsgRecord(record, turnId);
  }
  if (type === "response_item") {
    return normalizeResponseItemRecord(record, turnId);
  }
  if (type === "item.completed") {
    return normalizeItemCompletedRecord(record, turnId);
  }
  if (type === "subagent_notification") {
    return normalizeSubagentNotificationRecord(record, turnId);
  }
  return [];
}
