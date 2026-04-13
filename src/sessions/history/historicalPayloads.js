import fs from "node:fs";

import { isAgentMessageType, normalizeSymbolToken, nowIso, sanitizeTitleFragment } from "../shared/text.js";
import { cleanHistoricalMessageText, isBoilerplateUserText } from "./historicalText.js";

function extractTextFromNode(value) {
  if (value == null) {
    return [];
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractTextFromNode(item));
  }
  if (typeof value !== "object") {
    return [];
  }

  const pieces = [];
  for (const key of ["text", "message", "summary", "value", "content"]) {
    if (!(key in value)) {
      continue;
    }
    const child = value[key];
    if (child == null) {
      continue;
    }
    if (key === "content" && typeof child === "object" && !Array.isArray(child)) {
      pieces.push(...extractTextFromNode(child));
      continue;
    }
    if (key === "summary" && Array.isArray(child)) {
      pieces.push(...extractTextFromNode(child));
      continue;
    }
    if (typeof child === "string" || typeof child === "number" || typeof child === "boolean") {
      pieces.push(String(child));
      continue;
    }
    if (Array.isArray(child)) {
      pieces.push(...extractTextFromNode(child));
    }
  }
  return pieces;
}

function extractTextContentFromPayload(payload) {
  const pieces = [];
  if (!payload || typeof payload !== "object") {
    return pieces;
  }
  if (Array.isArray(payload.content)) {
    pieces.push(...extractTextFromNode(payload.content));
  } else if (payload.content != null) {
    pieces.push(...extractTextFromNode(payload.content));
  }
  if (typeof payload.message === "string") {
    pieces.push(payload.message);
  } else if (payload.message && typeof payload.message === "object") {
    pieces.push(...extractTextFromNode(payload.message));
  }
  if (typeof payload.summary === "string") {
    pieces.push(payload.summary);
  } else if (Array.isArray(payload.summary)) {
    pieces.push(...extractTextFromNode(payload.summary));
  }
  if (typeof payload.text === "string") {
    pieces.push(payload.text);
  }
  return pieces;
}

function summarizeEventPayload(payload, maxLen = 240) {
  const text = extractTextContentFromPayload(payload)
    .map((item) => sanitizeTitleFragment(item))
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!text) {
    return "";
  }
  return text.length <= maxLen ? text : `${text.slice(0, Math.max(0, maxLen - 3)).trimEnd()}...`;
}

function normalizeEventPartType(rawType) {
  const normalized = normalizeSymbolToken(rawType);
  if (!normalized) {
    return "event";
  }
  if (
    normalized.includes("commandexecution") ||
    normalized.includes("filechange") ||
    normalized.includes("toolcall") ||
    normalized.includes("mcptool")
  ) {
    return "tool";
  }
  if (normalized.includes("subagent") || normalized.includes("collab")) {
    return "subagent";
  }
  if (normalized.includes("reference") || normalized.includes("citation")) {
    return "reference";
  }
  return "event";
}

export function buildEventPartFromItem(item) {
  const rawType = String(item?.type || "").trim();
  if (!rawType || isAgentMessageType(rawType)) {
    return null;
  }
  const compactPayload = {
    id: String(item?.id || "").trim(),
    status: String(item?.status || "").trim(),
    title: String(item?.title || "").trim(),
    kind: String(item?.kind || "").trim(),
    command: String(item?.command || "").trim(),
    toolName: String(item?.tool_name || item?.toolName || "").trim(),
    path: String(item?.path || "").trim(),
    agentNickname: String(item?.agent_nickname || item?.agentNickname || "").trim(),
    agentRole: String(item?.agent_role || item?.agentRole || "").trim()
  };
  const summary =
    summarizeEventPayload(item, 280) ||
    [
      String(compactPayload.toolName || "").trim(),
      String(compactPayload.command || "").trim(),
      String(compactPayload.title || "").trim(),
      String(compactPayload.path || "").trim(),
      String(compactPayload.status || "").trim()
    ]
      .filter(Boolean)
      .join(" | ");
  return {
    type: normalizeEventPartType(rawType),
    rawType,
    summary: summary || rawType,
    payload: compactPayload
  };
}

function resolveRecordTimestamp(record, fallbackTimestamp = nowIso()) {
  const rawTimestamp = record?.timestamp || record?.payload?.timestamp || fallbackTimestamp;
  const parsed = Date.parse(String(rawTimestamp || ""));
  if (Number.isNaN(parsed)) {
    const fallbackParsed = Date.parse(String(fallbackTimestamp || ""));
    if (!Number.isNaN(fallbackParsed)) {
      return new Date(fallbackParsed).toISOString();
    }
    return nowIso();
  }
  return new Date(parsed).toISOString();
}

function normalizeHistoricalRole(record) {
  if (!record || typeof record !== "object") {
    return "";
  }

  if (record.type === "event_msg") {
    const type = String(record.payload?.type || "").trim().toLowerCase();
    if (type === "user_message") {
      return "user";
    }
    if (type === "agent_message") {
      const phase = String(record.payload?.phase || "").trim().toLowerCase();
      if (phase && phase !== "final_answer") {
        return "";
      }
      return "assistant";
    }
  }
  return "";
}

function buildHistoricalProcessEntry(record, fallbackTimestamp) {
  const timestamp = resolveRecordTimestamp(record, fallbackTimestamp);

  if (record?.type === "event_msg") {
    const payload = record?.payload || {};
    const type = String(payload?.type || "").trim().toLowerCase();
    if (type !== "agent_message") {
      return null;
    }
    const phase = String(payload?.phase || "").trim().toLowerCase();
    if (!phase || phase === "final_answer") {
      return null;
    }
    const rawText = typeof payload.message === "string" ? payload.message : extractTextContentFromPayload(payload).join("\n");
    const text = cleanHistoricalMessageText(rawText);
    if (!text) {
      return null;
    }
    return {
      role: "assistant",
      text,
      timestamp,
      partType: "event",
      payload: {
        summary: text,
        rawType: "agent_message",
        payload: { phase }
      },
      rawType: "agent_message"
    };
  }

  if (record?.type === "item.completed") {
    const eventPart = buildEventPartFromItem(record.item || {});
    if (!eventPart) {
      return null;
    }
    return {
      role: "assistant",
      text: String(eventPart.summary || "").trim(),
      timestamp,
      partType: eventPart.type,
      payload: {
        summary: eventPart.summary,
        rawType: eventPart.rawType,
        payload: eventPart.payload
      },
      rawType: eventPart.rawType
    };
  }

  return null;
}

function contentImageItems(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  const items = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const imageUrl = String(item.image_url || item.url || item.path || "").trim();
    if ((item.type === "input_image" || item.type === "image" || item.type === "output_image") && imageUrl) {
      items.push({
        url: imageUrl,
        alt: String(item.alt || item.name || "image").trim() || "image"
      });
      continue;
    }
    if (Array.isArray(item.content)) {
      items.push(...contentImageItems(item.content));
    }
  }
  return items;
}

function extractImagePayloadItems(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const images = [];
  const pushImage = (url, alt = "image") => {
    const normalizedUrl = String(url || "").trim();
    if (!normalizedUrl) {
      return;
    }
    images.push({
      url: normalizedUrl,
      alt: String(alt || "image").trim() || "image"
    });
  };

  if (Array.isArray(payload.images)) {
    for (const item of payload.images) {
      if (typeof item === "string") {
        pushImage(item);
      } else if (item && typeof item === "object") {
        pushImage(item.url || item.image_url || item.path, item.alt || item.name);
      }
    }
  }

  if (Array.isArray(payload.local_images)) {
    for (const item of payload.local_images) {
      if (typeof item === "string") {
        pushImage(item);
      } else if (item && typeof item === "object") {
        pushImage(item.path || item.url || item.image_url, item.alt || item.name);
      }
    }
  }

  if (Array.isArray(payload.content)) {
    images.push(...contentImageItems(payload.content));
  }

  if (payload.message?.role === "user" && Array.isArray(payload.message?.content)) {
    images.push(...contentImageItems(payload.message.content));
  }

  const seen = new Set();
  return images.filter((item) => {
    if (!item?.url || seen.has(item.url)) {
      return false;
    }
    seen.add(item.url);
    return true;
  });
}

export function extractHistoricalMessagesFromRecord(record, fallbackTimestamp) {
  const processEntry = buildHistoricalProcessEntry(record, fallbackTimestamp);
  if (processEntry) {
    return [processEntry];
  }

  const role = normalizeHistoricalRole(record);
  if (!role) {
    return [];
  }

  const payload = record?.payload || {};
  const timestamp = resolveRecordTimestamp(record, fallbackTimestamp);
  const imageItems = extractImagePayloadItems(payload);
  const rawText = typeof payload.message === "string" ? payload.message : extractTextContentFromPayload(payload).join("\n");
  if (role === "user" && isBoilerplateUserText(rawText) && imageItems.length === 0) {
    return [];
  }
  const text = cleanHistoricalMessageText(rawText);
  if (!text && imageItems.length === 0) {
    return [];
  }

  const messages = imageItems.map((image) => ({
    role,
    text: "",
    timestamp,
    partType: "image",
    payload: image,
    rawType: ""
  }));
  if (text) {
    messages.push({ role, text, timestamp, partType: "markdown", payload: {}, rawType: "" });
  }
  return messages;
}

export function extractHistoricalImageMessagesFromFile(filePath) {
  const results = [];
  let fallbackTimestamp = nowIso();
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return results;
  }

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const timestamp = resolveRecordTimestamp(record, fallbackTimestamp);
    fallbackTimestamp = timestamp;
    const payload = record?.payload || {};
    const images = extractImagePayloadItems(payload);
    if (!images.length) {
      continue;
    }

    const role =
      record?.type === "event_msg" && String(payload?.type || "").trim().toLowerCase() === "user_message"
        ? "user"
        : payload?.role === "user" || payload?.message?.role === "user"
          ? "user"
          : "assistant";

    for (const image of images) {
      results.push({
        role,
        text: "",
        timestamp,
        partType: "image",
        payload: image,
        rawType: ""
      });
    }
  }
  return results;
}

export function appendHistoricalMessage(messages, candidate) {
  if (!candidate || !candidate.role) {
    return;
  }
  if (!candidate.text && !((candidate.partType || "") === "image" && String(candidate?.payload?.url || "").trim())) {
    return;
  }

  const last = messages[messages.length - 1];
  if (
    last &&
    last.role === candidate.role &&
    (last.partType || "markdown") === "markdown" &&
    (candidate.partType || "markdown") === "markdown"
  ) {
    const lastTimestamp = Date.parse(last.timestamp);
    const candidateTimestamp = Date.parse(candidate.timestamp);
    const gap = Math.abs(lastTimestamp - candidateTimestamp);
    const lastText = sanitizeTitleFragment(last.text);
    const candidateText = sanitizeTitleFragment(candidate.text);
    const lastLooksLikeFragment = lastText.length <= 80 && !/[。！？.!?]$/.test(lastText) && !/\n/.test(lastText);
    const candidateLooksLikeFragment =
      candidateText.length <= 80 && !/^[,，、:：]/.test(candidateText) && !/\n/.test(candidateText);
    const shouldMerge =
      lastText &&
      candidateText &&
      Number.isFinite(gap) &&
      gap <= 15_000 &&
      lastText !== candidateText &&
      lastText.length + candidateText.length <= 320 &&
      (lastLooksLikeFragment || candidateLooksLikeFragment || !/[。！？.!?]$/.test(lastText));

    if (shouldMerge) {
      last.text = `${last.text}\n${candidate.text}`.trim();
      last.timestamp = lastTimestamp <= candidateTimestamp ? last.timestamp : candidate.timestamp;
      return;
    }

    if (last.text === candidate.text && Number.isFinite(gap) && gap <= 2_000) {
      return;
    }
  }

  messages.push({
    role: candidate.role,
    text: candidate.text,
    timestamp: candidate.timestamp,
    partType: candidate.partType || "markdown",
    payload: candidate.payload || {},
    rawType: candidate.rawType || ""
  });
}
