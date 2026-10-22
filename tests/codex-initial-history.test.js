import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readInitialHistory } from "../src/sessions/codex/initialHistory.js";
import { handleCodexV2Route } from "../src/routes/codexV2.js";
import { handleAuthRoute } from "../src/routes/auth.js";
import { createCodexChatStore } from "../web/src/lib/codex-chat-store.js";
import { createCodexReadRefresh } from "../web/src/lib/codex-read-refresh.js";
import { createCodexChatRuntime } from "../web/src/lib/codex-chat-runtime.js";
import { presentCodexChatSnapshot } from "../web/src/lib/codex-chat-presentation.js";

const item = (id, text = id, extra = {}) => ({ id, type: "agentMessage", text, status: "completed", ...extra });
function initial(items = [item("last")], { summaries = [], status = "completed", turnId = "turn" } = {}) {
  return {
    turnsPage: { threadId: "thread", turns: [{ id: turnId, status, items: summaries }], olderCursor: "older-turn", hasMore: true },
    itemsPage: { threadId: "thread", turnId, items, latestItemId: items.at(-1)?.id || null, nextCursor: "older-items", hasMore: true }
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(setImmediate);
function service(payload = initial()) {
  const calls = [];
  return { calls, reader: {
    async listTurns(threadId, options) { calls.push({ kind: "turns", threadId, options }); return payload.turnsPage; },
    async listItems(threadId, turnId, options) { calls.push({ kind: "items", threadId, turnId, options }); return payload.itemsPage; }
  }, reconcileRequests: (...args) => calls.push({ kind: "receipts", args }),
  reconcileItems: (...args) => calls.push({ kind: "reconcileItems", args }) };
}

test("initial reader requests exactly one turn then thirty descending items, retaining both cursors", async () => {
  const payload = initial(), s = service(payload), controller = new AbortController();
  assert.deepEqual(await readInitialHistory(s, "thread", { signal: controller.signal }), payload);
  assert.deepEqual(s.calls.slice(0, 2), [
    { kind: "turns", threadId: "thread", options: { limit: 1, signal: controller.signal } },
    { kind: "items", threadId: "thread", turnId: "turn", options: { limit: 30, sortDirection: "desc", signal: controller.signal } }
  ]);
  assert.deepEqual(s.calls.slice(2).map(({ kind }) => kind), ["receipts", "reconcileItems"]);
});

test("empty initial history never reads items or invents a turn", async () => {
  const payload = { turnsPage: { threadId: "thread", turns: [], olderCursor: null, hasMore: false }, itemsPage: null };
  const s = service(payload);
  assert.deepEqual(await readInitialHistory(s, "thread"), payload);
  assert.deepEqual(s.calls.map(({ kind }) => kind), ["turns", "receipts"]);
  const store = createCodexChatStore("thread");
  assert.equal(store.applyInitialHistory(payload), true);
  assert.equal(store.state.initialized, true);
  assert.deepEqual(store.state.turnOrder, []);
});

test("failed items and wrong identities cannot publish a successful initial history or reconcile receipts", async () => {
  for (const mode of ["items-failure", "wrong-thread", "wrong-turn", "oversized"]) {
    const s = service();
    s.reader.listItems = async () => {
      if (mode === "items-failure") throw new Error("items unavailable");
      return { ...initial().itemsPage, ...(mode === "wrong-thread" ? { threadId: "other" } : {}),
        ...(mode === "wrong-turn" ? { turnId: "other" } : {}), ...(mode === "oversized" ? { items: Array.from({ length: 31 }, (_, i) => item(String(i))) } : {}) };
    };
    await assert.rejects(readInitialHistory(s, "thread"));
    assert.equal(s.calls.some(({ kind }) => kind === "receipts"), false);
  }
});

test("cancellation between local reads stops the next phase and ignores late upstream replies", async () => {
  for (const stage of ["turns", "items"]) {
    const pending = deferred(), controller = new AbortController(), s = service();
    const key = stage === "turns" ? "listTurns" : "listItems";
    s.reader[key] = () => pending.promise;
    const reading = readInitialHistory(s, "thread", { signal: controller.signal });
    await tick(); controller.abort();
    pending.resolve(stage === "turns" ? initial().turnsPage : initial().itemsPage);
    await assert.rejects(reading, { name: "AbortError" });
    assert.equal(s.calls.some(({ kind }) => ["items", "receipts", "reconcileItems"].includes(kind)), false);
  }
});

test("initial route authenticates before reading and forwards one cancellation context", async () => {
  const s = service();
  const response = new EventEmitter();
  const ctx = { url: "/api/v2/codex/threads/thread/initial-history?limit=999", method: "GET", res: response };
  let authorized = false;
  const runtime = { codexThreads: s, requireAuthorized: () => authorized,
    json: (ctx, status, body) => { ctx.status = status; ctx.body = body; } };
  assert.equal(await handleCodexV2Route(ctx, runtime), true);
  assert.deepEqual(s.calls, []);
  authorized = true;
  await handleCodexV2Route(ctx, runtime);
  assert.equal(ctx.status, 200);
  assert.deepEqual(ctx.body, initial());
  assert.equal(s.calls[0].options.signal, s.calls[1].options.signal);
  assert.equal(response.listenerCount("close"), 0);
});

test("authenticated session advertises the additive capability while anonymous sessions do not", async () => {
  for (const authenticated of [false, true]) {
    const ctx = { path: "/api/auth/session", method: "GET" };
    await handleAuthRoute(ctx, { getAuthSessionStatus: () => ({ session: authenticated ? { expiresAt: 123 } : null }),
      attachAuthSessionCookie() {}, clearAuthCookie() {}, json: (_ctx, status, body) => { ctx.status = status; ctx.body = body; } });
    assert.equal(ctx.body.authenticated, authenticated);
    assert.deepEqual(ctx.body.capabilities, authenticated ? { initialHistory: 1 } : undefined);
  }
});

test("initial batch prefers full items over the same summary ID and retains hidden summaries", () => {
  const store = createCodexChatStore("thread");
  const full = item("same", "complete response", { hasDetails: false });
  store.applyInitialHistory(initial([full, item("same-text", "complete response")], {
    summaries: [item("head", "question", { type: "userMessage" }), item("same", "short summary", { hasDetails: true })]
  }), store.beginRead());
  const turn = store.state.turns.turn;
  assert.equal(turn.items.same.text, "complete response");
  assert.equal(turn.items.same.hasDetails, false);
  assert.deepEqual(turn.itemsWindowIds, ["same", "same-text"]);
  assert.equal(turn.items.head.text, "question");
  assert.equal(turn.itemsEarlierCursor, "older-items");
  assert.equal(turn.itemsLatestTail, "same-text");
  assert.equal(turn.itemsLatestNextCursor, null);
  assert.equal(store.state.olderCursor, "older-turn");
  assert.equal(turn.itemsLatestHydratedStatus, "completed");
});

test("a delayed initial batch preserves websocket text, completed status, chronology and sequence", () => {
  const store = createCodexChatStore("thread");
  const read = store.beginRead(), generation = store.beginSocket();
  const event = (seq, type, payload) => store.applyEvent({ schemaVersion: 2, threadId: "thread", epoch: "one", seq, type, payload }, generation);
  event(0, "sync.required", {});
  event(1, "turn.upsert", { turn: { id: "turn", status: "completed" } });
  event(2, "item.upsert", { turnId: "turn", item: item("answer", "live completed answer") });
  event(3, "item.upsert", { turnId: "turn", item: item("steer", "new input", { type: "userMessage" }) });
  store.applyInitialHistory(initial([item("answer", "old text", { status: "inProgress" })], { status: "inProgress" }), read);
  assert.equal(store.state.turns.turn.items.answer.text, "live completed answer");
  assert.equal(store.state.turns.turn.status, "completed");
  assert.deepEqual(store.state.turns.turn.itemsWindowIds, ["answer", "steer"]);
  assert.equal(store.state.seq, 3);
  assert.equal(store.state.epoch, "one");
});

test("an old epoch, invalid identity and malformed page leave initial state untouched", () => {
  const store = createCodexChatStore("thread");
  const generation = store.beginSocket();
  const handshake = (epoch) => store.applyEvent({ schemaVersion: 2, threadId: "thread", epoch, seq: 0, type: "sync.required", payload: {} }, generation);
  handshake("one"); const read = store.beginRead(); handshake("two");
  assert.equal(store.applyInitialHistory(initial(), read), false);
  assert.equal(store.state.initialized, false);
  for (const mutate of [
    (payload) => { payload.itemsPage.turnId = "other"; },
    (payload) => { payload.turnsPage.threadId = "other"; },
    (payload) => { payload.turnsPage.turns = [null]; payload.itemsPage = null; payload.turnsPage.hasMore = false; },
    (payload) => { payload.itemsPage.nextCursor = null; },
    (payload) => { payload.itemsPage.latestItemId = "wrong-tail"; }
  ]) {
    const payload = initial(); mutate(payload);
    assert.throws(() => store.applyInitialHistory(payload), /首屏历史/);
    assert.deepEqual(store.state.turnOrder, []);
  }
});

function refreshFixture({ supports = true, readInitial, recheck = async () => true } = {}) {
  const store = createCodexChatStore("thread"), calls = [], hydrated = [], details = [];
  let disposed = false;
  const refresh = createCodexReadRefresh({ store, base: "/thread", isDisposed: () => disposed,
    supportsInitialHistory: () => supports, checkInitialHistorySupport: recheck,
    call: async (path) => {
      calls.push(path);
      if (path.endsWith("/initial-history")) return readInitial ? readInitial() : initial();
      if (path.includes("/turns?")) return initial().turnsPage;
      if (path.endsWith("/requests")) return { requests: [] };
      return { thread: { id: "thread" } };
    }, onTurns: (turns) => hydrated.push(turns), onInitialItems: (id) => details.push(id),
    serverRequest: (value) => value, onSettled() {}, reconcileDismissedRequests() {} });
  return { store, refresh, calls, hydrated, details, dispose() { disposed = true; refresh.dispose(); } };
}

test("initial history shares concurrent reads, skips duplicate hydration and later refreshes use the existing path", async () => {
  const pending = deferred();
  const f = refreshFixture({ readInitial: () => pending.promise });
  const first = f.refresh.refreshLatestTurns(), second = f.refresh.refreshLatestTurns();
  assert.deepEqual(f.calls, ["/thread/initial-history"]);
  pending.resolve(initial());
  await Promise.all([first, second]);
  assert.equal(f.hydrated.length, 0);
  assert.deepEqual(f.details, ["turn"]);
  await f.refresh.refreshLatestTurns();
  assert.deepEqual(f.calls, ["/thread/initial-history", "/thread/turns?limit=1"]);
  assert.equal(f.hydrated.length, 1);
});

test("older backends use legacy reads without probing a new endpoint", async () => {
  const f = refreshFixture({ supports: false });
  await f.refresh.refreshLatestTurns();
  assert.deepEqual(f.calls, ["/thread/turns?limit=1"]);
});

test("404 falls back only after capability disappearance; thread errors and timeouts do not fan out", async () => {
  for (const [status, supported, fallback] of [[404, false, true], [404, true, false], [504, false, false]]) {
    let checks = 0;
    const failure = Object.assign(new Error("missing history"), { status });
    const f = refreshFixture({ readInitial: () => { throw failure; }, recheck: async () => { checks += 1; return supported; } });
    if (fallback) await f.refresh.refreshLatestTurns();
    else await assert.rejects(f.refresh.refreshLatestTurns(), (error) => error === failure);
    assert.equal(checks, status === 404 ? 1 : 0);
    assert.equal(f.calls.includes("/thread/turns?limit=1"), fallback);
  }
});

test("disposal during capability recheck aborts it and never starts fallback history", async () => {
  let signal;
  const pending = deferred();
  const f = refreshFixture({ readInitial: () => { throw Object.assign(new Error("missing"), { status: 404 }); },
    recheck: (options) => { signal = options.signal; return pending.promise; } });
  const reading = f.refresh.refreshLatestTurns();
  await tick(); f.dispose();
  assert.equal(signal.aborted, true);
  pending.resolve(false); await reading;
  assert.deepEqual(f.calls, ["/thread/initial-history"]);
  assert.equal(f.store.state.initialized, false);
});

test("initial body displays before independent metadata/receipts settle, then touching the top reads older items", async () => {
  const metadata = deferred(), receipts = deferred(), store = createCodexChatStore("thread"), calls = [];
  let settled = false;
  const runtime = createCodexChatRuntime({ store, maxPolls: 0, supportsInitialHistory: () => true,
    request: async (path) => {
      calls.push(path);
      if (path.endsWith("/initial-history")) return initial();
      if (path.endsWith("/interactions")) return { interactions: [], epoch: "interactions", revision: 0 };
      if (path.endsWith("/requests")) return receipts.promise;
      if (path.includes("/items?")) {
        assert.match(path, /cursor=older-items/);
        return { threadId: "thread", turnId: "turn", items: [item("before")], nextCursor: null, hasMore: false };
      }
      return metadata.promise;
    } });
  try {
    const opening = runtime.open().then(() => { settled = true; });
    await tick();
    assert.equal(presentCodexChatSnapshot(store.state).turns[0].items.at(-1).text, "last");
    assert.equal(settled, false);
    assert.equal(store.state.requestListReady, false);
    assert.equal(calls.some((path) => path.includes("/items?")), false);
    metadata.resolve({ thread: { id: "thread" } }); receipts.resolve({ requests: [] });
    await opening;
    assert.equal(store.state.requestListReady, true);
    await runtime.loadOlder();
    assert.deepEqual(store.state.turns.turn.itemsWindowIds, ["before", "last"]);
    assert.equal(store.state.turns.turn.itemsLatestTail, "last");
    assert.equal(store.state.olderCursor, "older-turn");
  } finally { runtime.dispose(); }
});

test("initial handshake shares the first batch and reconciles later with ascending incremental items", async () => {
  const pending = deferred(), store = createCodexChatStore("thread"), calls = [];
  let socket;
  const runtime = createCodexChatRuntime({ store, maxPolls: 0, supportsInitialHistory: () => true,
    location: { protocol: "https:", host: "example.test" }, createSocket: () => (socket = { close() {} }),
    request: async (path) => {
      calls.push(path);
      if (path.endsWith("/initial-history")) return pending.promise;
      if (path.endsWith("/interactions")) return { interactions: [], epoch: "interactions", revision: 0 };
      if (path.endsWith("/requests")) return { requests: [] };
      if (path.includes("/turns?")) return initial().turnsPage;
      if (path.includes("/items?")) {
        assert.match(path, /after=last/);
        assert.doesNotMatch(path, /sortDirection=desc/);
        return { threadId: "thread", turnId: "turn", items: [], latestItemId: "last", nextCursor: null, hasMore: false };
      }
      return { thread: { id: "thread" } };
    } });
  try {
    const opening = runtime.open();
    socket.onmessage({ data: JSON.stringify({ schemaVersion: 2, threadId: "thread", epoch: "one", seq: 0, type: "sync.required", payload: {} }) });
    await tick();
    assert.equal(calls.filter((path) => path.endsWith("/initial-history")).length, 1);
    assert.equal(calls.some((path) => path.includes("/turns?")), false);
    pending.resolve(initial());
    await opening; await tick();
    assert.equal(calls.filter((path) => path.endsWith("/initial-history")).length, 1);
    assert.equal(calls.filter((path) => path.includes("/turns?")).length, 1);
    assert.ok(calls.some((path) => path.includes("/items?after=last")));
    assert.equal(store.state.seq, 0);
    assert.equal(store.state.epoch, "one");
    assert.equal(store.state.loading, false);
  } finally { runtime.dispose(); }
});

test("a late initial snapshot cannot roll back a newer latest tail or earlier pagination", () => {
  const store = createCodexChatStore("thread");
  const oldRead = store.beginRead();
  store.applyInitialHistory(initial());
  store.applyEarlierItemsPage("turn", { threadId: "thread", turnId: "turn", items: [item("before")], hasMore: true, nextCursor: "even-older" });
  store.applyLatestItemsPage("turn", { threadId: "thread", turnId: "turn", items: [item("newest")], latestItemId: "newest", hasMore: false, nextCursor: null });
  store.applyInitialHistory(initial(), oldRead);
  assert.deepEqual(store.state.turns.turn.itemsWindowIds, ["before", "last", "newest"]);
  assert.equal(store.state.turns.turn.itemsEarlierCursor, "even-older");
  assert.equal(store.state.turns.turn.itemsLatestTail, "newest");
});
