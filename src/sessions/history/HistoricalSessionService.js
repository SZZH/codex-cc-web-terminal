import fs from "node:fs";
import path from "node:path";

import { parseHistoricalFile, extractHistoricalImageMessagesFromFile, isSystemTemporaryCwd, summarizeHistoricalSession, walkJsonlFiles } from "./historicalParsing.js";

function readJsonFile(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallbackValue;
  }
}

function formatShortTimestamp(value, timezone) {
  const formatter = new Intl.DateTimeFormat("en-AU", {
    timeZone: String(timezone || "UTC"),
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short"
  });
  const parts = formatter.formatToParts(new Date(value));
  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
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

export class HistoricalSessionService {
  constructor(config) {
    this.config = config;
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
      const shouldReload = stat.mtimeMs !== this.codexSessionIndexCache.mtimeMs || stat.size !== this.codexSessionIndexCache.size;
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

  listHistoricalSessions(providers, { archived = null } = {}) {
    return [...providers]
      .flatMap((provider) => this.listHistoricalSessionsForProvider(provider, { archived }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  listHistoricalSessionsForProvider(provider, { archived = null } = {}) {
    const byResumeId = new Map();
    for (const entry of this.scanHistoricalSessionsForProvider(provider)) {
      const entryArchived = this.isArchived(provider.id, entry.resumeSessionId);
      if (archived !== null && entryArchived !== archived) {
        continue;
      }
      const session = this.buildHistoricalSession(provider, entry, entryArchived ? "archived" : "history");
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
        const id = parsed.resumeSessionId || path.basename(filePath, path.extname(filePath));
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
    const summary = summarizeHistoricalSession(entry, fallbackSavedName);
    const customName = this.getCustomName(provider.id, entry.resumeSessionId);
    const finalName = customName || summary.title;
    const finalTitleSource = customName ? "custom_name" : summary.titleSource;
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
      inputPreview: summary.inputPreview,
      resumeSessionId: entry.resumeSessionId,
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

  saveCustomNames() {
    const payload = Object.fromEntries([...this.customNames.entries()].sort((left, right) => left[0].localeCompare(right[0])));
    fs.writeFileSync(this.customNamesPath, JSON.stringify(payload, null, 2), "utf8");
  }

  saveArchivedSessions() {
    const payload = Object.fromEntries(
      [...this.archivedSessions.entries()].sort((left, right) => left[0].localeCompare(right[0]))
    );
    fs.writeFileSync(this.archivedSessionsPath, JSON.stringify(payload, null, 2), "utf8");
  }

  getCustomName(providerId, resumeSessionId) {
    return this.customNames.get(customNameKey(providerId, resumeSessionId)) || null;
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
      this.listHistoricalSessionsForProvider(provider, { archived }).find(
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
