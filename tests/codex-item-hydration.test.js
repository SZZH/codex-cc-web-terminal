import test from "node:test";
import assert from "node:assert/strict";
import { createCodexChatStore } from "../web/src/lib/codex-chat-store.js";
import { createCodexHistoryItems } from "../web/src/lib/codex-history-items.js";
import { createCodexReadRequests } from "../web/src/lib/codex-read-requests.js";
import { createCodexItemHydration } from "../web/src/lib/codex-item-hydration.js";
import { createCodexChatRuntime } from "../web/src/lib/codex-chat-runtime.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(ids, { yieldPage = () => Promise.resolve(), syncVisibleDetails } = {}) {
  const store = createCodexChatStore("thread", { storage: { getItem: () => null, setItem() {} } });
  ids.forEach((id) => store.upsertTurn({ id, status: "completed", items: [] }));
  const calls = [], timers = new Set(), callbacks = [];
  let disposed = false, active = 0, maximum = 0, aborts = 0;
  const reads = createCodexReadRequests({ timeoutMs: 10000,
    setTimer(callback, ms) { const id = setTimeout(callback, ms); timers.add(id); return id; },
    clearTimer(id) { clearTimeout(id); timers.delete(id); },
    request(path, options) {
      const task = deferred();
      const url = new URL(path, "http://fixture.test");
      const turnId = decodeURIComponent(url.pathname.split("/turns/")[1].split("/")[0]);
      const call = { turnId, url, options, settled: false, resolve: task.resolve, reject: task.reject };
      active += 1; maximum = Math.max(maximum, active); calls.push(call);
      const cancel = () => { aborts += 1; task.reject(options.signal.reason); };
      options.signal.addEventListener("abort", cancel, { once: true });
      return task.promise.finally(() => { call.settled = true; active -= 1; options.signal.removeEventListener("abort", cancel); });
    }
  });
  const history = createCodexHistoryItems({ store, base: "/api/v2/codex/threads/thread", call: reads.call,
    isDisposed: () => disposed, onItems: (id) => callbacks.push(`items:${id}`) });
  const hydration = createCodexItemHydration({ store, loadItems: history.loadItems, isDisposed: () => disposed, yieldPage,
    syncVisibleDetails: async (id) => { callbacks.push(`details:${id}`); return syncVisibleDetails?.(id); },
    loadDetail: async (id, itemId) => callbacks.push(`reconcile:${id}:${itemId}`),
    schedulePoll: () => callbacks.push("poll"), scheduleDetailRetry: () => callbacks.push("detail-retry") });
  function complete(turnId, { hasMore = false, cursor = null, itemId = `${turnId}-${calls.length}` } = {}) {
    const call = calls.find((entry) => !entry.settled && !entry.completed && entry.turnId === turnId);
    assert.ok(call, `pending page for ${turnId}`); call.completed = true;
    call.resolve({ threadId: "thread", turnId, items: [{ id: itemId, type: "agentMessage", text: `full body ${itemId}`, presentation: { text: `full body ${itemId}` } }],
      hasMore, nextCursor: cursor, latestItemId: itemId });
    return call;
  }
  function dispose() { if (disposed) return; disposed = true; reads.dispose(); hydration.dispose(); }
  return { store, hydration, calls, callbacks, timers, complete, dispose,
    get maximum() { return maximum; }, get aborts() { return aborts; } };
}

function hydrateFullVisibleTurns(f) {
  const ids = [...f.store.state.turnOrder];
  return Promise.all([f.hydration.hydrateVisibleTurns(ids.map((id) => ({ id }))),
    ...ids.reverse().map((id) => f.hydration.syncItems(id))]);
}

test("a completed page yields its slot to an ordinary queued turn before continuing a long turn", async () => {
  const f = fixture(["old", "middle", "long", "latest"]);
  const all = hydrateFullVisibleTurns(f);
  try {
    await flush(); assert.deepEqual(f.calls.map((x) => x.turnId), ["latest", "long"]);
    f.complete("long", { hasMore: true, cursor: "page-two" }); await flush();
    assert.equal(f.calls[2]?.turnId, "middle");
    assert.equal(f.maximum, 2);
  } finally { f.dispose(); await all; }
});

test("explicit expansion boosts an already queued turn into the next available page slot", async () => {
  const f = fixture(["target", "middle", "long", "latest"]);
  const all = f.hydration.hydrateVisibleTurns(f.store.state.turnOrder.map((id) => ({ id })));
  let expanded;
  try {
    await flush(); expanded = f.hydration.setProcessExpanded("target", true);
    f.complete("latest", { hasMore: true, cursor: "next-latest" }); await flush();
    assert.equal(f.calls[2]?.turnId, "target");
    f.complete("target"); await expanded;
    assert.equal(f.store.state.turns.target.itemsLatestHydratedStatus, "completed");
  } finally { f.dispose(); await Promise.all([all, expanded]); }
});

test("queued boosts preserve older arrival order before the ordinary page behind them", async () => {
  const f = fixture(["ordinary", "third", "second", "first", "long", "latest"]);
  const all = hydrateFullVisibleTurns(f);
  const expansions = [];
  try {
    await flush();
    for (const id of ["first", "second", "third"]) expansions.push(f.hydration.setProcessExpanded(id, true));
    for (const id of ["latest", "first", "second"]) { f.complete(id); await flush(); }
    assert.deepEqual(f.calls.slice(2, 5).map((x) => x.turnId), ["first", "second", "third"]);
    f.complete("third"); await flush();
    assert.equal(f.calls[5]?.turnId, "ordinary", "the ordinary page follows the three targets that arrived earlier");
    assert.equal(f.maximum, 2);
  } finally { f.dispose(); await Promise.all([all, ...expansions]); }
});

test("dispose settles a paused between-page yield without late callbacks or queued requests", async () => {
  const gate = deferred();
  const f = fixture(["old", "latest"], { yieldPage: () => gate.promise });
  const all = hydrateFullVisibleTurns(f);
  let settled = false;
  all.then(() => { settled = true; });
  try {
    await flush(); f.complete("latest", { hasMore: true, cursor: "page-two" }); await flush();
    const callbacks = f.callbacks.length;
    f.dispose(); await flush();
    assert.equal(settled, true);
    assert.equal(f.calls.length, 2);
    assert.equal(f.callbacks.length, callbacks);
    assert.equal(f.timers.size, 0);
    assert.equal(f.aborts, 1);
  } finally { f.dispose(); gate.resolve(); await all; }
});

test("collapsing a boosted queued turn restores ordinary ordering without a stale detail callback", async () => {
  const f = fixture(["target", "middle", "long", "latest"]);
  const all = f.hydration.hydrateVisibleTurns(f.store.state.turnOrder.map((id) => ({ id })));
  let expanded;
  try {
    await flush(); expanded = f.hydration.setProcessExpanded("target", true);
    await f.hydration.setProcessExpanded("target", false);
    f.complete("latest"); await flush();
    assert.equal(f.calls[2]?.turnId, "middle");
    f.complete("middle"); await flush();
    const before = f.callbacks.filter((x) => x === "details:target").length;
    f.complete("target"); await expanded;
    assert.equal(f.callbacks.filter((x) => x === "details:target").length, before);
  } finally { f.dispose(); await Promise.all([all, expanded]); }
});

test("status changes while queued and in flight preserve the next after anchor and one final reconciliation", async () => {
  const f = fixture(["target", "long", "latest"]);
  f.store.state.turns.target.status = "unknown";
  const all = f.hydration.hydrateVisibleTurns(f.store.state.turnOrder.map((id) => ({ id })));
  try {
    await flush();
    const target = f.hydration.syncItems("target", { reconcile: true });
    assert.equal(f.hydration.syncItems("target"), target);
    f.store.upsertTurn({ id: "target", status: "inProgress" });
    f.complete("long"); await flush();
    f.store.upsertTurn({ id: "target", status: "completed" });
    f.complete("target", { itemId: "target-first" }); await flush();
    const second = f.calls.filter((x) => x.turnId === "target")[1];
    assert.equal(second.url.searchParams.get("after"), "target-first");
    f.complete("target", { itemId: "target-final" }); await target;
    assert.deepEqual(f.store.state.turns.target.itemOrder, ["target-first", "target-final"]);
    assert.equal(f.store.state.turns.target.itemsHydratedStatus, "completed");
    assert.deepEqual(f.callbacks.filter((x) => x.startsWith("reconcile:")), ["reconcile:target:target-final"]);
  } finally { f.dispose(); await all; }
});

test("reopening a completed process reuses its current window without consuming the earlier cursor", async () => {
  const f = fixture(["target", "latest"]);
  let expanded, resumed;
  try {
    expanded = f.hydration.setProcessExpanded("target", true); await flush();
    await f.hydration.setProcessExpanded("target", false);
    f.complete("target", { hasMore: true, cursor: "resume-cursor", itemId: "first" }); await expanded;
    assert.equal(f.calls.length, 1);
    resumed = f.hydration.setProcessExpanded("target", true); await resumed;
    assert.equal(f.calls.length, 1);
    assert.equal(f.store.state.turns.target.itemsEarlierCursor, "resume-cursor");
    assert.deepEqual(f.store.state.turns.target.itemsWindowIds, ["first"]);
    assert.ok(f.callbacks.includes("details:target"));
  } finally { f.dispose(); await Promise.all([expanded, resumed]); }
});

test("summary pages hydrate only the latest turn until another turn enters the viewport", async () => {
  const f = fixture(["outside", "latest"]);
  let summaries, visible;
  try {
    summaries = f.hydration.hydrateSummaryTurns(f.store.state.turnOrder.map((id) => ({ id })));
    await flush();
    assert.deepEqual(f.calls.map((call) => call.turnId), ["latest"]);
    assert.equal(f.callbacks.includes("details:outside"), false);
    f.complete("latest"); await summaries;
    visible = f.hydration.setTurnVisibility("outside", true); await flush();
    assert.deepEqual(f.calls.map((call) => call.turnId), ["latest", "outside"]);
    f.complete("outside"); await visible;
    assert.equal(f.store.state.turns.outside.itemsLatestHydratedStatus, "completed");
  } finally { f.dispose(); await Promise.all([summaries, visible]); }
});

test("opening a process during the latest window read displays only that window without a prefix read", async () => {
  const f = fixture(["latest"]);
  let initial, expanded;
  try {
    initial = f.hydration.hydrateSummaryTurns([{ id: "latest" }]); await flush();
    assert.equal(f.calls[0].url.searchParams.get("sortDirection"), "desc");
    expanded = f.hydration.setProcessExpanded("latest", true);
    f.complete("latest", { hasMore: true, cursor: "earlier-tail-cursor", itemId: "last" });
    await Promise.all([initial, expanded]);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.store.state.turns.latest.itemsWindowIds, ["last"]);
    assert.equal(f.store.state.turns.latest.itemsLatestHydratedStatus, "completed");
    assert.equal(f.store.state.turns.latest.itemsEarlierCursor, "earlier-tail-cursor");
    assert.equal(f.store.state.turns.latest.itemsLatestTail, "last");
  } finally { f.dispose(); await Promise.all([initial, expanded]); }
});

test("latest incremental reads finish every forward page while earlier process remains unloaded", async () => {
  const f = fixture(["latest"]);
  let initial, update;
  try {
    initial = f.hydration.hydrateSummaryTurns([{ id: "latest" }]); await flush();
    f.complete("latest", { hasMore: true, cursor: "older-only", itemId: "old-tail" }); await initial;
    assert.equal(f.calls.length, 1);
    update = f.hydration.syncLatestItems(); await flush();
    assert.equal(f.calls[1].url.searchParams.get("after"), "old-tail");
    f.complete("latest", { hasMore: true, cursor: "forward-next", itemId: "new-one" }); await flush();
    assert.equal(f.calls[2].url.searchParams.get("cursor"), "forward-next");
    f.complete("latest", { itemId: "new-two" }); await update;
    assert.equal(f.store.state.turns.latest.itemsLatestTail, "new-two");
    assert.equal(f.store.state.turns.latest.itemsPageLoaded, undefined);
    assert.equal(f.store.state.turns.latest.itemsLatestHasEarlier, true);
    assert.deepEqual(f.store.state.turns.latest.itemOrder, ["old-tail", "new-one", "new-two"]);
  } finally { f.dispose(); await Promise.all([initial, update]); }
});

test("expanding while the latest window finalizes its details does not start an older prefix", async () => {
  const gate = deferred();
  const f = fixture(["latest"], { syncVisibleDetails: () => gate.promise });
  f.store.state.turns.latest.itemsLatestHydratedStatus = "inProgress";
  let latest, expanded;
  try {
    latest = f.hydration.syncLatestItems(); await flush();
    f.complete("latest", { hasMore: true, cursor: "older-tail", itemId: "last" }); await flush();
    assert.equal(f.store.state.turns.latest.itemsLatestLoaded, true);
    expanded = f.hydration.setProcessExpanded("latest", true); await flush();
    assert.equal(f.calls.length, 1);
    gate.resolve(); await Promise.all([latest, expanded]);
    assert.equal(f.calls.length, 1);
    assert.equal(f.store.state.turns.latest.itemsPageLoaded, undefined);
    assert.equal(f.store.state.turns.latest.itemsEarlierCursor, "older-tail");
    assert.equal(f.store.state.turns.latest.itemsLatestHydratedStatus, "completed");
  } finally { gate.resolve(); f.dispose(); await Promise.all([latest, expanded]); }
});

test("collapsing the latest process retains the earlier cursor without requesting it", async () => {
  const f = fixture(["latest"]);
  let expanded;
  try {
    expanded = f.hydration.setProcessExpanded("latest", true); await flush();
    await f.hydration.setProcessExpanded("latest", false);
    f.complete("latest", { hasMore: true, cursor: "resume-prefix", itemId: "first" }); await expanded;
    assert.equal(f.calls.length, 1);
    assert.equal(f.store.state.turns.latest.itemsEarlierCursor, "resume-prefix");
    assert.equal(f.store.state.turns.latest.itemsHydratedStatus, undefined);
  } finally { f.dispose(); await expanded; }
});

test("a latest window keeps its older cursor out of automatic viewport refreshes", async () => {
  const f = fixture(["outside", "latest"]);
  f.store.state.turns.outside.status = "unknown";
  let first, resumed;
  try {
    first = f.hydration.setTurnVisibility("outside", true); await flush();
    await f.hydration.setTurnVisibility("outside", false);
    f.complete("outside", { hasMore: true, cursor: "remaining", itemId: "first" }); await first;
    assert.equal(f.calls.length, 1);
    assert.equal(f.store.state.turns.outside.itemsLatestHasEarlier, true);
    assert.equal(f.store.state.turns.outside.itemsHydratedStatus, undefined);
    await f.hydration.hydrateSummaryTurns([{ id: "outside" }]);
    assert.equal(f.calls.length, 1, "a complete latest window does not drain earlier process pages");
    f.store.upsertTurn({ id: "outside", status: "inProgress" });
    resumed = f.hydration.setTurnVisibility("outside", true); await flush();
    assert.equal(f.calls[1].url.searchParams.get("after"), "first");
    assert.equal(f.calls[1].url.searchParams.has("cursor"), false);
    f.complete("outside", { itemId: "last" }); await resumed;
    assert.deepEqual(f.store.state.turns.outside.itemOrder, ["first", "last"]);
  } finally { f.dispose(); await Promise.all([first, resumed]); }
});

test("a queued viewport read is skipped after its turn leaves the viewport", async () => {
  const f = fixture(["outside", "other", "latest"]);
  const latest = f.hydration.syncItems("latest"), other = f.hydration.syncItems("other");
  let outside;
  try {
    await flush();
    outside = f.hydration.setTurnVisibility("outside", true); await flush();
    await f.hydration.setTurnVisibility("outside", false);
    f.complete("other"); await flush(); await outside;
    assert.deepEqual(f.calls.map((call) => call.turnId), ["latest", "other"]);
  } finally { f.dispose(); await Promise.all([latest, other, outside]); }
});

test("disposing a final status reconciliation prevents late detail completion from mutating the detached turn", async () => {
  const gate = deferred();
  const store = createCodexChatStore("thread");
  store.upsertTurn({ id: "past", status: "completed", itemsHydratedStatus: "inProgress", itemsPageLoaded: true, items: [] });
  store.upsertTurn({ id: "latest", status: "completed", items: [] });
  let disposed = false;
  const hydration = createCodexItemHydration({ store, isDisposed: () => disposed, loadItems: async () => ({ items: [], hasMore: false }),
    syncVisibleDetails: () => gate.promise, loadDetail: async () => {}, schedulePoll() {}, scheduleDetailRetry() {}, yieldPage: async () => {} });
  const operation = hydration.hydrateSummaryTurns([{ id: "past" }]);
  await flush();
  disposed = true; hydration.dispose();
  const snapshot = JSON.stringify(store.state);
  gate.resolve(); await operation;
  assert.equal(JSON.stringify(store.state), snapshot);
});

test("disposing queued and active reads is idempotent and cannot publish late item state or callbacks", async () => {
  const f = fixture(["one", "two", "three", "latest"]);
  const all = f.hydration.hydrateVisibleTurns(f.store.state.turnOrder.map((id) => ({ id })));
  try {
    await flush();
    const snapshot = JSON.stringify(f.store.state), callbacks = f.callbacks.length;
    f.dispose(); f.dispose(); await all;
    assert.equal(f.calls.length, 2);
    assert.equal(f.aborts, 2);
    assert.equal(f.timers.size, 0);
    assert.equal(f.callbacks.length, callbacks);
    assert.equal(JSON.stringify(f.store.state), snapshot);
    await f.hydration.setProcessExpanded("one", true);
    await f.hydration.hydrateVisibleTurns([{ id: "one" }]);
    await f.hydration.retryFailures();
    assert.equal(f.calls.length, 2);
    assert.equal(f.callbacks.length, callbacks);
  } finally { f.dispose(); await all; }
});

test("real runtime expands a boosted 61-item target using only its latest 30 items", async () => {
  const ids = ["target", "middle", "long", "latest"];
  const pages = [], pending = [], source = ids.map((id) => Array.from({ length: id === "target" ? 61 : 60 }, (_, index) =>
    ({ id: `${id}-${index}`, type: "agentMessage", text: `complete body ${id}-${index}`, presentation: { text: `complete body ${id}-${index}` } })));
  const store = createCodexChatStore("thread", { storage: { getItem: () => null, setItem() {} } });
  ids.forEach((id) => store.upsertTurn({ id, status: "completed", items: [] }));
  let active = 0, maximum = 0;
  const runtime = createCodexChatRuntime({ store, maxPolls: 0, visibility: null, yieldPage: () => Promise.resolve(),
    request(path, options) {
      const url = new URL(path, "http://fixture.test");
      if (url.pathname.endsWith("/requests")) return Promise.resolve({ requests: [] });
      if (url.pathname.endsWith("/turns")) {
        assert.equal(url.searchParams.get("limit"), "1");
        return Promise.resolve({ turns: [{ id: "latest", status: "completed", items: [] }] });
      }
      if (!url.pathname.endsWith("/items")) return Promise.resolve({ thread: { id: "thread" } });
      const turnId = url.pathname.split("/turns/")[1].split("/")[0];
      assert.equal(url.searchParams.get("limit"), "30");
      const task = deferred(); active += 1; maximum = Math.max(maximum, active);
      const entry = { turnId, url, resolve() {
        const values = source[ids.indexOf(turnId)];
        const latest = url.searchParams.get("sortDirection") === "desc";
        const start = latest ? Math.max(0, values.length - 30) : Number(url.searchParams.get("cursor") || 0);
        const items = values.slice(start, start + 30);
        const more = latest ? start > 0 : start + items.length < values.length;
        task.resolve({ items, hasMore: more, nextCursor: more ? String(latest ? start : start + items.length) : null, latestItemId: items.at(-1)?.id });
      } };
      pending.push(entry); pages.push(entry);
      const cancel = () => task.reject(options.signal.reason);
      options.signal.addEventListener("abort", cancel, { once: true });
      return task.promise.finally(() => { active -= 1; options.signal.removeEventListener("abort", cancel); });
    } });
  let expanded;
  try {
    await runtime.open(); await flush();
    for (const id of [...ids].reverse()) void runtime.setTurnVisibility(id, true);
    await flush();
    expanded = runtime.setProcessExpanded("target", true);
    pending.shift().resolve(); await flush();
    assert.equal(pages[2].turnId, "target");
    for (let count = 0; count < 20 && ids.some((id) => !store.state.turns[id].itemsLatestHydratedStatus); count++) {
      for (const page of pending.splice(0)) page.resolve(); await flush();
    }
    await expanded;
    for (const id of ids) {
      const turn = store.state.turns[id];
      const expected = source[ids.indexOf(id)].slice(-30);
      assert.deepEqual(turn.itemOrder, expected.map((item) => item.id));
      for (const item of expected) assert.equal(turn.items[item.id].presentation.text, item.presentation.text);
      assert.equal(turn.itemsLatestHydratedStatus, "completed");
      assert.equal(turn.itemsEarlierHasMore, true);
    }
    assert.deepEqual(pages.filter((x) => x.turnId === "target").map((x) => x.url.searchParams.get("cursor")), [""]);
    assert.ok(pages.every((page) => page.url.searchParams.get("sortDirection") === "desc"));
    assert.equal(pages.length, 4);
    assert.equal(maximum, 2);
  } finally { runtime.dispose(); await expanded; }
});

test("explicit full reads retain bounded age progress under collapse and reopen priority pressure", async (t) => {
  const ids = ["hold", "release", "ordinary", "a", "b", "c", "latest"];
  const targets = new Set(["a", "b", "c"]);
  const source = new Map(ids.map((id) => [id, Array.from({ length: ["hold", "release"].includes(id) ? 1 : 600 }, (_, index) =>
    ({ id: `${id}-${index}`, type: "agentMessage", status: "completed", text: `full pressure body ${id}-${index} 汉 🧪`,
      presentation: { text: `full pressure body ${id}-${index} 汉 🧪` } }))]));
  const store = createCodexChatStore("thread", { storage: { getItem: () => null, setItem() {} } });
  const turns = ids.map((id) => ({ id, status: id === "latest" ? "inProgress" : "completed", items: [] }));
  turns.forEach((turn) => store.upsertTurn(turn));
  const calls = [], timers = new Set(), operations = [];
  let active = 0, maximum = 0;
  const runtime = createCodexChatRuntime({ store, maxPolls: 0, visibility: null, yieldPage: () => Promise.resolve(),
    setTimer(callback, ms) { const timer = setTimeout(callback, ms); timers.add(timer); return timer; },
    clearTimer(timer) { clearTimeout(timer); timers.delete(timer); },
    request(path, options) {
      const url = new URL(path, "http://fixture.test");
      if (url.pathname.endsWith("/requests")) return Promise.resolve({ requests: [] });
      if (url.pathname.endsWith("/turns")) return Promise.resolve({ turns: turns.slice(-1) });
      if (!url.pathname.endsWith("/items")) return Promise.resolve({ thread: { id: "thread" } });
      assert.equal(url.searchParams.get("limit"), "30");
      const turnId = url.pathname.split("/turns/")[1].split("/")[0];
      const items = source.get(turnId), cursor = url.searchParams.get("cursor"), after = url.searchParams.get("after");
      const start = cursor ? Number(cursor) : after ? items.findIndex((item) => item.id === after) + 1 : 0;
      const selected = items.slice(start, start + 30), hasMore = start + selected.length < items.length;
      const task = deferred();
      const entry = { turnId, start, hasMore, settled: false, completed: false, resolve() {
        entry.completed = true;
        task.resolve({ items: selected, hasMore, nextCursor: hasMore ? String(start + selected.length) : null,
          latestItemId: selected.at(-1)?.id || after });
      } };
      calls.push(entry); active += 1; maximum = Math.max(maximum, active);
      const cancel = () => task.reject(options.signal.reason);
      options.signal.addEventListener("abort", cancel, { once: true });
      return task.promise.finally(() => { entry.settled = true; active -= 1; options.signal.removeEventListener("abort", cancel); });
    } });
  try {
    operations.push(runtime.syncItems("hold"), runtime.syncItems("release")); await flush();
    assert.deepEqual(calls.map((call) => call.turnId), ["hold", "release"]);
    operations.push(runtime.syncItems("latest"), runtime.syncItems("ordinary"));
    void runtime.setTurnVisibility("ordinary", true);
    for (const id of targets) operations.push(runtime.setProcessExpanded(id, true), runtime.syncItems(id));
    await runtime.refreshLatest();
    const waiting = ["latest", "ordinary", "a", "b", "c"];
    const completed = calls.find((call) => call.turnId === "release"); completed.resolve(); await flush();
    let sinceFifo = 0, observed = 2, fifoGrants = 0;
    function observeGrant() {
      const next = calls[observed++]; assert.ok(next);
      const position = waiting.indexOf(next.turnId); assert.ok(position >= 0);
      sinceFifo = position === 0 ? 0 : sinceFifo + 1;
      assert.ok(sinceFifo <= 2, `oldest ${waiting[0]} bypassed at grant ${observed - 2}`);
      if (position === 0) fifoGrants += 1;
      waiting.splice(position, 1);
    }
    observeGrant();
    for (let completedPages = 0; completedPages < 18; completedPages++) {
      const current = calls.find((call) => call.turnId !== "hold" && !call.settled && !call.completed);
      assert.ok(current);
      if (targets.has(current.turnId)) {
        await runtime.setProcessExpanded(current.turnId, false);
        operations.push(runtime.setProcessExpanded(current.turnId, true));
      }
      current.resolve(); await flush(); observeGrant();
      if (current.hasMore) waiting.push(current.turnId);
    }
    const pressure = calls.slice(2).map((call) => call.turnId);
    assert.deepEqual(pressure.slice(0, 6), ["a", "b", "latest", "c", "a", "ordinary"]);
    for (const id of ["latest", "ordinary", ...targets]) assert.ok(pressure.filter((turnId) => turnId === id).length >= 2, `${id} progresses under continuous pressure`);
    assert.ok(fifoGrants >= 6);
    for (let guard = 0; guard < 120; guard++) {
      const current = calls.find((call) => call.turnId !== "hold" && !call.settled && !call.completed);
      if (!current) break;
      if (targets.has(current.turnId)) {
        await runtime.setProcessExpanded(current.turnId, false);
        operations.push(runtime.setProcessExpanded(current.turnId, true));
      }
      current.resolve(); await flush();
    }
    assert.equal(active, 1, JSON.stringify(calls.filter((call) => !call.settled).map((call) => ({ turnId: call.turnId, start: call.start, completed: call.completed }))));
    calls.find((call) => call.turnId === "hold").resolve(); await Promise.all(operations);
    for (const id of ids) {
      const turn = store.state.turns[id];
      assert.deepEqual(turn.itemOrder, source.get(id).map((item) => item.id));
      assert.equal(turn.confirmedItemIds.length, source.get(id).length);
      for (const item of source.get(id)) assert.equal(turn.items[item.id].presentation.text, item.presentation.text);
      assert.equal(turn.itemsHydratedStatus, id === "latest" ? "inProgress" : "completed");
    }
    assert.equal(calls.length, 102); assert.equal(maximum, 2); assert.equal(active, 0);
    assert.equal(timers.size, 0);
    t.diagnostic(JSON.stringify({ pressureGrants: pressure.length, pressureOrder: pressure,
      byTurn: Object.fromEntries(["latest", "ordinary", ...targets].map((id) => [id, pressure.filter((turnId) => turnId === id).length])),
      fifoGrants, maximumBypasses: 2, completePages: calls.length, completeItems: [...source.values()].reduce((sum, items) => sum + items.length, 0), maximum }));
  } finally {
    runtime.dispose(); const state = JSON.stringify(store.state); await Promise.all(operations);
    assert.equal(active, 0); assert.equal(timers.size, 0); assert.equal(JSON.stringify(store.state), state);
  }
});
