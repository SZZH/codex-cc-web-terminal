import fs from "node:fs";
import path from "node:path";

import { compactTranscriptText, sanitizeTitleFragment } from "../shared/text.js";
import {
  appendHistoricalMessage,
  extractHistoricalImageMessagesFromFile,
  extractHistoricalMessagesFromRecord
} from "./historicalPayloads.js";
import {
  cleanHistoricalMessageText,
  extractHistoricalSummaryCandidate,
  extractHistoricalTitleCandidate,
  isBoilerplateUserText,
  isSystemTemporaryCwd
} from "./historicalText.js";

function basenameWithoutExtension(filePath) {
  return path.basename(filePath, path.extname(filePath));
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

export function parseHistoricalFile(filePath) {
  const preview = fs.readFileSync(filePath, "utf8");
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
      sourceType = typeof record.payload?.source === "string" ? String(record.payload.source || sourceType || "").trim() : sourceType;
      sessionTimestamp = String(record.timestamp || sessionTimestamp || "").trim();
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

export function summarizeHistoricalSession(entry, fallbackSavedName) {
  const canonicalTitle = String(entry.title || "").trim();
  return {
    title: canonicalTitle || fallbackSavedName,
    titleSource: canonicalTitle ? (entry.titleSource || "session_meta") : "fallback_saved_name",
    inputPreview:
      extractHistoricalSummaryCandidate(
        entry.messages || [],
        canonicalTitle || fallbackSavedName,
        entry.firstUserMessage || entry.firstInput || entry.fallbackInput || ""
      ) ||
      extractHistoricalTitleCandidate(canonicalTitle) ||
      entry.firstInput ||
      entry.fallbackInput ||
      "",
    compactTitle: compactTranscriptText(canonicalTitle)
  };
}

export { basenameWithoutExtension, extractHistoricalImageMessagesFromFile, isSystemTemporaryCwd, walkJsonlFiles };
