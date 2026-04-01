export const PREVIEW_FALLBACK = {
  history: "恢复这个 Codex 会话",
  live: "继续当前会话"
};

const GENERIC_TITLES = new Set(["codex", "claude", "session", "会话", "untitled workspace"]);
const TITLE_NOISE_PATTERNS = [
  /^saved\b/i,
  /^-\s/,
  /^```/,
  /若必须做较大重构/,
  /accessibility override/i,
  /auth-required override/i,
  /automatic routing rule/i,
  /global instructions/i,
  /approval policy/i,
  /filesystem sandboxing/i,
  /current user accessibility context/i,
  /code task execution flow/i,
  /default browser workflow/i,
  /default memory workflow/i,
  /environment_context/i,
  /AGENTS\.md/i
];

const HISTORICAL_META_LINE_PATTERNS = [
  /^[-*•]\s+/,
  /^\d+[.)、]\s+/,
  /^#+\s+/,
  /^```/,
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
  /^(完成后请返回|请返回|修改文件列表|优化摘要|风险说明|风险\/后续建议|兼容性注意事项|视觉优化要点|关键 tokens 清单|自检点|潜在冲突点|可能冲突点|你做了哪些视觉提升|必须遵守|严格写入边界)[:：]?/i
];

export function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function stripAnsi(value) {
  return String(value || "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
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
  return String(value || "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export function normalizeLine(value) {
  return stripControlChars(applyBackspaces(stripAnsi(value)))
    .replace(/\t/g, "  ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function filterTerminalNoise(value) {
  const lines = stripControlChars(applyBackspaces(stripAnsi(value)))
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
  return lines
    .filter((line) => {
      const text = line.trim();
      if (!text) {
        return false;
      }
      if (/codex\s+resume/i.test(text)) {
        return false;
      }
      if (/'codex'.*'resume'/i.test(text)) {
        return false;
      }
      if (/dangerously-bypass-approvals-and-sandbox/i.test(text)) {
        return false;
      }
      if (/update available/i.test(text) || /release notes:/i.test(text)) {
        return false;
      }
      if (/^\d+\.\s*update now/i.test(text) || /^\d+\.\s*skip/i.test(text)) {
        return false;
      }
      if (/press enter to continue/i.test(text)) {
        return false;
      }
      if (/--no-alt-screen/i.test(text)) {
        return false;
      }
      if (/^[›>]\s*\d+\./.test(text) || /^until next version$/i.test(text)) {
        return false;
      }
      if (/^➜/.test(text) || /^%$/.test(text) || /^>$/.test(text)) {
        return false;
      }
      return true;
    })
    .join("\n");
}

function collapseDoubledAscii(value) {
  const text = String(value || "");
  const pairMatches = text.match(/([A-Za-z0-9])\1/g) || [];
  if (pairMatches.length < 6) {
    return text;
  }
  const ratio = pairMatches.length / Math.max(1, text.length);
  if (ratio < 0.1) {
    return text;
  }
  return text.replace(/([A-Za-z0-9])\1/g, "$1");
}

function compactNoiseKey(value) {
  return collapseDoubledAscii(compactLine(value)).toLowerCase();
}

function isProcessNoiseLine(value) {
  const text = compactNoiseKey(value);
  if (!text) {
    return true;
  }

  return (
    /^working\(/.test(text) ||
    /esc to interrupt/.test(text) ||
    /\b\d{1,3}% left\b/.test(text) ||
    /dangerously-bypass-approvals-and-sandbox/.test(text) ||
    /codex resume/.test(text) ||
    /current changes/.test(text) ||
    /\bworkdir\b/.test(text) ||
    /^~\//.test(text) ||
    /^\/users\//.test(text) ||
    /^\/home\//.test(text) ||
    /^@[a-z0-9._/-]+/.test(text) ||
    /^›/.test(text) ||
    /^>/.test(text) ||
    /^•/.test(text) ||
    /^[=~`._-]{1,12}$/.test(text)
  );
}

export function sanitizeAssistantText(value) {
  const raw = normalizeLine(value || "");
  if (!raw) {
    return "";
  }

  const rawLines = raw
    .split("\n")
    .map((line) => collapseDoubledAscii(line))
    .map((line) => line.trimEnd())
    .filter(Boolean);

  const lines = rawLines.filter((line) => !isProcessNoiseLine(line));

  if (lines.length) {
    return lines.join("\n").trim();
  }

  // Fallback: if aggressive noise filtering removed everything,
  // keep lines that still contain meaningful words so replies are not fully hidden.
  const fallback = rawLines.filter((line) => {
    const key = compactNoiseKey(line);
    if (!key) {
      return false;
    }
    if (/^working\(/.test(key) || /esc to interrupt/.test(key) || /\b\d{1,3}% left\b/.test(key)) {
      return false;
    }
    if (/^[=~`._-]{1,12}$/.test(key)) {
      return false;
    }
    return /[a-z\u4e00-\u9fff]/i.test(key);
  });

  // Some Codex TUI streams interleave progress chunks and final short replies
  // as bullet fragments like "• R" / "• 收到". Extract the latest signal.
  const bulletSignals = [...String(raw || "").matchAll(/•\s*([^\n\r]+)/g)]
    .map((match) => compactLine(match?.[1] || ""))
    .map((line) => line.replace(/\bworking.*$/i, "").trim())
    .filter(Boolean)
    .filter((line) => /[a-z\u4e00-\u9fff]/i.test(line))
    .filter((line) => !/^w(or|ork|orki|orkin|orking)?$/i.test(line));

  if (bulletSignals.length > 0) {
    return bulletSignals[bulletSignals.length - 1];
  }

  const fallbackText = fallback.join("\n").trim();
  if (fallbackText) {
    return fallbackText;
  }

  return "";
}

export function compactLine(value) {
  return normalizeLine(value).replace(/\s+/g, " ").trim();
}

export function clampText(value, max = 54) {
  const text = compactLine(value);
  if (!text) {
    return "";
  }
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text;
}

export function createMessage(role, text, timestamp = "", extra = {}) {
  return {
    id: `${role}-${timestamp || Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text: normalizeLine(text),
    timestamp,
    ...extra
  };
}

export function workspaceName(cwd) {
  const parts = String(cwd || "")
    .split("/")
    .filter(Boolean);
  return parts[parts.length - 1] || String(cwd || "").trim() || "未命名项目";
}

export function isInstructionLike(value) {
  const text = compactLine(value);
  if (!text) {
    return true;
  }
  return TITLE_NOISE_PATTERNS.some((pattern) => pattern.test(text));
}

export function isHistoricalMetaLine(value) {
  const text = compactLine(value);
  if (!text) {
    return true;
  }
  return HISTORICAL_META_LINE_PATTERNS.some((pattern) => pattern.test(text));
}

export function historicalMeaningfulLines(value) {
  return normalizeLine(value)
    .split("\n")
    .map((line) => compactLine(line))
    .filter(Boolean)
    .filter((line) => !isInstructionLike(line))
    .filter((line) => !isHistoricalMetaLine(line))
    .filter((line) => !line.startsWith("<") && !line.startsWith("["));
}

export function extractHistoricalTitleCandidate(value) {
  const lines = historicalMeaningfulLines(value);
  const preferred = lines.find((line) => !isHistoricalMetaLine(line));
  return preferred || lines[0] || "";
}

export function extractHistoricalSummaryCandidate(messages, title, fallback = "") {
  const normalizedTitle = compactLine(title);
  const candidates = [];

  for (const message of messages || []) {
    const lines = historicalMeaningfulLines(message.text).filter((line) => {
      if (!line) {
        return false;
      }
      if (compactLine(line) === normalizedTitle) {
        return false;
      }
      return !isHistoricalMetaLine(line);
    });

    for (const line of lines.slice(0, 3)) {
      let score = message.role === "assistant" ? 120 : 80;
      if (line.length >= 18 && line.length <= 140) {
        score += 24;
      } else if (line.length > 140) {
        score += 12;
      } else {
        score -= 12;
      }
      if (/[？?。.!！]/.test(line)) {
        score += 8;
      }
      candidates.push({ text: line, score });
    }
  }

  candidates.sort((left, right) => right.score - left.score);
  return compactLine(candidates[0]?.text || fallback);
}

function cleanHistoricalMessageText(value) {
  const lines = normalizeLine(value)
    .split("\n")
    .map((line) => compactLine(line))
    .filter(Boolean)
    .filter((line) => !isInstructionLike(line))
    .filter((line) => !isHistoricalMetaLine(line))
    .filter((line) => !/^[=~`._-]{1,8}$/.test(line))
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

function shouldMergeHistoricalMessages(last, current) {
  if (!last || !current || last.role !== current.role) {
    return false;
  }

  const lastText = compactLine(last.text);
  const currentText = compactLine(current.text);
  if (!lastText || !currentText || lastText === currentText) {
    return false;
  }

  const lastTime = Date.parse(last.timestamp || "");
  const currentTime = Date.parse(current.timestamp || "");
  const gap = Math.abs(lastTime - currentTime);
  if (!Number.isFinite(gap) || gap > 15_000) {
    return false;
  }

  const lastLooksLikeFragment = lastText.length <= 80 && !/[。！？.!?]$/.test(lastText) && !/\n/.test(lastText);
  const currentLooksLikeFragment =
    currentText.length <= 80 && !/^[,，、:：]/.test(currentText) && !/\n/.test(currentText);
  return lastText.length + currentText.length <= 320 && (lastLooksLikeFragment || currentLooksLikeFragment || !/[。！？.!?]$/.test(lastText));
}

function mergeHistoricalMessages(last, current) {
  return {
    ...last,
    text: `${last.text}\n${current.text}`.trim(),
    timestamp: Date.parse(last.timestamp || "") <= Date.parse(current.timestamp || "") ? last.timestamp : current.timestamp
  };
}

export function isLowSignalTitle(title, session) {
  const text = compactLine(title);
  if (!text) {
    return true;
  }
  if (GENERIC_TITLES.has(text.toLowerCase())) {
    return true;
  }
  if (TITLE_NOISE_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  const folder = workspaceName(session?.cwd).toLowerCase();
  return text.toLowerCase() === folder;
}

export function normalizeHistoryMessages(messages) {
  const normalized = [];
  for (const item of messages || []) {
    const role = item?.role === "user" ? "user" : "assistant";
    const text = normalizeLine(item?.text || "");
    if (!text) {
      continue;
    }
    normalized.push(createMessage(role, text, item?.timestamp || "", { source: "history" }));
  }
  return normalized;
}

export function pickRealTitle(messages, fallback, session) {
  const firstUser = messages.find((message) => message.role === "user" && extractHistoricalTitleCandidate(message.text));
  if (!isLowSignalTitle(fallback, session) && firstUser?.text) {
    const fallbackText = compactLine(fallback);
    const firstUserText = compactLine(extractHistoricalTitleCandidate(firstUser.text));
    if (fallbackText && firstUserText && (fallbackText.includes(firstUserText) || firstUserText.includes(fallbackText))) {
      return clampText(fallbackText, 44);
    }
  }
  if (firstUser?.text) {
    return clampText(extractHistoricalTitleCandidate(firstUser.text), 44);
  }
  if (!isLowSignalTitle(fallback, session)) {
    return clampText(fallback, 44);
  }
  return clampText(fallback || workspaceName(session?.cwd), 44) || workspaceName(session?.cwd);
}

export function pickPreview(messages, session, title) {
  const candidate = extractHistoricalSummaryCandidate(messages, title, session?.inputPreview || "");
  return clampText(candidate, 66) || PREVIEW_FALLBACK[session?.kind] || "继续这个会话";
}

export function fallbackTitleForSession(session) {
  if (!isLowSignalTitle(session?.name, session)) {
    return clampText(session.name, 44);
  }
  if (!isLowSignalTitle(session?.inputPreview, session)) {
    return clampText(session.inputPreview, 44);
  }
  if (session?.kind === "history") {
    return "历史会话";
  }
  return clampText(session?.name || session?.providerLabel || "当前会话", 44) || "当前会话";
}

export function fallbackPreviewForSession(session) {
  if (!isLowSignalTitle(session?.inputPreview, session)) {
    return clampText(session.inputPreview, 66);
  }
  if (!isLowSignalTitle(session?.name, session)) {
    return clampText(session.name, 66);
  }
  return PREVIEW_FALLBACK[session?.kind] || "继续这个会话";
}

export function formatRelativeTime(value) {
  if (!value) {
    return "";
  }
  const parsed = new Date(value).getTime();
  if (Number.isNaN(parsed)) {
    return "";
  }
  const diff = Date.now() - parsed;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;

  if (diff < hour) {
    return `${Math.max(1, Math.round(diff / minute))} 分钟前`;
  }
  if (diff < day) {
    return `${Math.max(1, Math.round(diff / hour))} 小时前`;
  }
  if (diff < week) {
    return `${Math.max(1, Math.round(diff / day))} 天前`;
  }
  return `${Math.max(1, Math.round(diff / week))} 周前`;
}
