import test from "node:test";
import assert from "node:assert/strict";
import { createPagedSessionCatalog } from "../web/src/lib/paged-session-catalog.js";
import { createSessionCatalogPages } from "../src/sessions/history/sessionCatalogPages.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const row = (id) => ({ id, name: id, provider: "codex", resumeSessionId: id, kind: "history" });
function payload({ revision = "r1", query = "", view = "groups", ids = ["a"], next = "next", groups } = {}) {
  const sessions = ids.map(row);
  return { catalogFormat: "paged-v1", revision, query, view, sessions,
    projectGroups: groups || [{ id: "project:a", name: "项目甲", sessions, catalogPage: { total: 30, running: 0, nextCursor: next } }],
    catalogPage: { total: 30, runningTotal: 0, sessionsTotal: 30, activitiesTotal: 30, nextCursor: view === "activity" ? next : null } };
}
function setup(respond) {
  const state = { isAuthenticated: true, sessions: [], projectGroups: [], sessionSearch: "" };
  const calls = [], sessionCache = {};
  const catalog = createPagedSessionCatalog({ state, sessionCache, request: (url, options) => {
    const parsed = new URL(url, "http://localhost"); calls.push({ params: parsed.searchParams, options });
    return respond(parsed.searchParams, calls.length);
  } });
  return { state, catalog, calls, sessionCache };
}

test("first page is independently ready and a repeated refresh requests only loaded group ranges", async () => {
  const { state, catalog, calls, sessionCache } = setup(() => Promise.resolve(payload()));
  await catalog.refresh();
  assert.equal(calls[0].params.has("loaded"), false);
  assert.equal(calls[0].params.get("limit"), "20");
  assert.equal(state.sessionListReady, true);
  assert.equal(state.sessionListComplete, false, "a page must not masquerade as a complete legacy catalog");
  assert.equal(sessionCache["thread:codex:a"].title, "a");
  await catalog.refresh();
  assert.deepEqual(JSON.parse(calls[1].params.get("loaded")), { "project:a": 1 });
});

test("visible unloaded groups and explicit further pages are single flight and merge without duplicating rows", async () => {
  const pending = deferred();
  const { state, catalog, calls } = setup((_params, count) => count === 1 ? Promise.resolve(payload({ ids: [] })) : pending.promise);
  await catalog.refresh();
  const first = catalog.loadGroup("project:a"), second = catalog.loadGroup("project:a");
  assert.equal(calls.length, 2);
  assert.equal(state.sessionCatalog.loadingGroups.has("project:a"), true);
  await catalog.refresh();
  assert.equal(calls.length, 2, "background refresh cannot invalidate a page currently in transit");
  pending.resolve(payload({ ids: ["a", "b"] }));
  await Promise.all([first, second]);
  assert.deepEqual(state.sessions.map(({ id }) => id), ["a", "b"]);
  assert.equal(state.sessionCatalog.loadingGroups.size, 0);
  await catalog.loadGroup("project:a");
  assert.equal(calls.length, 2, "viewport notifications do not refetch loaded pages");
  await catalog.loadGroup("project:a", { more: true });
  assert.deepEqual(state.sessions.map(({ id }) => id), ["a", "b"]);
});

test("search is normalized and sent to the server; an old response cannot publish across query changes", async () => {
  const old = deferred();
  const { state, catalog, calls } = setup((params, count) => count === 1 ? old.promise : Promise.resolve(payload({ query: params.get("q"), ids: ["tail-match"] })));
  const first = catalog.refresh();
  await catalog.setView({ query: "  ＡＢＣ   尾部  " });
  assert.equal(calls[1].params.get("q"), "abc 尾部");
  assert.equal(calls[0].options.signal.aborted, true);
  old.resolve(payload({ ids: ["old"] })); await first;
  assert.deepEqual(state.sessions.map(({ id }) => id), ["tail-match"]);
  assert.equal(state.sessionCatalog.query, "abc 尾部");
});

test("activity mode appends server pages and retains the same revision and group membership", async () => {
  const { state, catalog, calls } = setup((params, count) => Promise.resolve(payload({ view: params.get("view"), ids: count === 1 ? ["a"] : ["a", "b"], next: count === 1 ? "older" : null })));
  await catalog.setView({ view: "activity" });
  await catalog.loadMore();
  assert.equal(calls[1].params.get("cursor"), "older");
  assert.deepEqual(state.sessions.map(({ id }) => id), ["a", "b"]);
  assert.equal(state.sessionCatalog.page.nextCursor, null);
});

test("running activity requests full filtered pages and preserves filter and loaded range through refresh", async () => {
  const sessions = Array.from({ length: 120 }, (_, index) => ({ ...row(`s${index}`), updatedAt: index + 1,
    activityState: index < 100 && index % 2 === 0 ? "running" : "idle" }));
  const server = createSessionCatalogPages({ loadSnapshot: () => ({ sessions,
    projectGroups: [{ id: "project:a", name: "A", sessions }] }) });
  const { state, catalog, calls } = setup((params) => server.read(params));
  assert.equal(state.sessionCatalog.runningOnly, false);
  await catalog.refresh();
  assert.equal(calls[0].params.has("running"), false);
  await catalog.setView({ view: "activity", runningOnly: true });
  assert.equal(state.sessionCatalog.runningOnly, true);
  assert.equal(calls[1].params.get("running"), "1");
  assert.equal(calls[1].params.has("loaded"), false);
  assert.equal(state.sessions.length, 20);
  assert.ok(state.sessions.every((entry) => entry.activityState === "running"));
  const cursor = state.sessionCatalog.page.nextCursor;
  await catalog.loadMore();
  assert.equal(calls[2].params.get("cursor"), cursor);
  assert.equal(calls[2].params.get("running"), "1");
  assert.equal(state.sessions.length, 40);
  sessions[98].activityState = "idle";
  sessions[119].activityState = "running";
  await catalog.refresh();
  assert.equal(calls[3].params.get("running"), "1");
  assert.deepEqual(JSON.parse(calls[3].params.get("loaded")), { activity: 40 });
  assert.equal(state.sessions.length, 40);
  assert.equal(state.sessions[0].id, "s119");
  await catalog.loadMore();
  assert.deepEqual(state.sessions.map((entry) => entry.id), sessions.filter((entry) => entry.activityState === "running").reverse().map((entry) => entry.id));
  assert.equal(state.sessionCatalog.page.nextCursor, null);
  await catalog.setView({ query: "s119" });
  assert.equal(calls.at(-1).params.get("running"), "1");
  assert.deepEqual(state.sessions.map((entry) => entry.id), ["s119"]);
  await catalog.setView({ view: "groups", runningOnly: true });
  assert.equal(state.sessionCatalog.runningOnly, false);
  assert.equal(calls.at(-1).params.has("running"), false);
});

test("running response context mismatches cannot publish a manifest or append a page", async () => {
  for (const response of [payload({ view: "activity" }), { ...payload({ view: "activity" }), runningOnly: false }]) {
    const { state, catalog } = setup(() => Promise.resolve(response));
    await assert.rejects(catalog.setView({ view: "activity", runningOnly: true }), /会话列表格式无效/);
    assert.deepEqual(state.sessions, []);
    assert.equal(state.sessionListReady, false);
    assert.equal(state.sessionCatalog.loading, false);
  }
  const { state, catalog } = setup((_params, count) => Promise.resolve({ ...payload({ view: "activity", ids: count === 1 ? ["a"] : ["unfiltered"] }),
    ...(count === 1 ? { runningOnly: true } : {}) }));
  await catalog.setView({ view: "activity", runningOnly: true });
  await assert.rejects(catalog.loadMore(), /会话列表格式无效/);
  assert.deepEqual(state.sessions.map((entry) => entry.id), ["a"]);
  assert.match(state.sessionCatalog.groupErrors.get("activity"), /会话列表格式无效/);
  const ordinary = setup(() => Promise.resolve({ ...payload({ view: "activity" }), runningOnly: true }));
  await assert.rejects(ordinary.catalog.setView({ view: "activity" }), /会话列表格式无效/);
  assert.deepEqual(ordinary.state.sessions, []);
});

test("switching the running filter cancels an ordinary response and switching groups clears the filter", async () => {
  const old = deferred();
  const { state, catalog, calls } = setup((params, count) => count === 1 ? old.promise : Promise.resolve({
    ...payload({ view: params.get("view"), ids: [params.has("running") ? "running" : "group"] }),
    ...(params.has("running") ? { runningOnly: true } : {}) }));
  const pending = catalog.setView({ view: "activity" });
  await catalog.setView({ view: "activity", runningOnly: true });
  assert.equal(calls[0].options.signal.aborted, true);
  old.resolve(payload({ view: "activity", ids: ["late-unfiltered"] }));
  await pending;
  assert.deepEqual(state.sessions.map((entry) => entry.id), ["running"]);
  await catalog.setView({ view: "groups" });
  assert.equal(state.sessionCatalog.runningOnly, false);
  assert.equal(calls.at(-1).params.has("running"), false);
  assert.deepEqual(state.sessions.map((entry) => entry.id), ["group"]);
  catalog.invalidate();
  assert.equal(state.sessionCatalog.runningOnly, false);
});

test("an initially empty activity view discovers new sessions on the next refresh", async () => {
  const { state, catalog, calls } = setup((params, count) => Promise.resolve(payload({ view: params.get("view"),
    ids: count === 1 ? [] : ["new-thread"], next: null })));
  await catalog.setView({ view: "activity" }); await catalog.refresh();
  assert.equal(JSON.parse(calls[1].params.get("loaded")).activity, 20);
  assert.deepEqual(state.sessions.map(({ id }) => id), ["new-thread"]);
});

test("a catalog with more than 1000 loaded entries can refresh and continue after snapshot expiry", async () => {
  const sessions = Array.from({ length: 1045 }, (_, index) => row(`s${index}`));
  let time = 0;
  const server = createSessionCatalogPages({ now: () => time, loadSnapshot: () => ({ sessions,
    projectGroups: [{ id: "project:a", name: "A", sessions }] }) });
  const { state, catalog } = setup((params) => server.read(params));
  await catalog.refresh();
  for (let page = 0; page < 50; page += 1) await catalog.loadGroup("project:a", { more: true });
  assert.equal(state.sessions.length, 1005);
  await catalog.refresh();
  assert.equal(state.sessions.length, 1005);
  time = 120001;
  await catalog.loadGroup("project:a", { more: true });
  assert.equal(state.sessions.length, 1005, "expired cursors must preserve the requested loaded range during refresh");
  await catalog.loadGroup("project:a", { more: true });
  await catalog.loadGroup("project:a", { more: true });
  assert.equal(state.sessions.length, 1045);
  assert.equal(new Set(state.sessions.map(({ id }) => id)).size, 1045);
});

test("page failures retain the usable list, clear busy state, and remain explicitly retryable", async () => {
  const { state, catalog } = setup((_params, count) => count === 1 ? Promise.resolve(payload()) : count === 2
    ? Promise.reject(new Error("offline")) : Promise.resolve(payload({ ids: ["b"], next: null })));
  await catalog.refresh();
  await assert.rejects(catalog.loadGroup("project:a", { more: true }), /offline/);
  assert.deepEqual(state.sessions.map(({ id }) => id), ["a"]);
  assert.equal(state.sessionCatalog.groupErrors.get("project:a"), "offline");
  assert.equal(state.sessionCatalog.loadingGroups.size, 0);
  await catalog.loadGroup("project:a", { more: true });
  assert.deepEqual(state.sessions.map(({ id }) => id), ["a", "b"]);
  assert.equal(state.sessionCatalog.groupErrors.size, 0);
});

test("an expired snapshot refreshes known ranges instead of merging a page from a different snapshot", async () => {
  const { state, catalog, calls } = setup((_params, count) => count === 1 ? Promise.resolve(payload()) : count === 2
    ? Promise.reject(Object.assign(new Error("expired"), { status: 409 })) : Promise.resolve(payload({ revision: "r2", ids: ["fresh"] })));
  await catalog.refresh(); await catalog.loadGroup("project:a", { more: true });
  assert.equal(calls.length, 3);
  assert.equal(state.sessionCatalog.revision, "r2");
  assert.deepEqual(state.sessions.map(({ id }) => id), ["fresh"]);
});

test("route cancellation settles ignored transports and auth invalidation prevents late publication", async () => {
  const pending = deferred();
  const { state, catalog, calls } = setup(() => pending.promise);
  const operation = catalog.refresh(); catalog.invalidate(); state.isAuthenticated = false;
  await operation;
  pending.resolve(payload()); await new Promise(setImmediate);
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(state.sessionListLoading, false);
  assert.equal(state.sessionListReady, false);
  assert.deepEqual(state.sessions, []);
  assert.equal(state.sessionCatalog.revision, "");
});

test("invalid or degraded empty responses cannot confirm an empty directory", async () => {
  for (const response of [{}, { ...payload({ ids: [] }), sidebarStatus: { degraded: true } }]) {
    const { state, catalog } = setup(() => Promise.resolve(response));
    await assert.rejects(catalog.refresh());
    assert.equal(state.sessionListReady, undefined);
    assert.equal(state.sessionListLoading, false);
    assert.ok(state.sessionListError);
  }
});
