import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Koa from "koa";
import { createSessionCatalogPages } from "../src/sessions/history/sessionCatalogPages.js";
import { handleSessionCatalogRoute } from "../src/routes/sessionCatalog.js";
import { installResponseRuntime } from "../src/runtime/http/response.js";
import { buildGroupedSessions, createSessionSearch } from "../web/src/lib/session-list.js";

const session = (index, extra = {}) => ({ id: `history:codex:t${index}`, provider: "codex", providerLabel: "Codex",
  resumeSessionId: `t${index}`, threadId: `t${index}`, name: `Thread ${index}`, cwd: "/workspace/shared",
  kind: "history", status: "saved", updatedAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  inputPreview: `Preview ${index}`, model: "real-current", reasoningEffort: "high", permissionMode: "default", ...extra });
const group = (id, sessions, extra = {}) => ({ id, projectId: id, groupKind: "project", name: id,
  cwd: "/workspace/shared", rootPaths: ["/workspace/shared", "/workspace/alias"], sessions, ...extra });
const fixture = (count = 47) => {
  const sessions = Array.from({ length: count }, (_, index) => session(index));
  return { sessions, projectGroups: [group("project:a", sessions)],
    sidebarPreferences: { grouping: "project", projects: "manual" }, sidebarStatus: { source: "fixture", degraded: false } };
};
const pagesFor = (payload, options = {}) => createSessionCatalogPages({ loadSnapshot: async () => payload, ...options });
const ids = (sessions) => sessions.map((entry) => entry.id);
const assertCode = async (task, status, code) => assert.rejects(task, (error) => error.status === status && error.code === code);

test("bootstrap bounds unique briefs to 20, retains all canonical groups and skips collapsed members", async () => {
  const payload = fixture(72);
  payload.projectGroups = Array.from({ length: 7 }, (_, index) => group(`project:${index}`, payload.sessions.slice(index * 10, index * 10 + 10),
    { collapsed: index === 0, order: index, pinned: index === 2 }));
  const page = await pagesFor(payload).read({});
  assert.equal(page.catalogFormat, "paged-v1");
  assert.equal(page.sessions.length, 20);
  assert.deepEqual(page.projectGroups.map((entry) => entry.id), [...payload.projectGroups.map((entry) => entry.id), "recent:unassigned"]);
  assert.deepEqual(page.projectGroups.slice(0, 7).map((entry) => entry.catalogPage.total), Array(7).fill(10));
  assert.deepEqual(page.projectGroups.slice(0, 7).map((entry) => entry.sessions.length), [0, 5, 5, 5, 5, 0, 0]);
  assert.ok(page.projectGroups.every((entry) => entry.catalogPage.nextCursor));
  assert.deepEqual(page.projectGroups[2].rootPaths, payload.projectGroups[2].rootPaths);
  assert.equal(page.projectGroups[2].pinned, true);
  assert.equal(page.catalogPage.sessionsTotal, 72);
  assert.equal(page.catalogPage.total, 72);
  for (const brief of [...page.sessions, ...page.projectGroups.flatMap((entry) => entry.sessions)]) {
    for (const key of ["inputPreview", "displayPreview", "model", "reasoningEffort", "permissionMode"]) assert.equal(Object.hasOwn(brief, key), false);
    assert.ok(brief.id && brief.cwd && brief.resumeSessionId);
  }
  assert.equal(payload.projectGroups[0].sessions.length, 10);
});

test("search sees every full preview including the last row and matches old AND/NFKC semantics", async () => {
  const payload = fixture(91);
  payload.sessions[90].inputPreview = `Long prefix ${"x".repeat(4000)} 特征词 ＡＢＣ 最后内容`;
  Object.assign(payload.sessions[0], { displayTitle: "StaleTitle", displayPreview: "StalePreview", groupName: "StaleGroup" });
  payload.projectGroups.push(group("empty", [], { name: "空 项目" }));
  const controller = pagesFor(payload);
  const groups = buildGroupedSessions(payload.sessions, payload.projectGroups);
  for (const query of ["特征词 ABC", "最后内容", "Thread 90", "ＷＯＲＫＳＰＡＣＥ 预览", "PROJECT:A preview 7", "空 项目", "不存在", "共享", "StaleTitle", "StalePreview", "StaleGroup"]) {
    const expected = createSessionSearch(groups)(query);
    const actual = await controller.read({ q: query });
    assert.deepEqual(actual.projectGroups.map((entry) => [entry.id, entry.catalogPage.total]), expected.map((entry) => [entry.id, entry.sessions.length]), query);
    assert.equal(actual.catalogPage.sessionsTotal, new Set(expected.flatMap((entry) => ids(entry.sessions))).size, query);
  }
  const found = await controller.read({ q: "  特征词\tＡＢＣ  " });
  assert.equal(found.query, "特征词 abc");
  assert.deepEqual(ids(found.sessions), [payload.sessions[90].id]);
  assert.equal(JSON.stringify(found).includes("最后内容"), false);
});

test("same-cwd groups keep separate IDs and alias memberships while unassigned rows remain reachable", async () => {
  const first = session(1);
  const alias = { ...first, id: "live-alias", kind: "live" };
  const second = session(2);
  const unassigned = session(3);
  const payload = { sessions: [first, alias, second, unassigned], projectGroups: [group("legacy-id", [first]),
    group("server-id", [alias, second], { projectId: "mapped-project", order: 1 })] };
  const page = await pagesFor(payload).read({});
  assert.deepEqual(page.projectGroups.map((entry) => entry.id), ["legacy-id", "server-id", "recent:unassigned"]);
  assert.deepEqual(page.projectGroups.map((entry) => ids(entry.sessions)), [[first.id], [alias.id, second.id], [unassigned.id]]);
  assert.equal(page.projectGroups[1].projectId, "mapped-project");
  assert.equal(page.catalogPage.activitiesTotal, 3);
  const fallback = await pagesFor({ sessions: [unassigned] }).read({});
  assert.equal(fallback.projectGroups[0].id, "recent:unassigned");
  assert.deepEqual(ids(fallback.sessions), [unassigned.id]);
});

test("group cursor freezes the original snapshot and pages without repeats or omissions", async () => {
  let payload = fixture(47), reads = 0;
  const controller = createSessionCatalogPages({ loadSnapshot: async () => { reads += 1; return payload; } });
  const first = await controller.read({ group: "project:a", limit: 20 });
  const collected = [...ids(first.sessions)];
  let cursor = first.projectGroups[0].catalogPage.nextCursor;
  payload.sessions.unshift(session(999));
  payload.projectGroups[0].sessions[0].name = "Changed after capture";
  payload.projectGroups[0].rootPaths.push("/workspace/new-alias");
  while (cursor) {
    const page = await controller.read({ group: "project:a", limit: 20, cursor });
    assert.equal(page.revision, first.revision);
    assert.deepEqual(page.projectGroups[0].rootPaths, ["/workspace/shared", "/workspace/alias"]);
    collected.push(...ids(page.sessions));
    cursor = page.projectGroups[0].catalogPage.nextCursor;
  }
  assert.equal(reads, 1);
  assert.deepEqual(collected, Array.from({ length: 47 }, (_, index) => session(index).id));
  assert.equal(new Set(collected).size, 47);
  const refreshed = await controller.read({ group: "project:a" });
  assert.notEqual(refreshed.revision, first.revision);
  assert.equal(refreshed.sessions[0].name, "Changed after capture");
});

test("cursor rejects changed query/view/group/limit, malformed tokens, loaded mixing and tampering", async () => {
  const controller = pagesFor(fixture());
  const page = await controller.read({ group: "project:a", q: "preview", limit: 20 });
  const cursor = page.projectGroups[0].catalogPage.nextCursor;
  for (const options of [
    { q: "other" }, { view: "activity" }, { group: "another" }, { limit: 19 }, { loaded: '{}' },
    { cursor: "bogus" }, { cursor: `${cursor.slice(0, -2)}zz` }
  ]) await assertCode(controller.read({ group: "project:a", q: "preview", limit: 20, cursor, ...options }), 400, "CATALOG_INVALID_REQUEST");
});

test("snapshots expire after 120s, retain at most four revisions and never reload for stale cursors", async () => {
  let now = 1000, reads = 0, payload = fixture();
  const controller = createSessionCatalogPages({ now: () => now, loadSnapshot: async () => { reads += 1; return payload; } });
  const first = await controller.read({ group: "project:a" });
  const cursor = first.projectGroups[0].catalogPage.nextCursor;
  for (let index = 0; index < 4; index += 1) {
    payload = fixture(); payload.sessions[0].name = `Revision ${index}`;
    await controller.read({ group: "project:a" });
  }
  const before = reads;
  await assertCode(controller.read({ group: "project:a", cursor }), 409, "CATALOG_SNAPSHOT_EXPIRED");
  assert.equal(reads, before);
  const fresh = await controller.read({ group: "project:a" });
  now += 120_000;
  await assertCode(controller.read({ group: "project:a", cursor: fresh.projectGroups[0].catalogPage.nextCursor }), 409, "CATALOG_SNAPSHOT_EXPIRED");
  assert.equal(reads, before + 1);
});

test("request limits and loaded maps reject invalid or ambiguous reads before loading", async () => {
  let reads = 0;
  const controller = createSessionCatalogPages({ loadSnapshot: async () => { reads += 1; return fixture(); } });
  for (const options of [{ limit: 0 }, { limit: 21 }, { limit: 1.5 }, { view: "all" }, { q: "a".repeat(1001) },
    { loaded: '[]' }, { loaded: '{"project:a":-1}' }, { loaded: '{"project:a":9007199254740992}' },
    { view: "activity", loaded: '{"project:a":2}' }, { loaded: `{"project:a":0}${" ".repeat(100_000)}` },
    { loaded: '{"project:a":1.2}' }, { loaded: '{"project:a":"2"}' }]) {
    await assertCode(controller.read(options), 400, "CATALOG_INVALID_REQUEST");
  }
  assert.equal(reads, 0);
});

test("refresh loaded ranges stays bounded, includes no unseen group rows and updates active counts", async () => {
  const payload = fixture(80);
  payload.projectGroups = [group("project:a", payload.sessions.slice(0, 40)), group("project:b", payload.sessions.slice(40), { collapsed: true })];
  payload.sessions[0].activityState = "running";
  const controller = pagesFor(payload);
  const page = await controller.read({ loaded: '{"project:a":23,"project:b":0}' });
  assert.equal(page.sessions.length, 23);
  assert.deepEqual(page.projectGroups.map((entry) => entry.sessions.length), [23, 0]);
  assert.equal(page.projectGroups[0].catalogPage.running, 1);
  assert.equal(page.catalogPage.runningTotal, 1);
  const activity = await controller.read({ view: "activity", loaded: '{"activity":31}' });
  assert.equal(activity.sessions.length, 31);
  assert.deepEqual(ids(activity.sessions), ids([...payload.sessions].reverse().slice(0, 31)));
  assert.ok(activity.catalogPage.nextCursor);
  const removed = await controller.read({ loaded: '{"removed:group":20,"project:a":5}' });
  assert.equal(removed.sessions.length, 5);
});

test("parallel initial readers share capture and refresh preserves more than 2000 loaded records across groups", async () => {
  const payload = fixture(2100);
  payload.projectGroups = [group("a", payload.sessions.slice(0, 1000)), group("b", payload.sessions.slice(1000, 2000)), group("c", payload.sessions.slice(2000))];
  let release, reads = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const controller = createSessionCatalogPages({ loadSnapshot: async () => { reads += 1; await gate; return payload; } });
  const first = controller.read({}), second = controller.read({});
  release();
  assert.equal((await first).revision, (await second).revision);
  assert.equal(reads, 1);
  const refresh = await controller.read({ loaded: '{"a":1000,"b":1000,"c":100}' });
  assert.equal(refresh.sessions.length, 2100);
  assert.deepEqual(refresh.projectGroups.map((entry) => entry.sessions.length), [1000, 1000, 100]);
});

test("a group refresh preserves 1005 loaded rows and all remaining rows stay reachable after snapshot expiry", async () => {
  const payload = fixture(1045);
  let now = 1000;
  const controller = pagesFor(payload, { now: () => now });
  const first = await controller.read({ loaded: '{"project:a":1005}' });
  assert.equal(first.sessions.length, 1005);
  assert.deepEqual(ids(first.sessions), ids(payload.sessions.slice(0, 1005)));
  now += 120_000;
  await assertCode(controller.read({ group: "project:a", cursor: first.projectGroups[0].catalogPage.nextCursor }), 409, "CATALOG_SNAPSHOT_EXPIRED");
  const refreshed = await controller.read({ loaded: '{"project:a":1005}' });
  assert.notEqual(refreshed.revision, first.revision);
  assert.equal(refreshed.sessions.length, 1005);
  const collected = [...ids(refreshed.sessions)];
  let cursor = refreshed.projectGroups[0].catalogPage.nextCursor;
  while (cursor) {
    const page = await controller.read({ group: "project:a", cursor });
    assert.equal(page.sessions.length, 20);
    collected.push(...ids(page.sessions));
    cursor = page.projectGroups[0].catalogPage.nextCursor;
  }
  assert.deepEqual(collected, ids(payload.sessions));
  assert.equal(new Set(collected).size, 1045);
});

test("activity refresh preserves more than 1000 rows and the rest remain pageable", async () => {
  const payload = fixture(1045);
  const controller = pagesFor(payload);
  const refreshed = await controller.read({ view: "activity", loaded: '{"activity":1005}' });
  assert.equal(refreshed.sessions.length, 1005);
  const collected = [...ids(refreshed.sessions)];
  let cursor = refreshed.catalogPage.nextCursor;
  while (cursor) {
    const page = await controller.read({ view: "activity", cursor });
    assert.equal(page.sessions.length, 20);
    collected.push(...ids(page.sessions));
    cursor = page.catalogPage.nextCursor;
  }
  assert.deepEqual(collected, ids([...payload.sessions].reverse()));
});

test("safe large loaded counts clamp to actual snapshot rows without allocating the requested count", async () => {
  const payload = fixture(47);
  const controller = pagesFor(payload);
  const groups = await controller.read({ loaded: JSON.stringify({ "project:a": Number.MAX_SAFE_INTEGER }) });
  assert.deepEqual(ids(groups.sessions), ids(payload.sessions));
  assert.equal(groups.projectGroups[0].catalogPage.nextCursor, null);
  const activity = await controller.read({ view: "activity", loaded: JSON.stringify({ activity: Number.MAX_SAFE_INTEGER }) });
  assert.deepEqual(ids(activity.sessions), ids([...payload.sessions].reverse()));
  assert.equal(activity.catalogPage.nextCursor, null);
});

test("activity uses latest identity once, retains cross-group membership order and pages stably", async () => {
  const payload = fixture(31);
  const alias = { ...payload.sessions[30], id: "new-live-alias", updatedAt: "2030-01-01T00:00:00Z", activityState: "running" };
  payload.projectGroups.push(group("project:b", [payload.sessions[0], alias], { name: "Alias project" }));
  const controller = pagesFor(payload);
  const first = await controller.read({ view: "activity" });
  assert.equal(first.sessions[0].id, alias.id);
  assert.equal(first.catalogPage.activitiesTotal, 31);
  assert.deepEqual(ids(first.projectGroups[0].sessions), ids(payload.sessions.slice(11)));
  const next = await controller.read({ view: "activity", cursor: first.catalogPage.nextCursor });
  const all = [...first.sessions, ...next.sessions];
  assert.equal(all.length, 31);
  assert.equal(new Set(all.map((entry) => entry.resumeSessionId)).size, 31);
  assert.equal(next.catalogPage.nextCursor, null);
});

test("unchanged source reuses revision for validators and degraded snapshots remain explicit", async () => {
  const payload = fixture();
  const controller = pagesFor(payload);
  const first = await controller.read({});
  assert.equal((await controller.read({})).revision, first.revision);
  const degraded = await pagesFor({ sessions: [], projectGroups: [], sidebarStatus: { degraded: true, warnings: ["Database unavailable"] } }).read({});
  assert.equal(degraded.sidebarStatus.degraded, true);
  assert.equal(degraded.catalogPage.degraded, true);
  assert.deepEqual(degraded.sidebarStatus.warnings, ["Database unavailable"]);
});

async function startRouteFixture(t) {
  let reads = 0, unavailable = false;
  const payload = fixture();
  const runtime = { sessionManager: { async listSidebarSnapshotAsync() {
    reads += 1;
    if (unavailable) throw Object.assign(new Error("synthetic-private-source-location"), { status: 400 });
    return payload;
  } } };
  installResponseRuntime(runtime);
  runtime.requireAuthorized = (ctx) => {
    if (ctx.get("Authorization") === "Bearer synthetic-test-token") return true;
    runtime.unauthorized(ctx); return false;
  };
  const app = new Koa();
  app.use(async (ctx) => { if (!await handleSessionCatalogRoute(ctx, runtime)) ctx.status = 404; });
  const server = http.createServer(app.callback());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/api/session-catalog`,
    headers: { Authorization: "Bearer synthetic-test-token" }, fail: () => { unavailable = true; }, get reads() { return reads; } };
}

test("HTTP route authorizes before reads or validators and keeps cache, compression and safety headers", async (t) => {
  const server = await startRouteFixture(t);
  const unauthorized = await fetch(server.url);
  assert.equal(unauthorized.status, 401);
  assert.equal(server.reads, 0);
  assert.equal(unauthorized.headers.get("ETag"), null);
  const response = await fetch(server.url, { headers: { ...server.headers, "Accept-Encoding": "br" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Encoding"), "br");
  assert.equal(response.headers.get("Cache-Control"), "private, no-cache");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  const page = await response.json();
  assert.equal(page.sessions.length, 5);
  assert.equal(Object.hasOwn(page, "sidebarFormat"), false);
  const next = await fetch(`${server.url}?group=project%3Aa&cursor=${encodeURIComponent(page.projectGroups[0].catalogPage.nextCursor)}`, { headers: server.headers });
  assert.equal(next.status, 200);
  assert.equal((await next.json()).sessions.length, 20);
  assert.equal(server.reads, 1, "cursor requests must never build a newer source snapshot");
  const etag = response.headers.get("ETag");
  assert.ok(etag);
  const unchanged = await fetch(server.url, { headers: { ...server.headers, "If-None-Match": etag } });
  assert.equal(unchanged.status, 304);
  const denied = await fetch(server.url, { headers: { "If-None-Match": etag } });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("ETag"), null);
  const wrong = await fetch(`${server.url}?cursor=bad`, { headers: server.headers });
  assert.equal(wrong.status, 400);
  const rejected = await fetch(server.url, { headers: { ...server.headers, "Accept-Encoding": "identity;q=0,br;q=0,gzip;q=0" } });
  assert.equal(rejected.status, 406);
  server.fail();
  const unavailable = await fetch(server.url, { headers: server.headers });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.text()).includes("synthetic-private-source-location"), false);
});
