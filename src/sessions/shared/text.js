export function nowIso() {
  return new Date().toISOString();
}

export function applyBackspaces(value) {
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

export function stripControlChars(value) {
  return String(value || "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ");
}

export function sanitizeTitleFragment(value) {
  return stripControlChars(applyBackspaces(String(value || "")))
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, " ")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, " ")
    .replace(/\u001b[@-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripAnsiEscapeSequences(value) {
  return String(value || "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u009b[0-?]*[ -/]*[@-~]?/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]?/g, "")
    .replace(/\u001b[@-_]/g, "");
}

export function stripTerminalControlSequences(value) {
  return stripControlChars(applyBackspaces(String(value || "")))
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, " ")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, " ")
    .replace(/\u001b[@-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeLiveOutputLine(value) {
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
  return lower.includes("esc to interrupt") || /^working\(/i.test(text) || /^press esc to interrupt/i.test(text);
}

export function filterLiveOutputChunk(session, chunk) {
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

    if (/^[\p{P}\p{S}\s]+$/u.test(simplified) && simplified.length <= 4 && !/\w/.test(simplified)) {
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

export function extractImagePartsFromMarkdown(text) {
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

export function normalizeSymbolToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function isAgentMessageType(value) {
  return normalizeSymbolToken(value) === "agentmessage";
}

export function extractTurnItems(result) {
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

export function extractEmbeddedUserRequest(value) {
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

export function deriveSessionTitle(value, fallback) {
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

export function compactTranscriptText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => sanitizeTitleFragment(line))
    .filter(Boolean)
    .join("\n")
    .trim();
}
