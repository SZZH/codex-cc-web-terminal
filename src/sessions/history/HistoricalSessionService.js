import fs from "node:fs";
import path from "node:path";

import {
  parseHistoricalFile,
  extractHistoricalImageMessagesFromFile,
  walkJsonlFiles
} from "./historicalParsing.js";
import { buildConversationStateFromHistory } from "../conversation/state.js";
import { CONVERSATION_PROTOCOL_VERSION } from "../conversation/protocol.js";
import { nowIso } from "../shared/text.js";
import { buildThreadSnapshotFromFile, deriveConversationStateFromThreadSnapshot } from "../../threads/index.js";
import { parseHistoricalThreadComposerContext } from "../shared/historicalComposerState.js";
import {
  buildHistoryCatalogSourceSignature,
  historyFileSignature,
  optionalHistoryFileSignature,
  readHistoryCatalogFile
} from "./historyCatalogCache.js";

const CODEX_PROJECT_LIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function readJsonFile(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallbackValue;
  }
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

function isLowSignalLegacyCustomName(value) {
  const text = String(value || "").trim();
  if (!text) {
    return true;
  }

  if (/^回复[:：]?\s*/.test(text) && text.length <= 16) {
    return true;
  }

  if (/^(hi|hello|你好|哈哈|1|ok)$/i.test(text)) {
    return true;
  }

  return false;
}

export class HistoricalSessionService {
  constructor(config) {
    this.config = config;
    this.customNamesPath = path.join(this.config.dataDir, "session-names.json");
    this.customNameMetaPath = path.join(this.config.dataDir, "session-name-meta.json");
    this.archivedSessionsPath = path.join(this.config.dataDir, "archived-sessions.json");
    this.codexSessionIndexPath = this.config.codexSessionIndexPath || path.join(this.config.home, ".codex", "session_index.jsonl");
    this.codexSessionIndexCache = { signature: null, byId: new Map() };
    this.providerEntriesCache = new Map();
    this.historicalMessagesCache = new Map();
    this.customNames = new Map(
      Object.entries(readJsonFile(this.customNamesPath, {}))
        .map(([key, value]) => [normalizeCustomNameKey(key), value])
        .filter((entry) => entry[0] && entry[1])
    );
    this.customNameMeta = new Map(
      Object.entries(readJsonFile(this.customNameMetaPath, {}))
        .map(([key, value]) => [normalizeCustomNameKey(key), value])
        .filter((entry) => entry[0] && entry[1] && typeof entry[1] === "object")
    );
    this.archivedSessions = new Map(
      Object.entries(readJsonFile(this.archivedSessionsPath, {}))
        .map(([key, value]) => [normalizeCustomNameKey(key), String(value || "").trim()])
        .filter((entry) => entry[0] && entry[1])
    );
    fs.mkdirSync(this.config.dataDir, { recursive: true });
  }

  getCodexThreadName(resumeSessionId) {
    const id = String(resumeSessionId || "").trim();
    if (!id) {
      return "";
    }
    this.ensureCodexSessionIndexCache();
    return String(this.codexSessionIndexCache.byId.get(id)?.threadName || "").trim();
  }

  getCodexThreadUpdatedAt(resumeSessionId) {
    const id = String(resumeSessionId || "").trim();
    if (!id) {
      return "";
    }
    this.ensureCodexSessionIndexCache();
    return String(this.codexSessionIndexCache.byId.get(id)?.updatedAt || "").trim();
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
      const signature = historyFileSignature(this.codexSessionIndexPath);
      const shouldReload = signature !== this.codexSessionIndexCache.signature;
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
            const updatedAt = String(record?.updated_at || "").trim();
            if (recordId && threadName) {
              byId.set(recordId, { threadName, updatedAt });
            }
          } catch {
            // Ignore malformed rows.
          }
        }
        this.codexSessionIndexCache = {
          signature: historyFileSignature(this.codexSessionIndexPath) === signature ? signature : null,
          byId
        };
      }
    } catch {
      this.codexSessionIndexCache = { signature: null, byId: new Map() };
    }
  }

  listHistoricalSessions(providers, { archived = null } = {}) {
    return [...providers]
      .flatMap((provider) => this.listHistoricalSessionsForProvider(provider, { archived, canonicalTitles: true, listMode: true }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  listHistoricalSessionsForProvider(
    provider,
    { archived = null, includeSubagents = true, canonicalTitles = false, listMode = false } = {}
  ) {
    const byResumeId = new Map();
    for (const entry of this.scanHistoricalSessionsForProvider(provider)) {
      const entryArchived = this.isArchived(provider.id, entry.resumeSessionId);
      if (archived !== null && entryArchived !== archived) {
        continue;
      }
      const session = this.buildHistoricalSession(provider, entry, entryArchived ? "archived" : "history", {
        canonicalTitle: canonicalTitles && provider.id === "codex"
      });
      const existing = byResumeId.get(entry.resumeSessionId);
      if (!existing || existing.updatedAt < session.updatedAt) {
        byResumeId.set(entry.resumeSessionId, session);
      }
    }
    return [...byResumeId.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  scanHistoricalSessionsForProvider(provider) {
    const providerCacheKey = String(provider?.id || "").trim();
    const sourceDirs = this.getProviderHistorySourceDirs(provider, { includeArchived: true });
    const cached = this.providerEntriesCache.get(providerCacheKey);
    let sourceSignature = null;
    try {
      sourceSignature = this.buildHistorySourceSignature(sourceDirs);
      if (provider.id === "codex") {
        sourceSignature += `|index:${optionalHistoryFileSignature(this.codexSessionIndexPath)}`;
      }
      if (cached && cached.sourceSignature === sourceSignature) {
        return cached.entries;
      }
    } catch {
      // Ignore cache lookup failures and rescan below.
    }

    const files = sourceDirs.flatMap((dirPath) => walkJsonlFiles(dirPath));
    const entries = [];
    const fileEntries = new Map();
    let stableScan = sourceSignature !== null;

    for (const filePath of files) {
      try {
        const { stat, parsed, cached: fileCache } = readHistoryCatalogFile(filePath, cached?.fileEntries?.get(filePath));
        if (fileCache) {
          fileEntries.set(filePath, fileCache);
        } else {
          stableScan = false;
        }
        const id = parsed.resumeSessionId || path.basename(filePath, path.extname(filePath));
        if (!id) {
          continue;
        }
        const isCodexCliSession =
          /codex_cli/i.test(String(parsed.originator || "")) || /^cli$/i.test(String(parsed.sourceType || ""));
        const indexedTitle = provider.id === "codex" ? this.getCodexThreadName(id) : "";
        const parsedTitle = String(parsed.title || "").trim();
        const effectiveTitle = String(indexedTitle || parsedTitle).trim();
        const effectiveTitleSource = indexedTitle ? "codex_session_index" : parsedTitle ? "session_meta" : "";

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
          agentNickname: String(parsed.agentNickname || "").trim(),
          indexed: Boolean(indexedTitle),
          indexedUpdatedAt: provider.id === "codex" ? this.getCodexThreadUpdatedAt(id) : "",
          sourceRoot: filePath.startsWith(String(provider.sessionsDir || "")) ? "sessions" : "archived"
        });
      } catch {
        stableScan = false;
        // Ignore malformed or unreadable session files.
      }
    }
    this.providerEntriesCache.set(providerCacheKey, {
      sourceSignature: stableScan ? sourceSignature : null,
      entries,
      fileEntries
    });
    return entries;
  }

  getProviderHistorySourceDirs(provider, { includeArchived = false } = {}) {
    const dirs = [provider.sessionsDir];
    if (includeArchived && provider.id === "codex" && provider.historyDir && provider.historyDir !== provider.sessionsDir) {
      dirs.push(provider.sessionsDir);
      dirs.push(provider.historyDir);
    }
    return [...new Set(dirs.map((dirPath) => String(dirPath || "").trim()).filter(Boolean))];
  }

  buildHistorySourceSignature(sourceDirs) {
    return buildHistoryCatalogSourceSignature(sourceDirs);
  }

  isRecentCodexProjectListEntry(entry) {
    const updatedAt = Date.parse(String(entry?.indexedUpdatedAt || entry?.stat?.mtime || ""));
    if (!Number.isFinite(updatedAt)) {
      return false;
    }
    return Date.now() - updatedAt <= CODEX_PROJECT_LIST_MAX_AGE_MS;
  }

  buildHistoricalTruthBundle(provider, entry) {
    const targetId = String(entry?.resumeSessionId || "").trim();
    const historicalSession = this.buildHistoricalSession(
      provider,
      entry,
      this.isArchived(provider.id, entry.resumeSessionId) ? "archived" : "history"
    );

    let messages = entry.messages || [];
    let conversation = { turns: [], backgroundAgents: [] };
    let threadSnapshot = null;

    try {
      const reparsed = parseHistoricalFile(entry.filePath);
      messages = reparsed.messages || messages;
    } catch {
      // Fall back to scanned messages if direct reparse fails.
    }

    try {
      threadSnapshot = buildThreadSnapshotFromFile(entry.filePath, {
        threadId: targetId,
        metadata: {
          name: historicalSession.name || entry.title || "",
          preview: entry.firstUserMessage || entry.firstInput || entry.fallbackInput || "",
          cwd: entry.cwd || this.config.defaultCwd,
          source: provider.id
        }
      });
    } catch {
      threadSnapshot = null;
    }

    const hasThreadContent = Boolean((threadSnapshot?.turns || []).length);

    if (threadSnapshot && hasThreadContent) {
      const derived = deriveConversationStateFromThreadSnapshot(threadSnapshot, {
        sessionId: String(historicalSession.id || ""),
        threadId: targetId,
        status: "completed"
      });
      conversation = {
        turns: derived.turns || [],
        backgroundAgents: derived.backgroundAgents || []
      };
    }

    try {
      const imageMessages = extractHistoricalImageMessagesFromFile(entry.filePath);
      if (imageMessages.length) {
        const seen = new Set(
          messages
            .filter((item) => String(item?.partType || "") === "image" && String(item?.payload?.url || "").trim())
            .map((item) => `${item.timestamp}|${String(item.payload.url).trim()}`)
        );
        for (const image of imageMessages) {
          const key = `${image.timestamp}|${String(image?.payload?.url || "").trim()}`;
          if (!seen.has(key)) {
            messages.push(image);
            seen.add(key);
          }
        }
        messages.sort(
          (left, right) => Date.parse(String(left?.timestamp || "")) - Date.parse(String(right?.timestamp || ""))
        );
      }
    } catch {
      // Keep text-only historical messages if image recovery fails.
    }

    const conversationState = threadSnapshot && hasThreadContent
      ? deriveConversationStateFromThreadSnapshot(threadSnapshot, {
          sessionId: String(historicalSession.id || ""),
          threadId: targetId,
          status: "completed"
        })
      : buildConversationStateFromHistory(conversation, {
          sessionId: String(historicalSession.id || ""),
          threadId: targetId,
          status: conversation.turns?.length || conversation.backgroundAgents?.length ? "completed" : "idle"
        });
    const conversationSnapshot = {
      type: "conversation.snapshot",
      protocolVersion: CONVERSATION_PROTOCOL_VERSION,
      timestamp: nowIso(),
      session: historicalSession,
      sessionId: conversationState.sessionId,
      threadId: conversationState.threadId,
      conversation: conversationState,
      buffer: "",
      turns: conversationState.turns,
      backgroundAgents: conversationState.backgroundAgents
    };

    return {
      session: historicalSession,
      messages,
      turns: conversationState.turns || [],
      backgroundAgents: conversationState.backgroundAgents || [],
      threadSnapshot,
      liveOverlay: null,
      conversation: conversationState,
      conversationSnapshot
    };
  }

  buildHistoricalSession(provider, entry, kind = "history", { canonicalTitle = false } = {}) {
    const rawName = String(entry.title || "").trim();
    const composerContext = parseHistoricalThreadComposerContext(entry.filePath);
    return {
      id: `history:${provider.id}:${entry.resumeSessionId}`,
      provider: provider.id,
      providerLabel: provider.label,
      cliLabel: provider.cliLabel,
      name: rawName,
      titleSource: rawName ? (entry.titleSource || "") : "",
      cwd: entry.cwd,
      kind,
      status: kind === "archived" ? "archived" : "saved",
      createdAt: entry.stat.birthtime.toISOString(),
      updatedAt: String(entry.indexedUpdatedAt || "").trim() || entry.stat.mtime.toISOString(),
      exitCode: null,
      autoNamed: false,
      inputPreview: "",
      resumeSessionId: entry.resumeSessionId,
      model: String(composerContext?.model || "").trim(),
      reasoningEffort: String(composerContext?.reasoningEffort || "").trim(),
      permissionMode: String(composerContext?.permissionMode || "").trim(),
      archivedAt: this.getArchivedAt(provider.id, entry.resumeSessionId),
      sessionType: entry.sessionType === "subagent" ? "subagent" : "main",
      parentThreadId: String(entry.parentThreadId || "").trim(),
      agentRole: String(entry.agentRole || "").trim(),
      agentNickname: String(entry.agentNickname || "").trim()
    };
  }

  getHistoricalMessages(provider, resumeSessionId) {
    const targetId = String(resumeSessionId || "").trim();
    const entries = this.scanHistoricalSessionsForProvider(provider).filter((item) => item.resumeSessionId === targetId);
    if (!entries.length) {
      throw new Error(`Historical session not found: ${provider.id}/${resumeSessionId}`);
    }

    const entry = entries.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0];
    const cacheKey = `${provider.id}:${targetId}`;
    const cached = this.historicalMessagesCache.get(cacheKey);
    if (
      cached &&
      cached.filePath === entry.filePath &&
      cached.mtimeMs === entry.stat.mtimeMs
    ) {
      return cached.payload;
    }

    const payload = this.buildHistoricalTruthBundle(provider, entry);
    this.historicalMessagesCache.set(cacheKey, {
      filePath: entry.filePath,
      mtimeMs: entry.stat.mtimeMs,
      payload
    });
    return payload;
  }

  saveCustomNames() {
    const payload = Object.fromEntries([...this.customNames.entries()].sort((left, right) => left[0].localeCompare(right[0])));
    fs.writeFileSync(this.customNamesPath, JSON.stringify(payload, null, 2), "utf8");
  }

  saveCustomNameMeta() {
    const payload = Object.fromEntries(
      [...this.customNameMeta.entries()].sort((left, right) => left[0].localeCompare(right[0]))
    );
    fs.writeFileSync(this.customNameMetaPath, JSON.stringify(payload, null, 2), "utf8");
  }

  saveArchivedSessions() {
    const payload = Object.fromEntries(
      [...this.archivedSessions.entries()].sort((left, right) => left[0].localeCompare(right[0]))
    );
    fs.writeFileSync(this.archivedSessionsPath, JSON.stringify(payload, null, 2), "utf8");
  }

  getCustomName(providerId, resumeSessionId) {
    const key = customNameKey(providerId, resumeSessionId);
    const value = String(this.customNames.get(key) || "").trim();
    if (!value) {
      return null;
    }

    const meta = this.customNameMeta.get(key) || null;
    if (meta?.source === "manual") {
      return value;
    }

    if (isLowSignalLegacyCustomName(value)) {
      return null;
    }

    return value;
  }

  setCustomName(providerId, resumeSessionId, name) {
    const key = customNameKey(providerId, resumeSessionId);
    const value = String(name || "").trim();
    if (!key.endsWith(":") && value) {
      this.customNames.set(key, value);
      this.customNameMeta.set(key, {
        source: "manual",
        updatedAt: nowIso()
      });
      this.saveCustomNames();
      this.saveCustomNameMeta();
    }
  }

  removeCustomName(providerId, resumeSessionId) {
    const key = customNameKey(providerId, resumeSessionId);
    const removedName = this.customNames.delete(key);
    const removedMeta = this.customNameMeta.delete(key);
    if (removedName) {
      this.saveCustomNames();
    }
    if (removedMeta) {
      this.saveCustomNameMeta();
    }
  }

  isArchived(providerId, resumeSessionId) {
    return this.archivedSessions.has(archivedSessionKey(providerId, resumeSessionId));
  }

  getArchivedAt(providerId, resumeSessionId) {
    return this.archivedSessions.get(archivedSessionKey(providerId, resumeSessionId)) || null;
  }

  setArchived(providerId, resumeSessionId, archivedAt) {
    this.archivedSessions.set(archivedSessionKey(providerId, resumeSessionId), archivedAt);
    this.saveArchivedSessions();
  }

  clearArchived(providerId, resumeSessionId) {
    const key = archivedSessionKey(providerId, resumeSessionId);
    if (this.archivedSessions.delete(key)) {
      this.saveArchivedSessions();
    }
  }

  getHistoricalSession(provider, resumeSessionId, { archived = null } = {}) {
    return (
      this.listHistoricalSessionsForProvider(provider, {
        archived,
        includeSubagents: true
      }).find(
        (session) => session.resumeSessionId === String(resumeSessionId || "").trim()
      ) || null
    );
  }

  archiveHistoricalSession(provider, resumeSessionId, archivedAt) {
    const session = this.getHistoricalSession(provider, resumeSessionId, { archived: false });
    if (!session) {
      throw new Error(`Historical session not found: ${provider.id}/${resumeSessionId}`);
    }
    this.setArchived(provider.id, resumeSessionId, archivedAt);
    return this.getHistoricalSession(provider, resumeSessionId, { archived: true });
  }

  restoreHistoricalSession(provider, resumeSessionId) {
    const session = this.getHistoricalSession(provider, resumeSessionId, { archived: true });
    if (!session) {
      throw new Error(`Archived session not found: ${provider.id}/${resumeSessionId}`);
    }
    this.clearArchived(provider.id, resumeSessionId);
    return this.getHistoricalSession(provider, resumeSessionId, { archived: false });
  }

  deleteHistoricalSession(provider, resumeSessionId) {
    const targetId = String(resumeSessionId || "").trim();
    const entries = this.scanHistoricalSessionsForProvider(provider).filter((entry) => entry.resumeSessionId === targetId);
    if (!entries.length) {
      throw new Error(`Historical session not found: ${provider.id}/${resumeSessionId}`);
    }

    for (const entry of entries) {
      fs.rmSync(entry.filePath, { force: true });
    }
    this.clearArchived(provider.id, resumeSessionId);
    this.removeCustomName(provider.id, resumeSessionId);
    return true;
  }

  resumeKey(providerId, resumeSessionId) {
    const value = String(resumeSessionId || "").trim();
    if (!value) {
      return "";
    }
    return customNameKey(providerId, value);
  }
}
