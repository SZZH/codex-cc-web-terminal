import { applyBackspaces, sanitizeTitleFragment, stripControlChars } from "../shared/text.js";

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

export function isBoilerplateUserText(value) {
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

export function extractHistoricalTitleCandidate(value) {
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

export function extractHistoricalSummaryCandidate(messages, title, fallback = "") {
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

export function cleanHistoricalMessageText(value) {
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

export function isSystemTemporaryCwd(value) {
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
