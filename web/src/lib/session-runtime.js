import { hydrateHistoricalSession } from "./history-session-cache.js";
import { decorateSession, parseHistoryRouteSessionId } from "./session-list.js";
import { createSessionCatalogController } from "./session-catalog-runtime.js";
import { createConversationState, buildConversationStateFromPayload } from "./conversation-timeline.js";
import { buildSessionCreateRequest } from "./composer.js";
import { shouldSyncPersistedThread } from "./thread-display-state.js";

function isAwaitingInputStatus(statusText = "") {
  return statusText === "等待 Codex 回复…" || statusText === "正在发送…";
}

function isThreadSnapshotRunning(snapshot = null) {
  if (!snapshot || typeof snapshot !== "object") {
    return false;
  }
  if (String(snapshot.status || "").trim().toLowerCase() === "running") {
    return true;
  }
  if (String(snapshot.activeTurnId || "").trim()) {
    return true;
  }
  return (Array.isArray(snapshot.turns) ? snapshot.turns : []).some((turn) => {
    const status = String(turn?.status || turn?.assistant?.status || "").trim().toLowerCase();
    return status === "running" || status === "inprogress" || status === "in_progress";
  });
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
  getActiveProviderId,
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
  applyHistoricalComposerValues,
  pagedCatalog = false,
  now = Date.now
} = {}) {
  let historySyncTimer = null;
  let threadSyncInFlight = null;
  let activation = 0;
  let routeLookup = 0;
  let socketRecovery = null;
  let recoveryTimer = null;
  const { refreshSessions, startSessionListSyncLoop, stopSessionListSyncLoop, applyBackendConfig,
    requestWorkspaceConfig, invalidateWorkspaceBootstrap, bootstrapWorkspace,
    setSessionCatalogView, loadSessionCatalogGroup, loadMoreSessionCatalog } = createSessionCatalogController({
    state, route, request, composerOptions, sessionCache, getActiveProviderId, now, paged: pagedCatalog
  });

  function stopSocketRecovery() {
    if (recoveryTimer) window.clearTimeout(recoveryTimer);
    recoveryTimer = null;
    socketRecovery = null;
    state.liveView.recoveringSocket = false;
  }

  function invalidateActivation() {
    activation += 1;
    routeLookup += 1;
    state.loading = false;
    state.pendingSessionId = "";
    stopSocketRecovery();
    stopHistorySyncLoop();
  }

  function beginActivation(sessionId) {
    invalidateActivation();
    stopSessionListSyncLoop();
    state.pendingSessionId = sessionId;
    state.routeSessionId = sessionId;
    return activation;
  }

  function isActivationCurrent(token) {
    return token === activation;
  }

  async function hydrateSession(session, { includeMessages = false, silent = false, forceRefresh = false, strict = false } = {}) {
    const token = activation;
    let failure = null;
    const hydrated = await hydrateHistoricalSession(session, {
      includeMessages,
      silent: silent && !strict,
      forceRefresh,
      sessionCache,
      pendingHydrations,
      historyApiAvailable,
      requestHistoryMessages,
      onError: (error) => {
        failure = error;
        if (!silent && isActivationCurrent(token)) setStatus(error?.message || String(error));
      }
    });
    if (strict && failure) throw failure;
    return hydrated;
  }

  function stopHistorySyncLoop() {
    if (historySyncTimer) {
      window.clearInterval(historySyncTimer);
      historySyncTimer = null;
    }
  }

  function currentThreadSyncTarget({ force = false } = {}) {
    if (
      !shouldSyncPersistedThread({
        routeThreadId: String(getRouteHistoryTarget()?.resumeSessionId || "").trim(),
        threadMeta: state.threadView.meta,
        liveSessionId: state.liveView.liveSessionId,
        liveSessionMeta: state.liveView.sessionMeta,
        hasAuthoritativeLiveData: Boolean(state.liveView.hasConversationSnapshot || state.liveView.hasConversationDelta),
        forceSync: force || state.liveView.recoveringSocket || (!state.liveView.socket && state.liveView.activeInputStream) || isAwaitingInputStatus(state.statusText)
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

  async function syncActiveThreadSession({ silent = true, force = false, recover = false } = {}) {
    const target = currentThreadSyncTarget({ force });
    if (!target?.resumeSessionId) {
      return false;
    }
    const token = activation;
    const key = `${target.provider}:${target.resumeSessionId}`;
    if (threadSyncInFlight?.key === key && threadSyncInFlight.token === token) {
      await threadSyncInFlight.promise;
      return false;
    }
    const task = hydrateSession(target, {
      includeMessages: true,
      forceRefresh: true,
      silent,
      strict: recover
    });
    threadSyncInFlight = { key, token, promise: task };
    let hydrated;
    try {
      hydrated = await task;
    } finally {
      if (threadSyncInFlight?.promise === task) threadSyncInFlight = null;
    }
    const current = currentThreadSyncTarget({ force });
    if (!isActivationCurrent(token) || `${current?.provider}:${current?.resumeSessionId}` !== key) return false;
    if (!hydrated) {
      return false;
    }
    if (socketRecovery?.token === token && socketRecovery.threadId === target.resumeSessionId && socketRecovery.provider === target.provider) {
      socketRecovery.hydratedSession = hydrated.session || null;
    }

    const nextThreadSnapshot = hydrated.threadSnapshot || null;
    const applied = JSON.stringify(state.threadView.persistedSnapshot || null) !== JSON.stringify(nextThreadSnapshot || null);
    if (applied) {
      setThreadSnapshot(nextThreadSnapshot);
      if (isAwaitingInputStatus(state.statusText) && !isThreadSnapshotRunning(nextThreadSnapshot)) {
        setStatus("");
      }
    }
    if ((recover || state.liveView.recoveringSocket || !state.liveView.socket) && nextThreadSnapshot) {
      clearAuthoritativeThreadSnapshot();
      if (hydrated.conversation) setConversation(hydrated.conversation, { force: true });
      setLiveOverlay(null);
      const trackedTurnId = String(state.liveView.inputTurnId || "").trim();
      const trackedTurn = (nextThreadSnapshot.turns || []).find((turn) => !trackedTurnId || turn.id === trackedTurnId);
      if (trackedTurn && !isThreadSnapshotRunning(nextThreadSnapshot)) {
        state.liveView.activeInputStream = false;
        state.liveView.interruptInFlight = false;
        state.loading = false;
        if (isAwaitingInputStatus(state.statusText) || String(state.statusText || "").startsWith("连接已断开")) setStatus("");
      }
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

  function recoverLiveSession(sessionId) {
    if (state.liveView.liveSessionId !== sessionId || route.name !== "chat") return;
    if (socketRecovery?.token === activation && socketRecovery.sessionId === sessionId) return;
    stopSocketRecovery();
    const target = getRouteHistoryTarget() || state.threadView.meta || state.liveView.sessionMeta || {};
    const recovery = { token: activation, sessionId, attempts: 0,
      threadId: String(target.resumeSessionId || state.threadView.threadId || "").trim(),
      provider: String(target.provider || state.liveView.sessionMeta?.provider || "codex").trim().toLowerCase(), hydratedSession: null };
    socketRecovery = recovery;
    const isCurrent = () => {
      const current = getRouteHistoryTarget() || state.threadView.meta || state.liveView.sessionMeta || {};
      return socketRecovery === recovery && isActivationCurrent(recovery.token) && state.liveView.liveSessionId === recovery.sessionId && route.name === "chat" &&
        String(current.resumeSessionId || state.threadView.threadId || "").trim() === recovery.threadId &&
        String(current.provider || state.liveView.sessionMeta?.provider || "codex").trim().toLowerCase() === recovery.provider;
    };
    const matchesThread = (session) => session?.kind === "live" && session.id &&
      String(session.resumeSessionId || "").trim() === recovery.threadId &&
      String(session.provider || "").trim().toLowerCase() === recovery.provider;
    function rebindSession(session) {
      if (!isCurrent() || !matchesThread(session)) return false;
      closeSocket({ silent: true });
      recovery.sessionId = session.id;
      state.liveView.sessionId = session.id;
      state.liveView.liveSessionId = session.id;
      state.liveView.sessionMeta = decorateSession(session);
      return true;
    }
    async function resolveRecoverySession() {
      if (matchesThread(recovery.hydratedSession) && recovery.hydratedSession.id !== recovery.sessionId) {
        rebindSession(recovery.hydratedSession);
        return;
      }
      if (!requestSessionById) return;
      try {
        await requestSessionById(recovery.sessionId);
      } catch (error) {
        if (!isCurrent() || error?.status !== 404 || !recovery.threadId) throw error;
        if (matchesThread(recovery.hydratedSession) && recovery.hydratedSession.id !== recovery.sessionId) {
          rebindSession(recovery.hydratedSession);
          return;
        }
        const payload = await request("/api/sessions", {
          method: "POST",
          body: JSON.stringify({ provider: recovery.provider, resumeSessionId: recovery.threadId,
            cwd: String(state.threadView.meta?.cwd || state.liveView.sessionMeta?.cwd || "").trim() })
        });
        if (!isCurrent()) return;
        if (!rebindSession(payload?.session)) throw new Error("恢复会话返回了不匹配的线程。");
      }
    }
    state.liveView.recoveringSocket = true;
    state.liveView.hasConversationSnapshot = false;
    state.liveView.hasConversationDelta = false;
    state.liveView.hasReducerConversationDelta = false;
    setStatus("连接已断开，正在恢复…");
    startHistorySyncLoop();
    syncActiveThreadSession({ silent: true, force: true, recover: true }).catch(() => {});
    async function reconnect() {
      recoveryTimer = null;
      if (!isCurrent()) return;
      recovery.attempts += 1;
      try {
        await resolveRecoverySession();
        if (!isCurrent()) return;
        await attachLiveSocket(recovery.sessionId);
        if (!isCurrent()) return;
        await syncActiveThreadSession({ silent: true, force: true, recover: true });
        if (!isCurrent()) return;
        stopSocketRecovery();
        if (String(state.statusText || "").startsWith("连接已断开")) setStatus("");
      } catch {
        if (!isCurrent()) return;
        closeSocket({ silent: true });
        recoveryTimer = window.setTimeout(reconnect, Math.min(1000 * recovery.attempts, 10_000));
      }
    }
    recoveryTimer = window.setTimeout(reconnect, 500);
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

  async function openLiveSession(session, { skipRoute = false } = {}) {
    const token = beginActivation(session.id);
    closeSocket?.({ silent: true });
    finalizeAssistantStream?.();
    resetLiveView?.();
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
    if (!isActivationCurrent(token)) return;
    resetComposerDraftState({ keepOptions: false });
    state.liveView.replayGuardActive = false;
    state.liveView.replayGuardPrompt = "";
    state.liveView.replayGuardUntil = 0;
    await bootstrapWorkspace({ includeSessions: false });
    if (!isActivationCurrent(token)) return;
    if (!session.resumeSessionId) {
      applyHistoricalComposerValues(session);
    }

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
      if (!isActivationCurrent(token)) return;
      const hydrated = await hydrateSession(
        {
          ...session,
          id: `thread:${session.provider}:${session.resumeSessionId}`,
          kind: "thread",
          status: "saved"
        },
        { includeMessages: true, silent: true, forceRefresh: true }
      );
      if (!isActivationCurrent(token)) return;
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
    if (!isActivationCurrent(token)) return;
    setStatus("");
    state.pendingSessionId = "";
  }

  async function openThreadSession(session, { skipRoute = false } = {}) {
    const token = beginActivation(session.id);
    setStatus("正在加载会话…");
    const decorated = decorateSession(session);
    const targetThreadId = String(session.resumeSessionId || "").trim();
    const keepInteractiveState = targetThreadId && getInteractiveThreadId() === targetThreadId;

    if (!keepInteractiveState) {
      closeSocket();
      finalizeAssistantStream();
      resetLiveView();
      clearAuthoritativeThreadSnapshot();
      setThreadSnapshot(null);
    }

    state.routeSessionId = session.id;
    state.threadView.sessionId = session.id;
    state.threadView.threadId = targetThreadId;
    state.threadView.meta = {
      ...decorated,
      kind: "thread",
      cwd: decorated.cwd || ""
    };
    state.threadView.openToken += 1;
    if (!skipRoute && (route.name !== "chat" || String(route.params.sessionId || "").trim() !== session.id)) {
      await router.push({ name: "chat", params: { sessionId: session.id } });
    }
    if (!isActivationCurrent(token)) return;
    resetComposerDraftState({ keepOptions: false });
    const hydrated = await hydrateSession(session, { includeMessages: true, forceRefresh: true });
    if (!isActivationCurrent(token)) return;
    const historyThreadSnapshot = hydrated?.threadSnapshot || null;
    state.threadView.meta = {
      ...state.threadView.meta,
      cwd: hydrated?.session?.cwd || decorated.cwd || "",
      displayTitle: hydrated?.title || decorated.displayTitle,
      displayPreview: hydrated?.preview || decorated.displayPreview
    };
    const composerStateSynced = await syncComposerStateForThread(session.provider, targetThreadId, { silent: true });
    if (!isActivationCurrent(token)) return;
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
    const nextActivation = activation + 1;
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
      if (!isActivationCurrent(nextActivation)) return;
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

    const pendingCreateId = `__creating__:${cwd}`;
    const token = activation;
    try {
      state.pendingSessionId = pendingCreateId;
      setStatus("正在创建会话…");
      const payload = await request("/api/sessions", {
        method: "POST",
        body: JSON.stringify(
          buildSessionCreateRequest({
            provider: "codex",
            cwd,
            projectId: group.projectId || "",
            composerOptions: composerOptions.value
          })
        )
      });
      if (!isActivationCurrent(token)) return;
      await refreshSessions();
      if (!isActivationCurrent(token)) return;
      if (payload?.session) {
        await openSessionItem(payload.session);
        return;
      }
      setStatus("会话已创建，请手动打开。");
    } catch (error) {
      if (isActivationCurrent(token)) setStatus(error?.message || String(error));
    } finally {
      if (state.pendingSessionId === pendingCreateId) {
        state.pendingSessionId = "";
      }
    }
  }

  async function ensureLiveSession() {
    const token = activation;
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
    if (!isActivationCurrent(token)) throw new Error("会话已切换，已取消发送。");

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
    if (!isActivationCurrent(token)) throw new Error("会话已切换，已取消发送。");
    discardPendingAssistantStream();
    state.liveView.streamBuffer = "";
    return resumed.session.id;
  }

  async function backToList() {
    invalidateActivation();
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
    await refreshSessions().catch(() => {});
    if (route.name === "sessions" && state.ready && state.isAuthenticated) startSessionListSyncLoop();
  }

  function applyInputResponse(payload = {}) {
    const session = payload.session;
    if (session) {
      const decorated = decorateSession(session);
      state.liveView.sessionMeta = decorated;
      state.liveView.sessionId = session.id;
      state.liveView.liveSessionId = session.id;
      const threadId = String(session.resumeSessionId || payload.threadId || "").trim();
      if (threadId) {
        state.threadView.threadId = threadId;
        state.threadView.sessionId = `history:${session.provider}:${threadId}`;
        state.threadView.meta = { ...decorated, kind: "thread", id: state.threadView.sessionId };
        state.liveView.conversation.threadId = threadId;
      }
    }
    if (payload.turnId) state.liveView.inputTurnId = payload.turnId;
    refreshSessions().catch(() => {});
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
      (state.routeSessionId === targetSessionId &&
        (!historyTarget || Boolean(state.threadView.meta) || Boolean(state.liveView.liveSessionId)))
    ) {
      return;
    }

    if (historyTarget) {
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
      return;
    }

    let session = state.sessions.find((item) => item.id === targetSessionId);
    const lookup = ++routeLookup;
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

    if (lookup !== routeLookup || route.name !== "chat" || String(route.params.sessionId || "").trim() !== targetSessionId) return;

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

    await openSessionItem(session, { skipRoute: true });
  }

  return {
    setSessionCatalogView, loadSessionCatalogGroup, loadMoreSessionCatalog,
    applyBackendConfig,
    requestWorkspaceConfig,
    invalidateWorkspaceBootstrap,
    bootstrapWorkspace,
    hydrateSession,
    refreshSessions,
    startSessionListSyncLoop,
    stopSessionListSyncLoop,
    invalidateActivation,
    stopSocketRecovery,
    recoverLiveSession,
    getActivationToken: () => activation,
    isActivationCurrent,
    stopHistorySyncLoop,
    startHistorySyncLoop,
    currentThreadSyncTarget,
    syncActiveThreadSession,
    openLiveSession,
    openThreadSession,
    openSessionItem,
    createSessionInGroup,
    ensureLiveSession,
    applyInputResponse,
    backToList,
    syncRouteSession
  };
}
