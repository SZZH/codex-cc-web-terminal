import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Koa from "koa";
import { performance } from "node:perf_hooks";
import { createCodexHistoryItems } from "../web/src/lib/codex-history-items.js";
import { createCodexChatStore } from "../web/src/lib/codex-chat-store.js";
import { createCodexChatRuntime } from "../web/src/lib/codex-chat-runtime.js";
import { presentCodexChatSnapshot } from "../web/src/lib/codex-chat-presentation.js";
import { buildThreadViewModel } from "../web/src/lib/thread-view-model.js";
import { CodexHistoryReader } from "../src/sessions/codex/historyReader.js";
import { handleCodexV2Route } from "../src/routes/codexV2.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const storage = () => ({ getItem: () => null, setItem() {} });
const parsed = (path) => new URL(path, "http://example.test");
const message = (id, text = id) => ({ id, type: "agentMessage", status: "completed", text });

function fixture(handler, turnId = "turn") {
  const store = createCodexChatStore("thread /+#", { storage: storage() });
  store.upsertTurn({ id: turnId, status: "completed", items: [] });
  const calls = [], notifications = [];
  let disposed = false;
  const history = createCodexHistoryItems({ store, base: `/api/v2/codex/threads/${encodeURIComponent(store.state.threadId)}`,
    isDisposed: () => disposed, onItems: (id) => notifications.push(id), call(path) {
      calls.push(parsed(path)); return Promise.resolve().then(() => handler(path));
    } });
  return { store, calls, notifications, ...history, dispose() { disposed = true; } };
}

test("items first read requests 30 and preserves encoded thread and turn identities", async () => {
  const turnId = "turn /?# +";
  const f = fixture(() => ({ items: [message("first")], hasMore: false }), turnId);
  await f.loadItems(turnId);
  assert.equal(f.calls[0].pathname, `/api/v2/codex/threads/${encodeURIComponent(f.store.state.threadId)}/turns/${encodeURIComponent(turnId)}/items`);
  assert.deepEqual([...f.calls[0].searchParams], [["cursor", ""], ["limit", "30"]]);
  assert.deepEqual(f.notifications, [turnId]);
  assert.deepEqual(f.store.state.turns[turnId].itemOrder, ["first"]);
});

test("latest window reads the tail once and keeps its older cursor out of forward pagination", async () => {
  const f = fixture((path) => {
    const query = parsed(path).searchParams;
    if (query.get("sortDirection") === "desc") return { items: [message("tail-1"), message("tail-2")],
      nextCursor: "older-desc-only", hasMore: true, latestItemId: "tail-2" };
    if (query.has("after")) return { items: [message("newest")], nextCursor: "forward-next", hasMore: true, latestItemId: "newest" };
    return { items: [message("first")], nextCursor: "prefix-next", hasMore: true, latestItemId: "first" };
  });
  const initial = await f.loadItems("turn", { latest: true });
  assert.equal(initial.latestWindow, true);
  assert.equal(f.calls[0].searchParams.get("sortDirection"), "desc");
  assert.equal(f.store.state.turns.turn.itemsPageLoaded, undefined, "a tail window is not a complete ascending prefix");
  assert.equal(f.store.state.turns.turn.itemsLatestHasEarlier, true);
  assert.equal(f.store.state.turns.turn.itemsLatestNextCursor, null);
  await f.loadItems("turn", { latest: true });
  assert.equal(f.calls[1].searchParams.get("after"), "tail-2");
  assert.equal(f.calls[1].searchParams.has("sortDirection"), false);
  assert.equal(f.store.state.turns.turn.itemsLatestNextCursor, "forward-next");
  await f.loadItems("turn");
  assert.equal(f.calls[2].searchParams.get("cursor"), "");
  assert.equal(f.calls[2].searchParams.has("after"), false);
  assert.equal(f.store.state.turns.turn.nextCursor, "prefix-next");
  await f.loadItems("turn", { latest: true });
  assert.equal(f.calls[3].searchParams.get("cursor"), "forward-next");
  assert.equal(f.calls[3].searchParams.get("limit"), "30");
});

test("an earlier page and live after pages keep separate cursors and chronological visible content", async () => {
  let releaseEarlier;
  const f = fixture((path) => {
    const query = parsed(path).searchParams;
    if (query.get("cursor") === "older-one") return new Promise((resolve) => { releaseEarlier = resolve; });
    if (query.get("sortDirection") === "desc") return { items: [message("middle"), message("tail")],
      nextCursor: "older-one", hasMore: true, latestItemId: "tail" };
    if (query.get("after") === "tail") return { items: [message("live-one")], nextCursor: "forward-two", hasMore: true, latestItemId: "live-one" };
    assert.equal(query.get("cursor"), "forward-two");
    return { items: [message("live-two")], nextCursor: null, hasMore: false, latestItemId: "live-two" };
  });
  await f.loadItems("turn", { latest: true });
  const earlier = f.loadItems("turn", { earlier: true });
  assert.equal(f.loadItems("turn", { earlier: true }), earlier, "repeated upward events share one earlier read");
  await flush();
  await f.loadItems("turn", { latest: true });
  assert.equal(f.store.state.turns.turn.itemsEarlierCursor, "older-one");
  assert.equal(f.store.state.turns.turn.itemsLatestNextCursor, "forward-two");
  releaseEarlier({ items: [message("older")], nextCursor: "older-zero", hasMore: true, latestItemId: "older" });
  await earlier;
  assert.equal(f.calls[1].searchParams.get("sortDirection"), "desc");
  assert.equal(f.calls[1].searchParams.get("cursor"), "older-one");
  assert.equal(f.store.state.turns.turn.itemsLatestTail, "live-one");
  assert.equal(f.store.state.turns.turn.itemsLatestNextCursor, "forward-two");
  await f.loadItems("turn", { latest: true });
  assert.equal(f.store.state.turns.turn.itemsEarlierCursor, "older-zero");
  assert.equal(f.store.state.turns.turn.itemsEarlierHasMore, true);
  assert.equal(f.store.state.turns.turn.itemsLatestTail, "live-two");
  assert.deepEqual(f.store.state.turns.turn.itemsWindowIds, ["older", "middle", "tail", "live-one", "live-two"]);
  assert.deepEqual(presentCodexChatSnapshot(f.store.state).turns[0].items.map((item) => item.id),
    ["older", "middle", "tail", "live-one", "live-two"]);
});

for (const failure of ["unavailable", "repeated cursor", "missing cursor"]) {
  test(`upward pagination keeps its retry cursor and loaded window after ${failure}`, async () => {
    const store = createCodexChatStore("thread", { storage: storage() });
    store.upsertTurn({ id: "turn", status: "completed", items: [] });
    store.applyLatestItemsPage("turn", { items: [message("tail")], hasMore: true, nextCursor: "earlier-page", latestItemId: "tail" },
      store.beginRead(), { reset: true });
    const queries = [];
    let repaired = false;
    const runtime = createCodexChatRuntime({ store, maxPolls: 0, visibility: null, request: async (path) => {
      queries.push(parsed(path).searchParams);
      if (!repaired) {
        if (failure === "unavailable") throw new Error("earlier page unavailable");
        return { items: [message("invalid-partial")], hasMore: true, nextCursor: failure === "repeated cursor" ? "earlier-page" : null };
      }
      return { items: [message("first")], hasMore: false, nextCursor: null, latestItemId: "first" };
    } });
    try {
      assert.equal(await runtime.loadOlder(), false);
      assert.match(store.state.error, failure === "unavailable" ? /earlier page unavailable/ : /分页尚未就绪/);
      assert.equal(store.state.turns.turn.itemsEarlierCursor, "earlier-page", "failed paging must remain retryable from its original cursor");
      assert.deepEqual(store.state.turns.turn.itemsWindowIds, ["tail"], "an invalid page cannot change the visible window");
      assert.equal(runtime.hasOlderHistory(), true);
      repaired = true;
      assert.equal(await runtime.loadOlder(), true);
      assert.deepEqual(queries.map((query) => [query.get("cursor"), query.get("sortDirection"), query.get("limit")]),
        [["earlier-page", "desc", "30"], ["earlier-page", "desc", "30"]]);
      assert.deepEqual(store.state.turns.turn.itemsWindowIds, ["first", "tail"]);
      assert.equal(store.state.turns.turn.itemsEarlierHasMore, false);
      assert.equal(store.state.turns.turn.itemsEarlierCursor, null);
      assert.equal(runtime.hasOlderHistory(), false);
      assert.equal(store.state.error, "");
    } finally { runtime.dispose(); }
  });
}

test("opaque cursors take priority over incremental anchors and request 30", async () => {
  const cursor = "opaque /+?&=# 中文";
  const f = fixture(() => ({ items: [], hasMore: false, latestItemId: "tail" }));
  f.store.upsertTurn({ id: "turn", itemsPageLoaded: true, itemsPageTail: "tail", nextCursor: cursor });
  await f.loadItems("turn");
  assert.equal(f.calls[0].searchParams.get("cursor"), cursor);
  assert.equal(f.calls[0].searchParams.has("after"), false);
  assert.equal(f.calls[0].searchParams.get("limit"), "30");
  f.store.upsertTurn({ id: "turn", nextCursor: null, itemsNextCursor: cursor });
  await f.loadItems("turn");
  assert.equal(f.calls[1].searchParams.get("cursor"), cursor);
  assert.equal(f.calls[1].searchParams.get("limit"), "30");
});

test("empty incremental pages preserve the latest identity and request 30 after the exclusive anchor", async () => {
  const anchor = "item /+?&=# 中文";
  let initial = true;
  const f = fixture(() => {
    const items = initial ? [message(anchor)] : [];
    initial = false;
    return { items, nextCursor: null, hasMore: false, latestItemId: anchor };
  });
  await f.loadItems("turn");
  await f.loadItems("turn");
  const query = f.calls[1].searchParams;
  assert.equal(query.get("after"), anchor);
  assert.equal(query.has("cursor"), false);
  assert.equal(query.get("limit"), "30");
  assert.equal(f.store.state.turns.turn.itemsPageTail, anchor);
  assert.deepEqual(f.store.state.turns.turn.itemOrder, [anchor]);
});

test("same-turn pending reads share one promise and failures release the pending slot", async () => {
  let settle;
  const f = fixture(() => new Promise((_resolve, reject) => { settle = reject; }));
  const first = f.loadItems("turn");
  assert.equal(f.loadItems("turn"), first);
  await flush();
  assert.equal(f.calls.length, 1);
  settle(new Error("page offline"));
  await assert.rejects(first, /page offline/);
  const retry = f.loadItems("turn");
  assert.notEqual(retry, first);
  await flush();
  assert.equal(f.calls.length, 2);
  settle(new Error("retry offline"));
  await assert.rejects(retry, /retry offline/);
});

test("malformed pages release pending reads without applying items or notifying details", async () => {
  const f = fixture(() => ({ items: null }));
  await assert.rejects(f.loadItems("turn"), /执行过程暂时无法读取/);
  await assert.rejects(f.loadItems("turn"), /执行过程暂时无法读取/);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.store.state.turns.turn.itemOrder, []);
  assert.deepEqual(f.notifications, []);
});

test("late item pages retain the shared store revision guard and stop notifying after disposal", async () => {
  let resolve;
  const f = fixture(() => new Promise((done) => { resolve = done; }));
  const pending = f.loadItems("turn");
  await flush();
  f.store.upsertItem("turn", message("answer", "new websocket answer"));
  resolve({ items: [message("answer", "old HTTP answer")], hasMore: false });
  await pending;
  assert.equal(f.store.state.turns.turn.items.answer.text, "new websocket answer");
  const detached = f.loadItems("turn");
  await flush();
  f.dispose();
  resolve({ items: [message("detached")], hasMore: false });
  await detached;
  assert.equal(f.store.state.turns.turn.items.detached, undefined);
  assert.deepEqual(f.notifications, ["turn"]);
});

for (const failure of ["unavailable", "repeated cursor", "missing cursor"]) {
  test(`item hydration preserves a partial page and retries after ${failure}`, async () => {
    const store = createCodexChatStore("thread", { storage: storage() });
    store.upsertTurn({ id: "turn", status: "completed", items: [] });
    const queries = [];
    let repaired = false;
    const runtime = createCodexChatRuntime({ store, maxPolls: 0, visibility: null, yieldPage: async () => {}, request: async (path) => {
      const query = parsed(path).searchParams;
      queries.push(query);
      if (queries.length === 1) return { items: [message("first")], nextCursor: "second", hasMore: true };
      if (!repaired) {
        if (failure === "unavailable") throw Object.assign(new Error("page unavailable"), { status: 503 });
        return { items: [message("second")], nextCursor: failure === "repeated cursor" ? "second" : null, hasMore: true };
      }
      return { items: [message("second"), message("final")], nextCursor: null, hasMore: false };
    } });
    try {
      await runtime.syncItems("turn");
      assert.match(store.state.turns.turn.itemsError, failure === "unavailable" ? /page unavailable/ : /分页尚未就绪/);
      assert.equal(store.state.turns.turn.items.first.text, "first");
      assert.equal(store.state.turns.turn.itemsLoading, false);
      repaired = true;
      await runtime.syncItems("turn");
      assert.deepEqual(store.state.turns.turn.itemOrder, ["first", "second", "final"]);
      assert.equal(store.state.turns.turn.itemsError, "");
      assert.equal(store.state.turns.turn.hasMore, false);
      assert.ok(queries.every((query) => query.get("limit") === "30"));
      assert.equal(queries[1].get("cursor"), "second");
      if (failure !== "missing cursor") assert.equal(queries.at(-1).get("cursor"), "second");
      else { assert.equal(queries.at(-1).get("after"), "second"); assert.equal(queries.at(-1).has("cursor"), false); }
    } finally { runtime.dispose(); }
  });
}

function syntheticTurn(id, count) {
  const items = Array.from({ length: count }, (_, index) => {
    const common = { id: `${id}-item-${index}`, status: "completed" };
    if (index === count - 1) return { ...common, type: "agentMessage", phase: "final_answer", text: `final ${id}` };
    switch (index % 25) {
      case 0: return { ...common, type: "userMessage", clientId: `${id}-request-${index}`, content: [{ type: "inputText", text: "identical steer input" }] };
      case 1: return { ...common, type: "agentMessage", phase: "commentary", text: `commentary ${index} ${"progress ".repeat(20)}` };
      case 2: return { ...common, type: "fileChange", changes: [{ path: `src/${id}-${index}.js`, kind: { type: "update" }, diff: `@@ -1 +1 @@\n-old-${index}\n+new-${index}\n` }] };
      case 3: return { ...common, type: "plan", text: `plan ${index}` };
      case 4: return { ...common, type: "reasoning", summary: [`reasoning ${index}`], content: [] };
      case 5: return { ...common, type: "mcpToolCall", server: "synthetic", tool: "read", result: { content: [{ type: "text", text: `tool ${index}` }] } };
      default: return { ...common, type: "commandExecution", command: `check ${index}`, aggregatedOutput: `output ${index} ${"output line ".repeat(20)}`, exitCode: 0 };
    }
  });
  return { id, status: "completed", itemsView: "summary", items };
}

for (const [turnCount, itemCount] of [[1, 50], [10, 500]]) {
  test(`real runtime, route and reader reveal the latest window first and reach all ${turnCount * itemCount} items by scrolling older`, { timeout: 30000 }, async (t) => {
    const turns = Array.from({ length: turnCount }, (_, index) => syntheticTurn(`turn-${index}`, itemCount));
    const thread = { id: "thread", cwd: "/synthetic", historyMode: "paginated", turns: [], status: { type: "notLoaded" } };
    const byTurn = new Map(turns.map((turn) => [turn.id, turn]));
    const requests = [], rpcCalls = [];
    let active = 0, maximum = 0, yields = 0;
    let releasePages;
    const pageGate = new Promise((resolve) => { releasePages = resolve; });
    const delayMs = Number(process.env.HISTORY_ITEMS_RTT_MS || 0);
    const reader = new CodexHistoryReader({ bridge: { request: async (method, params) => {
      rpcCalls.push({ method, params });
      if (method === "thread/read") return { thread };
      if (method === "thread/turns/list") {
        assert.equal(params.limit, 1);
        assert.equal(params.sortDirection, "desc");
        const end = params.cursor ? Number(params.cursor.slice(6)) : turns.length;
        const start = Math.max(0, end - params.limit);
        return { data: turns.slice(start, end).reverse(), nextCursor: start ? `turns:${start}` : null };
      }
      assert.equal(method, "thread/items/list");
      const source = byTurn.get(params.turnId).items;
      const descending = params.sortDirection === "desc";
      const offset = params.cursor?.type === "item" ? source.findIndex((item) => item.id === params.cursor.itemId) + (descending ? 0 : 1)
        : params.cursor ? Number(params.cursor.slice(7)) : descending ? source.length : 0;
      const items = descending ? source.slice(Math.max(0, offset - params.limit), offset).reverse() : source.slice(offset, offset + params.limit);
      return { data: items.map((item) => ({ turnId: params.turnId, item })), nextCursor: descending
        ? offset > items.length ? `offset:${offset - items.length}` : null
        : offset + items.length < source.length ? `offset:${offset + items.length}` : null };
    } } });
    const routeRuntime = { requireAuthorized: () => true, forbidCrossOrigin: () => false,
      codexThreads: { reader, getThread: (id) => reader.getThread(id), reconcileRequests() {}, reconcileItems() {}, requests: { list: () => [] } },
      json(ctx, status, payload) { ctx.status = status; ctx.body = JSON.stringify(payload); } };
    const app = new Koa();
    app.use(async (ctx) => {
      const isPage = parsed(ctx.url).pathname.endsWith("/items");
      if (isPage) { active += 1; maximum = Math.max(maximum, active); }
      try {
        if (isPage) await pageGate;
        await new Promise((resolve) => delayMs ? setTimeout(resolve, delayMs) : setImmediate(resolve));
        assert.equal(await handleCodexV2Route(ctx, routeRuntime), true);
        const body = Buffer.from(ctx.body);
        requests.push({ url: parsed(ctx.url), isPage, bytes: body.length });
        ctx.type = "application/json";
      } catch (error) { ctx.status = 500; ctx.body = { error: error.stack }; }
      finally { if (isPage) active -= 1; }
    });
    const server = http.createServer(app.callback());
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const store = createCodexChatStore("thread", { storage: storage() });
    const runtime = createCodexChatRuntime({ store, maxPolls: 0, visibility: null,
      yieldPage: async () => { yields += 1; await flush(); }, request: async (path, options) => {
        const response = await fetch(new URL(path, base), { ...options, headers: { "accept-encoding": "identity" } });
        if (!response.ok) throw new Error(await response.text());
        return response.json();
      } });
    try {
      const started = performance.now();
      await runtime.open();
      const newest = turns.at(-1);
      assert.deepEqual(store.state.turnOrder, [newest.id], "opening a conversation reads only its newest turn");
      assert.deepEqual(presentCodexChatSnapshot(store.state).turns[0].items, [], "sparse summaries do not flash old messages before the latest window arrives");
      const hydration = runtime.setTurnVisibility(newest.id, true);
      releasePages();
      await hydration;
      const initialPages = requests.filter((request) => request.isPage);
      assert.equal(initialPages.length, 1, "opening never drains earlier item or turn pages");
      assert.equal(initialPages[0].url.searchParams.get("sortDirection"), "desc");
      assert.equal(initialPages[0].url.searchParams.get("cursor"), "");
      assert.deepEqual(presentCodexChatSnapshot(store.state).turns[0].items.map((item) => item.id), newest.items.slice(-30).map((item) => item.id));
      const earlierCursor = store.state.turns[newest.id].itemsEarlierCursor;
      await flush();
      assert.equal(requests.filter((request) => request.isPage).length, 1, "idle opening does not consume its earlier cursor");
      await runtime.setProcessExpanded(newest.id, true);
      const expansionPages = requests.filter((request) => request.isPage).slice(1);
      assert.ok(expansionPages.every((request) => request.url.searchParams.get("after") === newest.items.at(-1).id &&
        !request.url.searchParams.has("cursor")), "expansion may reconcile current live output but cannot fetch an older prefix");
      assert.equal(store.state.turns[newest.id].itemsEarlierCursor, earlierCursor);
      assert.equal(presentCodexChatSnapshot(store.state).turns[0].items.length, 30);
      const expectedPages = turnCount * Math.ceil(itemCount / 30);
      let olderLoads = 0;
      while (runtime.hasOlderHistory() && olderLoads < expectedPages + turnCount) {
        const first = store.state.turns[store.state.turnOrder[0]];
        const loadingEarlierItems = first.itemsEarlierHasMore;
        const beforeItems = requests.filter((request) => request.isPage).length;
        const beforeTurns = requests.filter((request) => request.url.pathname.endsWith("/turns")).length;
        const beforeCursor = first.itemsEarlierCursor;
        assert.equal(await runtime.loadOlder(), true);
        olderLoads += 1;
        const addedItems = requests.filter((request) => request.isPage).slice(beforeItems);
        assert.equal(addedItems.length, 1, "one upward load reads exactly one item window");
        assert.equal(addedItems[0].url.searchParams.get("sortDirection"), "desc");
        if (loadingEarlierItems) {
          assert.equal(requests.filter((request) => request.url.pathname.endsWith("/turns")).length, beforeTurns,
            "the current turn must be exhausted before requesting an older turn");
          assert.equal(addedItems[0].url.searchParams.get("cursor"), beforeCursor);
          assert.ok(addedItems[0].url.pathname.includes(`/turns/${first.id}/items`));
        } else {
          assert.equal(requests.filter((request) => request.url.pathname.endsWith("/turns")).length, beforeTurns + 1);
          assert.equal(addedItems[0].url.searchParams.get("cursor"), "");
        }
      }
      assert.equal(runtime.hasOlderHistory(), false, "every older item remains reachable without an infinite pagination loop");
      assert.equal(olderLoads, expectedPages - 1);
      const elapsedMs = performance.now() - started;
      const pages = requests.filter((request) => request.isPage);
      assert.equal(pages.length, expectedPages + expansionPages.length);
      assert.ok(pages.every((request) => request.url.searchParams.get("limit") === "30"));
      assert.equal(yields, 0, "upward pagination never drains another page in the background");
      assert.equal(maximum, 1);
      assert.equal(rpcCalls.filter((call) => call.method === "thread/items/list").length, pages.length);
      assert.ok(rpcCalls.filter((call) => call.method === "thread/items/list").every((call) => call.params.limit === 30));
      const snapshot = presentCodexChatSnapshot(store.state);
      const view = buildThreadViewModel(snapshot);
      for (const source of turns) {
        const actual = store.state.turns[source.id];
        assert.deepEqual(actual.itemOrder.map((id) => `${actual.items[id].type}:${id}`), source.items.map((item) => `${item.type}:${item.id}`));
        assert.equal(actual.confirmedItemIds.length, itemCount);
        assert.equal(actual.itemsEarlierHasMore, false);
        assert.equal(actual.itemsEarlierCursor, null);
        assert.deepEqual(actual.itemsWindowIds, source.items.map((item) => item.id));
        for (const item of source.items) {
          const stored = actual.items[item.id];
          if (item.text) assert.equal(stored.presentation.text, item.text);
          if (item.type === "userMessage") { assert.equal(stored.presentation.text, item.content[0].text); assert.equal(stored.clientId, item.clientId); }
          if (item.type === "commandExecution") assert.equal(stored.presentation.text, item.aggregatedOutput);
          if (item.type === "fileChange") assert.equal(stored.presentation.fileChanges[0].diff, item.changes[0].diff);
        }
        assert.equal(snapshot.turns.find((turn) => turn.id === source.id).items.filter((item) => item.kind === "UserMessage").length,
          source.items.filter((item) => item.type === "userMessage").length);
        assert.equal(view.turns.find((turn) => turn.id === source.id).fileChanges.length, source.items.filter((item) => item.type === "fileChange").length);
      }
      t.diagnostic(JSON.stringify({ delayMs, items: turnCount * itemCount, itemRequests: pages.length, totalRequests: requests.length,
        bodyBytes: requests.reduce((sum, request) => sum + request.bytes, 0), maxItemBytes: Math.max(...pages.map((request) => request.bytes)),
        maxPageConcurrency: maximum, yields, elapsedMs: Math.round(elapsedMs * 10) / 10 }));
    } finally {
      releasePages(); runtime.dispose(); server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      assert.equal(server.listening, false);
      assert.equal(active, 0);
    }
  });
}
