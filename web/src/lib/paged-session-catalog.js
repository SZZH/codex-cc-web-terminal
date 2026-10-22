import { mergeSessionTitlesIntoCache, sessionGroupKey } from "./session-list.js";

export const normalizeCatalogQuery = (query) => String(query || "").normalize("NFKC").toLowerCase().trim().split(/\s+/).filter(Boolean).join(" ");

function savedView() {
  try { return window.localStorage.getItem("codex-session-list-view") === "activity" ? "activity" : "groups"; }
  catch { return "groups"; }
}

function emptyCatalog(view = savedView(), query = "", runningOnly = false) {
  return { view, query, runningOnly, revision: "", page: null, loading: false, loadingGroups: new Set(), groupErrors: new Map() };
}

function validate(payload, catalog) {
  if (payload?.catalogFormat !== "paged-v1" || typeof payload.revision !== "string" || !payload.revision
    || payload.view !== catalog.view || Boolean(payload.runningOnly) !== catalog.runningOnly || normalizeCatalogQuery(payload.query) !== catalog.query
    || !Array.isArray(payload.sessions) || !Array.isArray(payload.projectGroups) || !payload.catalogPage) {
    throw new Error("会话列表格式无效，请重试。");
  }
  const groups = new Set();
  for (const group of payload.projectGroups) {
    const key = sessionGroupKey(group);
    if (!key || groups.has(key) || !Array.isArray(group.sessions) || !group.catalogPage
      || !Number.isSafeInteger(group.catalogPage.total) || group.catalogPage.total < group.sessions.length) {
      throw new Error("会话分组格式无效，请重试。");
    }
    groups.add(key);
  }
  return payload;
}

const unique = (sessions) => [...new Map(sessions.map((session) => [session.id, session])).values()];

export function createPagedSessionCatalog({ state, request, sessionCache = {} }) {
  state.sessionCatalog = emptyCatalog();
  let generation = 0;
  let manifest = null;
  const reads = new Map();

  function cancel() {
    generation += 1;
    for (const owner of reads.values()) { owner.cancel(); owner.controller.abort(); }
    reads.clear(); manifest = null;
    state.sessionListLoading = false;
    state.sessionCatalog.loading = false;
    state.sessionCatalog.loadingGroups.clear();
  }

  function current(owner) {
    return reads.get(owner.key) === owner && owner.generation === generation && state.isAuthenticated !== false;
  }

  function read(key, parameters, publish, groupKey = key) {
    if (reads.has(key)) return reads.get(key).promise;
    const owner = { key, generation, controller: new AbortController() };
    const cancellation = new Promise((resolve) => { owner.cancel = () => resolve(null); });
    reads.set(key, owner);
    const params = new URLSearchParams({ view: state.sessionCatalog.view, q: state.sessionCatalog.query, limit: "20", ...(state.sessionCatalog.runningOnly ? { running: "1" } : {}), ...parameters });
    owner.promise = Promise.race([request(`/api/session-catalog?${params}`, { signal: owner.controller.signal }), cancellation])
      .then((received) => {
        if (!current(owner) || !received) return;
        const payload = validate(received, state.sessionCatalog);
        publish(payload);
        mergeSessionTitlesIntoCache(payload.sessions, sessionCache);
      }).catch((error) => {
        if (!current(owner)) return;
        if (key === "manifest") state.sessionListError = error;
        else state.sessionCatalog.groupErrors.set(groupKey, error.message || String(error));
        throw error;
      }).finally(() => {
        if (reads.get(key) !== owner) return;
        reads.delete(key);
        if (key === "manifest") { manifest = null; state.sessionListLoading = false; state.sessionCatalog.loading = false; }
        else state.sessionCatalog.loadingGroups.delete(groupKey);
      });
    return owner.promise;
  }

  function refresh() {
    if (manifest) return manifest;
    if (reads.size) return Promise.resolve();
    const catalog = state.sessionCatalog;
    const loaded = catalog.revision ? catalog.view === "activity"
      ? { activity: Math.max(20, state.sessions.length) }
      : Object.fromEntries(state.projectGroups.map((group) => [sessionGroupKey(group), group.sessions.length])) : null;
    state.sessionListLoading = true; catalog.loading = true;
    manifest = read("manifest", loaded ? { loaded: JSON.stringify(loaded) } : {}, (payload) => {
      const degraded = payload.sidebarStatus?.degraded === true;
      if (degraded && !payload.sessions.length) {
        throw new Error("会话列表暂时无法读取，请重试。");
      }
      state.sessions = payload.sessions;
      state.projectGroups = payload.projectGroups;
      state.sessionListReady = true;
      state.sessionListComplete = false;
      catalog.revision = payload.revision; catalog.page = payload.catalogPage;
      catalog.groupErrors.clear();
      state.sessionListError = degraded ? new Error("部分会话数据暂时无法更新，请重试。") : null;
    });
    return manifest;
  }

  function setView({ view = state.sessionCatalog.view, query = state.sessionSearch || "", runningOnly = state.sessionCatalog.runningOnly } = {}) {
    view = view === "activity" ? "activity" : "groups";
    query = normalizeCatalogQuery(query);
    runningOnly = view === "activity" && Boolean(runningOnly);
    if (state.sessionCatalog.runningOnly === runningOnly && state.sessionCatalog.view === view && state.sessionCatalog.query === query) return refresh();
    cancel();
    state.sessionCatalog = emptyCatalog(view, query, runningOnly);
    state.sessions = []; state.projectGroups = [];
    state.sessionListReady = false; state.sessionListComplete = false; state.sessionListError = null;
    return refresh();
  }

  function loadGroup(key, { more = false } = {}) {
    const catalog = state.sessionCatalog;
    if (catalog.loading || catalog.view !== "groups") return Promise.resolve();
    const group = state.projectGroups.find((entry) => sessionGroupKey(entry) === key);
    if (!group || !more && group.sessions.length || !group.catalogPage?.nextCursor) return Promise.resolve();
    const revision = catalog.revision;
    catalog.loadingGroups.add(key); catalog.groupErrors.delete(key);
    return read(`group:${key}`, { group: key, cursor: group.catalogPage.nextCursor }, (payload) => {
      if (revision !== payload.revision) throw new Error("会话列表已更新，请重新加载。");
      const next = payload.projectGroups.find((entry) => sessionGroupKey(entry) === key);
      if (!next) throw new Error("会话分组暂时无法读取，请重试。");
      state.projectGroups = state.projectGroups.map((entry) => sessionGroupKey(entry) === key
        ? { ...next, sessions: unique([...entry.sessions, ...next.sessions]) } : entry);
      state.sessions = unique(state.projectGroups.flatMap((entry) => entry.sessions));
      state.sessionListError = null;
    }, key).catch(async (error) => {
      if (error.status === 409 && revision === state.sessionCatalog.revision) { await refresh(); return; }
      throw error;
    });
  }

  function loadMore() {
    const catalog = state.sessionCatalog;
    if (catalog.loading || catalog.view !== "activity" || !catalog.page?.nextCursor) return Promise.resolve();
    const revision = catalog.revision;
    const key = "activity";
    catalog.loadingGroups.add(key); catalog.groupErrors.delete(key);
    return read(key, { cursor: catalog.page.nextCursor }, (payload) => {
      if (revision !== payload.revision) throw new Error("会话列表已更新，请重新加载。");
      state.sessions = unique([...state.sessions, ...payload.sessions]);
      const previous = new Map(state.projectGroups.map((group) => [sessionGroupKey(group), group]));
      state.projectGroups = payload.projectGroups.map((group) => ({ ...group,
        sessions: unique([...(previous.get(sessionGroupKey(group))?.sessions || []), ...group.sessions]) }));
      catalog.page = payload.catalogPage; state.sessionListError = null;
    }).catch(async (error) => {
      if (error.status === 409 && revision === state.sessionCatalog.revision) { await refresh(); return; }
      throw error;
    });
  }

  function invalidate() {
    cancel(); state.sessionCatalog = emptyCatalog();
    state.sessions = []; state.projectGroups = [];
    state.sessionListReady = false; state.sessionListComplete = false; state.sessionListError = null;
  }

  return { refresh, setView, loadGroup, loadMore, cancel, invalidate };
}
