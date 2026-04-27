import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import pty from "node-pty";

import { HistoricalSessionService } from "./sessions/history/HistoricalSessionService.js";
import { CodexSidebarService } from "./sessions/history/CodexSidebarService.js";
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
  buildConversationStateFromThreadSnapshot,
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

function normalizeComparablePath(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  try {
    return path.resolve(text);
  } catch {
    return text;
  }
}

function isSubpathOf(targetPath, rootPath) {
  const target = normalizeComparablePath(targetPath);
  const root = normalizeComparablePath(rootPath);
  if (!target || !root) {
    return false;
  }
  if (target === root) {
    return true;
  }
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function bestProjectRootForCwd(cwd, projectRoots) {
  const matches = projectRoots.filter((rootPath) => isSubpathOf(cwd, rootPath));
  return matches.sort((left, right) => right.length - left.length)[0] || "";
}

function byUpdatedAtDesc(left, right) {
  return String(right?.updatedAt || "").localeCompare(String(left?.updatedAt || ""));
}

function isManuallyNamedSession(session) {
  const titleSource = String(session?.titleSource || "").trim().toLowerCase();
  return titleSource === "custom_name" || titleSource === "user_provided";
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
    const historySessions = this.listHistoricalSessions({ archived: false });
    return [...liveSessions, ...historySessions].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  listArchived() {
    return this.listHistoricalSessions({ archived: true });
  }

  listProjectGroups() {
    const baseGroups = this.codexSidebarService.listProjectGroups();
    if (!baseGroups.length) {
      return [];
    }

    const groups = baseGroups.map((group) => ({
      ...group,
      sessions: Array.isArray(group.sessions) ? [...group.sessions] : []
    }));
    const projectRoots = groups.map((group) => String(group.projectRoot || group.cwd || "").trim()).filter(Boolean);
    const groupsByRoot = new Map(groups.map((group) => [String(group.projectRoot || group.cwd || "").trim(), group]));

    for (const session of this.listLiveSessions()) {
      const projectRoot = bestProjectRootForCwd(session.cwd, projectRoots);
      if (!projectRoot) {
        continue;
      }
      const group = groupsByRoot.get(projectRoot);
      if (!group) {
        continue;
      }
      group.sessions.push(session);
    }

    for (const group of groups) {
      const deduped = new Map();
      for (const session of group.sessions) {
        const identity = `${String(session.provider || "codex").trim()}:${String(
          session.resumeSessionId || session.threadId || session.id || ""
        ).trim()}`;
        const existing = deduped.get(identity);
        if (!existing || byUpdatedAtDesc(session, existing) < 0) {
          deduped.set(identity, session);
        }
      }
      group.sessions = [...deduped.values()].sort(byUpdatedAtDesc);
    }

    return groups.sort((left, right) => byUpdatedAtDesc(left.sessions[0], right.sessions[0]));
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

  ensureLiveSessionForThread(threadId, { providerId = "", cwd = "", model = "", name = "" } = {}) {
    const targetThreadId = String(threadId || "").trim();
    if (!targetThreadId) {
      throw new Error("threadId is required");
    }

    const resolvedProvider = this.resolveProviderForThread(targetThreadId, providerId);
    const existing =
      this.findLiveSessionByThreadId(targetThreadId, { providerId: resolvedProvider.id }) ||
      this.findLiveSessionByThreadId(targetThreadId);
    if (existing) {
      return existing;
    }

    const created = this.create({
      provider: resolvedProvider.id,
      cwd,
      model,
      name,
      resumeSessionId: targetThreadId
    });
    return this.get(created.id);
  }

  create({ cwd = "", name = "", resumeSessionId = "", provider = "codex", model = "" } = {}) {
    const resolvedProvider = this.getProvider(provider);
    const id = crypto.randomUUID();
    const resolvedCwd = this.resolveCwd(cwd);
    const fallbackName = `${resolvedProvider.fallbackPrefix}-${this.sessions.size + 1}`;
    const sessionName =
      resolvedProvider.id === "codex" && !String(name || "").trim()
        ? ""
        : normalizeName(name, fallbackName);
    const spawnSpec = resolvedProvider.buildSpawnSpec({
      resumeSessionId: String(resumeSessionId || "").trim() || null,
      name: sessionName,
      model: String(model || "").trim()
    });

    if (resolvedProvider.id === "codex") {
      // App-server bridge does not yet provide a reliable resumed-thread turn lifecycle
      // (notifications can stall after userMessage without a terminal turn event), so
      // thread continuation must stay on the stable json_exec runner until the adapter
      // contract is completed end-to-end.
      const preferAppServer = Boolean(
        this.config.codexAppServerEnabled &&
          this.appServerBridge &&
          !String(resumeSessionId || "").trim()
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
        threadSnapshot: null,
        liveOverlay: null,
        threadCanonicalizerState: createCanonicalizerState(),
        threadProjection: null,
        currentTurnId: "",
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
      threadSnapshot: null,
      liveOverlay: null,
      threadCanonicalizerState: createCanonicalizerState(),
      threadProjection: null,
      currentTurnId: "",
      queuedTurnIds: [],
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
    this.syncConversationStateFromThreadSnapshot(session);
    if (shouldBroadcast) {
      this.broadcastConversationSnapshot(session);
    }
    return [];
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

  createConversationTurn(session, userText, timestamp = nowIso()) {
    if (!session) {
      return null;
    }
    session.turnSequence = Math.max(0, Number(session.turnSequence) || 0) + 1;
    const suffix = typeof crypto.randomUUID === "function" ? crypto.randomUUID().slice(0, 8) : String(Date.now());
    const turnId = `${session.id}-turn-${Date.now()}-${session.turnSequence}-${suffix}`;
    session.currentTurnId = turnId;
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

  applyConversationRecord(session, record, { turnId = session?.currentTurnId || session?.threadSnapshot?.activeTurnId || session?.conversationState?.activeTurnId || "" } = {}) {
    if (!session || !turnId) {
      return [];
    }
    const previous = createConversationState(session.conversationState);
    this.applyThreadRawRecord(session, record, { turnId });
    this.broadcastDerivedConversationDelta(session, previous);
    this.broadcastConversationSnapshot(session);
    return [];
  }

  finalizeConversationTurn(session, status = "completed", timestamp = nowIso()) {
    const targetTurnId = String(session?.currentTurnId || session?.threadSnapshot?.activeTurnId || session?.conversationState?.activeTurnId || "");
    if (!targetTurnId) {
      return;
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
    session.currentTurnId = "";
    this.broadcastDerivedConversationDelta(session, previous);
    this.broadcastConversationSnapshot(session);
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
        const shouldReplace =
          Number(incomingSnapshot?.lastEventSeq || 0) > Number(currentSnapshot?.lastEventSeq || 0) ||
          Number(incomingSnapshot?.version || 0) > Number(currentSnapshot?.version || 0);
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
    let historical = null;
    try {
      historical = this.historyService.getHistoricalMessages(provider, resumeSessionId);
    } catch {
      historical = null;
    }
    return {
      session: historical?.session || null,
      threadSnapshot: historical?.threadSnapshot || null,
      liveOverlay: historical?.liveOverlay || null,
      conversation: historical?.conversation || null,
      conversationSnapshot: historical?.conversationSnapshot || null
    };
  }

  getLiveHistoryContinuation(providerId, resumeSessionId) {
    const provider = this.getProvider(providerId);
    const targetResumeId = String(resumeSessionId || "").trim();
    if (!targetResumeId) {
      return null;
    }
    const liveSession = [...this.sessions.values()]
      .filter(
        (session) =>
          session.provider === provider.id &&
          session.status !== "exited" &&
          String(session.resumeSessionId || "").trim() === targetResumeId
      )
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))[0];
    if (!liveSession) {
      return null;
    }
    let baseSnapshot = null;
    try {
      baseSnapshot = this.historyService.getHistoricalMessages(provider, targetResumeId)?.threadSnapshot || null;
    } catch {
      baseSnapshot = null;
    }
    const currentSnapshot = this.ensureThreadSnapshot(liveSession);
    const currentConversation = this.ensureConversationState(liveSession);
    buildThreadProjection(liveSession);
    const mergedSnapshot =
      (currentSnapshot?.turns?.length || 0) >= (currentConversation?.turns?.length || 0)
        ? currentSnapshot
        : deriveThreadSnapshotFromConversationState(currentConversation, {
            threadId: targetResumeId,
            metadata: currentSnapshot?.metadata || baseSnapshot?.metadata || {},
            baseSnapshot: baseSnapshot || currentSnapshot || null
          });
    liveSession.threadSnapshot = mergedSnapshot;
    syncProjectedThreadState(liveSession, { previousSnapshot: mergedSnapshot });
    return {
      session: this.serialize(liveSession),
      conversation: currentConversation,
      threadSnapshot: mergedSnapshot,
      liveOverlay: liveSession.liveOverlay || null
    };
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
      model: session.model || ""
    });
  }
}
