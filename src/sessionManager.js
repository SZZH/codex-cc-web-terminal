import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import pty from "node-pty";

const shortTimeFormatterCache = new Map();

function nowIso() {
  return new Date().toISOString();
}

function getShortTimeFormatter(timezone) {
  const key = String(timezone || "UTC");
  if (!shortTimeFormatterCache.has(key)) {
    shortTimeFormatterCache.set(
      key,
      new Intl.DateTimeFormat("en-AU", {
        timeZone: key,
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZoneName: "short"
      })
    );
  }
  return shortTimeFormatterCache.get(key);
}

function formatShortTimestamp(value, timezone) {
  const parts = getShortTimeFormatter(timezone).formatToParts(new Date(value));
  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

function quotePosix(value) {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}

function quotePowerShell(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function buildShellCommand(parts, quoteStyle) {
  const values = parts.filter((part) => String(part || "").length > 0);
  if (values.length === 0) {
    return "";
  }

  if (quoteStyle === "powershell") {
    const [command, ...args] = values;
    const quotedArgs = args.map((arg) => quotePowerShell(arg)).join(" ");
    return quotedArgs
      ? `& ${quotePowerShell(command)} ${quotedArgs}`
      : `& ${quotePowerShell(command)}`;
  }

  return values.map((part) => quotePosix(part)).join(" ");
}

function normalizeName(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

function sanitizeTitleFragment(value) {
  return stripControlChars(applyBackspaces(String(value || "")))
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, " ")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, " ")
    .replace(/\u001b[@-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function applyBackspaces(value) {
  const result = [];
  for (const char of String(value || "")) {
    if (char === "\b" || char === "\u007f") {
      result.pop();
      continue;
    }
    result.push(char);
  }
  return result.join("");
}

function stripControlChars(value) {
  return String(value || "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ");
}

function stripAnsiEscapeSequences(value) {
  return String(value || "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u009b[0-?]*[ -/]*[@-~]?/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]?/g, "")
    .replace(/\u001b[@-_]/g, "");
}

function stripTerminalControlSequences(value) {
  return stripControlChars(applyBackspaces(String(value || "")))
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, " ")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, " ")
    .replace(/\u001b[@-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLiveOutputLine(value) {
  return stripControlChars(applyBackspaces(stripAnsiEscapeSequences(String(value || ""))))
    .replace(/[ \t]+$/g, "");
}

function simplifyLiveOutputLine(value) {
  return normalizeLiveOutputLine(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function collapseDoubledAsciiNoise(value) {
  const text = String(value || "");
  if (!text) {
    return text;
  }

  const pairMatches = text.match(/([A-Za-z0-9])\1/g) || [];
  if (pairMatches.length < 6) {
    return text;
  }

  const ratio = pairMatches.length / Math.max(1, text.length);
  if (ratio < 0.12) {
    return text;
  }

  return text.replace(/([A-Za-z0-9])\1/g, "$1");
}

function isLikelyResumeEchoLine(value, pendingInput) {
  const expected = simplifyLiveOutputLine(pendingInput);
  const candidate = simplifyLiveOutputLine(value);
  if (!expected || !candidate) {
    return false;
  }

  if (candidate === expected) {
    return true;
  }

  const delta = candidate.length - expected.length;
  if (delta >= 0 && delta <= 80 && candidate.endsWith(expected)) {
    return true;
  }

  if (delta >= 0 && delta <= 80 && candidate.startsWith(expected)) {
    return true;
  }

  return false;
}

function isTerminalStatusLine(value) {
  const text = sanitizeTitleFragment(value);
  if (!text) {
    return true;
  }

  const lower = text.toLowerCase();
  return (
    lower.includes("esc to interrupt") ||
    /^working\(/i.test(text) ||
    /^press esc to interrupt/i.test(text)
  );
}

function filterLiveOutputChunk(session, chunk) {
  const text = String(chunk || "");
  if (!text) {
    return "";
  }

  if (session?.resumeSessionId && !session.resumeBootstrapComplete && !session.pendingResumeInput) {
    return "";
  }

  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const visibleLines = [];
  let sawNonEmptyLine = false;

  for (const line of lines) {
    const currentLine = line.includes("\r") ? line.slice(line.lastIndexOf("\r") + 1) : line;
    const cleaned = normalizeLiveOutputLine(currentLine);
    const normalized = collapseDoubledAsciiNoise(cleaned);
    const simplified = sanitizeTitleFragment(normalized);

    if (!normalized) {
      if (currentLine === "" || /^[ \t]+$/.test(currentLine)) {
        visibleLines.push("");
      }
      continue;
    }

    if (isTerminalStatusLine(simplified)) {
      continue;
    }

    if (
      /^[\p{P}\p{S}\s]+$/u.test(simplified) &&
      simplified.length <= 4 &&
      !/\w/.test(simplified)
    ) {
      continue;
    }

    if (
      session?.resumeSessionId &&
      !session.resumeBootstrapComplete &&
      session.pendingResumeInput &&
      isLikelyResumeEchoLine(normalized, session.pendingResumeInput)
    ) {
      continue;
    }

    visibleLines.push(normalized);
    if (simplified) {
      sawNonEmptyLine = true;
    }
  }

  if (!visibleLines.length) {
    return "";
  }

  if (session?.resumeSessionId && !session.resumeBootstrapComplete && sawNonEmptyLine) {
    session.resumeBootstrapComplete = true;
    session.pendingResumeInput = "";
  }

  return visibleLines.join(newline);
}

function extractImagePartsFromMarkdown(text) {
  const source = String(text || "");
  if (!source) {
    return { text: "", images: [] };
  }

  const images = [];
  const cleaned = source.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => {
    images.push({
      type: "image",
      alt: String(alt || "").trim(),
      url: String(url || "").trim()
    });
    return "";
  });

  return {
    text: cleaned,
    images
  };
}

function normalizeSymbolToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function isAgentMessageType(value) {
  return normalizeSymbolToken(value) === "agentmessage";
}

function extractTurnItems(result) {
  const direct = Array.isArray(result?.turn?.items) ? result.turn.items : null;
  if (direct) {
    return direct;
  }
  const fallback = Array.isArray(result?.items) ? result.items : null;
  if (fallback) {
    return fallback;
  }
  return [];
}

function emitNoReplyFallback(manager, session) {
  if (!session || session.turnNoReplyNotified) {
    return;
  }
  session.turnNoReplyNotified = true;
  manager.broadcast(session, {
    type: "message_part",
    role: "system",
    part: { type: "text", text: "本轮未返回可展示文本。" },
    phase: "final",
    timestamp: nowIso()
  });
}

function extractEmbeddedUserRequest(value) {
  const text = String(value || "");
  const userRequestMarker = "User request:";
  const userRequestIndex = text.lastIndexOf(userRequestMarker);
  if (userRequestIndex >= 0) {
    return text.slice(userRequestIndex + userRequestMarker.length).trim();
  }

  const replyMarker = "Reply with exactly:";
  const replyIndex = text.lastIndexOf(replyMarker);
  if (replyIndex >= 0) {
    return text.slice(replyIndex).trim();
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (
      !(line.startsWith("<") && line.endsWith(">")) &&
      !line.startsWith("[") &&
      !line.startsWith("Conversation info") &&
      !line.startsWith("Sender (") &&
      !line.startsWith("Bridge info") &&
      !line.startsWith("Workspace memory") &&
      !line.startsWith("Retrieved ") &&
      !line.startsWith("Available genes")
    ) {
      return line;
    }
  }

  return text.trim();
}

function deriveSessionTitle(value, fallback) {
  const clean = sanitizeTitleFragment(extractEmbeddedUserRequest(value))
    .replace(/^(codex|continue|resume|claude|cc)\s*/i, "")
    .trim();
  if (!clean) {
    return fallback;
  }

  if (clean.length <= 52) {
    return clean;
  }

  return `${clean.slice(0, 49).trimEnd()}...`;
}

const HISTORICAL_META_LINE_PATTERNS = [
  /^#+\s+/,
  /^accessibility override/i,
  /^auth-required override/i,
  /^automatic routing rule/i,
  /^how to infer auth-sensitive tasks/i,
  /^public-web routing rule/i,
  /^ambiguous-case policy/i,
  /^failure-upgrade rule/i,
  /^stability rules/i,
  /^execution style/i,
  /^important integration note/i,
  /^natural-language triggers/i,
  /^recall triggers/i,
  /^default objective/i,
  /^structure:?$/i,
  /^style rules:?$/i,
  /^content rules:?$/i,
  /^forbidden in final article output:?$/i,
  /^image rules:?$/i,
  /^html article rules:?$/i,
  /^execution rule:?$/i,
  /^this rule applies/i,
  /^当满足任一条件时，视为 `?code_task/i,
  /^若均不满足/i,
  /^当 `?code_task=true`? 时/i,
  /^创建文件时[:：]?/i,
  /^(完成后请返回|请返回|修改文件列表|优化摘要|风险说明|风险\/后续建议|风险\/后续建议（若有）|兼容性注意事项|视觉优化要点|关键 tokens 清单|自检点|潜在冲突点|可能冲突点|你做了哪些视觉提升|必须遵守|严格写入边界)[:：]?/i
];

function isHistoricalMetaLine(value) {
  const line = sanitizeTitleFragment(value);
  if (!line) {
    return true;
  }
  const withoutListPrefix = line.replace(/^[-*•]\s+/, "").replace(/^\d+[.)、]\s+/, "").trim();
  return HISTORICAL_META_LINE_PATTERNS.some((pattern) => pattern.test(line) || pattern.test(withoutListPrefix));
}

function sanitizeHistoricalLine(value) {
  return stripControlChars(applyBackspaces(String(value || "")))
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, " ")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, " ")
    .replace(/\u001b[@-_]/g, " ")
    .replace(/\t/g, "  ")
    .trimEnd();
}

function historicalMeaningfulLines(value) {
  return normalizeHistoricalText(value)
    .split("\n")
    .map((line) => sanitizeHistoricalLine(line))
    .filter(Boolean)
    .filter((line) => !isBoilerplateUserText(line))
    .filter((line) => !isHistoricalMetaLine(line))
    .filter((line) => !line.startsWith("<") && !line.startsWith("["));
}

function truncateHistoricalTitle(value, fallback = "") {
  const clean = sanitizeTitleFragment(value || fallback);
  if (!clean) {
    return sanitizeTitleFragment(fallback);
  }
  return clean.length <= 52 ? clean : `${clean.slice(0, 49).trimEnd()}...`;
}

function extractHistoricalTitleCandidate(value) {
  const lines = historicalMeaningfulLines(value);
  const preferred = lines.find((line) => !isHistoricalMetaLine(line));
  return preferred || lines[0] || "";
}

function scoreHistoricalSummarySnippet(text, role, title) {
  const clean = sanitizeTitleFragment(text);
  if (!clean) {
    return -1;
  }

  let score = role === "assistant" ? 120 : 80;
  if (clean === sanitizeTitleFragment(title)) {
    score -= 60;
  }
  if (isHistoricalMetaLine(clean)) {
    score -= 80;
  }
  if (clean.length >= 18 && clean.length <= 140) {
    score += 24;
  } else if (clean.length > 140) {
    score += 12;
  } else {
    score -= 12;
  }
  if (/[？?。.!！]/.test(clean)) {
    score += 8;
  }
  return score;
}

function extractHistoricalSummaryCandidate(messages, title, fallback = "") {
  const candidates = [];

  for (const message of messages || []) {
    const snippets = historicalMeaningfulLines(message.text).filter((line) => {
      if (!line) {
        return false;
      }
      if (sanitizeTitleFragment(line) === sanitizeTitleFragment(title)) {
        return false;
      }
      return !isHistoricalMetaLine(line);
    });

    for (const snippet of snippets.slice(0, 3)) {
      candidates.push({
        text: snippet,
        score: scoreHistoricalSummarySnippet(snippet, message.role, title)
      });
    }
  }

  candidates.sort((left, right) => right.score - left.score);
  return sanitizeTitleFragment(candidates[0]?.text || fallback);
}

function cleanHistoricalMessageText(value) {
  const normalized = normalizeHistoricalText(value);
  if (!normalized) {
    return "";
  }

  const lines = normalized
    .split("\n")
    .map((line) => sanitizeHistoricalLine(line))
    .filter(Boolean)
    .filter((line) => !isBoilerplateUserText(line))
    .filter((line) => !isHistoricalMetaLine(line))
    .filter((line) => !/\bagent-browser\b/i.test(line))
    .filter((line) => !/default browser automation path/i.test(line))
    .filter((line) => !/this routing rule applies to both chinese and english/i.test(line))
    .filter((line) => !/\bmemory-brain\b/i.test(line))
    .filter((line) => !/^automatic remember triggers[:：]?/i.test(line))
    .filter((line) => !/^write rules[:：]?/i.test(line))
    .filter((line) => !/what really changes in the real world and the application layer/i.test(line))
    .filter((line) => !/^<.*>$/.test(line))
    .filter((line) => !/^\[.*\]$/.test(line));

  if (!lines.length) {
    return "";
  }

  return lines.join("\n");
}

function isLowSignalTitle(value) {
  const clean = sanitizeTitleFragment(value);
  const lower = clean.toLowerCase();
  if (!lower) {
    return true;
  }

  return (
    lower === "codex" ||
    lower === "claude" ||
    lower === "session" ||
    lower === "会话" ||
    lower === "历史会话" ||
    lower === "untitled workspace" ||
    lower.startsWith("saved ") ||
    /^-\s/.test(clean) ||
    lower.startsWith("conversation info") ||
    lower.includes("safety and fallback") ||
    lower.includes("available skills") ||
    lower.includes("skill.md") ||
    lower.includes("environment_context") ||
    lower.includes("imported context from the selected codex session") ||
    lower.includes("local-command-caveat") ||
    lower.includes("invalid api key") ||
    lower.includes("please run /login")
  );
}

function isBoilerplateUserText(value) {
  const original = String(value || "").trim();
  const text = extractEmbeddedUserRequest(value).trim();
  if (!original || !text) {
    return true;
  }

  const originalLower = original.toLowerCase();
  const lower = text.toLowerCase();
  return (
    (text.startsWith("<") && text.endsWith(">")) ||
    originalLower.startsWith("# agents.md instructions") ||
    originalLower.includes("### available skills") ||
    originalLower.includes("a skill is a set of local instructions") ||
    originalLower.includes("global instructions for browser automation") ||
    originalLower.includes("global instructions for memory recall") ||
    originalLower.includes("current user accessibility context") ||
    originalLower.includes("auth-required override") ||
    originalLower.includes("default browser workflow") ||
    originalLower.includes("default memory workflow") ||
    originalLower.includes("code task execution flow") ||
    originalLower.includes("filesystem sandboxing defines") ||
    originalLower.includes("approval policy is currently never") ||
    originalLower.includes("<environment_context>") ||
    originalLower.includes("</environment_context>") ||
    originalLower.includes("<app-context>") ||
    originalLower.includes("</app-context>") ||
    originalLower.includes("<local-command-caveat>") ||
    originalLower.includes("<command-name>") ||
    originalLower.includes("<command-message>") ||
    originalLower.includes("<command-args>") ||
    originalLower.includes("<local-command-stdout>") ||
    originalLower.includes("the user doesn't want to proceed with this tool use") ||
    originalLower.includes("[request interrupted by user for tool use]") ||
    originalLower.includes("do not respond to these messages") ||
    lower.startsWith("# agents.md instructions") ||
    lower.startsWith("<environment_context>") ||
    lower.startsWith("</environment_context>") ||
    lower.startsWith("<app-context>") ||
    lower.startsWith("</app-context>") ||
    lower.startsWith("you are running inside a local discord-controlled agent bridge") ||
    lower.includes("a skill is a set of local instructions") ||
    lower.includes("### available skills") ||
    lower.includes("<instructions>") ||
    lower.includes("</instructions>") ||
    lower.includes("<local-command-caveat>") ||
    lower.includes("<command-name>") ||
    lower.includes("<command-message>") ||
    lower.includes("<command-args>") ||
    lower.includes("<local-command-stdout>") ||
    lower.includes("the user doesn't want to proceed with this tool use") ||
    lower.includes("[request interrupted by user for tool use]")
  );
}

function normalizeHistoricalText(value) {
  return stripControlChars(applyBackspaces(String(value || "")))
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, " ")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, " ")
    .replace(/\u001b[@-_]/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function isSystemTemporaryCwd(value) {
  const cwd = String(value || "").trim();
  if (!cwd) {
    return false;
  }
  return (
    cwd.startsWith("/tmp") ||
    cwd.startsWith("/var/folders") ||
    cwd.startsWith("/private/var/folders") ||
    cwd.includes("/.weclaw/workspace")
  );
}

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
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLen - 3)).trimEnd()}...`;
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

function buildEventPartFromItem(item) {
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
  const rawTimestamp =
    record?.timestamp ||
    record?.payload?.timestamp ||
    fallbackTimestamp;
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
    const rawText =
      typeof payload.message === "string" ? payload.message : extractTextContentFromPayload(payload).join("\n");
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
        payload: {
          phase
        }
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

function extractHistoricalMessagesFromRecord(record, fallbackTimestamp) {
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
  const rawText =
    typeof payload.message === "string" ? payload.message : extractTextContentFromPayload(payload).join("\n");
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

function extractHistoricalImageMessagesFromFile(filePath) {
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

function appendHistoricalMessage(messages, candidate) {
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
    const lastLooksLikeFragment =
      lastText.length <= 80 && !/[。！？.!?]$/.test(lastText) && !/\n/.test(lastText);
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

function findFirstRealUserMessage(messages) {
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    if (isBoilerplateUserText(message.text)) {
      continue;
    }
    return message.text;
  }
  return "";
}

function walkJsonlFiles(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return [];
  }

  const result = [];
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile() && fullPath.endsWith(".jsonl")) {
        result.push(fullPath);
      }
    }
  }
  return result;
}

function readSessionPreview(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function readJsonFile(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallbackValue;
  }
}

function commandBaseName(command) {
  return path
    .basename(String(command || ""))
    .replace(/\.(exe|cmd|bat|ps1)$/i, "")
    .trim()
    .toLowerCase();
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim().toLowerCase()))];
}

function customNameKey(providerId, resumeSessionId) {
  return `${String(providerId || "codex").trim()}:${String(resumeSessionId || "").trim()}`;
}

function archivedSessionKey(providerId, resumeSessionId) {
  return customNameKey(providerId, resumeSessionId);
}

function normalizeCustomNameKey(key) {
  const text = String(key || "").trim();
  if (!text) {
    return "";
  }
  return text.includes(":") ? text : customNameKey("codex", text);
}

function basenameWithoutExtension(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function contentTextItems(content) {
  if (typeof content === "string") {
    return [content];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const items = [];
  for (const item of content) {
    if (typeof item === "string") {
      items.push(item);
      continue;
    }

    if (item?.type === "input_text" && item.text) {
      items.push(String(item.text));
      continue;
    }

    if (item?.type === "text" && item.text) {
      items.push(String(item.text));
      continue;
    }

    if (item?.type === "output_text" && item.text) {
      items.push(String(item.text));
      continue;
    }

    if (item?.type === "tool_result" && item.content) {
      items.push(...contentTextItems(item.content));
    }
  }

  return items;
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

function userTextsFromPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  if (payload.type === "user_message" && payload.message) {
    return [String(payload.message)];
  }

  if (payload.role === "user") {
    return contentTextItems(payload.content);
  }

  if (payload.type === "user" && payload.message) {
    return userTextsFromPayload(payload.message);
  }

  if (payload.message?.role === "user") {
    return contentTextItems(payload.message.content);
  }

  return [];
}

function assistantTextsFromPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  if (payload.role === "assistant") {
    return contentTextItems(payload.content);
  }

  if (payload.type === "agent_message" && payload.message) {
    return [String(payload.message)];
  }

  if (payload.message?.role === "assistant") {
    return contentTextItems(payload.message.content);
  }

  return [];
}

function compactTranscriptText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => sanitizeTitleFragment(line))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseHistoricalFile(filePath) {
  const preview = readSessionPreview(filePath);
  let id = "";
  let cwd = "";
  let title = "";
  let firstInput = "";
  let firstUserMessage = "";
  let fallbackInput = "";
  const messages = [];
  let sessionTimestamp = "";
  let sessionType = "main";
  let parentThreadId = "";
  let agentRole = "";
  let agentNickname = "";
  let originator = "";
  let sourceType = "";

  for (const line of preview.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (record.type === "session_meta") {
      id = String(record.payload?.id || id);
      cwd = String(record.payload?.cwd || cwd);
      title = sanitizeTitleFragment(record.payload?.thread_name || title);
      originator = String(record.payload?.originator || originator || "").trim();
      sourceType =
        typeof record.payload?.source === "string"
          ? String(record.payload.source || sourceType || "").trim()
          : sourceType;
      sessionTimestamp = resolveRecordTimestamp(record, sessionTimestamp);
      const spawn = record?.payload?.source?.subagent?.thread_spawn || null;
      if (spawn && typeof spawn === "object") {
        sessionType = "subagent";
        parentThreadId = String(spawn.parent_thread_id || parentThreadId || "").trim();
        agentNickname = String(spawn.agent_nickname || agentNickname || "").trim();
        agentRole = String(spawn.agent_role || agentRole || "").trim();
      }
      agentRole = String(record?.payload?.agent_role || agentRole || "").trim();
      agentNickname = String(record?.payload?.agent_nickname || agentNickname || "").trim();
    }

    if (record.type === "event_msg" && record.payload?.type === "user_message") {
      const rawUserMessage = String(record.payload?.message || "");
      const normalizedUserMessage = cleanHistoricalMessageText(rawUserMessage);
      if (!firstUserMessage && normalizedUserMessage && !isBoilerplateUserText(normalizedUserMessage)) {
        firstUserMessage = normalizedUserMessage;
      }
    }

    id = String(record.sessionId || id || "");
    cwd = String(record.cwd || cwd || "");

    const candidates = extractHistoricalMessagesFromRecord(record, sessionTimestamp);
    for (const candidate of candidates) {
      if (!fallbackInput) {
        fallbackInput = candidate.text;
      }
      if (candidate.role === "user" && isBoilerplateUserText(candidate.text)) {
        continue;
      }
      if (candidate.role === "user" && !firstInput) {
        firstInput = candidate.text;
      }
      appendHistoricalMessage(messages, candidate);
    }
  }

  return {
    resumeSessionId: id || basenameWithoutExtension(filePath),
    cwd,
    title,
    titleSource: extractHistoricalTitleCandidate(title),
    firstUserMessage,
    firstInput,
    fallbackInput,
    messages,
    sessionType,
    parentThreadId,
    agentRole,
    agentNickname,
    originator,
    sourceType
  };
}

function uniqueTrimmedStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push(text);
  }
  return result;
}

function selectModel(preferred, fallback) {
  const preferredText = String(preferred || "").trim();
  if (preferredText) {
    return preferredText;
  }
  return String(fallback || "").trim();
}

function buildProviders(config) {
  const codexBootstrapNames = uniqueStrings(["codex", commandBaseName(config.codexBin)]);
  const ccBootstrapNames = uniqueStrings(["cc", "claude", commandBaseName(config.ccBin)]);
  const codexModelOptions = uniqueTrimmedStrings([config.codexModel, ...(config.codexModels || [])]);
  const ccModelOptions = uniqueTrimmedStrings([config.ccModel, ...(config.ccModels || [])]);
  const codexArgs = ({ resumeSessionId, model }) => {
    const args = [];
    const selectedModel = selectModel(model, config.codexModel);
    if (resumeSessionId) {
      args.push("resume", "--all", resumeSessionId);
    }
    if (selectedModel) {
      args.push("--model", selectedModel);
    }
    if (config.codexProfile) {
      args.push("--profile", config.codexProfile);
    }
    if (config.codexNoAltScreen) {
      args.push("--no-alt-screen");
    }
    if (config.codexFullAccess) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    if (config.codexExtraArgs.length > 0) {
      args.push(...config.codexExtraArgs);
    }
    return args;
  };
  const ccArgs = ({ resumeSessionId, name, model }) => {
    const args = [];
    const selectedModel = selectModel(model, config.ccModel);
    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    } else if (String(name || "").trim()) {
      args.push("--name", String(name).trim());
    }
    if (selectedModel) {
      args.push("--model", selectedModel);
    }
    if (config.ccFullAccess) {
      args.push("--dangerously-skip-permissions");
    }
    if (config.ccExtraArgs.length > 0) {
      args.push(...config.ccExtraArgs);
    }
    return args;
  };

  return [
    {
      id: "codex",
      aliases: ["codex"],
      label: "Codex",
      cliLabel: "Codex CLI",
      historyLabel: "Saved Codex sessions",
      fallbackPrefix: "codex",
      sessionsDir: config.codexSessionsDir,
      bootstrapNames: codexBootstrapNames,
      defaultModel: config.codexModel,
      models: codexModelOptions,
      buildSpawnSpec({ resumeSessionId, model }) {
        return {
          file: config.codexBin,
          args: codexArgs({ resumeSessionId, model })
        };
      },
      buildCommand({ resumeSessionId, model }) {
        const parts = [config.codexBin, ...codexArgs({ resumeSessionId, model })];
        return buildShellCommand(parts, config.shellQuoteStyle);
      }
    },
    {
      id: "cc",
      aliases: ["cc", "claude"],
      label: "Claude",
      cliLabel: "Claude CLI",
      historyLabel: "Saved Claude sessions",
      fallbackPrefix: "cc",
      sessionsDir: config.ccSessionsDir,
      bootstrapNames: ccBootstrapNames,
      defaultModel: config.ccModel,
      models: ccModelOptions,
      buildSpawnSpec({ resumeSessionId, name, model }) {
        return {
          file: config.ccBin,
          args: ccArgs({ resumeSessionId, name, model })
        };
      },
      buildCommand({ resumeSessionId, name, model }) {
        const parts = [config.ccBin, ...ccArgs({ resumeSessionId, name, model })];
        return buildShellCommand(parts, config.shellQuoteStyle);
      }
    }
  ];
}

export class SessionManager {
  constructor(config, { appServerBridge = null } = {}) {
    this.config = config;
    this.appServerBridge = appServerBridge;
    this.sessions = new Map();
    this.providers = new Map(buildProviders(config).map((provider) => [provider.id, provider]));
    this.customNamesPath = path.join(this.config.dataDir, "session-names.json");
    this.archivedSessionsPath = path.join(this.config.dataDir, "archived-sessions.json");
    this.codexSessionIndexPath = path.join(path.dirname(this.config.codexSessionsDir), "session_index.jsonl");
    this.codexSessionIndexCache = { mtimeMs: -1, size: -1, byId: new Map() };
    this.customNames = new Map(
      Object.entries(readJsonFile(this.customNamesPath, {}))
        .map(([key, value]) => [normalizeCustomNameKey(key), value])
        .filter((entry) => entry[0] && entry[1])
    );
    this.archivedSessions = new Map(
      Object.entries(readJsonFile(this.archivedSessionsPath, {}))
        .map(([key, value]) => [normalizeCustomNameKey(key), String(value || "").trim()])
        .filter((entry) => entry[0] && entry[1])
    );
    fs.mkdirSync(this.config.dataDir, { recursive: true });
    if (this.appServerBridge) {
      this.appServerBridge.on("notification", (msg) => this.handleAppServerNotification(msg));
      this.appServerBridge.on("log", (line) => {
        const text = String(line || "").trim();
        if (text) {
          console.warn(`[app-server] ${text}`);
        }
      });
    }
  }

  getCodexThreadName(resumeSessionId) {
    const id = String(resumeSessionId || "").trim();
    if (!id) {
      return "";
    }
    this.ensureCodexSessionIndexCache();
    return String(this.codexSessionIndexCache.byId.get(id) || "").trim();
  }

  hasCodexSessionIndexEntry(resumeSessionId) {
    const id = String(resumeSessionId || "").trim();
    if (!id) {
      return false;
    }
    this.ensureCodexSessionIndexCache();
    return this.codexSessionIndexCache.byId.has(id);
  }

  ensureCodexSessionIndexCache() {
    try {
      const stat = fs.statSync(this.codexSessionIndexPath);
      const shouldReload =
        stat.mtimeMs !== this.codexSessionIndexCache.mtimeMs || stat.size !== this.codexSessionIndexCache.size;
      if (shouldReload) {
        const byId = new Map();
        const content = fs.readFileSync(this.codexSessionIndexPath, "utf8");
        for (const line of content.split(/\r?\n/)) {
          if (!line.trim()) {
            continue;
          }
          try {
            const record = JSON.parse(line);
            const recordId = String(record?.id || "").trim();
            const threadName = String(record?.thread_name || "").trim();
            if (recordId && threadName) {
              byId.set(recordId, threadName);
            }
          } catch {
            // Ignore malformed rows.
          }
        }
        this.codexSessionIndexCache = { mtimeMs: stat.mtimeMs, size: stat.size, byId };
      }
    } catch {
      this.codexSessionIndexCache = { mtimeMs: -1, size: -1, byId: new Map() };
    }
  }

  providerCatalog() {
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      label: provider.label,
      cliLabel: provider.cliLabel,
      historyLabel: provider.historyLabel,
      defaultModel: provider.defaultModel || "",
      models: provider.models || []
    }));
  }

  getProvider(providerId = "codex") {
    const normalizedId = String(providerId || "codex").trim().toLowerCase() || "codex";
    const provider =
      this.providers.get(normalizedId) ||
      [...this.providers.values()].find((item) => Array.isArray(item.aliases) && item.aliases.includes(normalizedId));
    if (!provider) {
      throw new Error(`Unsupported session provider: ${providerId}`);
    }
    return provider;
  }

  list() {
    return this.listLiveSessions();
  }

  listLiveSessions() {
    return [...this.sessions.values()]
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((session) => this.serialize(session));
  }

  listAll() {
    const liveSessions = this.listLiveSessions();
    const liveByResumeId = new Set(
      liveSessions
        .map((session) => this.resumeKey(session.provider, session.resumeSessionId))
        .filter(Boolean)
    );
    const historySessions = this.listHistoricalSessions({ archived: false }).filter((session) => {
      return !liveByResumeId.has(this.resumeKey(session.provider, session.resumeSessionId));
    });
    return [...liveSessions, ...historySessions].sort((a, b) =>
      String(b.updatedAt).localeCompare(String(a.updatedAt))
    );
  }

  listArchived() {
    return this.listHistoricalSessions({ archived: true });
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  stats() {
    let clientCount = 0;
    let running = 0;
    let exited = 0;
    for (const session of this.sessions.values()) {
      clientCount += session.clients.size;
      if (session.status === "exited") {
        exited += 1;
      } else {
        running += 1;
      }
    }

    return {
      sessions: this.sessions.size,
      clients: clientCount,
      running,
      exited
    };
  }

  findRunningLiveSessionByResume(providerId, resumeSessionId) {
    const provider = this.getProvider(providerId);
    const targetResumeId = String(resumeSessionId || "").trim();
    if (!targetResumeId) {
      return null;
    }
    const candidates = [...this.sessions.values()]
      .filter(
        (session) =>
          session.provider === provider.id &&
          session.status !== "exited" &&
          String(session.resumeSessionId || "").trim() === targetResumeId
      )
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
    return candidates.length ? this.serialize(candidates[0]) : null;
  }

  create({ cwd = "", name = "", resumeSessionId = "", provider = "codex", model = "" } = {}) {
    const resolvedProvider = this.getProvider(provider);
    const id = crypto.randomUUID();
    const resolvedCwd = this.resolveCwd(cwd);
    const fallbackName = `${resolvedProvider.fallbackPrefix}-${this.sessions.size + 1}`;
    const sessionName = normalizeName(name, fallbackName);
    const spawnSpec = resolvedProvider.buildSpawnSpec({
      resumeSessionId: String(resumeSessionId || "").trim() || null,
      name: sessionName,
      model: String(model || "").trim()
    });

    if (resolvedProvider.id === "codex") {
      const preferAppServer = Boolean(this.config.codexAppServerEnabled && this.appServerBridge);
      const session = {
        id,
        provider: resolvedProvider.id,
        providerLabel: resolvedProvider.label,
        cliLabel: resolvedProvider.cliLabel,
        name: sessionName,
        cwd: resolvedCwd,
        shell: null,
        buffer: "",
        status: "running",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        exitCode: null,
        clients: new Set(),
        autoNamed: !String(name || "").trim(),
        fallbackName,
        inputPreview: "",
        sawBootstrapCommand: true,
        bootstrapNames: resolvedProvider.bootstrapNames,
        claudeStartupStage: 2,
        resumeSessionId: String(resumeSessionId || "").trim() || null,
        resumeBootstrapComplete: true,
        pendingResumeInput: "",
        model: String(model || "").trim() || resolvedProvider.defaultModel || "",
        titleSource: String(name || "").trim() ? "user_provided" : "auto_generated",
        runnerMode: preferAppServer ? "app_server" : "json_exec",
        turnRunning: false,
        turnHadVisibleOutput: false,
        turnNoReplyNotified: false,
        runningProcess: null,
        queuedInputs: [],
        sessionType: "main",
        parentThreadId: "",
        agentRole: "",
        agentNickname: ""
      };
      this.sessions.set(id, session);
      return this.serialize(session);
    }

    const shell = pty.spawn(spawnSpec.file, spawnSpec.args, {
      name: "xterm-color",
      cols: 120,
      rows: 30,
      cwd: resolvedCwd,
      env: {
        ...process.env,
        TERM: "xterm-256color"
      }
    });

    const session = {
      id,
      provider: resolvedProvider.id,
      providerLabel: resolvedProvider.label,
      cliLabel: resolvedProvider.cliLabel,
      name: sessionName,
      cwd: resolvedCwd,
      shell,
      buffer: "",
      status: "starting",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      exitCode: null,
      clients: new Set(),
      autoNamed: !String(name || "").trim(),
      fallbackName,
      inputPreview: "",
      sawBootstrapCommand: false,
      bootstrapNames: resolvedProvider.bootstrapNames,
      claudeStartupStage: 0,
      resumeSessionId: String(resumeSessionId || "").trim() || null,
      resumeBootstrapComplete: !String(resumeSessionId || "").trim(),
      pendingResumeInput: "",
      model: String(model || "").trim() || resolvedProvider.defaultModel || "",
      titleSource: String(name || "").trim() ? "user_provided" : "auto_generated",
      sessionType: "main",
      parentThreadId: "",
      agentRole: "",
      agentNickname: ""
    };

    shell.onData((chunk) => {
      session.status = "running";
      session.updatedAt = nowIso();
      this.maybeAutoAdvanceClaudeStartup(session);

      const visibleChunk = filterLiveOutputChunk(session, chunk);
      if (!visibleChunk) {
        return;
      }

      const { text: textChunk, images } = extractImagePartsFromMarkdown(visibleChunk);
      if (!textChunk && images.length === 0) {
        return;
      }

      if (textChunk) {
        session.buffer += textChunk;
      }
      for (const image of images) {
        session.buffer += `\n![${image.alt || "image"}](${image.url})\n`;
      }
      if (session.buffer.length > this.config.sessionBufferLimit) {
        session.buffer = session.buffer.slice(-this.config.sessionBufferLimit);
      }

      for (const client of session.clients) {
        if (textChunk) {
          client.send(
            JSON.stringify({
              type: "message_part",
              role: "assistant",
              part: {
                type: "text",
                text: textChunk,
                format: "terminal_raw"
              },
              phase: "streaming",
              timestamp: nowIso()
            })
          );
        }
        for (const image of images) {
          client.send(
            JSON.stringify({
              type: "message_part",
              role: "assistant",
              part: image,
              timestamp: nowIso()
            })
          );
        }
      }
    });

    shell.onExit(({ exitCode }) => {
      session.exitCode = exitCode;
      session.status = "exited";
      session.updatedAt = nowIso();
      if (!this.persistSessionName(session)) {
        this.scheduleDeferredNamePersistence(session);
      }
      for (const client of session.clients) {
        client.send(JSON.stringify({ type: "exit", exitCode }));
      }
    });

    this.sessions.set(id, session);
    return this.serialize(session);
  }

  pushSessionBuffer(session, text = "") {
    const value = String(text || "");
    if (!value) {
      return;
    }
    session.buffer += value;
    if (session.buffer.length > this.config.sessionBufferLimit) {
      session.buffer = session.buffer.slice(-this.config.sessionBufferLimit);
    }
  }

  broadcast(session, payload) {
    for (const client of session.clients) {
      try {
        client.send(JSON.stringify(payload));
      } catch {
        // Ignore transient ws send failures.
      }
    }
  }

  attachClient(id, ws) {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }

    session.clients.add(ws);
    ws.send(
      JSON.stringify({
        type: "snapshot",
        session: this.serialize(session),
        buffer: session.buffer
      })
    );

    ws.on("close", () => {
      session.clients.delete(ws);
    });
  }

  enqueueJsonExecInput(session, data) {
    const text = String(data || "");
    if (!text) {
      return;
    }
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) {
      return;
    }

    const queueLimit = Math.max(1, Number(this.config.maxQueuedInputs) || 200);
    if (session.queuedInputs.length + lines.length > queueLimit) {
      throw new Error(`当前会话待处理消息过多（上限 ${queueLimit}），请稍后重试。`);
    }

    for (const line of lines) {
      session.queuedInputs.push(line);
    }
    session.updatedAt = nowIso();
    if (session.runnerMode === "app_server") {
      this.maybeStartAppServerTurn(session);
      return;
    }
    this.maybeStartJsonExecRun(session);
  }

  async maybeStartAppServerTurn(session) {
    if (!session || session.runnerMode !== "app_server") {
      return;
    }
    if (session.turnRunning) {
      return;
    }
    const prompt = session.queuedInputs.shift();
    if (!prompt) {
      return;
    }
    session.turnRunning = true;
    session.turnHadVisibleOutput = false;
    session.turnNoReplyNotified = false;
    session.updatedAt = nowIso();
    try {
      const result = await this.appServerBridge.startTurn(session, prompt);
      this.handleAppServerTurnResult(session, result);
      session.turnRunning = false;
      session.updatedAt = nowIso();
      this.broadcast(session, { type: "session_updated", session: this.serialize(session) });
      this.maybeStartAppServerTurn(session);
    } catch (error) {
      session.turnRunning = false;
      session.updatedAt = nowIso();
      this.broadcast(session, {
        type: "message_part",
        role: "system",
        part: { type: "text", text: `Codex app-server 执行失败：${error?.message || String(error)}` },
        phase: "final",
        timestamp: nowIso()
      });
      this.maybeStartAppServerTurn(session);
    }
  }

  handleAppServerTurnResult(session, result) {
    const items = extractTurnItems(result);
    if (!items.length) {
      return false;
    }
    let hadOutput = false;
    for (const item of items) {
      if (!isAgentMessageType(item?.type)) {
        const eventPart = buildEventPartFromItem(item);
        if (eventPart) {
          this.broadcast(session, {
            type: "message_part",
            role: "assistant",
            part: eventPart,
            phase: "final",
            timestamp: nowIso()
          });
        }
        continue;
      }
      const text = String(item?.text || "").trim();
      if (!text) {
        continue;
      }
      hadOutput = true;
      session.turnHadVisibleOutput = true;
      this.pushSessionBuffer(session, `${text}\n`);
      this.broadcast(session, {
        type: "message_part",
        role: "assistant",
        part: { type: "text", text, format: "markdown" },
        phase: "final",
        timestamp: nowIso()
      });
    }
    return hadOutput;
  }

  maybeStartJsonExecRun(session) {
    if (!session || session.runnerMode !== "json_exec") {
      return;
    }
    if (session.runningProcess) {
      return;
    }

    const prompt = session.queuedInputs.shift();
    if (!prompt) {
      return;
    }

    const args = this.buildCodexJsonExecArgs(session, prompt);
    const child = spawn(this.config.codexBin, args, {
      cwd: session.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    session.runningProcess = child;
    session.updatedAt = nowIso();

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let emittedAssistant = false;
    const parseLine = (line) => {
      const trimmed = String(line || "").trim();
      if (!trimmed) {
        return;
      }
      try {
        const event = JSON.parse(trimmed);
        if (this.handleCodexJsonEvent(session, event)) {
          emittedAssistant = true;
        }
      } catch {
        // Ignore non-json diagnostic lines.
      }
    };

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += String(chunk || "");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        parseLine(line);
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBuffer += String(chunk || "");
      if (stderrBuffer.length > 10000) {
        stderrBuffer = stderrBuffer.slice(-10000);
      }
    });

    child.on("close", (code) => {
      if (stdoutBuffer.trim()) {
        parseLine(stdoutBuffer.trim());
      }
      session.runningProcess = null;
      session.updatedAt = nowIso();
      if (code && code !== 0) {
        const concise = String(stderrBuffer || "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 220);
        this.broadcast(session, {
          type: "message_part",
          role: "system",
          part: { type: "text", text: concise ? `Codex 执行失败（exit=${code}）：${concise}` : `Codex 执行失败（exit=${code}）` },
          phase: "final",
          timestamp: nowIso()
        });
      } else if (!emittedAssistant) {
        const concise = String(stderrBuffer || "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 220);
        this.broadcast(session, {
          type: "message_part",
          role: "system",
          part: { type: "text", text: concise ? `本轮无可展示回复：${concise}` : "本轮未返回可展示文本。" },
          phase: "final",
          timestamp: nowIso()
        });
      }
      this.maybeStartJsonExecRun(session);
    });
  }

  buildCodexJsonExecArgs(session, prompt) {
    const args = ["exec"];
    if (session.resumeSessionId) {
      args.push("resume", "--all", session.resumeSessionId);
    }
    args.push("--json", "--skip-git-repo-check");
    const model = String(session.model || "").trim();
    if (model) {
      args.push("--model", model);
    }
    if (this.config.codexProfile) {
      args.push("--profile", this.config.codexProfile);
    }
    if (this.config.codexFullAccess) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    if (Array.isArray(this.config.codexExtraArgs) && this.config.codexExtraArgs.length > 0) {
      args.push(...this.config.codexExtraArgs);
    }
    args.push(prompt);
    return args;
  }

  handleCodexJsonEvent(session, event) {
    if (!event || typeof event !== "object") {
      return false;
    }
    if (event.type === "thread.started" && event.thread_id && !session.resumeSessionId) {
      session.resumeSessionId = String(event.thread_id || "").trim() || session.resumeSessionId;
      session.updatedAt = nowIso();
      this.broadcast(session, {
        type: "session_updated",
        session: this.serialize(session)
      });
    }
    if (event.type === "item.completed") {
      const item = event.item || {};
      if (String(item.type || "").trim() !== "agent_message") {
        const eventPart = buildEventPartFromItem(item);
        if (eventPart) {
          this.broadcast(session, {
            type: "message_part",
            role: "assistant",
            part: eventPart,
            phase: "final",
            timestamp: nowIso()
          });
        }
        return false;
      }
      const text = String(item.text || "").trim();
      if (!text) {
        return false;
      }
      this.pushSessionBuffer(session, `${text}\n`);
      this.broadcast(session, {
        type: "message_part",
        role: "assistant",
        part: { type: "text", text, format: "markdown" },
        phase: "final",
        timestamp: nowIso()
      });
      return true;
    }
    return false;
  }

  handleAppServerNotification(msg) {
    const method = String(msg?.method || "");
    const normalizedMethod = normalizeSymbolToken(method);
    const params = msg?.params || {};
    const threadId = String(params?.threadId || params?.thread_id || "").trim();
    if (!threadId) {
      return;
    }
    const targets = [...this.sessions.values()].filter(
      (session) => session.provider === "codex" && String(session.resumeSessionId || "").trim() === threadId
    );
    if (!targets.length) {
      return;
    }

    for (const session of targets) {
      session.updatedAt = nowIso();
      if (method === "item/agentMessage/delta" || normalizedMethod === "itemagentmessagedelta") {
        const delta = String(params?.delta || "");
        if (!delta.trim()) {
          continue;
        }
        session.turnHadVisibleOutput = true;
        this.pushSessionBuffer(session, delta);
        this.broadcast(session, {
          type: "message_part",
          role: "assistant",
          part: { type: "text", text: delta, format: "markdown" },
          phase: "streaming",
          timestamp: nowIso()
        });
        continue;
      }
      if (method === "item/completed" || normalizedMethod === "itemcompleted") {
        const item = params?.item || {};
        if (!isAgentMessageType(item?.type)) {
          const eventPart = buildEventPartFromItem(item);
          if (eventPart) {
            this.broadcast(session, {
              type: "message_part",
              role: "assistant",
              part: eventPart,
              phase: "final",
              timestamp: nowIso()
            });
          }
          continue;
        }
        const text = String(item?.text || "").trim();
        if (!text) {
          continue;
        }
        session.turnHadVisibleOutput = true;
        this.pushSessionBuffer(session, `${text}\n`);
        this.broadcast(session, {
          type: "message_part",
          role: "assistant",
          part: { type: "text", text, format: "markdown" },
          phase: "final",
          timestamp: nowIso()
        });
        continue;
      }
      if (method === "turn/completed" || normalizedMethod === "turncompleted") {
        if (!session.turnHadVisibleOutput) {
          emitNoReplyFallback(this, session);
        }
        continue;
      }
      if (method === "thread/status/changed" || normalizedMethod === "threadstatuschanged") {
        this.broadcast(session, { type: "session_updated", session: this.serialize(session) });
      }
    }
  }

  write(id, data) {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }

    const text = String(data || "");
    if (!text) {
      return;
    }

    this.maybeAutoRename(session, text);
    if (session.resumeSessionId && !session.resumeBootstrapComplete) {
      session.pendingResumeInput = `${session.pendingResumeInput || ""}${text}`.slice(-4096);
      session.updatedAt = nowIso();
    }
    if (session.runnerMode === "json_exec" || session.runnerMode === "app_server") {
      this.enqueueJsonExecInput(session, text);
      return;
    }

    session.shell.write(text);
    session.updatedAt = nowIso();
  }

  resize(id, cols, rows) {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }

    if (session.runnerMode === "json_exec" || session.runnerMode === "app_server") {
      return;
    }

    session.shell.resize(Math.max(20, cols || 120), Math.max(10, rows || 30));
    session.updatedAt = nowIso();
  }

  rename(id, name) {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }

    session.name = normalizeName(name, session.fallbackName || session.name);
    session.autoNamed = false;
    session.updatedAt = nowIso();
    this.persistSessionName(session);
    return this.serialize(session);
  }

  close(id) {
    const session = this.get(id);
    if (!session) {
      return false;
    }

    session.status = "closing";
    session.updatedAt = nowIso();
    try {
      if (session.runnerMode === "json_exec" || session.runnerMode === "app_server") {
        session.turnRunning = false;
      } else {
        session.shell.kill();
      }
    } catch {
      // Ignore kill failures.
    }
    this.sessions.delete(id);
    return true;
  }

  shutdown() {
    for (const session of [...this.sessions.values()]) {
      try {
        if (session.runnerMode === "json_exec" || session.runnerMode === "app_server") {
          session.turnRunning = false;
        } else {
          session.shell.kill();
        }
      } catch {
        // Ignore kill failures during shutdown.
      }
      session.clients.clear();
    }
    this.sessions.clear();
  }

  resolveCwd(cwd) {
    const value = String(cwd || "").trim();
    if (!value) {
      return this.config.defaultCwd;
    }

    const resolved = path.resolve(value);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return resolved;
    }

    return this.config.defaultCwd;
  }

  serialize(session) {
    return {
      id: session.id,
      provider: session.provider,
      providerLabel: session.providerLabel,
      cliLabel: session.cliLabel,
      name: session.name,
      cwd: session.cwd,
      kind: "live",
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      exitCode: session.exitCode,
      autoNamed: session.autoNamed,
      inputPreview: session.inputPreview,
      resumeSessionId: session.resumeSessionId,
      model: session.model || "",
      titleSource: session.titleSource || "",
      sessionType: session.sessionType || "main",
      parentThreadId: session.parentThreadId || "",
      agentRole: session.agentRole || "",
      agentNickname: session.agentNickname || ""
    };
  }

  listHistoricalSessions({ archived = null } = {}) {
    return [...this.providers.values()]
      .flatMap((provider) => this.listHistoricalSessionsForProvider(provider, { archived }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  listHistoricalSessionsForProvider(provider, { archived = null } = {}) {
    const byResumeId = new Map();

    for (const entry of this.scanHistoricalSessionsForProvider(provider)) {
      const isArchived = this.isArchived(provider.id, entry.resumeSessionId);
      if (archived !== null && isArchived !== archived) {
        continue;
      }

      const session = this.buildHistoricalSession(provider, entry, isArchived ? "archived" : "history");
      const existing = byResumeId.get(entry.resumeSessionId);
      if (!existing || existing.updatedAt < session.updatedAt) {
        byResumeId.set(entry.resumeSessionId, session);
      }
    }

    return [...byResumeId.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  scanHistoricalSessionsForProvider(provider) {
    const files = walkJsonlFiles(provider.sessionsDir);
    const entries = [];

    for (const filePath of files) {
      try {
        const stat = fs.statSync(filePath);
        const parsed = parseHistoricalFile(filePath);
        const id = parsed.resumeSessionId || basenameWithoutExtension(filePath);
        if (!id) {
          continue;
        }
        const isCodexCliSession =
          /codex_cli/i.test(String(parsed.originator || "")) || /^cli$/i.test(String(parsed.sourceType || ""));
        if (provider.id === "codex") {
          const inIndex = this.hasCodexSessionIndexEntry(id);
          const keepByTemp = isSystemTemporaryCwd(parsed.cwd);
          const keepByCli = isCodexCliSession;
          if (!inIndex && !keepByTemp && !keepByCli) {
            continue;
          }
        }
        const indexedTitle = provider.id === "codex" ? this.getCodexThreadName(id) : "";
        const parsedTitle = String(parsed.title || "").trim();
        const effectiveTitle = String(indexedTitle || parsedTitle).trim();
        const effectiveTitleSource = indexedTitle
          ? "codex_session_index"
          : parsedTitle
            ? "session_meta"
            : "";

        entries.push({
          filePath,
          stat,
          resumeSessionId: id,
          cwd: parsed.cwd || this.config.defaultCwd,
          title: effectiveTitle,
          titleSource: effectiveTitleSource,
          firstUserMessage: parsed.firstUserMessage,
          firstInput: parsed.firstInput,
          fallbackInput: parsed.fallbackInput,
          messages: parsed.messages,
          sessionType: parsed.sessionType === "subagent" ? "subagent" : "main",
          parentThreadId: String(parsed.parentThreadId || "").trim(),
          agentRole: String(parsed.agentRole || "").trim(),
          agentNickname: String(parsed.agentNickname || "").trim()
        });
      } catch {
        // Ignore malformed or unreadable session files.
      }
    }

    return entries;
  }

  buildHistoricalSession(provider, entry, kind = "history") {
    const fallbackSavedName = `Saved ${path.basename(entry.cwd || this.config.defaultCwd)} ${formatShortTimestamp(
      entry.stat.mtime,
      this.config.timezone
    )}`;
    const titleSource = extractHistoricalTitleCandidate(entry.title);
    const canonicalTitle = String(entry.title || "").trim();
    const summarySource = extractHistoricalSummaryCandidate(
      entry.messages || [],
      canonicalTitle || fallbackSavedName,
      entry.firstUserMessage || entry.firstInput || entry.fallbackInput || ""
    );
    const finalName =
      this.getCustomName(provider.id, entry.resumeSessionId) ||
      (canonicalTitle || fallbackSavedName);
    const finalTitleSource = this.getCustomName(provider.id, entry.resumeSessionId)
      ? "custom_name"
      : canonicalTitle
        ? (entry.titleSource || "session_meta")
        : "fallback_saved_name";
    return {
      id: `history:${provider.id}:${entry.resumeSessionId}`,
      provider: provider.id,
      providerLabel: provider.label,
      cliLabel: provider.cliLabel,
      name: finalName,
      titleSource: finalTitleSource,
      cwd: entry.cwd,
      kind,
      status: kind === "archived" ? "archived" : "saved",
      createdAt: entry.stat.birthtime.toISOString(),
      updatedAt: entry.stat.mtime.toISOString(),
      exitCode: null,
      autoNamed: false,
      inputPreview: summarySource || titleSource || entry.firstInput || entry.fallbackInput || "",
      resumeSessionId: entry.resumeSessionId,
      archivedAt: this.getArchivedAt(provider.id, entry.resumeSessionId),
      sessionType: entry.sessionType === "subagent" ? "subagent" : "main",
      parentThreadId: String(entry.parentThreadId || "").trim(),
      agentRole: String(entry.agentRole || "").trim(),
      agentNickname: String(entry.agentNickname || "").trim()
    };
  }

  getHistoricalMessages(providerId, resumeSessionId) {
    const provider = this.getProvider(providerId);
    const targetId = String(resumeSessionId || "").trim();
    const entries = this.scanHistoricalSessionsForProvider(provider).filter((item) => item.resumeSessionId === targetId);
    if (!entries.length) {
      throw new Error(`Historical session not found: ${providerId}/${resumeSessionId}`);
    }

    const entry = entries.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0];
    let liveParsedMessages = entry.messages || [];
    try {
      liveParsedMessages = parseHistoricalFile(entry.filePath).messages || liveParsedMessages;
    } catch {
      // Fall back to scanned messages if direct reparse fails.
    }
    try {
      const imageMessages = extractHistoricalImageMessagesFromFile(entry.filePath);
      if (imageMessages.length) {
        const seen = new Set(
          liveParsedMessages
            .filter((item) => String(item?.partType || "") === "image" && String(item?.payload?.url || "").trim())
            .map((item) => `${item.timestamp}|${String(item.payload.url).trim()}`)
        );
        for (const image of imageMessages) {
          const key = `${image.timestamp}|${String(image?.payload?.url || "").trim()}`;
          if (!seen.has(key)) {
            liveParsedMessages.push(image);
            seen.add(key);
          }
        }
        liveParsedMessages.sort(
          (left, right) => Date.parse(String(left?.timestamp || "")) - Date.parse(String(right?.timestamp || ""))
        );
      }
    } catch {
      // Keep text-only historical messages if image recovery fails.
    }
    return {
      session: this.buildHistoricalSession(provider, entry, this.isArchived(provider.id, entry.resumeSessionId) ? "archived" : "history"),
      messages: liveParsedMessages
    };
  }

  maybeAutoRename(session, chunk) {
    if (!session.autoNamed) {
      return;
    }

    const text = String(chunk || "");
    if (!text) {
      return;
    }

    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    for (const segment of normalized.split("\n")) {
      const candidate = sanitizeTitleFragment(segment);
      if (!candidate) {
        continue;
      }

      const lowerCandidate = candidate.toLowerCase();
      if (!session.sawBootstrapCommand && session.bootstrapNames.includes(lowerCandidate)) {
        session.sawBootstrapCommand = true;
        continue;
      }

      session.inputPreview = candidate;
      session.name = deriveSessionTitle(candidate, session.fallbackName);
      session.titleSource = "first_user_input";
      session.autoNamed = false;
      session.updatedAt = nowIso();
      this.persistSessionName(session);
      return;
    }
  }

  maybeAutoAdvanceClaudeStartup(session) {
    if (!session || session.provider !== "cc" || session.claudeStartupStage >= 2) {
      return;
    }

    const text = stripTerminalControlSequences(session.buffer.slice(-6000));
    if (session.claudeStartupStage < 1 && text.includes("Yes, I trust this folder") && text.includes("No, exit")) {
      session.claudeStartupStage = 1;
      session.shell.write("\r");
      session.updatedAt = nowIso();
      return;
    }

    if (
      session.claudeStartupStage < 2 &&
      text.includes("WARNING: Claude Code running in Bypass Permissions mode") &&
      text.includes("Yes, I accept")
    ) {
      session.claudeStartupStage = 2;
      session.shell.write("\u001b[B");
      setTimeout(() => {
        if (!this.sessions.has(session.id) || session.status === "exited") {
          return;
        }
        session.shell.write("\r");
      }, 150).unref?.();
      session.updatedAt = nowIso();
    }
  }

  saveCustomNames() {
    const payload = Object.fromEntries(
      [...this.customNames.entries()].sort((left, right) => left[0].localeCompare(right[0]))
    );
    fs.writeFileSync(this.customNamesPath, JSON.stringify(payload, null, 2), "utf8");
  }

  saveArchivedSessions() {
    const payload = Object.fromEntries(
      [...this.archivedSessions.entries()].sort((left, right) => left[0].localeCompare(right[0]))
    );
    fs.writeFileSync(this.archivedSessionsPath, JSON.stringify(payload, null, 2), "utf8");
  }

  getCustomName(providerId, resumeSessionId) {
    const key = customNameKey(providerId, resumeSessionId);
    return this.customNames.get(key) || null;
  }

  setCustomName(providerId, resumeSessionId, name) {
    const key = customNameKey(providerId, resumeSessionId);
    const value = String(name || "").trim();
    if (!key.endsWith(":") && value) {
      this.customNames.set(key, value);
      this.saveCustomNames();
    }
  }

  removeCustomName(providerId, resumeSessionId) {
    const key = customNameKey(providerId, resumeSessionId);
    if (this.customNames.delete(key)) {
      this.saveCustomNames();
    }
  }

  isArchived(providerId, resumeSessionId) {
    return this.archivedSessions.has(archivedSessionKey(providerId, resumeSessionId));
  }

  getArchivedAt(providerId, resumeSessionId) {
    return this.archivedSessions.get(archivedSessionKey(providerId, resumeSessionId)) || null;
  }

  setArchived(providerId, resumeSessionId, archivedAt = nowIso()) {
    const key = archivedSessionKey(providerId, resumeSessionId);
    this.archivedSessions.set(key, archivedAt);
    this.saveArchivedSessions();
  }

  clearArchived(providerId, resumeSessionId) {
    const key = archivedSessionKey(providerId, resumeSessionId);
    if (this.archivedSessions.delete(key)) {
      this.saveArchivedSessions();
    }
  }

  getHistoricalSession(providerId, resumeSessionId, { archived = null } = {}) {
    const provider = this.getProvider(providerId);
    return this.listHistoricalSessionsForProvider(provider, { archived }).find(
      (session) => session.resumeSessionId === String(resumeSessionId || "").trim()
    ) || null;
  }

  archiveHistoricalSession(providerId, resumeSessionId) {
    const session = this.getHistoricalSession(providerId, resumeSessionId, { archived: false });
    if (!session) {
      throw new Error(`Historical session not found: ${providerId}/${resumeSessionId}`);
    }

    this.setArchived(providerId, resumeSessionId);
    return this.getHistoricalSession(providerId, resumeSessionId, { archived: true });
  }

  restoreHistoricalSession(providerId, resumeSessionId) {
    const session = this.getHistoricalSession(providerId, resumeSessionId, { archived: true });
    if (!session) {
      throw new Error(`Archived session not found: ${providerId}/${resumeSessionId}`);
    }

    this.clearArchived(providerId, resumeSessionId);
    return this.getHistoricalSession(providerId, resumeSessionId, { archived: false });
  }

  deleteHistoricalSession(providerId, resumeSessionId) {
    const provider = this.getProvider(providerId);
    const targetId = String(resumeSessionId || "").trim();
    const entries = this.scanHistoricalSessionsForProvider(provider).filter((entry) => entry.resumeSessionId === targetId);
    if (!entries.length) {
      throw new Error(`Historical session not found: ${providerId}/${resumeSessionId}`);
    }

    for (const entry of entries) {
      fs.rmSync(entry.filePath, { force: true });
    }
    this.clearArchived(providerId, resumeSessionId);
    this.removeCustomName(providerId, resumeSessionId);
    return true;
  }

  resumeKey(providerId, resumeSessionId) {
    const value = String(resumeSessionId || "").trim();
    if (!value) {
      return "";
    }
    return customNameKey(providerId, value);
  }

  findHistoricalMatch(session) {
    const sessionCreatedAt = Date.parse(String(session?.createdAt || ""));
    const candidates = this.listHistoricalSessions().filter((item) => {
      if (item.provider !== session.provider || item.cwd !== session.cwd) {
        return false;
      }

      if (Number.isNaN(sessionCreatedAt)) {
        return true;
      }

      const itemUpdatedAt = Date.parse(String(item.updatedAt || ""));
      return Number.isNaN(itemUpdatedAt) || itemUpdatedAt >= sessionCreatedAt;
    });
    if (!candidates.length) {
      return null;
    }

    const preview = String(session.inputPreview || "").trim().toLowerCase();
    const withSamePreview = preview
      ? candidates.filter((item) => String(item.inputPreview || "").trim().toLowerCase() === preview)
      : [];
    const pool = withSamePreview.length ? withSamePreview : candidates;
    return [...pool].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
  }

  persistSessionName(session) {
    if (!session || session.autoNamed) {
      return false;
    }

    const name = String(session.name || "").trim();
    if (!name) {
      return false;
    }

    if (session.resumeSessionId) {
      this.setCustomName(session.provider, session.resumeSessionId, name);
      return true;
    }

    const historicalSession = this.findHistoricalMatch(session);
    if (historicalSession?.resumeSessionId) {
      this.setCustomName(session.provider, historicalSession.resumeSessionId, name);
      return true;
    }

    return false;
  }

  scheduleDeferredNamePersistence(session) {
    if (!session || session.autoNamed || session.resumeSessionId) {
      return;
    }

    const snapshot = {
      provider: session.provider,
      cwd: session.cwd,
      inputPreview: session.inputPreview,
      name: session.name,
      createdAt: session.createdAt,
      autoNamed: false,
      resumeSessionId: null
    };

    let attempts = 0;
    const tryPersist = () => {
      attempts += 1;
      if (this.persistSessionName(snapshot) || attempts >= 12) {
        return;
      }
      setTimeout(tryPersist, 250).unref?.();
    };

    setTimeout(tryPersist, 150).unref?.();
  }

  buildProviderCommand(session) {
    const provider = this.getProvider(session.provider);
    return provider.buildCommand({
      resumeSessionId: session.resumeSessionId,
      name: session.autoNamed ? "" : session.name
    });
  }
}
