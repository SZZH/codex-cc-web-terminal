import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import pty from "node-pty";

import { HistoricalSessionService } from "./sessions/history/HistoricalSessionService.js";
import { CodexSidebarService } from "./sessions/history/CodexSidebarService.js";
import {
  buildLiveHistoryContinuation,
  buildThreadSnapshotBundle
} from "./sessions/history/liveHistoryRuntime.js";
import {
  buildSidebarSnapshotFromGroups,
  mergeProjectGroupsWithLiveSessions
} from "./sessions/history/sessionSidebarSnapshot.js";
import {
  createTurnCompletedDelta,
  createTurnCreatedDelta,
  createTurnStatusDelta,
  normalizeRecordToDeltas
} from "./sessions/normalize/turnDeltas.js";
import { attachClient, broadcast, maybeAutoAdvanceClaudeStartup, maybeAutoRename, pushSessionBuffer, registerPtySessionHandlers } from "./sessions/live/sessionOutput.js";
import { buildProviders } from "./sessions/providers/buildProviders.js";
import {
  buildConversationDeltaPayload,
  buildConversationSnapshotPayload,
  buildLegacyConversationSnapshotPayload
} from "./sessions/conversation/protocol.js";
import {
  applyConversationDeltas as applyConversationStateDeltas,
  buildConversationStateFromThreadSnapshot,
  createConversationState
} from "./sessions/conversation/state.js";
import {
  nowIso
} from "./sessions/shared/text.js";
import {
  applyComposerOptionOverrides,
  extractComposerOptions,
  sessionRequiresJsonExec
} from "./sessions/shared/composerOptions.js";
import { CodexThreadStateStore } from "./sessions/state/CodexThreadStateStore.js";
import {
  buildCodexJsonExecArgs,
  enqueueRunnerInput,
  handleAppServerNotification,
  handleCodexJsonEvent,
  handleAppServerTurnResult,
  startAppServerTurn,
  startJsonExecRun
} from "./sessions/runners/codexRunner.js";
import {
  createRawRecord,
  canonicalizeRawRecord,
  createCanonicalizerState,
  deriveConversationStateFromThreadSnapshot,
  deriveThreadSnapshotFromConversationState
} from "./threads/index.js";
import { createCanonicalEventFromLegacy } from "./canonical/index.js";
import { createLegacyThreadProjection } from "./projector/index.js";

function normalizeName(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

function readCodexModelsFromCache(filePath = "") {
  const targetPath = String(filePath || "").trim();
  if (!targetPath || !fs.existsSync(targetPath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(targetPath, "utf8"));
    const models = Array.isArray(parsed?.models) ? parsed.models : Array.isArray(parsed) ? parsed : [];
    const result = [];
    const seen = new Set();
    for (const model of models) {
      const slug = String(model?.slug || "").trim();
      const label = String(model?.display_name || slug).trim();
      const visibility = String(model?.visibility || "").trim().toLowerCase();
      if (!slug || seen.has(slug)) {
        continue;
      }
      if (visibility && visibility !== "list") {
        continue;
      }
      if (model?.supported_in_api === false) {
        continue;
      }
      seen.add(slug);
      result.push({
        value: slug,
        label: label || slug,
        priority: Number.isFinite(Number(model?.priority)) ? Number(model.priority) : Number.MAX_SAFE_INTEGER
      });
    }
    return result
      .sort((left, right) => left.priority - right.priority || left.label.localeCompare(right.label))
      .map(({ value, label }) => ({ value, label }));
  } catch {
    return [];
  }
}

function isManuallyNamedSession(session) {
  const titleSource = String(session?.titleSource || "").trim().toLowerCase();
  return titleSource === "custom_name" || titleSource === "user_provided";
}

function buildThreadTurnSignature(turn = null) {
  if (!turn || typeof turn !== "object") {
    return "";
  }
  const items = Array.isArray(turn.items)
    ? turn.items.map((item) => ({
        id: String(item?.id || ""),
        kind: String(item?.kind || ""),
        text: String(item?.text || ""),
        type: String(item?.type || ""),
        status: String(item?.status || "")
      }))
    : [];
  return JSON.stringify({
    id: String(turn.id || ""),
    status: String(turn.status || ""),
    items
  });
}

function hasThreadSnapshotMeaningfulAdvance(incomingSnapshot, currentSnapshot) {
  if (!incomingSnapshot || typeof incomingSnapshot !== "object") {
    return false;
  }
  if (!currentSnapshot || typeof currentSnapshot !== "object") {
    return true;
  }

  const incomingTurns = Array.isArray(incomingSnapshot.turns) ? incomingSnapshot.turns : [];
  const currentTurns = Array.isArray(currentSnapshot.turns) ? currentSnapshot.turns : [];

  if (incomingTurns.length !== currentTurns.length) {
    return true;
  }

  const currentById = new Map(currentTurns.map((turn) => [String(turn?.id || "").trim(), turn]));
  for (const incomingTurn of incomingTurns) {
    const incomingTurnId = String(incomingTurn?.id || "").trim();
    const currentTurn = currentById.get(incomingTurnId);
    if (!currentTurn) {
      return true;
    }
    if (buildThreadTurnSignature(incomingTurn) !== buildThreadTurnSignature(currentTurn)) {
      return true;
    }
  }

  return false;
}

function parseSnapshotUpdatedAt(snapshot) {
  const value = String(snapshot?.updatedAt || "").trim();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function snapshotHasTurn(snapshot, turnId = "") {
  const targetTurnId = String(turnId || "").trim();
  if (!targetTurnId) {
    return false;
  }
  return Array.isArray(snapshot?.turns) && snapshot.turns.some((turn) => String(turn?.id || "").trim() === targetTurnId);
}

function buildThreadProjection(session) {
  const projection = createLegacyThreadProjection({
    threadId: String(session?.resumeSessionId || session?.threadSnapshot?.threadId || session?.id || ""),
    snapshot: session?.threadSnapshot || null
  });
  session.threadProjection = projection;
  return projection;
}

function getThreadProjection(session) {
  if (session?.threadProjection) {
    return session.threadProjection;
  }
  return buildThreadProjection(session);
}

function syncProjectedThreadState(session, { previousSnapshot = null } = {}) {
  const projection = getThreadProjection(session);
  const projected = projection.getLegacyState(previousSnapshot || session.threadSnapshot || null);
  session.threadSnapshot = projected.threadSnapshot;
  session.liveOverlay = projected.liveOverlay;
  return projected;
}

export class SessionManager {
  constructor(config, { appServerBridge = null } = {}) {
    this.config = config;
    this.appServerBridge = appServerBridge;
    this.sessions = new Map();
    this.providers = new Map(buildProviders(config).map((provider) => [provider.id, provider]));
    this.historyService = new HistoricalSessionService(config);
    this.codexSidebarService = new CodexSidebarService(config);

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

  providerCatalog() {
    const codexCacheModels = readCodexModelsFromCache(this.config.codexModelsCachePath);
    return [...this.providers.values()].map((provider) => {
      const isCodex = provider.id === "codex";
      const providerModels = isCodex && codexCacheModels.length ? codexCacheModels : provider.models || [];
      return {
        id: provider.id,
        label: provider.label,
        cliLabel: provider.cliLabel,
        historyLabel: provider.historyLabel,
        defaultModel: provider.defaultModel || "",
        models: providerModels
      };
    });
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

  listHistoricalSessions({ archived = null } = {}) {
    return this.historyService.listHistoricalSessions(this.providers.values(), { archived });
  }

  listHistoricalSessionsForProvider(provider, { archived = null } = {}) {
    return this.historyService.listHistoricalSessionsForProvider(provider, { archived });
  }

  listAll() {
    const liveSessions = this.listLiveSessions();
    const historySessions = this.listHistoricalSessions({ archived: false });
    return [...liveSessions, ...historySessions].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  listSidebarSnapshot() {
    return buildSidebarSnapshotFromGroups(this.listAll(), this.listProjectGroups());
  }

  listArchived() {
    return this.listHistoricalSessions({ archived: true });
  }

  listProjectGroups() {
    return mergeProjectGroupsWithLiveSessions(this.codexSidebarService.listProjectGroups(), this.listLiveSessions());
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

  findLiveSessionByThreadId(threadId, { providerId = "" } = {}) {
    const targetThreadId = String(threadId || "").trim();
    if (!targetThreadId) {
      return null;
    }
    const normalizedProviderId = String(providerId || "").trim();
    const provider = normalizedProviderId ? this.getProvider(normalizedProviderId) : null;
    const candidates = [...this.sessions.values()]
      .filter((session) => {
        if (session.status === "exited") {
          return false;
        }
        if (provider && session.provider !== provider.id) {
          return false;
        }
        return String(session.resumeSessionId || session.threadSnapshot?.threadId || "").trim() === targetThreadId;
      })
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
    return candidates[0] || null;
  }

  resolveProviderForThread(threadId, preferredProviderId = "") {
    const targetThreadId = String(threadId || "").trim();
    if (!targetThreadId) {
      return this.getProvider(preferredProviderId || "codex");
    }

    const liveProviderId = this.findLiveSessionByThreadId(targetThreadId, { providerId: preferredProviderId })?.provider;
    if (liveProviderId) {
      return this.getProvider(liveProviderId);
    }

    const orderedProviders = preferredProviderId
      ? [
          this.getProvider(preferredProviderId),
          ...[...this.providers.values()].filter((provider) => provider.id !== this.getProvider(preferredProviderId).id)
        ]
      : [...this.providers.values()];

    for (const provider of orderedProviders) {
      try {
        const historical = this.getHistoricalSession(provider.id, targetThreadId, { archived: null });
        if (historical) {
          return provider;
        }
      } catch {
        // Ignore missing historical threads while probing providers.
      }
    }

    return this.getProvider(preferredProviderId || "codex");
  }

  ensureLiveSessionForThread(threadId, options = {}) {
    const targetThreadId = String(threadId || "").trim();
    if (!targetThreadId) {
      throw new Error("threadId is required");
    }
    const { providerId = "", cwd = "", model = "", name = "", reasoningEffort = "", permissionMode = "" } = options;
    const composerOverrides = {};
    if (Object.prototype.hasOwnProperty.call(options, "model")) {
      composerOverrides.model = model;
    }
    if (Object.prototype.hasOwnProperty.call(options, "reasoningEffort")) {
      composerOverrides.reasoningEffort = reasoningEffort;
    }
    if (Object.prototype.hasOwnProperty.call(options, "permissionMode")) {
      composerOverrides.permissionMode = permissionMode;
    }

    const resolvedProvider = this.resolveProviderForThread(targetThreadId, providerId);
    const existing =
      this.findLiveSessionByThreadId(targetThreadId, { providerId: resolvedProvider.id }) ||
      this.findLiveSessionByThreadId(targetThreadId);
    if (existing) {
      this.updateSessionOptions(existing, composerOverrides);
      return existing;
    }

    const created = this.create({
      provider: resolvedProvider.id,
      cwd,
      ...composerOverrides,
      name,
      resumeSessionId: targetThreadId
    });
    return this.get(created.id);
  }

  preferredCodexRunnerMode({ resumeSessionId = "", permissionMode = "default" } = {}) {
    return Boolean(
      this.config.codexAppServerEnabled &&
        this.appServerBridge &&
        !sessionRequiresJsonExec({ permissionMode })
    )
      ? "app_server"
      : "json_exec";
  }

  create({ cwd = "", name = "", resumeSessionId = "", provider = "codex", model = "", reasoningEffort = "", permissionMode = "" } = {}) {
    const resolvedProvider = this.getProvider(provider);
    const id = crypto.randomUUID();
    const normalizedResumeSessionId = String(resumeSessionId || "").trim();
    let nextCwd = cwd;
    let nextModel = model;
    let nextReasoningEffort = reasoningEffort;
    let nextPermissionMode = permissionMode;

    if (resolvedProvider.id === "codex" && normalizedResumeSessionId) {
      const threadState = new CodexThreadStateStore(this.config).getThreadComposerState(normalizedResumeSessionId);
      if (threadState) {
        nextCwd = String(nextCwd || "").trim() || threadState.cwd || nextCwd;
        nextModel = String(nextModel || "").trim() || threadState.model || nextModel;
        nextReasoningEffort = String(nextReasoningEffort || "").trim() || threadState.reasoningEffort || nextReasoningEffort;
        nextPermissionMode = String(nextPermissionMode || "").trim() || threadState.permissionMode || nextPermissionMode;
      }
    }

    const resolvedCwd = this.resolveCwd(nextCwd);
    const fallbackName = `${resolvedProvider.fallbackPrefix}-${this.sessions.size + 1}`;
    const sessionName =
      resolvedProvider.id === "codex" && !String(name || "").trim()
        ? ""
        : normalizeName(name, fallbackName);
    const composerOptions = extractComposerOptions({ model: nextModel, reasoningEffort: nextReasoningEffort, permissionMode: nextPermissionMode });
    const spawnSpec = resolvedProvider.buildSpawnSpec({
      resumeSessionId: normalizedResumeSessionId || null,
      name: sessionName,
      model: composerOptions.model,
      permissionMode: composerOptions.permissionMode
    });

    if (resolvedProvider.id === "codex") {
      const preferAppServer = Boolean(
        this.config.codexAppServerEnabled &&
          this.appServerBridge &&
          !sessionRequiresJsonExec({ permissionMode: composerOptions.permissionMode })
      );
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
        resumeSessionId: normalizedResumeSessionId || null,
        resumeBootstrapComplete: true,
        pendingResumeInput: "",
        model: composerOptions.model || resolvedProvider.defaultModel || "",
        reasoningEffort: composerOptions.reasoningEffort,
        permissionMode: composerOptions.permissionMode,
        titleSource: String(name || "").trim() ? "user_provided" : "auto_generated",
        runnerMode: preferAppServer ? "app_server" : "json_exec",
        turnRunning: false,
        turnHadVisibleOutput: false,
        turnNoReplyNotified: false,
        runningProcess: null,
        queuedInputs: [],
        queuedTurnIds: [],
        pendingLocalTurnIds: new Set(),
        activePendingTurnId: "",
        conversationState: createConversationState({
          sessionId: id,
          threadId: normalizedResumeSessionId,
          status: "idle"
        }),
        threadSnapshot: null,
        liveOverlay: null,
        threadCanonicalizerState: createCanonicalizerState(),
        threadProjection: null,
        currentTurnId: "",
        activeTypedItems: new Map(),
        turnIdAliases: new Map(),
        turnAliasSources: new Map(),
        sessionType: "main",
        parentThreadId: "",
        agentRole: "",
        agentNickname: "",
        turnSequence: 0
      };
      this.seedThreadSnapshotFromHistory(session, resolvedProvider);
      this.seedConversationStateFromHistory(session, resolvedProvider);
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
      resumeSessionId: normalizedResumeSessionId || null,
      resumeBootstrapComplete: !normalizedResumeSessionId,
      pendingResumeInput: "",
      model: String(nextModel || "").trim() || resolvedProvider.defaultModel || "",
      reasoningEffort: composerOptions.reasoningEffort,
      permissionMode: composerOptions.permissionMode,
      titleSource: String(name || "").trim() ? "user_provided" : "auto_generated",
      conversationState: createConversationState({
        sessionId: id,
        threadId: normalizedResumeSessionId,
        status: "idle"
      }),
      threadSnapshot: null,
      liveOverlay: null,
      threadCanonicalizerState: createCanonicalizerState(),
      threadProjection: null,
      currentTurnId: "",
      activeTypedItems: new Map(),
      turnIdAliases: new Map(),
      turnAliasSources: new Map(),
      queuedTurnIds: [],
      pendingLocalTurnIds: new Set(),
      activePendingTurnId: "",
      sessionType: "main",
      parentThreadId: "",
      agentRole: "",
      agentNickname: "",
      turnSequence: 0
    };

    registerPtySessionHandlers(this, session, shell);

    this.seedThreadSnapshotFromHistory(session, resolvedProvider);
    this.seedConversationStateFromHistory(session, resolvedProvider);
    this.sessions.set(id, session);
    return this.serialize(session);
  }

  updateSessionOptions(target, input = {}) {
    const session = typeof target === "string" ? this.get(target) : target;
    if (!session) {
      throw new Error(`Session not found: ${typeof target === "string" ? target : ""}`);
    }

    applyComposerOptionOverrides(session, input);
    if (!String(session.model || "").trim()) {
      session.model = this.getProvider(session.provider).defaultModel || "";
    }
    if (!String(session.reasoningEffort || "").trim()) {
      session.reasoningEffort = "medium";
    }
    if (!String(session.permissionMode || "").trim()) {
      session.permissionMode = "default";
    }
    if (session.provider === "codex") {
      session.runnerMode = this.preferredCodexRunnerMode({
        resumeSessionId: session.resumeSessionId,
        permissionMode: session.permissionMode
      });
    }
    session.updatedAt = nowIso();
    return session;
  }

  pushSessionBuffer(session, text = "") {
    pushSessionBuffer(session, text, this.config);
  }

  broadcast(session, payload) {
    broadcast(session, payload);
  }

  attachClient(id, ws, options) {
    attachClient(this, id, ws, options);
  }

  ensureConversationState(session, { status = "" } = {}) {
    if (!session) {
      return createConversationState();
    }
    if (session.threadSnapshot) {
      session.conversationState = deriveConversationStateFromThreadSnapshot(session.threadSnapshot, {
        sessionId: String(session.id || ""),
        threadId: String(session.resumeSessionId || session.threadSnapshot?.threadId || ""),
        status: status || session.conversationState?.status || "idle"
      });
      return session.conversationState;
    }
    session.conversationState = createConversationState({
      ...(session.conversationState || {}),
      sessionId: String(session.id || ""),
      threadId: String(session.resumeSessionId || session.conversationState?.threadId || ""),
      status: status || session.conversationState?.status || "idle",
      updatedAt: session.updatedAt || session.conversationState?.updatedAt || nowIso()
    });
    return session.conversationState;
  }

  syncConversationStateFromThreadSnapshot(session, { status = "" } = {}) {
    if (!session) {
      return createConversationState();
    }
    const snapshot = this.ensureThreadSnapshot(session);
    session.conversationState = deriveConversationStateFromThreadSnapshot(snapshot, {
      sessionId: String(session.id || ""),
      threadId: String(session.resumeSessionId || snapshot?.threadId || ""),
      status: status || session.conversationState?.status || "idle"
    });
    return session.conversationState;
  }

  ensureThreadSnapshot(session) {
    if (!session) {
      return null;
    }
    session.threadSnapshot ||= {
      threadId: String(session.resumeSessionId || session.id || ""),
      metadata: {
        name: session.name || "",
        preview: session.inputPreview || "",
        model: session.model || "",
        cwd: session.cwd || "",
        source: session.provider || ""
      },
      turns: [],
      runtime: { latestTurnContext: null },
      metrics: { latestUsage: null },
      version: 0,
      lastEventSeq: 0,
      updatedAt: session.updatedAt || nowIso(),
      activeTurnId: null
    };
    session.threadSnapshot.threadId = String(session.resumeSessionId || session.threadSnapshot.threadId || session.id || "");
    session.threadSnapshot.metadata = {
      ...session.threadSnapshot.metadata,
      name: session.name || "",
      preview: session.inputPreview || "",
      model: session.model || "",
      cwd: session.cwd || "",
      source: session.provider || ""
    };
    return session.threadSnapshot;
  }

  seedThreadSnapshotFromHistory(session, provider = null) {
    if (!session) {
      return;
    }
    const current = this.ensureThreadSnapshot(session);
    if ((current?.turns || []).length > 0) {
      buildThreadProjection(session);
      syncProjectedThreadState(session, { previousSnapshot: current });
      return;
    }
    if (!session.resumeSessionId) {
      buildThreadProjection(session);
      session.liveOverlay = null;
      return;
    }
    const resolvedProvider = provider || this.getProvider(session.provider);
    try {
      const historical = this.historyService.getHistoricalMessages(resolvedProvider, session.resumeSessionId);
      if (historical?.threadSnapshot) {
        session.threadSnapshot = {
          ...historical.threadSnapshot,
          metadata: {
            ...(historical.threadSnapshot.metadata || {}),
            name: session.name || historical.threadSnapshot.metadata?.name || "",
            preview: session.inputPreview || historical.threadSnapshot.metadata?.preview || "",
            model: session.model || historical.threadSnapshot.metadata?.model || "",
            cwd: session.cwd || historical.threadSnapshot.metadata?.cwd || "",
            source: session.provider || historical.threadSnapshot.metadata?.source || ""
          }
        };
        buildThreadProjection(session);
        syncProjectedThreadState(session, { previousSnapshot: session.threadSnapshot });
      }
    } catch {
      const ensured = this.ensureThreadSnapshot(session);
      buildThreadProjection(session);
      syncProjectedThreadState(session, { previousSnapshot: ensured });
    }
  }

  applyThreadRawRecord(session, record, { turnId = "" } = {}) {
    if (!session || !record) {
      return null;
    }
    const snapshot = this.ensureThreadSnapshot(session);
    const rawRecord = createRawRecord({
      id: `raw:${session.id}:${snapshot.lastEventSeq + 1}`,
      threadId: String(session.resumeSessionId || snapshot.threadId || session.id || ""),
      turnId: String(turnId || record?.turnId || record?.turn_id || record?.payload?.turn_id || session.currentTurnId || snapshot.activeTurnId || ""),
      source: "session_manager",
      raw: record,
      seq: snapshot.lastEventSeq + 1,
      recordTs: record?.timestamp || record?.payload?.timestamp || nowIso()
    });
    const canonicalizerState = session.threadCanonicalizerState || createCanonicalizerState();
    session.threadCanonicalizerState = canonicalizerState;
    const events = canonicalizeRawRecord(rawRecord, canonicalizerState);
    if (!events.length) {
      return null;
    }
    const projection = getThreadProjection(session);
    for (const event of events) {
      const canonicalEvent = createCanonicalEventFromLegacy(event, {
        provider: session.provider,
        providerThreadId: String(session.resumeSessionId || snapshot.threadId || session.id || "")
      });
      if (!canonicalEvent) {
        continue;
      }
      projection.projector.applyEvent(canonicalEvent);
    }
    syncProjectedThreadState(session, { previousSnapshot: snapshot });
    this.syncConversationStateFromThreadSnapshot(session);
    return session.threadSnapshot;
  }

  seedConversationStateFromHistory(session, provider = null) {
    if (!session) {
      return createConversationState();
    }
    if (!session.resumeSessionId) {
      return this.ensureConversationState(session);
    }
    if ((session.conversationState?.turns || []).length > 0) {
      return this.ensureConversationState(session);
    }
    const resolvedProvider = provider || this.getProvider(session.provider);
    try {
      const historical = this.historyService.getHistoricalMessages(resolvedProvider, session.resumeSessionId);
      session.conversationState = createConversationState({
        ...(historical?.conversation || {}),
        sessionId: String(session.id || ""),
        threadId: String(session.resumeSessionId || ""),
        updatedAt: session.updatedAt || nowIso()
      });
      return session.conversationState;
    } catch {
      return this.ensureConversationState(session);
    }
  }

  applyConversationDeltas(session, deltas = [], { broadcast: shouldBroadcast = true } = {}) {
    if (!session) {
      return [];
    }
    const previous = createConversationState(session.conversationState);
    const normalizedDeltas = (Array.isArray(deltas) ? deltas : []).filter(Boolean);
    const { state, applied } = applyConversationStateDeltas(previous, normalizedDeltas);
    session.conversationState = createConversationState({
      ...state,
      sessionId: String(session.id || state.sessionId || ""),
      threadId: String(session.resumeSessionId || state.threadId || "")
    });
    if (shouldBroadcast) {
      this.broadcastConversationDelta(session, applied);
    }
    return applied;
  }

  broadcastDerivedConversationDelta(session, previousState = null) {
    if (!session) {
      return;
    }
    const before = createConversationState(previousState || {});
    const after = this.ensureConversationState(session);
    if (before.version === after.version) {
      return;
    }
    this.broadcastConversationDelta(session, [
      {
        delta: {
          kind: "conversation_replaced",
          conversation: after,
          sessionId: after.sessionId,
          threadId: after.threadId,
          timestamp: after.updatedAt
        },
        fromVersion: before.version,
        toVersion: after.version,
        timestamp: after.updatedAt
      }
    ]);
  }

  createConversationTurn(session, userText, timestamp = nowIso(), { activate = true } = {}) {
    if (!session) {
      return null;
    }
    session.turnSequence = Math.max(0, Number(session.turnSequence) || 0) + 1;
    const suffix = typeof crypto.randomUUID === "function" ? crypto.randomUUID().slice(0, 8) : String(Date.now());
    const turnId = `${session.id}-turn-${Date.now()}-${session.turnSequence}-${suffix}`;
    if (activate) {
      session.currentTurnId = turnId;
      session.activePendingTurnId = turnId;
    }
    session.pendingLocalTurnIds ||= new Set();
    session.pendingLocalTurnIds.add(turnId);
    const previous = createConversationState(session.conversationState);
    this.applyThreadRawRecord(
      session,
      {
        type: "event_msg",
        timestamp,
        payload: {
          type: "user_message",
          message: userText,
          content: [{ type: "input_text", text: userText }]
        }
      },
      { turnId }
    );
    this.broadcastDerivedConversationDelta(session, previous);
    return turnId;
  }

  bindConversationTurnAlias(session, clientTurnId = "", serverTurnId = "", { source = "unknown" } = {}) {
    const clientId = String(clientTurnId || "").trim();
    const serverId = String(serverTurnId || "").trim();
    if (!session || !clientId || !serverId) {
      return false;
    }
    if (clientId === serverId) {
      return true;
    }

    session.turnIdAliases ||= new Map();
    session.turnAliasSources ||= new Map();
    const existingServer = session.turnIdAliases.get(clientId);
    const existingClient = [...session.turnIdAliases.entries()].find(
      ([leftClientId, rightServerId]) => rightServerId === serverId && leftClientId !== clientId
    )?.[0];
    if ((existingServer && existingServer !== serverId) || existingClient) {
      console.warn(
        `[conversation] turn alias conflict sessionId=${session.id || ""} clientTurnId=${clientId} serverTurnId=${serverId}`
      );
      return false;
    }

    session.turnIdAliases.set(clientId, serverId);
    session.turnAliasSources.set(`${clientId}->${serverId}`, String(source || "unknown"));
    session.pendingLocalTurnIds?.delete(clientId);
    session.pendingLocalTurnIds?.add(serverId);

    const renameTurns = (turns = []) =>
      (Array.isArray(turns) ? turns : []).map((turn) =>
        String(turn?.id || "").trim() === clientId
          ? {
              ...turn,
              id: serverId
            }
          : turn
      );

    if (session.threadSnapshot) {
      session.threadSnapshot = {
        ...session.threadSnapshot,
        activeTurnId: String(session.threadSnapshot.activeTurnId || "") === clientId ? serverId : session.threadSnapshot.activeTurnId,
        turns: renameTurns(session.threadSnapshot.turns)
      };
      buildThreadProjection(session);
      syncProjectedThreadState(session, { previousSnapshot: session.threadSnapshot });
    }

    if (session.conversationState) {
      session.conversationState = createConversationState({
        ...session.conversationState,
        activeTurnId: String(session.conversationState.activeTurnId || "") === clientId ? serverId : session.conversationState.activeTurnId,
        turns: renameTurns(session.conversationState.turns)
      });
    }

    if (String(session.currentTurnId || "") === clientId) {
      session.currentTurnId = serverId;
    }
    if (String(session.activePendingTurnId || "") === clientId) {
      session.activePendingTurnId = serverId;
    }
    session.queuedTurnIds = (Array.isArray(session.queuedTurnIds) ? session.queuedTurnIds : []).map((turnId) =>
      String(turnId || "") === clientId ? serverId : turnId
    );
    return true;
  }

  applyConversationRecord(session, record, { turnId = session?.currentTurnId || session?.threadSnapshot?.activeTurnId || session?.conversationState?.activeTurnId || "" } = {}) {
    if (!session || !turnId) {
      return [];
    }
    const previous = createConversationState(session.conversationState);
    const explicitDeltas = normalizeRecordToDeltas(record, { turnId }).map((delta) => ({
      ...delta,
      sessionId: String(session.id || ""),
      threadId: String(session.resumeSessionId || session.conversationState?.threadId || ""),
      clientTurnId: String(record?.clientTurnId || ""),
      aliasSource: String(record?.aliasSource || "")
    }));
    this.applyThreadRawRecord(session, record, { turnId });
    this.syncConversationStateFromThreadSnapshot(session);
    if (explicitDeltas.length) {
      const after = createConversationState(session.conversationState);
      const finalVersion = Math.max(after.version, previous.version + explicitDeltas.length);
      const applied = explicitDeltas.map((delta, index) => ({
        delta,
        fromVersion: previous.version + index,
        toVersion: index === explicitDeltas.length - 1 ? finalVersion : previous.version + index + 1,
        timestamp: delta.timestamp || delta.block?.ts || delta.event?.ts || record?.timestamp || after.updatedAt
      }));
      this.broadcastConversationDelta(session, applied);
    } else {
      this.broadcastDerivedConversationDelta(session, previous);
    }
    if (String(record?.phase || "").toLowerCase() !== "streaming") {
      this.broadcastConversationSnapshot(session);
    }
    return explicitDeltas;
  }

  hasConversationTurn(session, turnId = "") {
    const targetTurnId = String(turnId || "").trim();
    if (!session || !targetTurnId) {
      return false;
    }
    return Boolean(
      (Array.isArray(session.threadSnapshot?.turns) &&
        session.threadSnapshot.turns.some((turn) => String(turn?.id || "").trim() === targetTurnId)) ||
        (Array.isArray(session.conversationState?.turns) &&
          session.conversationState.turns.some((turn) => String(turn?.id || "").trim() === targetTurnId))
    );
  }

  finalizeConversationTurn(session, status = "completed", timestamp = nowIso(), options = {}) {
    const hasExplicitTurnId = Object.prototype.hasOwnProperty.call(options || {}, "turnId");
    const targetTurnId = String(
      hasExplicitTurnId
        ? options?.turnId || ""
        : session?.currentTurnId || session?.threadSnapshot?.activeTurnId || session?.conversationState?.activeTurnId || ""
    ).trim();
    if (!targetTurnId) {
      return false;
    }
    if (hasExplicitTurnId && !this.hasConversationTurn(session, targetTurnId)) {
      return false;
    }
    const previous = createConversationState(session.conversationState);
    this.applyThreadRawRecord(
      session,
      {
        type: "event_msg",
        timestamp,
        payload: {
          type: status === "failed" ? "task_failed" : status === "aborted" || status === "interrupted" ? "turn_aborted" : "task_complete",
          status
        }
      },
      { turnId: targetTurnId }
    );
    if (String(session.currentTurnId || "").trim() === targetTurnId) {
      session.currentTurnId = "";
    }
    if (String(session.activePendingTurnId || "").trim() === targetTurnId) {
      session.activePendingTurnId = "";
    }
    session.pendingLocalTurnIds?.delete(targetTurnId);
    this.broadcastDerivedConversationDelta(session, previous);
    this.broadcastConversationSnapshot(session);
    return true;
  }

  updateConversationTurnStatus(session, status = "running", timestamp = nowIso()) {
    const targetTurnId = String(session?.currentTurnId || session?.threadSnapshot?.activeTurnId || session?.conversationState?.activeTurnId || "");
    if (!targetTurnId) {
      return;
    }
    this.syncConversationStateFromThreadSnapshot(session, { status });
  }

  scheduleConversationHistoryResync(session, { attempts = 12, delayMs = 2_000 } = {}) {
    if (!session?.resumeSessionId) {
      return;
    }
    const providerId = String(session.provider || "").trim();
    const resumeSessionId = String(session.resumeSessionId || "").trim();
    const sessionId = String(session.id || "");
    if (!providerId || !resumeSessionId || !sessionId) {
      return;
    }

    for (let index = 0; index < attempts; index += 1) {
      const waitMs = delayMs * (index + 1);
      setTimeout(() => {
        const live = this.sessions.get(sessionId);
        if (!live || live.status === "exited") {
          return;
        }
        let historical;
        try {
          historical = this.historyService.getHistoricalMessages(this.getProvider(providerId), resumeSessionId);
        } catch {
          return;
        }
        const currentSnapshot = this.ensureThreadSnapshot(live);
        const incomingSnapshot = historical?.threadSnapshot || null;
        const currentUpdatedAt = parseSnapshotUpdatedAt(currentSnapshot);
        const incomingUpdatedAt = parseSnapshotUpdatedAt(incomingSnapshot);
        const protectedTurnId = String(
          live.currentTurnId ||
          currentSnapshot?.activeTurnId ||
          live.conversationState?.activeTurnId ||
          ""
        ).trim();
        if (protectedTurnId && snapshotHasTurn(currentSnapshot, protectedTurnId) && !snapshotHasTurn(incomingSnapshot, protectedTurnId)) {
          return;
        }
        if (incomingUpdatedAt && currentUpdatedAt && incomingUpdatedAt < currentUpdatedAt) {
          return;
        }
        const shouldReplace =
          Number(incomingSnapshot?.lastEventSeq || 0) > Number(currentSnapshot?.lastEventSeq || 0) ||
          Number(incomingSnapshot?.version || 0) > Number(currentSnapshot?.version || 0) ||
          hasThreadSnapshotMeaningfulAdvance(incomingSnapshot, currentSnapshot);
        if (!shouldReplace) {
          return;
        }
        if (incomingSnapshot) {
          live.threadSnapshot = incomingSnapshot;
          buildThreadProjection(live);
          syncProjectedThreadState(live, { previousSnapshot: incomingSnapshot });
          if (!live.liveOverlay && historical.liveOverlay) {
            live.liveOverlay = historical.liveOverlay;
          }
        }
        this.syncConversationStateFromThreadSnapshot(live);
        live.updatedAt = nowIso();
        this.broadcastConversationSnapshot(live);
      }, waitMs).unref?.();
    }
  }

  broadcastConversationSnapshot(session) {
    if (!session) {
      return;
    }
    this.syncConversationStateFromThreadSnapshot(session);
    const sessionView = this.serialize(session);
    const snapshotPayload = buildConversationSnapshotPayload(session, sessionView);
    this.broadcast(session, snapshotPayload);
    this.broadcast(
      session,
      buildLegacyConversationSnapshotPayload(session, {
        fromVersion: snapshotPayload.conversation?.version || 0,
        toVersion: snapshotPayload.conversation?.version || 0
      })
    );
  }

  broadcastConversationDelta(session, applied = []) {
    if (!session) {
      return;
    }
    this.syncConversationStateFromThreadSnapshot(session);
    const payload = buildConversationDeltaPayload(session, applied);
    if (!payload) {
      return;
    }
    this.broadcast(session, payload);
    this.broadcast(
      session,
      buildLegacyConversationSnapshotPayload(session, {
        fromVersion: payload.fromVersion,
        toVersion: payload.toVersion
      })
    );
  }

  enqueueJsonExecInput(session, data) {
    return enqueueRunnerInput(this, session, data);
  }

  async maybeStartAppServerTurn(session) {
    return startAppServerTurn(this, session);
  }

  handleAppServerTurnResult(session, result) {
    return handleAppServerTurnResult(this, session, result);
  }

  maybeStartJsonExecRun(session) {
    return startJsonExecRun(this, session);
  }

  buildCodexJsonExecArgs(session, prompt) {
    return buildCodexJsonExecArgs(this, session, prompt);
  }

  handleCodexJsonEvent(session, event) {
    return handleCodexJsonEvent(this, session, event);
  }

  handleAppServerNotification(msg) {
    return handleAppServerNotification(this, msg);
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
      return this.enqueueJsonExecInput(session, text);
    }

    session.shell.write(text);
    session.updatedAt = nowIso();
    return "";
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
    session.titleSource = "custom_name";
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
      threadId: session.resumeSessionId || session.threadSnapshot?.threadId || session.id,
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
      reasoningEffort: session.reasoningEffort || "medium",
      permissionMode: session.permissionMode || "default",
      titleSource: session.titleSource || "",
      sessionType: session.sessionType || "main",
      parentThreadId: session.parentThreadId || "",
      agentRole: session.agentRole || "",
      agentNickname: session.agentNickname || ""
    };
  }

  getConversationSnapshot(id) {
    const session = this.get(id);
    if (!session) {
      return null;
    }
    this.ensureConversationState(session);
    this.ensureThreadSnapshot(session);
    buildThreadProjection(session);
    syncProjectedThreadState(session, { previousSnapshot: session.threadSnapshot });
    return buildConversationSnapshotPayload(session, this.serialize(session));
  }

  getHistoricalMessages(providerId, resumeSessionId) {
    const provider = this.getProvider(providerId);
    return this.historyService.getHistoricalMessages(provider, resumeSessionId);
  }

  getThreadSnapshotBundle(providerId, resumeSessionId) {
    const provider = this.getProvider(providerId);
    return buildThreadSnapshotBundle(this.historyService, provider, resumeSessionId);
  }

  getLiveHistoryContinuation(providerId, resumeSessionId) {
    const provider = this.getProvider(providerId);
    return buildLiveHistoryContinuation({
      sessions: this.sessions.values(),
      provider,
      resumeSessionId,
      historyService: this.historyService,
      ensureThreadSnapshot: (session) => this.ensureThreadSnapshot(session),
      ensureConversationState: (session) => this.ensureConversationState(session),
      buildThreadProjection,
      deriveThreadSnapshotFromConversationState,
      syncProjectedThreadState,
      serialize: (session) => this.serialize(session)
    });
  }

  getThreadContinuation(providerId, resumeSessionId) {
    return this.getLiveHistoryContinuation(providerId, resumeSessionId);
  }

  getThreadContinuationRuntime(providerId, resumeSessionId) {
    return this.getLiveHistoryContinuation(providerId, resumeSessionId);
  }

  maybeAutoRename(session, chunk) {
    return maybeAutoRename(this, session, chunk);
  }

  maybeAutoAdvanceClaudeStartup(session) {
    return maybeAutoAdvanceClaudeStartup(this, session);
  }

  getCustomName(providerId, resumeSessionId) {
    return this.historyService.getCustomName(providerId, resumeSessionId);
  }

  setCustomName(providerId, resumeSessionId, name) {
    this.historyService.setCustomName(providerId, resumeSessionId, name);
  }

  removeCustomName(providerId, resumeSessionId) {
    this.historyService.removeCustomName(providerId, resumeSessionId);
  }

  isArchived(providerId, resumeSessionId) {
    return this.historyService.isArchived(providerId, resumeSessionId);
  }

  getArchivedAt(providerId, resumeSessionId) {
    return this.historyService.getArchivedAt(providerId, resumeSessionId);
  }

  setArchived(providerId, resumeSessionId, archivedAt = nowIso()) {
    this.historyService.setArchived(providerId, resumeSessionId, archivedAt);
  }

  clearArchived(providerId, resumeSessionId) {
    this.historyService.clearArchived(providerId, resumeSessionId);
  }

  getHistoricalSession(providerId, resumeSessionId, { archived = null } = {}) {
    const provider = this.getProvider(providerId);
    return this.historyService.getHistoricalSession(provider, resumeSessionId, { archived });
  }

  archiveHistoricalSession(providerId, resumeSessionId) {
    const provider = this.getProvider(providerId);
    return this.historyService.archiveHistoricalSession(provider, resumeSessionId, nowIso());
  }

  restoreHistoricalSession(providerId, resumeSessionId) {
    const provider = this.getProvider(providerId);
    return this.historyService.restoreHistoricalSession(provider, resumeSessionId);
  }

  deleteHistoricalSession(providerId, resumeSessionId) {
    const provider = this.getProvider(providerId);
    return this.historyService.deleteHistoricalSession(provider, resumeSessionId);
  }

  resumeKey(providerId, resumeSessionId) {
    return this.historyService.resumeKey(providerId, resumeSessionId);
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
    if (!session || session.autoNamed || !isManuallyNamedSession(session)) {
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
    if (!session || session.autoNamed || session.resumeSessionId || !isManuallyNamedSession(session)) {
      return;
    }

    const snapshot = {
      provider: session.provider,
      cwd: session.cwd,
      inputPreview: session.inputPreview,
      name: session.name,
      createdAt: session.createdAt,
      autoNamed: false,
      resumeSessionId: null,
      titleSource: session.titleSource || ""
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
      name: session.autoNamed ? "" : session.name,
      model: session.model || "",
      permissionMode: session.permissionMode || "default"
    });
  }
}
