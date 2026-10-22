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
import { attachClient, broadcast, maybeAutoAdvanceClaudeStartup, maybeAutoRename, pushSessionBuffer, registerPtySessionHandlers } from "./sessions/live/sessionOutput.js";
import { buildProviders } from "./sessions/providers/buildProviders.js";
import { createConversationState } from "./sessions/conversation/state.js";
import {
  applyConversationDeltas,
  broadcastConversationDelta,
  broadcastConversationSnapshot,
  broadcastDerivedConversationDelta,
  ensureConversationState,
  getConversationSnapshot,
  seedConversationStateFromHistory,
  syncConversationStateFromThreadSnapshot
} from "./sessions/conversation/legacyConversationRuntime.js";
import {
  applyThreadRawRecord,
  buildThreadProjection,
  ensureThreadSnapshot,
  scheduleConversationHistoryResync,
  seedThreadSnapshotFromHistory,
  syncProjectedThreadState
} from "./sessions/conversation/legacyThreadProjection.js";
import {
  applyConversationRecord,
  bindConversationTurnAlias,
  createConversationTurn,
  finalizeConversationTurn,
  hasConversationTurn,
  updateConversationTurnStatus
} from "./sessions/conversation/legacyConversationTurns.js";
import {
  nowIso
} from "./sessions/shared/text.js";
import {
  applyComposerOptionOverrides,
  assertPermissionModeSupported,
  extractComposerOptions,
  normalizeCodexComposerPatch
} from "./sessions/shared/composerOptions.js";
import { readCodexModelsFromCache } from "./sessions/shared/codexModelCatalog.js";
import { getCachedAppServerModels } from "./sessions/shared/appServerModelCatalog.js";
import { CodexThreadStateStore } from "./sessions/state/CodexThreadStateStore.js";
import { interruptSession } from "./sessions/control/sessionInterrupt.js";
import { resolveImageAttachments } from "./sessions/shared/imageAttachments.js";
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
  createCanonicalizerState,
  deriveThreadSnapshotFromConversationState
} from "./threads/index.js";

function normalizeName(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

function isManuallyNamedSession(session) {
  const titleSource = String(session?.titleSource || "").trim().toLowerCase();
  return titleSource === "custom_name" || titleSource === "user_provided";
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

  codexModelCatalog() {
    const cachedModels = this.config.codexAppServerEnabled ? getCachedAppServerModels(this.appServerBridge) : null;
    if (cachedModels) return cachedModels;
    const diskModels = readCodexModelsFromCache(this.config.codexModelsCachePath);
    return diskModels.length ? diskModels : this.getProvider("codex").models || [];
  }

  providerCatalog() {
    const codexCacheModels = this.codexModelCatalog();
    return [...this.providers.values()].map((provider) => {
      const isCodex = provider.id === "codex";
      const providerModels = isCodex ? codexCacheModels : provider.models || [];
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
    const desktopSnapshot = this.codexSidebarService.getDesktopSnapshot(this.listLiveSessions());
    if (desktopSnapshot) {
      return desktopSnapshot;
    }
    return buildSidebarSnapshotFromGroups(this.listAll(), this.listProjectGroups());
  }

  async listSidebarSnapshotAsync() {
    const desktop = await this.codexSidebarService.getDesktopSnapshotAsync(() => this.listLiveSessions());
    if (desktop) return desktop;
    const groups = await this.listProjectGroupsAsync();
    return buildSidebarSnapshotFromGroups(this.listAll(), groups);
  }

  listArchived() {
    return this.listHistoricalSessions({ archived: true });
  }

  listProjectGroups() {
    const desktopSnapshot = this.codexSidebarService.getDesktopSnapshot(this.listLiveSessions());
    if (desktopSnapshot) {
      return desktopSnapshot.projectGroups;
    }
    return mergeProjectGroupsWithLiveSessions(this.codexSidebarService.listProjectGroups(), this.listLiveSessions());
  }

  async listProjectGroupsAsync() {
    const desktop = await this.codexSidebarService.getDesktopSnapshotAsync(() => this.listLiveSessions());
    if (desktop) return desktop.projectGroups;
    const groups = await this.codexSidebarService.listProjectGroupsAsync();
    return mergeProjectGroupsWithLiveSessions(groups, this.listLiveSessions());
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

  preferredCodexRunnerMode() {
    return this.config.codexAppServerEnabled && this.appServerBridge ? "app_server" : "json_exec";
  }

  create({ cwd = "", name = "", resumeSessionId = "", provider = "codex", model = "", reasoningEffort = "", permissionMode = "", projectId = "" } = {}) {
    const resolvedProvider = this.getProvider(provider);
    const id = crypto.randomUUID();
    const normalizedResumeSessionId = String(resumeSessionId || "").trim();
    let nextCwd = cwd;
    let nextModel = model;
    let nextReasoningEffort = reasoningEffort;
    let nextPermissionMode = permissionMode;
    let savedComposerState = {};

    if (resolvedProvider.id === "codex" && normalizedResumeSessionId) {
      const threadState = new CodexThreadStateStore(this.config).getThreadComposerState(normalizedResumeSessionId);
      if (threadState) {
        if (threadState.permissionPolicyUnsupported) {
          throw new Error("当前会话使用自定义权限策略，请先在输入设置中明确选择权限后再继续。");
        }
        savedComposerState = threadState;
        nextCwd = String(nextCwd || "").trim() || threadState.cwd || nextCwd;
        nextModel = String(nextModel || "").trim() || threadState.model || nextModel;
        nextReasoningEffort = String(nextReasoningEffort || "").trim() || threadState.reasoningEffort || nextReasoningEffort;
        nextPermissionMode = String(nextPermissionMode || "").trim() || threadState.permissionMode || nextPermissionMode;
      }
    }

    const resolvedCwd = this.resolveCwd(nextCwd);
    const fallbackName = `${resolvedProvider.fallbackPrefix}-${this.sessions.size + 1}`;
    const resumedCodex = resolvedProvider.id === "codex" && Boolean(normalizedResumeSessionId);
    let desktopTitle = "";
    if (resumedCodex && !String(name || "").trim()) {
      const desktopSession = this.codexSidebarService.getDesktopSnapshot([])?.sessions?.find(
        (session) => String(session.resumeSessionId || session.threadId || "") === normalizedResumeSessionId
      );
      desktopTitle = String(desktopSession?.name || desktopSession?.title || "").trim();
    }
    const sessionName =
      resolvedProvider.id === "codex" && !String(name || "").trim()
        ? desktopTitle
        : normalizeName(name, fallbackName);
    const composerOptions = resolvedProvider.id === "codex"
      ? {
          reasoningEffort: String(nextReasoningEffort || "").trim() || "medium",
          ...normalizeCodexComposerPatch({
            model: String(nextModel || "").trim() || resolvedProvider.defaultModel || "",
            ...(String(reasoningEffort || "").trim() ? { reasoningEffort } : {}),
            permissionMode: nextPermissionMode
          }, savedComposerState, this.codexModelCatalog())
        }
      : extractComposerOptions({ model: nextModel, reasoningEffort: nextReasoningEffort, permissionMode: nextPermissionMode });
    assertPermissionModeSupported(composerOptions.permissionMode, {
      providerId: resolvedProvider.id,
      runnerMode: resolvedProvider.id === "codex" ? this.preferredCodexRunnerMode() : ""
    });
    const spawnSpec = resolvedProvider.buildSpawnSpec({
      resumeSessionId: normalizedResumeSessionId || null,
      name: sessionName,
      model: composerOptions.model,
      permissionMode: composerOptions.permissionMode
    });

    if (resolvedProvider.id === "codex") {
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
        autoNamed: !resumedCodex && !String(name || "").trim(),
        fallbackName,
        inputPreview: "",
        sawBootstrapCommand: true,
        bootstrapNames: resolvedProvider.bootstrapNames,
        claudeStartupStage: 2,
        resumeSessionId: normalizedResumeSessionId || null,
        projectId: normalizedResumeSessionId ? "" : this.codexSidebarService.resolveProjectId(projectId),
        resumeBootstrapComplete: true,
        pendingResumeInput: "",
        model: composerOptions.model || resolvedProvider.defaultModel || "",
        reasoningEffort: composerOptions.reasoningEffort,
        permissionMode: composerOptions.permissionMode,
        titleSource: String(name || "").trim() ? "user_provided" : resumedCodex ? "codex_state_db" : "auto_generated",
        runnerMode: this.preferredCodexRunnerMode(),
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

    assertPermissionModeSupported(input.permissionMode ?? session.permissionMode, {
      providerId: session.provider,
      runnerMode: session.runnerMode || (session.provider === "codex" ? this.preferredCodexRunnerMode() : "")
    });
    const options = session.provider === "codex"
      ? normalizeCodexComposerPatch(input, session, this.codexModelCatalog())
      : input;
    applyComposerOptionOverrides(session, options);
    if (!String(session.model || "").trim()) {
      session.model = this.getProvider(session.provider).defaultModel || "";
    }
    if (session.reasoningEffort == null) {
      session.reasoningEffort = "medium";
    }
    if (!String(session.permissionMode || "").trim()) {
      session.permissionMode = "default";
    }
    if (session.provider === "codex") {
      session.runnerMode ||= this.preferredCodexRunnerMode();
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
    return ensureConversationState(this, session, { status });
  }

  syncConversationStateFromThreadSnapshot(session, { status = "" } = {}) {
    return syncConversationStateFromThreadSnapshot(this, session, { status });
  }

  ensureThreadSnapshot(session) {
    return ensureThreadSnapshot(this, session);
  }

  seedThreadSnapshotFromHistory(session, provider = null) {
    return seedThreadSnapshotFromHistory(this, session, provider);
  }

  applyThreadRawRecord(session, record, { turnId = "" } = {}) {
    return applyThreadRawRecord(this, session, record, { turnId });
  }

  seedConversationStateFromHistory(session, provider = null) {
    return seedConversationStateFromHistory(this, session, provider);
  }

  applyConversationDeltas(session, deltas = [], { broadcast: shouldBroadcast = true } = {}) {
    return applyConversationDeltas(this, session, deltas, { broadcast: shouldBroadcast });
  }

  broadcastDerivedConversationDelta(session, previousState = null) {
    return broadcastDerivedConversationDelta(this, session, previousState);
  }

  createConversationTurn(session, userText, timestamp = nowIso(), { activate = true, images = [] } = {}) {
    return createConversationTurn(this, session, userText, timestamp, { activate, images });
  }

  bindConversationTurnAlias(session, clientTurnId = "", serverTurnId = "", { source = "unknown" } = {}) {
    return bindConversationTurnAlias(this, session, clientTurnId, serverTurnId, { source });
  }

  applyConversationRecord(session, record, { turnId = session?.currentTurnId || session?.threadSnapshot?.activeTurnId || session?.conversationState?.activeTurnId || "" } = {}) {
    return applyConversationRecord(this, session, record, { turnId });
  }

  hasConversationTurn(session, turnId = "") {
    return hasConversationTurn(this, session, turnId);
  }

  finalizeConversationTurn(session, status = "completed", timestamp = nowIso(), options = {}) {
    return finalizeConversationTurn(this, session, status, timestamp, options);
  }

  updateConversationTurnStatus(session, status = "running", timestamp = nowIso()) {
    return updateConversationTurnStatus(this, session, status, timestamp);
  }

  scheduleConversationHistoryResync(session, { attempts = 12, delayMs = 2_000 } = {}) {
    return scheduleConversationHistoryResync(this, session, { attempts, delayMs });
  }

  broadcastConversationSnapshot(session) {
    return broadcastConversationSnapshot(this, session);
  }

  broadcastConversationDelta(session, applied = []) {
    return broadcastConversationDelta(this, session, applied);
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

  buildCodexJsonExecArgs(session, prompt, images = []) {
    return buildCodexJsonExecArgs(this, session, prompt, images);
  }

  handleCodexJsonEvent(session, event) {
    return handleCodexJsonEvent(this, session, event);
  }

  handleAppServerNotification(msg) {
    return handleAppServerNotification(this, msg);
  }

  write(id, data, { attachments = [] } = {}) {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }

    const text = String(data || "");
    const images = resolveImageAttachments(this.config, attachments);
    if (!text.trim() && !images.length) {
      return;
    }
    if (images.length && (session.provider !== "codex" || !["json_exec", "app_server"].includes(session.runnerMode))) {
      throw new Error("Image attachments require a Codex app-server or JSON exec session.");
    }

    this.maybeAutoRename(session, text);
    if (session.resumeSessionId && !session.resumeBootstrapComplete) {
      session.pendingResumeInput = `${session.pendingResumeInput || ""}${text}`.slice(-4096);
      session.updatedAt = nowIso();
    }
    if (session.runnerMode === "json_exec" || session.runnerMode === "app_server") {
      return this.enqueueJsonExecInput(session, images.length ? { text, images } : text);
    }

    session.shell.write(text);
    session.updatedAt = nowIso();
    return "";
  }

  interrupt(id) {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }
    return interruptSession(this, session);
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
      projectId: session.projectId || "",
      model: session.model || "",
      reasoningEffort: session.reasoningEffort ?? "medium",
      permissionMode: session.permissionMode || "default",
      titleSource: session.titleSource || "",
      sessionType: session.sessionType || "main",
      parentThreadId: session.parentThreadId || "",
      agentRole: session.agentRole || "",
      agentNickname: session.agentNickname || ""
    };
  }

  getConversationSnapshot(id) {
    return getConversationSnapshot(this, id);
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
