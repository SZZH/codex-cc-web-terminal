import { mergeSessionTitlesIntoCache } from "./session-list.js";
import { restoreSessionSidebarPayload } from "./session-sidebar-payload.js";
import { createSessionListSyncLoop } from "./session-list-sync.js";
import { createPagedSessionCatalog } from "./paged-session-catalog.js";

export function createSessionCatalogController({ state, route, request, composerOptions, sessionCache, getActiveProviderId, now = Date.now, paged = false }) {
  state.sessionListReady ??= false;
  state.sessionListComplete ??= state.sessionListReady;
  state.sessionListCounts ??= null;
  state.sessionListLoading ??= false;
  state.sessionListError ??= null;
  let refreshInFlight = null;
  let workspaceGeneration = 0;
  let workspaceConfigPromise = null;
  let workspaceConfigExpiresAt = 0;
  const catalog = paged ? createPagedSessionCatalog({ state, request, sessionCache }) : null;

  async function refreshSessions() {
    if (catalog) return catalog.refresh();
    if (refreshInFlight) return refreshInFlight.promise;
    const wasAuthenticated = state.isAuthenticated;
    const generation = workspaceGeneration;
    const owner = { controller: new AbortController(), cold: !state.sessionListComplete, cancelled: false };
    const cancellation = new Promise((resolve) => { owner.cancel = resolve; });
    const isCurrent = () => refreshInFlight === owner && generation === workspaceGeneration
      && (!wasAuthenticated || state.isAuthenticated) && !owner.cancelled;
    refreshInFlight = owner;
    state.sessionListLoading = true;
    const task = (async () => {
      const received = await Promise.race([request(`/api/sessions?compact=1${owner.cold ? "&progressive=1" : ""}`, {
        signal: owner.controller.signal,
        ...(owner.cold ? { onSidebarBootstrap: ({ payload: received, counts }) => {
          if (!isCurrent() || state.sessionListComplete) return;
          const payload = restoreSessionSidebarPayload(received);
          mergeSessionTitlesIntoCache(payload.sessions, sessionCache);
          state.sessions = payload.sessions;
          state.projectGroups = payload.projectGroups;
          state.sessionListReady = true;
          state.sessionListCounts = counts;
        } } : {})
      }), cancellation]);
      if (!isCurrent()) return;
      const payload = restoreSessionSidebarPayload(received);
      if (!Array.isArray(payload.sessions) || payload.projectGroups !== undefined && !Array.isArray(payload.projectGroups)) {
        throw new Error("会话列表格式无效，请重试。");
      }
      const sessions = payload.sessions || [];
      const degraded = payload.sidebarStatus?.degraded === true;
      if (!degraded || !state.sessionListComplete && sessions.length > 0) {
        mergeSessionTitlesIntoCache(sessions, sessionCache);
        state.sessions = sessions;
        state.projectGroups = payload.projectGroups || [];
        state.sessionListReady = true;
        state.sessionListComplete = true;
        state.sessionListCounts = null;
      }
      state.sessionListError = degraded ? Object.assign(new Error(state.sessionListReady
        ? state.sessionListComplete ? "部分会话数据暂时无法更新，当前显示可用数据，请重试。" : "会话列表尚未完整加载，请重试。"
        : "会话列表暂时无法读取，请重试。"), { code: "SIDEBAR_DEGRADED" }) : null;
    })();
    owner.promise = task.catch((error) => {
      if (owner.cancelled) return;
      if (isCurrent()) {
        state.sessionListError = state.sessionListReady && !state.sessionListComplete
          ? Object.assign(new Error("会话列表尚未完整加载，请重试。", { cause: error }), error,
            { message: "会话列表尚未完整加载，请重试。", cause: error })
          : error;
        throw state.sessionListError;
      }
      throw error;
    }).finally(() => {
      if (refreshInFlight === owner) {
        refreshInFlight = null;
        state.sessionListLoading = false;
      }
    });
    return owner.promise;
  }

  const { start: startSessionListSyncLoop, stop } = createSessionListSyncLoop({
    refresh: refreshSessions,
    intervalMs: paged ? 15000 : 4000,
    shouldSync: () => state.ready && state.isAuthenticated && route.name === "sessions"
  });

  function stopSessionListSyncLoop({ abortBootstrap = false } = {}) {
    stop();
    if (catalog) { if (abortBootstrap) catalog.cancel(); return; }
    const owner = refreshInFlight;
    if (!abortBootstrap || !owner?.cold || state.sessionListComplete) return;
    owner.cancelled = true;
    refreshInFlight = null;
    state.sessionListLoading = false;
    owner.cancel();
    owner.controller.abort();
  }

  function applyBackendConfig(_payload) {
    if (typeof window === "undefined" || !window.location) return;
    const protocol = String(window.location.protocol || "").toLowerCase() === "https:";
    const authority = window.location.host || window.location.hostname || "localhost";
    state.backendHttpOrigin = `${protocol ? "https:" : "http:"}//${authority}`;
    state.backendWsOrigin = `${protocol ? "wss:" : "ws:"}//${authority}`;
  }

  function invalidateWorkspaceBootstrap() {
    catalog?.invalidate();
    workspaceGeneration += 1;
    workspaceConfigPromise = null;
    workspaceConfigExpiresAt = 0;
    refreshInFlight?.controller.abort();
    refreshInFlight = null;
    state.providerCatalog = [];
    state.codexDefaults = { model: "", reasoningEffort: "medium", permissionMode: "default" };
    state.sessions = [];
    state.projectGroups = [];
    state.sessionListReady = false;
    state.sessionListComplete = false;
    state.sessionListCounts = null;
    state.sessionListLoading = false;
    state.sessionListError = null;
    state.sessionSearch = "";
  }

  function requestWorkspaceConfig({ force = false } = {}) {
    if (workspaceConfigPromise && (!workspaceConfigExpiresAt || !force && now() < workspaceConfigExpiresAt)) return workspaceConfigPromise;
    const generation = workspaceGeneration;
    const initialOptions = composerOptions.value;
    workspaceConfigExpiresAt = 0;
    const task = request("/api/config").then((configPayload) => {
      if (generation !== workspaceGeneration || !state.isAuthenticated) return null;
      workspaceConfigExpiresAt = now() + 60_000;
      applyBackendConfig(configPayload);
      state.providerCatalog = Array.isArray(configPayload?.providers) ? configPayload.providers : [];
      state.codexDefaults = {
        model: String(configPayload?.codexDefaults?.model || "").trim(),
        reasoningEffort: String(configPayload?.codexDefaults?.reasoningEffort || "medium").trim() || "medium",
        permissionMode: String(configPayload?.codexDefaults?.permissionMode || "default").trim() || "default"
      };
      state.defaultProvider = String(configPayload?.defaultProvider || "codex").trim().toLowerCase() || "codex";
      const providerId = String(getActiveProviderId?.() || state.defaultProvider || "codex").trim().toLowerCase();
      if (providerId === "codex" && composerOptions.value === initialOptions && !initialOptions.model && !initialOptions.attachments.length) {
        composerOptions.value = { ...composerOptions.value, ...state.codexDefaults };
      }
      return configPayload;
    }).catch((error) => {
      if (workspaceConfigPromise === task) workspaceConfigPromise = null;
      throw error;
    });
    workspaceConfigPromise = task;
    return task;
  }

  async function bootstrapWorkspace({ includeSessions = true } = {}) {
    await Promise.all([requestWorkspaceConfig(), ...(includeSessions ? [refreshSessions()] : [])]);
  }

  return { refreshSessions, startSessionListSyncLoop, stopSessionListSyncLoop,
    setSessionCatalogView: (context) => catalog?.setView(context),
    loadSessionCatalogGroup: (key, options) => catalog?.loadGroup(key, options),
    loadMoreSessionCatalog: () => catalog?.loadMore(),
    applyBackendConfig, requestWorkspaceConfig, invalidateWorkspaceBootstrap, bootstrapWorkspace };
}
