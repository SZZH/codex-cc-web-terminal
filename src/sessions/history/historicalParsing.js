import fs from "node:fs";
import path from "node:path";

import { compactTranscriptText, normalizeSymbolToken, sanitizeTitleFragment } from "../shared/text.js";
import { applyDelta, createEmptyConversationState } from "../normalize/turnState.js";
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
import { createTurnCompletedDelta, createTurnCreatedDelta, normalizeRecordToDeltas } from "../normalize/turnDeltas.js";

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
  const records = [];
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
      records,
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

export function buildHistoricalConversationFromFile(filePath) {
  const state = createEmptyConversationState();
  let content = "";
  let activeTurnId = "";
  let turnIndex = 0;
  let lastTimestamp = "";

  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return { turns: [], backgroundAgents: [] };
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
    const timestamp = String(record?.timestamp || record?.payload?.timestamp || lastTimestamp || "");
    lastTimestamp = timestamp || lastTimestamp;
    const recordType = normalizeSymbolToken(record?.type);
    const payloadType = normalizeSymbolToken(record?.payload?.type);
    const isUserMessageRecord = recordType === "eventmsg" && payloadType === "usermessage";
    const isTurnCompletedRecord = payloadType === "turncompleted" || payloadType === "turncomplete";
    const isTurnFailedRecord = payloadType === "turnfailed";
    const isTurnInterruptedRecord = payloadType === "turnaborted" || payloadType === "turninterrupted";

    if (isUserMessageRecord) {
      if (activeTurnId) {
        Object.assign(state, applyDelta(state, createTurnCompletedDelta(activeTurnId, "completed", timestamp || undefined)));
        activeTurnId = "";
      }
      turnIndex += 1;
      activeTurnId = `history-turn-${turnIndex}`;
      Object.assign(state, applyDelta(state, createTurnCreatedDelta(activeTurnId, String(record?.payload?.message || "").trim(), timestamp)));
      continue;
    }
    if (activeTurnId && (isTurnCompletedRecord || isTurnFailedRecord || isTurnInterruptedRecord)) {
      const status = isTurnFailedRecord ? "failed" : isTurnInterruptedRecord ? "interrupted" : "completed";
      Object.assign(state, applyDelta(state, createTurnCompletedDelta(activeTurnId, status, timestamp || undefined)));
      activeTurnId = "";
      continue;
    }
    if (!activeTurnId) {
      const previewTurnId = `history-turn-${turnIndex + 1}`;
      const previewDeltas = normalizeRecordToDeltas(record, { turnId: previewTurnId });
      if (!previewDeltas.length) {
        continue;
      }
      turnIndex += 1;
      activeTurnId = previewTurnId;
      Object.assign(state, applyDelta(state, createTurnCreatedDelta(activeTurnId, "", timestamp)));
      for (const delta of previewDeltas) {
        Object.assign(state, applyDelta(state, delta));
      }
      continue;
    }
    for (const delta of normalizeRecordToDeltas(record, { turnId: activeTurnId })) {
      Object.assign(state, applyDelta(state, delta));
    }
  }

  if (activeTurnId) {
    Object.assign(state, applyDelta(state, createTurnCompletedDelta(activeTurnId, "completed", lastTimestamp || undefined)));
  }

  return {
    turns: state.turns,
    backgroundAgents: state.backgroundAgents
  };
}

export { basenameWithoutExtension, extractHistoricalImageMessagesFromFile, isSystemTemporaryCwd, walkJsonlFiles };
