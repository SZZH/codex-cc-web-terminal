import { hydrateHistoricalSession } from "./history-session-cache.js";
import { decorateSession, mergeSessionTitlesIntoCache, parseHistoryRouteSessionId } from "./session-list.js";
import { createConversationState, buildConversationStateFromPayload } from "./conversation-timeline.js";
import { buildSessionCreateRequest } from "./composer.js";
import { shouldSyncPersistedThread } from "./thread-display-state.js";

function toOriginProtocol(proto) {
  return String(proto || "").toLowerCase() === "https:" ? "https:" : "http:";
}

function toWsProtocol(proto) {
  return String(proto || "").toLowerCase() === "https:" ? "wss:" : "ws:";
}

function normalizeBackendHost(rawHost) {
  const host = String(rawHost || "").trim();
  if (!host || host === "0.0.0.0" || host === "::") {
    return window.location.hostname || "localhost";
  }
  if (host === "::1") {
    return "localhost";
  }
  return host;
}

export function createSessionRuntimeController({
  state,
  route,
  router,
  composerOptions,
  sessionCache,
  pendingHydrations,
  historyApiAvailable,
  request,
  requestHistoryMessages,
  requestSessionById,
  requestThreadComposerState,
  setStatus,
  wait,
  getActiveThreadId,
  getExpectedThreadId,
  getInteractiveThreadId,
  getRouteHistoryTarget,
  getPreferredThreadSnapshot,
  resetComposerDraftState,
  resetLiveView,
  resetThreadView,
  closeSocket,
  finalizeAssistantStream,
  discardPendingAssistantStream,
  clearAuthoritativeThreadSnapshot,
  setConversation,
  setThreadSnapshot,
  setLiveOverlay,
  attachLiveSocket,
  syncComposerStateForThread,
  applyHistoricalComposerValues
} = {}) {
  let historySyncTimer = null;
  let syncingRouteOpen = false;

  async function hydrateSession(session, { includeMessages = false, silent = false, forceRefresh = false } = {}) {
    return hydrateHistoricalSession(session, {
      includeMessages,
      silent,
      forceRefresh,
      sessionCache,
      pendingHydrations,
      historyApiAvailable,
      requestHistoryMessages,
      onError: (error) => {
        setStatus(error?.message || String(error));
      }
    });
  }

  async function refreshSessions() {
    const payload = await request("/api/sessions");
    const sessions = payload.sessions || [];
    const projectGroups = payload.projectGroups || [];
    mergeSessionTitlesIntoCache(sessions, sessionCache);
    state.sessions = sessions;
    state.projectGroups = projectGroups;
  }

  function stopHistorySyncLoop() {
    if (historySyncTimer) {
      window.clearInterval(historySyncTimer);
      historySyncTimer = null;
    }
  }

  function currentThreadSyncTarget() {
    if (
      !shouldSyncPersistedThread({
        routeThreadId: String(getRouteHistoryTarget()?.resumeSessionId || "").trim(),
        threadMeta: state.threadView.meta,
        liveSessionId: state.liveView.liveSessionId,
        liveSessionMeta: state.liveView.sessionMeta,
        hasAuthoritativeLiveData: Boolean(state.liveView.hasConversationSnapshot || state.liveView.hasConversationDelta)
      })
    ) {
      return null;
    }
    const routeTarget = getRouteHistoryTarget();
    if (routeTarget) {
      return {
        id: `thread:${routeTarget.provider}:${routeTarget.resumeSessionId}`,
        kind: "thread",
        status: "saved",
        provider: routeTarget.provider,
        resumeSessionId: routeTarget.resumeSessionId,
        name: state.threadView.meta?.name || "会话",
        cwd: state.threadView.meta?.cwd || ""
      };
    }
    if (state.threadView.meta?.resumeSessionId) {
      return state.threadView.meta;
    }
    return null;
  }

  async function syncActiveThreadSession({ silent = true } = {}) {
    const target = currentThreadSyncTarget();
    if (!target?.resumeSessionId) {
      return false;
    }

    const hydrated = await hydrateSession(target, {
      includeMessages: true,
      forceRefresh: true,
      silent
    });
    if (!hydrated) {
      return false;
    }

    const nextThreadSnapshot = hydrated.threadSnapshot || null;
    const applied = JSON.stringify(state.threadView.persistedSnapshot || null) !== JSON.stringify(nextThreadSnapshot || null);
    if (applied) {
      setThreadSnapshot(nextThreadSnapshot);
    }
    if (state.threadView.meta && target.resumeSessionId === state.threadView.meta.resumeSessionId) {
      state.threadView.meta = {
        ...state.threadView.meta,
        displayTitle: hydrated.title || state.threadView.meta.displayTitle,
        displayPreview: hydrated.preview || state.threadView.meta.displayPreview,
        cwd: hydrated?.session?.cwd || state.threadView.meta.cwd || ""
      };
    }
    return applied;
  }

  function startHistorySyncLoop() {
    stopHistorySyncLoop();
    if (typeof window === "undefined") {
      return;
    }
    historySyncTimer = window.setInterval(() => {
      if (!state.ready || !state.isAuthenticated || route.name !== "chat") {
        return;
      }
      if (!currentThreadSyncTarget()) {
        return;
      }
      syncActiveThreadSession({ silent: true }).catch(() => {});
    }, 4000);
  }

  function applyBackendConfig(payload) {
    const host = normalizeBackendHost(payload?.host);
    const port = Number(payload?.port || 0);
    if (!host || !port) {
      return;
    }
    const httpProtocol = toOriginProtocol(window.location.protocol);
    const wsProtocol = toWsProtocol(window.location.protocol);
    state.backendHttpOrigin = `${httpProtocol}//${host}:${port}`;
    state.backendWsOrigin = `${wsProtocol}//${host}:${port}`;
  }

  async function bootstrapWorkspace({ includeSessions = true } = {}) {
    const configPayload = await request("/api/config");
    applyBackendConfig(configPayload);
    state.providerCatalog = Array.isArray(configPayload?.providers) ? configPayload.providers : [];
    state.codexDefaults = {
      model: String(configPayload?.codexDefaults?.model || "").trim(),
      reasoningEffort: String(configPayload?.codexDefaults?.reasoningEffort || "medium").trim() || "medium",
      permissionMode: String(configPayload?.codexDefaults?.permissionMode || "default").trim() || "default"
    };
    state.defaultProvider = String(configPayload?.defaultProvider || "codex").trim().toLowerCase() || "codex";
    if (!composerOptions.value.model && !composerOptions.value.attachments.length) {
      composerOptions.value = {
        ...composerOptions.value,
        ...state.codexDefaults
      };
    }
    if (includeSessions) {
      await refreshSessions();
    }
  }

  async function openLiveSession(session, { skipRoute = false } = {}) {
    stopHistorySyncLoop();
    state.pendingSessionId = session.id;
    setStatus("正在连接会话…");
    state.routeSessionId = session.id;
    const decorated = decorateSession(session);
    state.liveView.sessionId = session.id;
    state.liveView.sessionMeta = decorated;
    if (session.resumeSessionId) {
      clearAuthoritativeThreadSnapshot();
      state.threadView.threadId = String(session.resumeSessionId || "").trim();
      state.threadView.meta = {
        ...decorated,
        kind: "thread",
        id: `history:${session.provider}:${session.resumeSessionId}`
      };
      state.threadView.sessionId = `history:${session.provider}:${session.resumeSessionId}`;
    } else {
      resetThreadView();
      setThreadSnapshot(null);
    }
    state.liveView.openToken += 1;
    if (!skipRoute && (route.name !== "chat" || String(route.params.sessionId || "").trim() !== session.id)) {
      await router.push({ name: "chat", params: { sessionId: session.id } });
    }
    resetComposerDraftState({ keepOptions: false });
    state.liveView.replayGuardActive = false;
    state.liveView.replayGuardPrompt = "";
    state.liveView.replayGuardUntil = 0;
    await bootstrapWorkspace({ includeSessions: false });

    let historyTurns = [];
    let historyAgents = [];
    let historyThreadSnapshot = null;
    let historyLiveOverlay = null;
    let historyConversation = createConversationState({
      sessionId: session.id,
      threadId: String(session.resumeSessionId || "")
    });
    if (session.resumeSessionId) {
      const composerStateSynced = await syncComposerStateForThread(session.provider, session.resumeSessionId, { silent: true });
      const hydrated = await hydrateSession(
        {
          ...session,
          id: `thread:${session.provider}:${session.resumeSessionId}`,
          kind: "thread",
          status: "saved"
        },
        { includeMessages: true, silent: true, forceRefresh: true }
      );
      historyTurns = hydrated?.turns || [];
      historyAgents = hydrated?.backgroundAgents || [];
      historyConversation = buildConversationStateFromPayload(hydrated?.conversation || {}, {
        sessionId: session.id,
        threadId: String(session.resumeSessionId || ""),
        turns: historyTurns,
        backgroundAgents: historyAgents
      });
      historyThreadSnapshot = hydrated?.threadSnapshot || null;
      historyLiveOverlay = hydrated?.liveOverlay || null;
      if (!composerStateSynced) {
        applyHistoricalComposerValues(hydrated?.session || null, historyThreadSnapshot);
      }
      if (hydrated?.session) {
        state.liveView.sessionMeta = {
          ...state.liveView.sessionMeta,
          displayTitle: hydrated.title || state.liveView.sessionMeta.displayTitle,
          displayPreview: hydrated.preview || state.liveView.sessionMeta.displayPreview,
          cwd: hydrated.session.cwd || state.liveView.sessionMeta.cwd || ""
        };
      }
    }
    setConversation(historyConversation, { force: true });
    setThreadSnapshot(historyThreadSnapshot);
    setLiveOverlay(historyLiveOverlay);
    await attachLiveSocket(session.id);
    setStatus("");
    state.pendingSessionId = "";
  }

  async function openThreadSession(session, { skipRoute = false } = {}) {
    stopHistorySyncLoop();
    state.pendingSessionId = session.id;
    setStatus("正在加载会话…");
    const decorated = decorateSession(session);
    const hydrated = await hydrateSession(session, { includeMessages: true, forceRefresh: true });
    const historyThreadSnapshot = hydrated?.threadSnapshot || null;
    const targetThreadId = String(session.resumeSessionId || "").trim();
    const keepInteractiveState = targetThreadId && getInteractiveThreadId() === targetThreadId;

    if (!keepInteractiveState) {
      closeSocket();
      finalizeAssistantStream();
      resetLiveView();
      clearAuthoritativeThreadSnapshot();
    }

    state.routeSessionId = session.id;
    state.threadView.sessionId = session.id;
    state.threadView.threadId = targetThreadId;
    state.threadView.meta = {
      ...decorated,
      kind: "thread",
      cwd: hydrated?.session?.cwd || decorated.cwd || "",
      displayTitle: hydrated?.title || decorated.displayTitle,
      displayPreview: hydrated?.preview || decorated.displayPreview
    };
    state.threadView.openToken += 1;
    if (!skipRoute && (route.name !== "chat" || String(route.params.sessionId || "").trim() !== session.id)) {
      await router.push({ name: "chat", params: { sessionId: session.id } });
    }
    resetComposerDraftState({ keepOptions: false });
    const composerStateSynced = await syncComposerStateForThread(session.provider, targetThreadId, { silent: true });
    if (!composerStateSynced) {
      applyHistoricalComposerValues(hydrated?.session || null, historyThreadSnapshot);
    }
    setThreadSnapshot(historyThreadSnapshot);
    if (!keepInteractiveState) {
      startHistorySyncLoop();
      setLiveOverlay(null);
    }
    setStatus("");
    state.pendingSessionId = "";
  }

  async function openSessionItem(session, { skipRoute = false } = {}) {
    try {
      if (session?.resumeSessionId) {
        await openThreadSession(
          {
            ...decorateSession(session),
            id: `history:${session.provider}:${session.resumeSessionId}`,
            kind: "thread",
            status: session.status || "saved"
          },
          { skipRoute }
        );
        return;
      }
      await openLiveSession(session, { skipRoute });
    } catch (error) {
      if (session.kind === "live" && session.resumeSessionId) {
        try {
          await openThreadSession(
            {
              ...session,
              id: `history:${session.provider}:${session.resumeSessionId}`,
              kind: "thread",
              status: "saved"
            },
            { skipRoute }
          );
          setStatus("已切换到该会话的历史记录。");
          return;
        } catch {
          // Fall through to the original error below.
        }
      }
      state.pendingSessionId = "";
      setStatus(error.message || String(error));
    }
  }

  async function createSessionInGroup(group) {
    const cwd = String(group?.cwd || "").trim();
    if (!cwd) {
      setStatus("该分组目录不可用，无法新增会话。");
      return;
    }

    try {
      state.pendingSessionId = "__creating__";
      setStatus("正在创建会话…");
      const payload = await request("/api/sessions", {
        method: "POST",
        body: JSON.stringify(
          buildSessionCreateRequest({
            provider: "codex",
            cwd,
            composerOptions: composerOptions.value
          })
        )
      });
      await refreshSessions();
      if (payload?.session) {
        await openSessionItem(payload.session);
        return;
      }
      setStatus("会话已创建，请手动打开。");
    } catch (error) {
      setStatus(error?.message || String(error));
    } finally {
      if (state.pendingSessionId === "__creating__") {
        state.pendingSessionId = "";
      }
    }
  }

  async function ensureLiveSession() {
    if (state.liveView.liveSessionId) {
      return state.liveView.liveSessionId;
    }
    if (!state.liveView.sessionMeta) {
      const preferredThreadSnapshot = getPreferredThreadSnapshot();
      const routeHistoryTarget = getRouteHistoryTarget();
      const continuationSeed =
        state.threadView.meta ||
        (routeHistoryTarget
          ? {
              id: `history:${routeHistoryTarget.provider}:${routeHistoryTarget.resumeSessionId}`,
              kind: "thread",
              provider: routeHistoryTarget.provider,
              providerLabel: "Codex",
              resumeSessionId: routeHistoryTarget.resumeSessionId,
              cwd: preferredThreadSnapshot?.metadata?.cwd || "",
              displayTitle: String(preferredThreadSnapshot?.metadata?.name || "").trim() || "会话",
              displayPreview: String(preferredThreadSnapshot?.metadata?.preview || "").trim() || ""
            }
          : null);
      if (continuationSeed?.resumeSessionId) {
        state.liveView.sessionMeta = {
          ...continuationSeed,
          kind: "thread"
        };
      }
    }
    if (!state.liveView.sessionMeta) {
      throw new Error("当前没有可继续的会话");
    }
    if (state.liveView.sessionMeta.kind === "live") {
      state.liveView.sessionId = state.liveView.sessionMeta.id;
      state.liveView.liveSessionId = state.liveView.sessionMeta.id;
      return state.liveView.sessionMeta.id;
    }

    const resumeSessionId = String(state.liveView.sessionMeta.resumeSessionId || "").trim();
    const provider = String(state.liveView.sessionMeta.provider || "").trim().toLowerCase();
    if (resumeSessionId && provider) {
      const reusable = state.sessions
        .filter(
          (session) =>
            session.kind === "live" &&
            session.status !== "exited" &&
            String(session.provider || "").trim().toLowerCase() === provider &&
            String(session.resumeSessionId || "").trim() === resumeSessionId
        )
        .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))[0];
      if (reusable) {
        state.liveView.sessionMeta = decorateSession(reusable);
        state.liveView.sessionId = reusable.id;
        state.liveView.liveSessionId = reusable.id;
        stopHistorySyncLoop();
        return reusable.id;
      }
    }

    const resumed = await request("/api/sessions", {
      method: "POST",
      body: JSON.stringify(
        buildSessionCreateRequest({
          provider: state.liveView.sessionMeta.provider,
          cwd: state.liveView.sessionMeta.cwd,
          name: state.liveView.sessionMeta.displayTitle || state.liveView.sessionMeta.name,
          resumeSessionId: state.liveView.sessionMeta.resumeSessionId,
          composerOptions: composerOptions.value
        })
      )
    });

    state.liveView.sessionMeta = {
      ...state.liveView.sessionMeta,
      id: resumed.session.id,
      kind: "live",
      status: resumed.session.status,
      updatedAt: resumed.session.updatedAt
    };
    state.liveView.sessionId = resumed.session.id;
    state.liveView.liveSessionId = resumed.session.id;
    stopHistorySyncLoop();
    refreshSessions().catch(() => {});
    setStatus("正在恢复会话上下文…");
    state.liveView.replayGuardActive = true;
    state.liveView.replayGuardUntil = Date.now() + 20_000;
    await wait(1800);
    discardPendingAssistantStream();
    state.liveView.streamBuffer = "";
    return resumed.session.id;
  }

  async function backToList() {
    closeSocket();
    stopHistorySyncLoop();
    finalizeAssistantStream();
    state.routeSessionId = "";
    resetComposerDraftState();
    resetLiveView();
    resetThreadView();
    if (route.name !== "sessions") {
      await router.push({ name: "sessions" });
    }
    await refreshSessions();
  }

  async function syncRouteSession() {
    const ready = state.ready;
    const isAuthenticated = state.isAuthenticated;
    const routeName = route.name;
    const routeSessionId = route.params.sessionId;

    if (!ready) {
      return;
    }
    if (!isAuthenticated) {
      if (routeName !== "login") {
        const redirect = route.fullPath || "/sessions";
        await router.replace({ name: "login", query: { redirect } });
      }
      return;
    }
    if (routeName === "login") {
      const redirectPath = String(route.query.redirect || "").trim();
      if (redirectPath) {
        await router.replace(redirectPath);
      } else {
        await router.replace({ name: "sessions" });
      }
      return;
    }
    if (routeName !== "chat") {
      return;
    }

    const targetSessionId = String(routeSessionId || "").trim();
    if (!targetSessionId) {
      await router.replace({ name: "sessions" });
      return;
    }

    const historyTarget = parseHistoryRouteSessionId(targetSessionId);
    if (
      syncingRouteOpen ||
      (state.routeSessionId === targetSessionId &&
        (!historyTarget || Boolean(state.threadView.meta) || Boolean(state.liveView.liveSessionId)))
    ) {
      return;
    }

    if (historyTarget) {
      syncingRouteOpen = true;
      try {
        await openThreadSession(
          {
            id: targetSessionId,
            kind: "thread",
            status: "saved",
            provider: historyTarget.provider,
            resumeSessionId: historyTarget.resumeSessionId,
            name: "会话",
            cwd: state.liveView.sessionMeta?.cwd || state.threadView.meta?.cwd || ""
          },
          { skipRoute: true }
        );
      } finally {
        syncingRouteOpen = false;
      }
      return;
    }

    let session = state.sessions.find((item) => item.id === targetSessionId);
    if (!session) {
      try {
        const single = await requestSessionById(targetSessionId);
        if (single) {
          session = single;
        }
      } catch {
        // Keep existing state when single-session lookup fails.
      }
    }

    if (!session) {
      setStatus("会话 ID 已失效，无法定位历史记录。请使用 history:provider:resumeSessionId 形式的链接。");
      await router.replace({ name: "sessions" });
      return;
    }

    if (session.resumeSessionId) {
      const threadRouteId = `history:${session.provider}:${session.resumeSessionId}`;
      if (targetSessionId !== threadRouteId) {
        await router.replace({ name: "chat", params: { sessionId: threadRouteId } });
        return;
      }
    }

    syncingRouteOpen = true;
    try {
      await openSessionItem(session, { skipRoute: true });
    } finally {
      syncingRouteOpen = false;
    }
  }

  return {
    applyBackendConfig,
    bootstrapWorkspace,
    hydrateSession,
    refreshSessions,
    stopHistorySyncLoop,
    startHistorySyncLoop,
    currentThreadSyncTarget,
    syncActiveThreadSession,
    openLiveSession,
    openThreadSession,
    openSessionItem,
    createSessionInGroup,
    ensureLiveSession,
    backToList,
    syncRouteSession
  };
}
