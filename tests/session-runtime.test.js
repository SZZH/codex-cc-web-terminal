import test from "node:test";
import assert from "node:assert/strict";
import { createSessionRuntimeController } from "../web/src/lib/session-runtime.js";
import { createLiveSessionRuntimeController } from "../web/src/lib/live-session-runtime.js";
import { createLiveViewState, createThreadViewState, resetLiveViewState, resetThreadViewState } from "../web/src/lib/app-state.js";
import { createComposerOptions } from "../web/src/lib/composer.js";
import { request as apiRequest } from "../web/src/lib/api.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function createHarness({ onAttach, onLookup, now } = {}) {
  const timers = new Map();
  const timeouts = new Map();
  globalThis.window = {
    location: { hostname: "localhost", protocol: "http:" },
    setInterval: (callback) => { const id = {}; timers.set(id, callback); return id; },
    clearInterval: (id) => timers.delete(id),
    setTimeout: (callback) => { const id = {}; timeouts.set(id, callback); return id; },
    clearTimeout: (id) => timeouts.delete(id)
  };
  const state = {
    ready: true, isAuthenticated: true, loading: false, sessions: [], projectGroups: [],
    codexDefaults: {}, liveView: createLiveViewState(), threadView: createThreadViewState()
  };
  const route = { name: "chat", params: { sessionId: "history:codex:a" }, query: {} };
  const reads = [];
  const requests = [];
  const lookups = [];
  const attached = [];
  const composerOptions = { value: createComposerOptions() };
  const runtime = createSessionRuntimeController({
    state, route,
    router: { push: async (target) => Object.assign(route, target), replace: async (target) => Object.assign(route, target) },
    composerOptions, sessionCache: {}, pendingHydrations: new Map(), historyApiAvailable: { value: true },
    request: (url, options) => { const item = { url, options, ...deferred() }; requests.push(item); return item.promise; },
    requestSessionById: async (id) => { lookups.push(id); return onLookup ? onLookup(id) : { id, kind: "live", provider: "codex", resumeSessionId: "a" }; },
    requestHistoryMessages: (session) => { const item = { session, ...deferred() }; reads.push(item); return item.promise; },
    setStatus: (value) => { state.statusText = value; }, wait: async () => {},
    getActiveThreadId: () => state.threadView.threadId,
    getActiveProviderId: () => state.liveView.sessionMeta?.provider || state.threadView.meta?.provider || String(route.params.sessionId).split(":")[1] || "codex",
    getExpectedThreadId: () => String(route.params.sessionId).split(":").at(-1),
    getInteractiveThreadId: () => state.liveView.sessionMeta?.resumeSessionId || "",
    getRouteHistoryTarget: () => route.name === "chat" && String(route.params.sessionId).startsWith("history:")
      ? { provider: "codex", resumeSessionId: String(route.params.sessionId).split(":").at(-1) } : null,
    getPreferredThreadSnapshot: () => state.threadView.persistedSnapshot,
    resetComposerDraftState() {},
    resetLiveView: () => resetLiveViewState(state.liveView), resetThreadView: () => resetThreadViewState(state.threadView),
    closeSocket: () => { state.liveView.socket = null; }, finalizeAssistantStream() {}, discardPendingAssistantStream() {},
    clearAuthoritativeThreadSnapshot: () => { state.threadView.authoritativeSnapshot = null; },
    setConversation: (value) => { state.liveView.conversation = value; },
    setThreadSnapshot: (value) => { state.threadView.persistedSnapshot = value; },
    setLiveOverlay: (value) => { state.liveView.liveOverlay = value; },
    attachLiveSocket: async (id) => { attached.push(id); await onAttach?.(id); },
    syncComposerStateForThread: async () => true, applyHistoricalComposerValues() {}, now
  });
  const thread = (id) => ({ id: `history:codex:${id}`, kind: "thread", provider: "codex", resumeSessionId: id, status: "saved" });
  const payload = (id) => ({ session: { name: id }, messages: [], threadSnapshot: { threadId: id, turns: [], status: "completed" } });
  return { state, route, runtime, composerOptions, reads, requests, lookups, attached, timers, timeouts, thread, payload };
}

test("a delayed historical open cannot replace a newer thread activation", async () => {
  const h = createHarness();
  const first = h.runtime.openThreadSession(h.thread("a"), { skipRoute: true });
  h.route.params.sessionId = "history:codex:b";
  const second = h.runtime.openThreadSession(h.thread("b"), { skipRoute: true });
  h.reads[1].resolve(h.payload("b"));
  await second;
  h.reads[0].resolve(h.payload("a"));
  await first;
  assert.equal(h.state.threadView.threadId, "b");
  assert.equal(h.state.threadView.persistedSnapshot.threadId, "b");
  assert.equal(h.state.pendingSessionId, "");
  h.runtime.stopHistorySyncLoop();
});

test("a delayed background history sync cannot overwrite the next thread", async () => {
  const h = createHarness();
  h.state.threadView.meta = h.thread("a");
  h.state.threadView.threadId = "a";
  const sync = h.runtime.syncActiveThreadSession();
  h.route.params.sessionId = "history:codex:b";
  const opening = h.runtime.openThreadSession(h.thread("b"), { skipRoute: true });
  h.reads[1].resolve(h.payload("b"));
  await opening;
  h.reads[0].resolve(h.payload("a"));
  assert.equal(await sync, false);
  assert.equal(h.state.threadView.persistedSnapshot.threadId, "b");
  h.runtime.stopHistorySyncLoop();
});

test("live opens discard stale config continuations and attach only the latest socket", async () => {
  const h = createHarness();
  h.route.params.sessionId = "a";
  const first = h.runtime.openLiveSession({ id: "a", provider: "codex", kind: "live" }, { skipRoute: true });
  h.route.params.sessionId = "b";
  const second = h.runtime.openLiveSession({ id: "b", provider: "codex", kind: "live" }, { skipRoute: true });
  assert.equal(h.requests.length, 1, "live activations share the authenticated workspace config");
  h.requests[0].resolve({});
  await second;
  await first;
  assert.equal(h.state.liveView.sessionId, "b");
  assert.deepEqual(h.attached, ["b"]);
});

test("workspace bootstrap starts the session list before its shared config resolves", async () => {
  const h = createHarness();
  const boot = h.runtime.bootstrapWorkspace();
  const config = h.runtime.requestWorkspaceConfig();
  assert.deepEqual(h.requests.map(({ url }) => url), ["/api/config", "/api/sessions?compact=1&progressive=1"]);
  h.requests[1].resolve({ sessions: [{ id: "available" }] });
  await h.runtime.refreshSessions();
  assert.equal(h.state.sessions[0].id, "available");
  h.requests[0].resolve({ providers: [{ id: "codex" }], codexDefaults: { model: "ready" } });
  await Promise.all([boot, config]);
  assert.equal(h.state.codexDefaults.model, "ready");
  assert.equal(h.requests.length, 2);
});

test("session refresh restores compact members and metadata before updating the existing list state", async () => {
  const h = createHarness();
  const first = { id: "first", provider: "codex", name: "First", activityState: "running" };
  const second = { id: "second", provider: "claude", name: "Second" };
  const refresh = h.runtime.refreshSessions();
  assert.equal(h.requests[0].url, "/api/sessions?compact=1&progressive=1");
  h.requests[0].resolve({ sidebarFormat: "compact-v1", sessions: [first, second], projectGroups: [
    { id: "project", name: "Project", collapsed: true, sessionIds: [second.id, first.id] }
  ] });
  await refresh;
  assert.deepEqual(h.state.sessions, [first, second]);
  assert.deepEqual(h.state.projectGroups, [{ id: "project", name: "Project", collapsed: true, sessions: [second, first] }]);
  assert.equal(h.state.projectGroups[0].sessions[1], h.state.sessions[0]);
});

test("invalid compact refresh preserves the previous list and a later legacy response can recover", async () => {
  const h = createHarness();
  const previousSessions = [{ id: "previous" }];
  const previousGroups = [{ id: "project", sessions: previousSessions }];
  h.state.sessions = previousSessions;
  h.state.projectGroups = previousGroups;
  const invalid = h.runtime.refreshSessions();
  h.requests[0].resolve({ sidebarFormat: "compact-v1", sessions: [], projectGroups: [{ id: "broken", sessionIds: ["missing"] }] });
  await assert.rejects(invalid, /Missing compact sidebar session reference/);
  assert.equal(h.state.sessions, previousSessions);
  assert.equal(h.state.projectGroups, previousGroups);
  const recovery = h.runtime.refreshSessions();
  const sessions = [{ id: "recovered" }];
  h.requests[1].resolve({ sessions, projectGroups: [] });
  await recovery;
  assert.equal(h.state.sessions, sessions);
  assert.deepEqual(h.state.projectGroups, []);
});

test("catalog loading distinguishes a failed first read, retry, and a confirmed empty result", async () => {
  const h = createHarness();
  assert.equal(h.state.sessionListReady, false);
  const first = h.runtime.refreshSessions();
  assert.equal(h.state.sessionListLoading, true);
  const failure = new Error("catalog offline");
  h.requests[0].reject(failure);
  await assert.rejects(first, /catalog offline/);
  assert.equal(h.state.sessionListReady, false);
  assert.equal(h.state.sessionListLoading, false);
  assert.equal(h.state.sessionListError, failure);
  const retry = h.runtime.refreshSessions();
  assert.equal(h.state.sessionListLoading, true);
  assert.equal(h.state.sessionListError, failure, "retain recovery feedback until the read succeeds");
  h.requests[1].resolve({ sessions: [], projectGroups: [] });
  await retry;
  assert.equal(h.state.sessionListReady, true);
  assert.equal(h.state.sessionListLoading, false);
  assert.equal(h.state.sessionListError, null);
});

test("cold bootstrap shows partial rows and real totals until full completion, and retries after a tail failure", async () => {
  const h = createHarness();
  const first = { id: "first", name: "First" }, last = { id: "last", inputPreview: "last preview" };
  const counts = { sessionsTotal: 2, activitiesTotal: 2, runningTotal: 0, groups: [{ key: "project", total: 2, running: 0 }] };
  const bootstrap = { counts, payload: { sidebarFormat: "compact-v1", sessions: [first], projectGroups: [{ id: "project", sessionIds: ["first"] }] } };
  const loading = h.runtime.refreshSessions();
  assert.equal(h.requests[0].url, "/api/sessions?compact=1&progressive=1");
  h.requests[0].options.onSidebarBootstrap(bootstrap);
  assert.deepEqual(h.state.sessions, [first]); assert.equal(h.state.sessionListReady, true);
  assert.equal(h.state.sessionListComplete, false); assert.equal(h.state.sessionListCounts, counts);
  assert.equal(h.state.sessionListLoading, true);
  const coalesced = h.runtime.refreshSessions();
  const originalCause = new Error("socket detail");
  const failure = Object.assign(new Error("tail offline", { cause: originalCause }), { code: "READ_TIMEOUT", status: 503 });
  Object.defineProperty(failure, "message", { value: "tail offline", enumerable: true });
  h.requests[0].reject(failure);
  const [firstFailure, coalescedFailure] = await Promise.allSettled([loading, coalesced]);
  assert.equal(firstFailure.status, "rejected"); assert.equal(firstFailure.reason.message, "会话列表尚未完整加载，请重试。");
  assert.equal(firstFailure.reason.cause, failure); assert.equal(firstFailure.reason.cause.cause, originalCause);
  assert.equal(firstFailure.reason.code, "READ_TIMEOUT"); assert.equal(firstFailure.reason.status, 503);
  assert.equal(coalescedFailure.reason, firstFailure.reason, "all callers observe the catalog's one recovery error");
  assert.deepEqual(h.state.sessions, [first]); assert.equal(h.state.sessionListComplete, false);
  assert.match(h.state.sessionListError.message, /尚未完整/);
  const retry = h.runtime.refreshSessions();
  h.requests[1].resolve({ sidebarFormat: "compact-v1", sessions: [first, last], projectGroups: [{ id: "project", sessionIds: ["first", "last"] }] });
  await retry; assert.equal(h.state.sessionListComplete, true); assert.equal(h.state.sessionListCounts, null);
  assert.equal(h.state.sessions[1], last); assert.equal(h.state.sessionListError, null);
  const warm = h.runtime.refreshSessions(); assert.equal(h.requests[2].url, "/api/sessions?compact=1");
  h.requests[2].resolve({ sessions: [first, last] }); await warm;
});

test("explicit leave cancels only owned cold reads and stale callbacks cannot affect a new flight", async () => {
  const h = createHarness();
  const previous = h.runtime.refreshSessions(), old = h.requests[0];
  h.runtime.stopSessionListSyncLoop({ abortBootstrap: true });
  await previous;
  assert.equal(old.options.signal.aborted, true); assert.equal(h.state.sessionListLoading, false);
  const current = h.runtime.refreshSessions();
  old.options.onSidebarBootstrap({ counts: {}, payload: { sessions: [{ id: "stale" }] } });
  old.resolve({ sessions: [{ id: "stale" }] }); await new Promise(setImmediate);
  assert.equal(h.state.sessionListReady, false); assert.equal(h.state.sessionListLoading, true);
  h.requests[1].resolve({ sessions: [{ id: "current" }] }); await current;
  const warm = h.runtime.refreshSessions(), request = h.requests[2];
  h.runtime.stopSessionListSyncLoop({ abortBootstrap: true });
  assert.equal(request.options?.signal.aborted, false);
  request.resolve({ sessions: [{ id: "warm" }] }); await warm;
  assert.equal(h.state.sessions[0].id, "warm");
});

test("partial readiness accepts a usable degraded full tail but never confirms a degraded empty tail", async () => {
  for (const empty of [false, true]) {
    const h = createHarness(), first = { id: "first" }, last = { id: "last" };
    const counts = { sessionsTotal: 2, activitiesTotal: 2, runningTotal: 0, groups: [] };
    const loading = h.runtime.refreshSessions();
    h.requests[0].options.onSidebarBootstrap({ counts, payload: { sessions: [first], projectGroups: [] } });
    h.requests[0].resolve({ sessions: empty ? [] : [first, last], projectGroups: [], sidebarStatus: { degraded: true } });
    await loading;
    assert.equal(h.state.sessionListReady, true); assert.equal(h.state.sessionListComplete, !empty);
    assert.deepEqual(h.state.sessions, empty ? [first] : [first, last]);
    assert.equal(h.state.sessionListCounts, empty ? counts : null);
    assert.equal(h.state.sessionListError.code, "SIDEBAR_DEGRADED");
    const next = h.runtime.refreshSessions(); h.requests[1].reject(new Error("retry failed"));
    await assert.rejects(next, (error) => {
      assert.equal(error.message, empty ? "会话列表尚未完整加载，请重试。" : "retry failed");
      if (empty) assert.equal(error.cause.message, "retry failed");
      return true;
    });
    assert.equal(h.state.sessionListComplete, !empty);
    assert.equal(h.state.sessionListCounts, empty ? counts : null);
  }
});

test("identity invalidation clears partial rows and counts and rejects every old bootstrap and tail", async () => {
  const h = createHarness(), counts = { sessionsTotal: 2, activitiesTotal: 2, runningTotal: 0, groups: [] };
  const old = h.runtime.refreshSessions(), request = h.requests[0];
  request.options.onSidebarBootstrap({ counts, payload: { sessions: [{ id: "old-first" }], projectGroups: [] } });
  h.runtime.invalidateWorkspaceBootstrap();
  assert.equal(request.options.signal.aborted, true);
  assert.deepEqual(h.state.sessions, []); assert.equal(h.state.sessionListReady, false);
  assert.equal(h.state.sessionListComplete, false); assert.equal(h.state.sessionListCounts, null);
  const current = h.runtime.refreshSessions();
  request.options.onSidebarBootstrap({ counts, payload: { sessions: [{ id: "stale-first" }], projectGroups: [] } });
  request.resolve({ sessions: [{ id: "old-full" }] }); await old;
  assert.deepEqual(h.state.sessions, []); assert.equal(h.state.sessionListLoading, true);
  h.requests[1].resolve({ sessions: [{ id: "current" }] }); await current;
  assert.equal(h.state.sessions[0].id, "current"); assert.equal(h.state.sessionListComplete, true);
});

test("invalid catalog structures and background failures preserve the last confirmed list", async () => {
  const h = createHarness();
  const sessions = [{ id: "retained", name: "Retained" }];
  const initial = h.runtime.refreshSessions();
  h.requests[0].resolve({ sessions }); await initial;
  for (const payload of [{}, { sessions: null }, { sessions: [], projectGroups: {} }]) {
    const read = h.runtime.refreshSessions();
    h.requests.at(-1).resolve(payload);
    await assert.rejects(read, /会话列表格式无效/);
    assert.equal(h.state.sessions, sessions);
    assert.equal(h.state.sessionListReady, true);
    assert.equal(h.state.sessionListLoading, false);
  }
});

test("a degraded cold sidebar is recoverable without confirming a misleading empty catalog", async () => {
  const h = createHarness();
  const read = h.runtime.refreshSessions();
  h.requests[0].resolve({ sessions: [], projectGroups: [], sidebarStatus: { degraded: true, warnings: ["database locked"] } });
  await read;
  assert.equal(h.state.sessionListReady, false);
  assert.equal(h.state.sessionListLoading, false);
  assert.equal(h.state.sessionListError?.code, "SIDEBAR_DEGRADED");
  const retry = h.runtime.refreshSessions();
  h.requests[1].resolve({ sessions: [], projectGroups: [], sidebarStatus: { degraded: false, warnings: [] } });
  await retry;
  assert.equal(h.state.sessionListReady, true);
  assert.equal(h.state.sessionListError, null);
});

test("degraded responses preserve client identities and can supply a first usable server snapshot", async () => {
  for (const initialDegraded of [false, true]) {
    const h = createHarness();
    const sessions = [{ id: "retained", name: "Confirmed or cached" }];
    const groups = [{ id: "project", sessions }];
    const first = h.runtime.refreshSessions();
    h.requests[0].resolve({ sessions, projectGroups: groups, sidebarStatus: { degraded: initialDegraded } });
    await first;
    assert.equal(h.state.sessionListReady, true);
    assert.equal(h.state.sessionListError?.code || null, initialDegraded ? "SIDEBAR_DEGRADED" : null);
    for (const partial of [[], [{ id: "incomplete-live-only" }]]) {
      const refresh = h.runtime.refreshSessions();
      h.requests.at(-1).resolve({ sessions: partial, projectGroups: [], sidebarStatus: { degraded: true } });
      await refresh;
      assert.equal(h.state.sessions, sessions);
      assert.equal(h.state.projectGroups, groups);
      assert.equal(h.state.sessionListReady, true);
      assert.equal(h.state.sessionListError.code, "SIDEBAR_DEGRADED");
    }
    const recovered = h.runtime.refreshSessions();
    h.requests.at(-1).resolve({ sessions: [{ id: "recovered" }], projectGroups: [] });
    await recovered;
    assert.equal(h.state.sessions[0].id, "recovered");
    assert.equal(h.state.sessionListError, null);
  }
});

test("an older identity's degraded response cannot warn or populate the new catalog", async () => {
  const h = createHarness();
  const previous = h.runtime.refreshSessions();
  h.runtime.invalidateWorkspaceBootstrap();
  const current = h.runtime.refreshSessions();
  h.requests[0].resolve({ sessions: [{ id: "previous" }], sidebarStatus: { degraded: true } });
  await previous;
  assert.equal(h.state.sessionListReady, false);
  assert.equal(h.state.sessionListError, null);
  assert.equal(h.state.sessionListLoading, true);
  h.requests[1].resolve({ sessions: [{ id: "current" }] });
  await current;
  assert.equal(h.state.sessions[0].id, "current");
  assert.equal(h.state.sessionListError, null);
});

test("old catalog failures cannot alter a newer identity's pending load or search", async () => {
  const h = createHarness();
  h.state.sessionSearch = "previous search";
  const previous = h.runtime.refreshSessions();
  h.runtime.invalidateWorkspaceBootstrap();
  assert.equal(h.state.sessionSearch, "");
  const current = h.runtime.refreshSessions();
  h.state.sessionSearch = "current search";
  h.requests[0].reject(new Error("old offline")); await assert.rejects(previous, /old offline/);
  assert.equal(h.state.sessionListLoading, true);
  assert.equal(h.state.sessionListError, null);
  assert.equal(h.state.sessionListReady, false);
  assert.equal(h.state.sessionSearch, "current search");
  h.requests[1].resolve({ sessions: [{ id: "current" }] }); await current;
  assert.equal(h.state.sessions[0].id, "current");
  assert.equal(h.state.sessionListReady, true);
});

test("returning to the list keeps a failed catalog read recoverable without rejecting navigation", async () => {
  const h = createHarness();
  const returning = h.runtime.backToList();
  await new Promise(setImmediate);
  h.requests[0].reject(new Error("list offline"));
  await returning;
  assert.equal(h.route.name, "sessions");
  assert.match(h.state.sessionListError.message, /list offline/);
  assert.equal(h.state.sessionListLoading, false);
  assert.equal(h.timers.size, 1);
  h.runtime.stopSessionListSyncLoop();
});

test("a delayed return-to-list read cannot restart list polling after opening another page", async () => {
  const h = createHarness();
  const returning = h.runtime.backToList();
  await new Promise(setImmediate);
  h.route.name = "chat";
  h.requests[0].resolve({ sessions: [] }); await returning;
  assert.equal(h.timers.size, 0);
});

test("workspace config failures can retry and old login results cannot populate the next identity", async () => {
  const h = createHarness();
  const failed = h.runtime.requestWorkspaceConfig();
  h.requests[0].reject(new Error("config offline"));
  await assert.rejects(failed, /config offline/);
  const stale = h.runtime.bootstrapWorkspace();
  h.runtime.invalidateWorkspaceBootstrap();
  h.state.isAuthenticated = true;
  const current = h.runtime.bootstrapWorkspace();
  assert.deepEqual(h.requests.map(({ url }) => url), ["/api/config", "/api/config", "/api/sessions?compact=1&progressive=1", "/api/config", "/api/sessions?compact=1&progressive=1"]);
  h.requests[3].resolve({ providers: [{ id: "new" }], codexDefaults: { model: "new" } });
  h.requests[4].resolve({ sessions: [{ id: "new" }] });
  await current;
  h.requests[1].resolve({ providers: [{ id: "old" }], codexDefaults: { model: "old" } });
  h.requests[2].resolve({ sessions: [{ id: "old" }] });
  await stale;
  assert.equal(h.state.codexDefaults.model, "new");
  assert.equal(h.state.providerCatalog[0].id, "new");
  assert.equal(h.state.sessions[0].id, "new");
  assert.equal(h.state.isAuthenticated, true);
});

test("late workspace config cannot merge Codex defaults into a CC composer or replace new settings and images", async () => {
  const previousWindow = globalThis.window;
  try {
    for (const context of ["cc", "claude", "codex", "settings", "confirmed-empty", "image"]) {
      const h = createHarness();
      const pending = h.runtime.requestWorkspaceConfig();
      if (["cc", "claude"].includes(context)) h.route.params.sessionId = `history:${context}:cc-thread`;
      if (context === "settings") h.composerOptions.value = createComposerOptions({ model: "chosen" });
      if (context === "confirmed-empty") h.composerOptions.value = createComposerOptions({ model: "", permissionMode: "auto-review" });
      const image = { id: "new-image", kind: "image", file: new File(["image"], "new.png") };
      if (context === "image") h.composerOptions.value.attachments.push(image);
      const before = h.composerOptions.value;
      h.requests[0].resolve({ codexDefaults: { model: "gpt-r18-only", permissionMode: "full-access" } });
      await pending;
      assert.equal(h.composerOptions.value.model, context === "codex" ? "gpt-r18-only" : context === "settings" ? "chosen" : "");
      if (context !== "codex") assert.equal(h.composerOptions.value, before);
      if (context === "confirmed-empty") assert.equal(h.composerOptions.value.permissionMode, "auto-review");
      if (context === "image") assert.equal(h.composerOptions.value.attachments[0], image);
      assert.equal(h.timers.size + h.timeouts.size, 0);
    }
  } finally { globalThis.window = previousWindow; }
});

test("legacy CC live entry waits for shared config before attaching its interactive connection", async () => {
  const h = createHarness();
  h.route.params.sessionId = "cc-live";
  const opening = h.runtime.openLiveSession({ id: "cc-live", provider: "claude", kind: "live" }, { skipRoute: true });
  const shared = h.runtime.requestWorkspaceConfig();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.attached, []);
  h.requests[0].resolve({ providers: [{ id: "claude", models: ["claude-model"] }] });
  await Promise.all([opening, shared]);
  assert.deepEqual(h.attached, ["cc-live"]);
  assert.equal(h.state.providerCatalog[0].id, "claude");
});

test("workspace config refreshes after its bounded freshness window or an explicit retry", async () => {
  let clock = 1;
  const h = createHarness({ now: () => clock });
  const first = h.runtime.requestWorkspaceConfig();
  assert.equal(h.runtime.requestWorkspaceConfig({ force: true }), first, "force still shares an active read");
  h.requests[0].resolve({ codexDefaults: { model: "first" } }); await first;
  clock += 59_999;
  assert.equal(h.runtime.requestWorkspaceConfig(), first);
  clock += 1;
  const expired = h.runtime.requestWorkspaceConfig();
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve({ codexDefaults: { model: "updated" } }); await expired;
  assert.equal(h.state.codexDefaults.model, "updated");
  const forced = h.runtime.requestWorkspaceConfig({ force: true });
  assert.equal(h.requests.length, 3);
  h.requests[2].resolve({ codexDefaults: { model: "forced" } }); await forced;
  assert.equal(h.state.codexDefaults.model, "forced");
});

test("public reverse proxy keeps browser authority for realtime transport", async () => {
  const h = createHarness();
  window.location = { hostname: "203.0.113.5", host: "203.0.113.5:8443", protocol: "https:" };
  const bootstrap = h.runtime.bootstrapWorkspace({ includeSessions: false });
  h.requests[0].resolve({ host: "127.0.0.1", port: 3210, providers: [], codexDefaults: {} });
  await bootstrap;
  assert.equal(h.state.backendHttpOrigin, "https://203.0.113.5:8443");
  assert.equal(h.state.backendWsOrigin, "wss://203.0.113.5:8443");
});

test("session catalog refreshes coalesce and list timers clean up", async () => {
  const h = createHarness();
  h.route.name = "sessions";
  h.runtime.startSessionListSyncLoop();
  const tick = [...h.timers.values()][0];
  tick(); tick(); tick();
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve({ sessions: [{ id: "new" }], projectGroups: [{ key: "project" }] });
  await h.runtime.refreshSessions();
  assert.equal(h.state.sessions[0].id, "new");
  assert.equal(h.state.projectGroups[0].key, "project");
  h.runtime.stopSessionListSyncLoop();
  assert.equal(h.timers.size, 0);
});

test("input POST response establishes the first thread identity and turn", () => {
  const h = createHarness();
  h.runtime.applyInputResponse({ session: { id: "live-a", kind: "live", provider: "codex", resumeSessionId: "thread-a" }, turnId: "turn-a" });
  assert.equal(h.state.liveView.liveSessionId, "live-a");
  assert.equal(h.state.threadView.threadId, "thread-a");
  assert.equal(h.state.liveView.conversation.threadId, "thread-a");
  assert.equal(h.state.liveView.inputTurnId, "turn-a");
  h.requests[0].resolve({ sessions: [], projectGroups: [] });
});

test("obsolete websocket messages and close events cannot alter the new session", async () => {
  const h = createHarness();
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    constructor(url) { super(); this.url = url; }
    emit(type, data) { const event = new Event(type); event.data = JSON.stringify(data); this.dispatchEvent(event); }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  try {
    const runtime = createLiveSessionRuntimeController({
      state: h.state, setStatus: (value) => { h.state.statusText = value; },
      setMessages: (value) => { h.state.liveView.messages = value; },
      waitForSocketOpen: async () => {}, threadRuntime: {}, liveBootstrapLinePatterns: [], decorateSession: (value) => value
    });
    const deps = { closeSocket: () => { h.state.liveView.socket = null; }, resolveWsUrl: (id) => id };
    await runtime.attachLiveSocket("a", deps);
    const old = h.state.liveView.socket;
    h.state.liveView.liveSessionId = "b";
    await runtime.attachLiveSocket("b", deps);
    const current = h.state.liveView.socket;
    assert.notEqual(current, old);
    assert.equal(current.url, "b");
    h.state.statusText = "等待 Codex 回复…";
    old.emit("message", { type: "error", error: "old error" });
    old.emit("close"); old.emit("error");
    assert.equal(h.state.statusText, "等待 Codex 回复…");
    assert.equal(h.state.liveView.socket, current);
    assert.deepEqual(h.state.liveView.messages, []);
  } finally { globalThis.WebSocket = original; }
});

test("socket loss enables history backfill and settles a completed tracked turn before reconnect", async () => {
  const h = createHarness();
  h.state.liveView.liveSessionId = "live-a";
  h.state.liveView.sessionMeta = { provider: "codex", resumeSessionId: "a" };
  h.state.liveView.activeInputStream = true;
  h.state.liveView.inputTurnId = "turn-a";
  h.state.liveView.hasConversationSnapshot = true;
  h.state.liveView.hasConversationDelta = true;
  h.state.threadView.threadId = "a";
  h.state.threadView.meta = h.thread("a");
  h.runtime.recoverLiveSession("live-a");
  assert.equal(h.state.liveView.hasConversationSnapshot, false);
  assert.equal(h.state.liveView.hasConversationDelta, false);
  assert.equal(h.state.liveView.recoveringSocket, true);
  assert.equal(h.reads.length, 1);
  const recovered = h.payload("a");
  recovered.threadSnapshot.turns = [{ id: "turn-a", status: "completed" }];
  recovered.conversation = { threadId: "a", turns: [{ id: "turn-a", user: null, assistant: { body: [{ text: "recovered reply" }], status: "completed" } }] };
  h.reads[0].resolve(recovered);
  await new Promise(setImmediate);
  assert.equal(h.state.liveView.activeInputStream, false);
  assert.equal(h.state.liveView.conversation.turns[0].assistant.body[0].text, "recovered reply");
  assert.equal(h.state.statusText, "");
  h.runtime.stopSocketRecovery();
  h.runtime.stopHistorySyncLoop();
});

test("reconnect retries subscription without sending input and is cancelled on thread change", async () => {
  const h = createHarness();
  h.state.liveView.liveSessionId = "live-a";
  h.state.liveView.sessionMeta = { provider: "codex", resumeSessionId: "a" };
  h.state.threadView.meta = h.thread("a");
  h.runtime.recoverLiveSession("live-a");
  h.reads[0].resolve(h.payload("a"));
  await new Promise(setImmediate);
  const reconnect = [...h.timeouts.values()][0];
  h.timeouts.clear();
  const reconnected = reconnect();
  await new Promise(setImmediate);
  assert.deepEqual(h.attached, ["live-a"]);
  assert.equal(h.requests.length, 0);
  h.route.params.sessionId = "history:codex:b";
  const opening = h.runtime.openThreadSession(h.thread("b"), { skipRoute: true });
  h.reads[2].resolve(h.payload("b"));
  await opening;
  h.reads[1].resolve(h.payload("a"));
  await reconnected;
  assert.equal(h.state.threadView.threadId, "b");
  assert.equal(h.state.threadView.persistedSnapshot.threadId, "b");
  assert.equal(h.timeouts.size, 0);
  h.runtime.stopHistorySyncLoop();
});

test("socket close and error notify recovery once for the current connection", async () => {
  const h = createHarness();
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    constructor() { super(); }
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  try {
    const recovered = [];
    const live = createLiveSessionRuntimeController({ state: h.state, threadRuntime: {}, liveBootstrapLinePatterns: [],
      setMessages() {}, setStatus() {}, waitForSocketOpen: async () => {}, onSocketUnavailable: (id) => recovered.push(id) });
    const deps = { closeSocket: () => { h.state.liveView.socket = null; }, resolveWsUrl: (id) => id };
    await live.attachLiveSocket("live-a", deps);
    const errored = h.state.liveView.socket;
    errored.dispatchEvent(new Event("error"));
    errored.dispatchEvent(new Event("close"));
    assert.deepEqual(recovered, ["live-a"]);
    await live.attachLiveSocket("live-b", deps);
    h.state.liveView.socket.dispatchEvent(new Event("close"));
    assert.deepEqual(recovered, ["live-a", "live-b"]);
    assert.equal(h.state.liveView.socket, null);
  } finally { globalThis.WebSocket = original; }
});

test("failed reconnect retries only the subscription and resumes history sync on success", async () => {
  let attempts = 0;
  const h = createHarness({ onAttach: async () => { attempts += 1; if (attempts === 1) throw new Error("offline"); } });
  h.state.liveView.liveSessionId = "live-a";
  h.state.liveView.sessionMeta = { provider: "codex", resumeSessionId: "a" };
  h.state.threadView.meta = h.thread("a");
  h.runtime.recoverLiveSession("live-a");
  h.reads[0].resolve(h.payload("a"));
  await new Promise(setImmediate);
  const first = [...h.timeouts.values()][0];
  h.timeouts.clear();
  await first();
  assert.equal(h.state.liveView.recoveringSocket, true);
  assert.equal(h.timeouts.size, 1);
  const retry = [...h.timeouts.values()][0];
  h.timeouts.clear();
  const recovered = retry();
  await new Promise(setImmediate);
  h.reads[1].resolve(h.payload("a"));
  await recovered;
  assert.deepEqual(h.attached, ["live-a", "live-a"]);
  assert.equal(h.state.liveView.recoveringSocket, false);
  assert.equal(h.requests.length, 0);
  h.runtime.stopHistorySyncLoop();
});

function prepareRecovery(h) {
  h.state.liveView.liveSessionId = "old-live-a";
  h.state.liveView.sessionId = "old-live-a";
  h.state.liveView.sessionMeta = { id: "old-live-a", kind: "live", provider: "codex", resumeSessionId: "a", cwd: "/workspace/a", model: "selected-model", permissionMode: "full-access" };
  h.state.threadView.meta = { ...h.thread("a"), cwd: "/workspace/a" };
  h.state.threadView.threadId = "a";
  h.runtime.recoverLiveSession("old-live-a");
}

function runReconnect(h) {
  const callback = [...h.timeouts.values()][0];
  h.timeouts.clear();
  return callback();
}

test("old live session 404 restores the same thread and changes subscription without resending input", async () => {
  const h = createHarness({ onLookup: async () => { throw Object.assign(new Error("not found"), { status: 404 }); } });
  prepareRecovery(h);
  h.reads[0].resolve(h.payload("a"));
  await new Promise(setImmediate);
  const reconnect = runReconnect(h);
  await new Promise(setImmediate);
  assert.deepEqual(h.lookups, ["old-live-a"]);
  assert.equal(h.requests[0].url, "/api/sessions");
  assert.equal(h.requests[0].options.method, "POST");
  assert.deepEqual(JSON.parse(h.requests[0].options.body), { provider: "codex", resumeSessionId: "a", cwd: "/workspace/a" });
  h.requests[0].resolve({ session: { id: "new-live-a", kind: "live", provider: "codex", resumeSessionId: "a", model: "saved-model", permissionMode: "auto-review" } });
  await new Promise(setImmediate);
  assert.deepEqual(h.attached, ["new-live-a"]);
  assert.equal(h.state.liveView.liveSessionId, "new-live-a");
  assert.equal(h.state.liveView.sessionMeta.model, "saved-model");
  h.reads[1].resolve(h.payload("a"));
  await reconnect;
  assert.equal(h.requests.some((item) => item.url.includes("/input")), false);
  assert.equal(h.state.liveView.recoveringSocket, false);
  h.runtime.stopHistorySyncLoop();
});

test("history-provided live continuation is reused before looking up the lost session", async () => {
  const h = createHarness({ onLookup: async () => assert.fail("history already supplied the replacement") });
  prepareRecovery(h);
  h.reads[0].resolve({ ...h.payload("a"), session: { id: "existing-new-live", kind: "live", provider: "codex", resumeSessionId: "a" } });
  await new Promise(setImmediate);
  const reconnect = runReconnect(h);
  await new Promise(setImmediate);
  assert.deepEqual(h.lookups, []);
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.attached, ["existing-new-live"]);
  h.reads[1].resolve(h.payload("a"));
  await reconnect;
  assert.equal(h.state.liveView.liveSessionId, "existing-new-live");
  h.runtime.stopHistorySyncLoop();
});

test("recovery rejects unrelated live identities from hydration and session creation", async () => {
  const h = createHarness({ onLookup: async () => { throw Object.assign(new Error("not found"), { status: 404 }); } });
  prepareRecovery(h);
  h.reads[0].resolve({ ...h.payload("a"), session: { id: "other-live", kind: "live", provider: "codex", resumeSessionId: "b" } });
  await new Promise(setImmediate);
  const reconnect = runReconnect(h);
  await new Promise(setImmediate);
  assert.deepEqual(h.lookups, ["old-live-a"]);
  h.requests[0].resolve({ session: { id: "wrong-new-live", kind: "live", provider: "codex", resumeSessionId: "b" } });
  await reconnect;
  assert.deepEqual(h.attached, []);
  assert.equal(h.state.liveView.liveSessionId, "old-live-a");
  assert.equal(h.state.threadView.threadId, "a");
  h.runtime.stopSocketRecovery();
  h.runtime.stopHistorySyncLoop();
});

for (const status of [undefined, 401, 503]) {
  test(`recovery lookup ${status || "network"} failure never creates a new session`, async () => {
    const h = createHarness({ onLookup: async () => { throw Object.assign(new Error("unavailable"), status ? { status } : {}); } });
    prepareRecovery(h);
    h.reads[0].resolve(h.payload("a"));
    await new Promise(setImmediate);
    await runReconnect(h);
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.attached, []);
    assert.equal(h.state.liveView.liveSessionId, "old-live-a");
    assert.equal(h.timeouts.size, 1);
    h.runtime.stopSocketRecovery();
    h.runtime.stopHistorySyncLoop();
  });
}

test("a replacement session response arriving after switching threads cannot rebind the new thread", async () => {
  const h = createHarness({ onLookup: async () => { throw Object.assign(new Error("not found"), { status: 404 }); } });
  prepareRecovery(h);
  h.reads[0].resolve(h.payload("a"));
  await new Promise(setImmediate);
  const reconnect = runReconnect(h);
  await new Promise(setImmediate);
  h.route.params.sessionId = "history:codex:b";
  const opening = h.runtime.openThreadSession(h.thread("b"), { skipRoute: true });
  h.reads[1].resolve(h.payload("b"));
  await opening;
  h.state.statusText = "B status";
  h.requests[0].resolve({ session: { id: "late-new-live-a", kind: "live", provider: "codex", resumeSessionId: "a" } });
  await reconnect;
  assert.deepEqual(h.attached, []);
  assert.equal(h.state.threadView.threadId, "b");
  assert.equal(h.state.threadView.persistedSnapshot.threadId, "b");
  assert.equal(h.state.liveView.liveSessionId, "");
  assert.equal(h.state.statusText, "B status");
  assert.equal(h.timeouts.size, 0);
  h.runtime.stopHistorySyncLoop();
});

test("a late old-session 404 after switching threads cannot create a recovery session", async () => {
  const lookup = deferred();
  const h = createHarness({ onLookup: () => lookup.promise });
  prepareRecovery(h);
  h.reads[0].resolve(h.payload("a"));
  await new Promise(setImmediate);
  const reconnect = runReconnect(h);
  await new Promise(setImmediate);
  h.route.params.sessionId = "history:codex:b";
  const opening = h.runtime.openThreadSession(h.thread("b"), { skipRoute: true });
  h.reads[1].resolve(h.payload("b"));
  await opening;
  lookup.reject(Object.assign(new Error("not found"), { status: 404 }));
  await reconnect;
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.attached, []);
  assert.equal(h.state.threadView.threadId, "b");
  h.runtime.stopHistorySyncLoop();
});

test("HTTP API errors expose response status while network errors stay distinguishable", async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [404, 503]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: "API failure" }), { status, headers: { "Content-Type": "application/json" } });
      await assert.rejects(apiRequest("/api/sessions/missing"), (error) => error.status === status && error.message === "API failure");
    }
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    await assert.rejects(apiRequest("/api/sessions/missing"), (error) => error instanceof TypeError && error.status === undefined);
  } finally { globalThis.fetch = original; }
});
