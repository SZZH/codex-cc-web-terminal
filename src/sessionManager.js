import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import pty from "node-pty";

import { HistoricalSessionService } from "./sessions/history/HistoricalSessionService.js";
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
  applyConversationDeltas as applyConversationDeltaBatch,
  buildConversationStateFromHistory,
  compareConversationContent,
  createConversationState
} from "./sessions/conversation/state.js";
import {
  nowIso
} from "./sessions/shared/text.js";
import {
  buildCodexJsonExecArgs,
  enqueueRunnerInput,
  handleAppServerNotification,
  handleCodexJsonEvent,
  handleAppServerTurnResult,
  startAppServerTurn,
  startJsonExecRun
} from "./sessions/runners/codexRunner.js";

function normalizeName(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

export class SessionManager {
  constructor(config, { appServerBridge = null } = {}) {
    this.config = config;
    this.appServerBridge = appServerBridge;
    this.sessions = new Map();
    this.providers = new Map(buildProviders(config).map((provider) => [provider.id, provider]));
    this.historyService = new HistoricalSessionService(config);

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

  listHistoricalSessions({ archived = null } = {}) {
    return this.historyService.listHistoricalSessions(this.providers.values(), { archived });
  }

  listHistoricalSessionsForProvider(provider, { archived = null } = {}) {
    return this.historyService.listHistoricalSessionsForProvider(provider, { archived });
  }

  listAll() {
    const liveSessions = this.listLiveSessions();
    const liveByResumeId = new Set(
      liveSessions.map((session) => this.resumeKey(session.provider, session.resumeSessionId)).filter(Boolean)
    );
    const historySessions = this.listHistoricalSessions({ archived: false }).filter((session) => {
      return !liveByResumeId.has(this.resumeKey(session.provider, session.resumeSessionId));
    });
    return [...liveSessions, ...historySessions].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
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
        queuedTurnIds: [],
        conversationState: createConversationState({
          sessionId: id,
          threadId: String(resumeSessionId || "").trim(),
          status: "idle"
        }),
        currentTurnId: "",
        sessionType: "main",
        parentThreadId: "",
        agentRole: "",
        agentNickname: "",
        turnSequence: 0
      };
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
      resumeSessionId: String(resumeSessionId || "").trim() || null,
      resumeBootstrapComplete: !String(resumeSessionId || "").trim(),
      pendingResumeInput: "",
      model: String(model || "").trim() || resolvedProvider.defaultModel || "",
      titleSource: String(name || "").trim() ? "user_provided" : "auto_generated",
      conversationState: createConversationState({
        sessionId: id,
        threadId: String(resumeSessionId || "").trim(),
        status: "idle"
      }),
      currentTurnId: "",
      queuedTurnIds: [],
      sessionType: "main",
      parentThreadId: "",
      agentRole: "",
      agentNickname: "",
      turnSequence: 0
    };

    registerPtySessionHandlers(this, session, shell);

    this.seedConversationStateFromHistory(session, resolvedProvider);
    this.sessions.set(id, session);
    return this.serialize(session);
  }

  pushSessionBuffer(session, text = "") {
    pushSessionBuffer(session, text, this.config);
  }

  broadcast(session, payload) {
    broadcast(session, payload);
  }

  attachClient(id, ws) {
    attachClient(this, id, ws);
  }

  ensureConversationState(session, { status = "" } = {}) {
    if (!session) {
      return createConversationState();
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

  seedConversationStateFromHistory(session, provider = null) {
    if (!session?.resumeSessionId) {
      this.ensureConversationState(session);
      return;
    }
    if ((session.conversationState?.turns || []).length > 0) {
      this.ensureConversationState(session);
      return;
    }
    const resolvedProvider = provider || this.getProvider(session.provider);
    try {
      const historical = this.historyService.getHistoricalMessages(resolvedProvider, session.resumeSessionId);
      const hasRecoveredTurns = Array.isArray(historical?.turns) && historical.turns.length > 0;
      const hasRecoveredAgents = Array.isArray(historical?.backgroundAgents) && historical.backgroundAgents.length > 0;
      session.conversationState = buildConversationStateFromHistory(historical, {
        sessionId: String(session.id || ""),
        threadId: String(session.resumeSessionId || ""),
        status: hasRecoveredTurns || hasRecoveredAgents ? "completed" : "idle",
        updatedAt: session.updatedAt || nowIso()
      });
    } catch {
      this.ensureConversationState(session);
    }
  }

  applyConversationDeltas(session, deltas = [], { broadcast: shouldBroadcast = true } = {}) {
    if (!session) {
      return [];
    }
    const current = this.ensureConversationState(session);
    const prepared = (Array.isArray(deltas) ? deltas : [])
      .filter((delta) => delta && typeof delta === "object")
      .filter((delta) => String(delta.kind || "").trim().length > 0)
      .map((delta) => ({
        ...delta,
        sessionId: String(delta.sessionId || session.id || current.sessionId || ""),
        threadId: String(delta.threadId || session.resumeSessionId || current.threadId || ""),
        timestamp: delta.timestamp || nowIso()
      }));
    if (!prepared.length) {
      return [];
    }
    const appliedResult = applyConversationDeltaBatch(current, prepared);
    session.conversationState = appliedResult.state;
    if (shouldBroadcast) {
      this.broadcastConversationDelta(session, appliedResult.applied);
    }
    return appliedResult.applied.map((entry) => entry.delta);
  }

  createConversationTurn(session, userText, timestamp = nowIso()) {
    if (!session) {
      return null;
    }
    session.turnSequence = Math.max(0, Number(session.turnSequence) || 0) + 1;
    const suffix = typeof crypto.randomUUID === "function" ? crypto.randomUUID().slice(0, 8) : String(Date.now());
    const turnId = `${session.id}-turn-${Date.now()}-${session.turnSequence}-${suffix}`;
    session.currentTurnId = turnId;
    this.applyConversationDeltas(session, [createTurnCreatedDelta(turnId, userText, timestamp)]);
    return turnId;
  }

  applyConversationRecord(session, record, { turnId = session?.currentTurnId || session?.conversationState?.activeTurnId || "" } = {}) {
    if (!session || !turnId) {
      return [];
    }
    const deltas = normalizeRecordToDeltas(record, { turnId });
    if (!deltas.length) {
      return [];
    }
    return this.applyConversationDeltas(session, deltas);
  }

  finalizeConversationTurn(session, status = "completed", timestamp = nowIso()) {
    const targetTurnId = String(session?.currentTurnId || session?.conversationState?.activeTurnId || "");
    if (!targetTurnId) {
      return;
    }
    this.applyConversationDeltas(session, [createTurnCompletedDelta(targetTurnId, status, timestamp)]);
    session.currentTurnId = "";
  }

  updateConversationTurnStatus(session, status = "running", timestamp = nowIso()) {
    const targetTurnId = String(session?.currentTurnId || session?.conversationState?.activeTurnId || "");
    if (!targetTurnId) {
      return;
    }
    this.applyConversationDeltas(session, [createTurnStatusDelta(targetTurnId, status, timestamp)]);
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
        const current = this.ensureConversationState(live);
        const incoming = createConversationState({
          ...(historical?.conversation || {}),
          sessionId: current.sessionId,
          threadId: current.threadId || resumeSessionId
        });
        const shouldReplace =
          Number(incoming.version || 0) > Number(current.version || 0) ||
          (incoming.turns?.length || 0) > (current.turns?.length || 0);
        if (!shouldReplace) {
          return;
        }
        live.conversationState = incoming;
        live.updatedAt = nowIso();
        this.broadcastConversationSnapshot(live);
      }, waitMs).unref?.();
    }
  }

  broadcastConversationSnapshot(session) {
    if (!session) {
      return;
    }
    this.ensureConversationState(session);
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
    this.ensureConversationState(session);
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

  getConversationSnapshot(id) {
    const session = this.get(id);
    if (!session) {
      return null;
    }
    this.ensureConversationState(session);
    return buildConversationSnapshotPayload(session, this.serialize(session));
  }

  getHistoricalMessages(providerId, resumeSessionId) {
    const provider = this.getProvider(providerId);
    const historical = this.historyService.getHistoricalMessages(provider, resumeSessionId);
    const liveSession = [...this.sessions.values()]
      .filter(
        (session) =>
          session.provider === provider.id &&
          session.status !== "exited" &&
          String(session.resumeSessionId || "").trim() === String(resumeSessionId || "").trim()
      )
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))[0];
    if (!liveSession?.conversationState) {
      return historical;
    }

    const liveConversation = this.ensureConversationState(liveSession);
    const historicalConversation = historical?.conversation || createConversationState({
      threadId: String(resumeSessionId || "")
    });
    const liveTurns = Array.isArray(liveConversation.turns) ? liveConversation.turns : [];
    const historicalTurns = Array.isArray(historicalConversation.turns) ? historicalConversation.turns : [];
    const contentComparison = compareConversationContent(liveConversation, historicalConversation);
    const sameContent = contentComparison === 0;
    const shouldPreferLive =
      liveTurns.length > historicalTurns.length ||
      contentComparison > 0 ||
      (sameContent && Number(liveConversation.version || 0) > Number(historicalConversation.version || 0));

    if (!shouldPreferLive) {
      return historical;
    }

    return {
      ...historical,
      turns: liveTurns,
      backgroundAgents: Array.isArray(liveConversation.backgroundAgents) ? liveConversation.backgroundAgents : [],
      conversation: createConversationState({
        ...liveConversation,
        sessionId: historical?.session?.id || historicalConversation.sessionId || "",
        threadId: String(resumeSessionId || liveConversation.threadId || "")
      })
    };
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
      name: session.autoNamed ? "" : session.name,
      model: session.model || ""
    });
  }
}
