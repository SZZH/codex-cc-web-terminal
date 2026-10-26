import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { compileScript, parse } from "vue/compiler-sfc";
import { createRenderer, h, markRaw, nextTick, reactive } from "vue";
import { createCodexChatStore } from "../web/src/lib/codex-chat-store.js";
import { createCodexChatRuntime } from "../web/src/lib/codex-chat-runtime.js";
import { codexRequestLabel, presentCodexChatSnapshot, presentCodexQueue } from "../web/src/lib/codex-chat-presentation.js";
import { buildThreadViewModel } from "../web/src/lib/thread-view-model.js";
import { buildQuestionAnswer } from "../web/src/lib/codex-question-history.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
}
function runtimeClock() {
  const timers = new Map();
  let time = 0, timerId = 0;
  return {
    now: () => time,
    setTimer: (callback, delay) => { timers.set(++timerId, { callback, at: time + delay }); return timerId; },
    clearTimer: (id) => timers.delete(id),
    get pending() { return timers.size; },
    // Connection watchdogs do not imply receipt/history polling.
    get pendingReads() { return [...timers.values()].filter(({ callback }) => !["connect", "handshakeExpired"].includes(callback.name)).length; },
    async advance(duration) {
      const end = time + duration;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id); time = timer.at;
        await timer.callback(); await flush();
      }
      time = end; await flush();
    }
  };
}
function fixture(handler, options = {}) {
  const storage = options.storage || memoryStorage();
  const store = createCodexChatStore(options.threadId || "thread", { storage });
  const calls = [], sockets = [];
  let index = 0;
  const runtime = createCodexChatRuntime({ store, location: { protocol: "https:", host: "example.test" },
    maxPolls: 0, newId: () => `request-${++index}`, request: async (url, request = {}) => {
      calls.push({ url, ...request });
      return handler(url, request);
    }, createSocket: (url) => {
      const socket = { url, close() { this.onclose?.(); }, event(event) { this.onmessage?.({ data: JSON.stringify(event) }); } };
      sockets.push(socket); return socket;
    }, ...options.runtime });
  return { store, runtime, calls, sockets, storage };
}
const requestBody = { input: { text: "same", attachments: [] }, options: { model: "test", reasoningEffort: "high", permissionMode: "default" } };
function reads(url) {
  if (url.endsWith("/interactions")) return { interactions: [], epoch: "interactions", revision: 0 };
  if (url.includes("/items?")) return { items: [], hasMore: false };
  if (url.endsWith("/requests")) return { requests: [] };
  if (url.includes("/turns?")) return { threadId: "thread", turns: [], hasMore: false };
  return { thread: { id: "thread", name: "title", cwd: "/tmp" } };
}

test("active queue submission stays above composer before delayed POST and through receipt transitions", async () => {
  const post = deferred();
  const { store, runtime, calls, storage } = fixture((url, options) => options.method === "POST" ? post.promise : reads(url));
  try {
    store.upsertTurn({ id: "active", status: "inProgress", items: [] });
    store.setDraft({ text: "next", attachments: [] });
    const sending = runtime.submit({ ...requestBody, input: { text: "next", attachments: [{ id: "photo" }] } });
    assert.equal(presentCodexQueue(store.state)[0].state, "sending");
    assert.deepEqual(presentCodexChatSnapshot(store.state).turns.map((turn) => turn.id), ["active"]);
    const body = JSON.parse(calls.find((call) => call.method === "POST").body);
    assert.deepEqual(Object.keys(body).sort(), ["clientRequestId", "input", "mode", "options"]);
    assert.equal(body.mode, "queue");
    store.upsertTurn({ id: "active", status: "completed" });
    store.setDraft({ text: "new draft" });
    assert.equal(presentCodexQueue(store.state)[0].state, "sending", "finishing the preceding turn cannot change initial placement");
    const pendingReload = createCodexChatStore("thread", { storage });
    assert.equal(presentCodexQueue(pendingReload.state)[0].state, "unknown");
    assert.equal(presentCodexChatSnapshot(pendingReload.state).turns.length, 0);
    post.resolve({ request: { id: body.clientRequestId, state: "received" } });
    await sending;
    for (const state of ["received", "dispatching", "queued"]) {
      store.upsertRequest({ id: body.clientRequestId, state });
      assert.equal(presentCodexQueue(store.state)[0].state, state);
      assert.deepEqual(presentCodexChatSnapshot(store.state).turns.map((turn) => turn.id), ["active"]);
      assert.equal(store.state.draft.text, "new draft");
    }
    store.upsertRequest({ id: body.clientRequestId, state: "accepted", turnId: "next-turn" });
    assert.equal(presentCodexQueue(store.state).length, 0);
    assert.equal(presentCodexChatSnapshot(store.state).turns.flatMap((turn) => turn.items).filter((item) => item.request?.id === body.clientRequestId).length, 1);
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  } finally { runtime.dispose(); }
});

test("idle submission and direct steer retain their ordinary timeline placement during a delayed POST", async () => {
  for (const mode of ["queue", "steer"]) {
    const post = deferred();
    const { store, runtime } = fixture((url, options) => options.method === "POST" ? post.promise : reads(url));
    try {
      if (mode === "steer") store.upsertTurn({ id: "active", status: "inProgress", items: [] });
      else {
        store.upsertTurn({ id: "stale-running", status: "inProgress", items: [] });
        store.upsertTurn({ id: "latest-completed", status: "completed", items: [] });
      }
      const sending = runtime.submit({ ...requestBody, mode, ...(mode === "steer" ? { expectedTurnId: "active" } : {}) });
      assert.equal(presentCodexQueue(store.state).length, 0);
      assert.equal(presentCodexChatSnapshot(store.state).turns.flatMap((turn) => turn.items).filter((item) => item.request?.id === "request-1").length, 1);
      post.resolve({ request: { id: "request-1", state: "received", mode } });
      await sending;
      assert.equal(presentCodexQueue(store.state).length, 0);
      assert.equal(store.state.requests["request-1"].initialPlacement, "timeline");
    } finally { runtime.dispose(); }
  }
});

test("an idle send stays in the timeline through desktop queue handoff, reload and official execution", async () => {
  const post = deferred();
  const { store, runtime, calls, storage } = fixture((url, options) => {
    if (url.endsWith("/requests") && options.method === "POST") return post.promise;
    return reads(url);
  });
  try {
    const sending = runtime.submit(requestBody);
    assert.equal(store.state.requests["request-1"].initialPlacement, "timeline");
    assert.equal(presentCodexChatSnapshot(store.state).turns.length, 1);
    post.resolve({ request: { id: "request-1", state: "queued", executionRoute: "desktopQueue" } });
    await sending;
    assert.equal(presentCodexChatSnapshot(store.state).turns.length, 1);
    assert.equal(presentCodexQueue(store.state).length, 0);
    assert.equal(codexRequestLabel(store.state.requests["request-1"]), "发送中");
    store.upsertRequest({ id: "request-1", state: "dispatching" });
    assert.equal(presentCodexQueue(store.state).length, 0);
    const restored = createCodexChatStore("thread", { storage });
    assert.equal(restored.state.requests["request-1"].initialPlacement, "timeline");
    assert.equal(presentCodexChatSnapshot(restored.state).turns.length, 1);
    assert.equal(presentCodexQueue(restored.state).length, 0);
    restored.upsertRequest({ id: "request-1", state: "accepted", turnId: "next-turn" });
    restored.upsertTurn({ id: "next-turn", status: "inProgress", items: [
      { id: "official-user", type: "userMessage", clientId: "request-1", text: requestBody.input.text }
    ] });
    assert.equal(presentCodexQueue(restored.state).length, 0);
    const messages = presentCodexChatSnapshot(restored.state).turns.flatMap((turn) => turn.items);
    assert.deepEqual(messages.map((item) => item.id), ["official-user"]);
    assert.equal(calls.filter((call) => call.url.endsWith("/requests") && call.method === "POST").length, 1);
  } finally { runtime.dispose(); }
});

test("unknown and rejected queued submits remain in composer with original input and explicit recovery", async () => {
  for (const status of [503, 400]) {
    const { store, runtime, calls, storage } = fixture((url, options) => {
      if (options.method === "POST") throw Object.assign(new Error("submit failed"), { status });
      if (url.endsWith("/requests/request-1")) throw Object.assign(new Error("not found"), { status: 404 });
      return reads(url);
    });
    try {
      store.upsertTurn({ id: "active", status: "inProgress", items: [] });
      const receipt = await runtime.submit({ ...requestBody, input: { text: "original", attachments: [{ id: "photo" }] } });
      assert.equal(receipt.state, status === 503 ? "unknown" : "rejected");
      assert.equal(presentCodexQueue(store.state)[0].text, "original");
      assert.deepEqual(presentCodexChatSnapshot(store.state).turns.map((turn) => turn.id), ["active"]);
      assert.equal(presentCodexQueue(createCodexChatStore("thread", { storage }).state)[0].state, receipt.state);
      if (status === 503) {
        assert.equal(runtime.restoreRequest(receipt.id), false);
        await runtime.dismissUnknownReceipt(receipt.id);
        assert.equal(presentCodexQueue(store.state)[0].request.confirmationDismissed, true);
        assert.equal(store.state.requests[receipt.id].state, "unknown");
      } else {
        store.setDraft({ text: "new draft" });
        assert.equal(runtime.restoreRequest(receipt.id), false);
        assert.equal(store.state.draft.text, "new draft");
        assert.equal(presentCodexQueue(store.state).length, 1);
        store.setDraft({ text: "" });
        assert.equal(runtime.restoreRequest(receipt.id), true);
        assert.equal(store.state.draft.text, "original");
        assert.equal(store.state.draft.attachments[0].uploadedId, "photo");
        assert.equal(presentCodexQueue(store.state).length, 0);
        assert.deepEqual(presentCodexChatSnapshot(store.state).turns.map((turn) => turn.id), ["active"]);
        assert.equal(store.state.requests[receipt.id].restoredToDraft, true);
        assert.equal(presentCodexQueue(createCodexChatStore("thread", { storage }).state).length, 0);
      }
      assert.equal(calls.filter((call) => call.method === "POST").length, 1);
    } finally { runtime.dispose(); }
  }
});

test("confirmed cancellation removes the waiting card without a synthetic turn or draft restoration", async () => {
  const cancellation = deferred();
  const { store, runtime, calls, storage } = fixture((url) => url.endsWith("/cancel") ? cancellation.promise : reads(url));
  try {
    store.upsertRequest({ id: "waiting", mode: "queue", state: "queued", input: { text: "withdrawn", attachments: [{ id: "photo" }] } });
    store.setDraft({ text: "new draft", attachments: [{ id: "draft-photo", uploadedId: "draft-photo", kind: "image" }] });
    const cancel = runtime.cancelQueuedRequest("waiting");
    assert.equal(runtime.cancelQueuedRequest("waiting"), cancel);
    assert.equal(presentCodexQueue(store.state).length, 1, "pending cancellation is not a confirmed removal");
    cancellation.resolve({ request: { id: "waiting", state: "cancelled" } });
    await cancel;
    assert.equal(presentCodexQueue(store.state).length, 0);
    assert.equal(presentCodexChatSnapshot(store.state).turns.length, 0);
    assert.equal(store.state.requests.waiting.state, "cancelled");
    assert.equal(store.state.draft.text, "new draft");
    assert.equal(store.state.draft.attachments[0].uploadedId, "draft-photo");
    const restored = createCodexChatStore("thread", { storage });
    assert.equal(restored.state.requests.waiting.state, "cancelled");
    assert.equal(presentCodexChatSnapshot(restored.state).turns.length, 0);
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  } finally { runtime.dispose(); }
});

test("claimed cancellation conflict retains the card until authoritative execution is confirmed", async () => {
  let serverState = "dispatching";
  const { store, runtime, calls } = fixture((url) => {
    if (url.endsWith("/cancel")) throw Object.assign(new Error("message already claimed"), { status: 409 });
    if (url.endsWith("/requests/claimed")) return { request: { id: "claimed", state: serverState,
      ...(serverState === "running" ? { turnId: "official-turn" } : {}) } };
    return reads(url);
  });
  try {
    store.upsertRequest({ id: "claimed", mode: "queue", state: "queued", input: { text: "claimed" } });
    store.setDraft({ text: "preserved" });
    await runtime.cancelQueuedRequest("claimed");
    assert.equal(presentCodexQueue(store.state)[0].state, "dispatching");
    assert.equal(presentCodexChatSnapshot(store.state).turns.length, 0);
    assert.match(store.state.error, /already claimed/);
    serverState = "running";
    await runtime.checkRequest("claimed");
    assert.equal(presentCodexQueue(store.state).length, 0);
    const snapshot = presentCodexChatSnapshot(store.state);
    assert.equal(snapshot.turns.length, 1);
    assert.equal(snapshot.turns[0].items[0].request.state, "running");
    assert.notEqual(snapshot.turns[0].status, "aborted");
    assert.equal(store.state.draft.text, "preserved");
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  } finally { runtime.dispose(); }
});

function declaredHistoryPages() {
  const turns = new Map();
  function route(path) {
    const url = new URL(path, "https://example.test");
    const match = url.pathname.match(/\/threads\/([^/]+)\/turns(?:\/([^/]+)\/items)?$/);
    return match && { url, threadId: decodeURIComponent(match[1]), turnId: match[2] && decodeURIComponent(match[2]) };
  }
  return {
    remember(path, payload) {
      const target = route(path);
      if (target && !target.turnId && Array.isArray(payload?.turns)) {
        for (const turn of payload.turns) turns.set(`${target.threadId}:${turn.id}`,
          (turn.items || []).map((item, position) => ({ ...item, position: item.position ?? position })));
      }
      return payload;
    },
    read(path) {
      const target = route(path);
      const source = target?.turnId && turns.get(`${target.threadId}:${target.turnId}`);
      if (!source) return undefined;
      const query = target.url.searchParams, limit = Number(query.get("limit")) || 30;
      const descending = query.get("sortDirection") === "desc";
      const cursor = query.get("cursor");
      const anchor = query.has("after") ? source.findIndex((item) => item.id === query.get("after")) : -1;
      const offset = cursor?.startsWith("fixture:") ? Number(cursor.split(":").at(-1))
        : descending ? source.length : query.has("after") ? anchor < 0 ? source.length : anchor + 1 : 0;
      const start = descending ? Math.max(0, offset - limit) : offset;
      const end = descending ? offset : Math.min(source.length, offset + limit);
      const items = source.slice(start, end);
      const nextCursor = descending ? start > 0 ? `fixture:desc:${start}` : null : end < source.length ? `fixture:asc:${end}` : null;
      return { threadId: target.threadId, turnId: target.turnId, items, nextCursor, hasMore: Boolean(nextCursor),
        latestItemId: items.at(-1)?.id || query.get("after") || null };
    }
  };
}

test("a successful older-page retry retires its own error and preserves the draft", async () => {
  let attempts = 0;
  const { runtime, store } = fixture((url) => {
    if (url.includes("cursor=older")) {
      if (++attempts === 1) throw Object.assign(new Error("older temporarily unavailable"), { status: 503 });
      return { turns: [{ id: "older", status: "completed", items: [] }], hasMore: false };
    }
    return reads(url);
  });
  try {
    store.state.hasMore = true; store.state.olderCursor = "older";
    store.setDraft({ text: "preserved draft" });
    await runtime.loadOlder();
    assert.equal(store.state.error, "older temporarily unavailable");
    await runtime.loadOlder();
    assert.ok(store.state.turns.older);
    assert.equal(store.state.hasMore, false);
    assert.equal(store.state.error, "");
    assert.equal(store.state.draft.text, "preserved draft");
  } finally { runtime.dispose(); }
});

test("a successful interrupt retry retires its own error after refreshing without another write", async () => {
  let posts = 0;
  const { runtime, store } = fixture((url) => {
    if (url.endsWith("/interrupt")) {
      if (++posts === 1) throw Object.assign(new Error("interrupt temporarily unavailable"), { status: 503 });
      return {};
    }
    return reads(url);
  });
  try {
    await runtime.interrupt();
    assert.equal(store.state.error, "interrupt temporarily unavailable");
    await runtime.interrupt();
    assert.equal(posts, 2);
    assert.equal(store.state.interrupting, false);
    assert.equal(store.state.historyReadError, "");
    assert.equal(store.state.error, "");
  } finally { runtime.dispose(); }
});

test("an invalid older-page success cannot clear the error or consume its retry cursor", async () => {
  let response = {};
  const { runtime, store } = fixture((url) => url.includes("cursor=older") ? response : reads(url));
  try {
    store.state.hasMore = true; store.state.olderCursor = "older";
    await runtime.loadOlder();
    assert.match(store.state.error, /响应格式无效/);
    assert.equal(store.state.hasMore, true);
    assert.equal(store.state.olderCursor, "older");
    response = { turns: [], hasMore: false };
    await runtime.loadOlder();
    assert.equal(store.state.error, "");
    assert.equal(store.state.hasMore, false);
  } finally { runtime.dispose(); }
});

test("older recovery cannot clear a newer interrupt failure and interrupt recovery preserves history errors", async () => {
  const page = deferred();
  let olderReads = 0, interrupts = 0;
  const { runtime, store } = fixture((url) => {
    if (url.includes("cursor=older")) {
      if (++olderReads === 1) throw new Error("older failed");
      return page.promise;
    }
    if (url.endsWith("/interrupt")) {
      if (++interrupts === 1) throw new Error("interrupt failed");
      return {};
    }
    if (url.includes("/turns?")) throw new Error("latest history failed");
    return reads(url);
  });
  try {
    store.state.hasMore = true; store.state.olderCursor = "older";
    await runtime.loadOlder();
    const recovery = runtime.loadOlder();
    await runtime.interrupt();
    assert.equal(store.state.error, "interrupt failed");
    page.resolve({ turns: [], hasMore: false }); await recovery;
    assert.equal(store.state.error, "interrupt failed");
    await runtime.interrupt();
    assert.equal(store.state.error, "");
    assert.equal(store.state.historyReadError, "latest history failed");
  } finally { page.resolve({ turns: [], hasMore: false }); runtime.dispose(); }
});

for (const oldOutcome of ["success", "failure"]) {
  test(`an older promotion ${oldOutcome} cannot replace a newer same-owner outcome`, async () => {
    const old = deferred(), latest = deferred();
    const original = (id) => ({ id, state: "received", mode: "queue", input: { text: id } });
    const accepted = (id) => ({ request: { ...original(id), mode: "steer", state: "accepted", turnId: "active" } });
    const { runtime, store } = fixture((url) => {
      if (url.endsWith("/requests/old/steer")) return old.promise;
      if (url.endsWith("/requests/latest/steer")) return latest.promise;
      if (url.endsWith("/requests/old")) return { request: original("old") };
      if (url.endsWith("/requests/latest")) return { request: original("latest") };
      return reads(url);
    });
    try {
      store.upsertTurn({ id: "active", status: "inProgress", items: [] });
      store.upsertRequest(original("old")); store.upsertRequest(original("latest"));
      const first = runtime.promoteQueuedRequest("old");
      const second = runtime.promoteQueuedRequest("latest");
      if (oldOutcome === "success") latest.reject(new Error("latest guide failed"));
      else latest.resolve(accepted("latest"));
      await second;
      if (oldOutcome === "success") old.resolve(accepted("old"));
      else old.reject(new Error("old guide failed"));
      await first;
      assert.equal(store.state.error, oldOutcome === "success" ? "latest guide failed" : "");
    } finally { old.resolve(accepted("old")); latest.resolve(accepted("latest")); runtime.dispose(); }
  });
}

test("successful submit, promote, cancel and restore cannot erase an unrelated older-page failure", async () => {
  const { runtime, store, calls } = fixture((url, options) => {
    if (url.includes("cursor=older")) throw new Error("older still failed");
    if (url.endsWith("/requests/queued/steer")) return { request: { id: "queued", mode: "steer", state: "accepted", turnId: "active" } };
    if (url.endsWith("/requests/desktop/cancel")) return { request: { id: "desktop", state: "cancelled" } };
    if (url.endsWith("/requests") && options.method === "POST") return { request: { id: JSON.parse(options.body).clientRequestId, state: "completed" } };
    return reads(url);
  });
  try {
    store.state.hasMore = true; store.state.olderCursor = "older";
    await runtime.loadOlder();
    store.upsertTurn({ id: "active", status: "inProgress", items: [] });
    store.upsertRequest({ id: "queued", mode: "queue", state: "received", input: { text: "guide" } });
    store.upsertRequest({ id: "desktop", state: "queued" });
    store.upsertRequest({ id: "failed", state: "rejected", input: { text: "restore" } });
    await runtime.promoteQueuedRequest("queued");
    assert.equal(store.state.error, "older still failed");
    await runtime.cancelQueuedRequest("desktop");
    assert.equal(store.state.error, "older still failed");
    assert.equal(runtime.restoreRequest("failed"), true);
    assert.equal(store.state.error, "older still failed");
    await runtime.submit(requestBody);
    assert.equal(store.state.error, "older still failed");
    assert.equal(calls.filter((call) => call.url.endsWith("/requests") && call.method === "POST").length, 1);
  } finally { runtime.dispose(); }
});

test("restoring after a draft conflict clears only the recovered restore error", async () => {
  const { runtime, store } = fixture(reads);
  try {
    store.upsertRequest({ id: "failed", state: "rejected", input: { text: "original" } });
    store.setDraft({ text: "in progress" });
    assert.equal(runtime.restoreRequest("failed"), false);
    assert.match(store.state.error, /请先处理当前草稿/);
    store.setDraft({ text: "" });
    assert.equal(runtime.restoreRequest("failed"), true);
    assert.equal(store.state.error, "");
    assert.equal(store.state.draft.text, "original");
  } finally { runtime.dispose(); }
});

test("restoring another failed message retires a resolved draft conflict from the previous restore", () => {
  const { runtime, store } = fixture(reads);
  try {
    store.upsertRequest({ id: "failed-a", state: "rejected", input: { text: "message A" } });
    store.upsertRequest({ id: "failed-b", state: "rejected", input: { text: "message B" } });
    store.setDraft({ text: "current draft" });
    assert.equal(runtime.restoreRequest("failed-a"), false);
    assert.match(store.state.error, /请先处理当前草稿/);
    store.setDraft({ text: "" });
    assert.equal(runtime.restoreRequest("failed-b"), true);
    assert.equal(store.state.draft.text, "message B");
    assert.equal(store.state.error, "");
  } finally { runtime.dispose(); }
});

test("a successful submit after local persistence failure clears only its own send error", async () => {
  const values = new Map();
  let unavailable = false;
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => {
    if (unavailable) throw new Error("storage unavailable");
    values.set(key, value);
  } };
  const { runtime, store, calls } = fixture((url, options) => options.method === "POST"
    ? { request: { id: JSON.parse(options.body).clientRequestId, state: "completed" } } : reads(url), { storage });
  try {
    store.setDraft({ text: "keep unsent" }); unavailable = true;
    await assert.rejects(runtime.submit(requestBody), /storage unavailable/);
    assert.match(store.state.error, /storage unavailable/);
    assert.equal(calls.length, 0);
    unavailable = false;
    await runtime.submit(requestBody);
    assert.equal(store.state.error, "");
    assert.equal(store.state.persistenceError, "");
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  } finally { runtime.dispose(); }
});

for (const operation of ["promote", "cancel"]) {
  for (const recovery of ["retry", "receipt"]) {
    test(`${operation} retires its own error after ${recovery} recovery without replaying another request`, async () => {
      const original = { id: "queued", state: operation === "promote" ? "received" : "queued", mode: "queue", input: { text: "original" } };
      const recovered = { ...original, ...(operation === "promote" ? { mode: "steer", state: "accepted", turnId: "active" } : { state: "cancelled" }) };
      let posts = 0;
      const { runtime, store } = fixture((url, options) => {
        if (options.method === "POST") {
          if (++posts === 1) throw new Error("lost action acknowledgement");
          return { request: recovered };
        }
        if (url.endsWith("/requests/queued")) return { request: recovery === "receipt" ? recovered : original };
        return reads(url);
      });
      try {
        store.upsertTurn({ id: "active", status: "inProgress", items: [] });
        store.upsertRequest(original); store.setDraft({ text: "keep draft" });
        const action = () => operation === "promote" ? runtime.promoteQueuedRequest("queued") : runtime.cancelQueuedRequest("queued");
        await action();
        if (recovery === "retry") {
          assert.equal(store.state.error, "lost action acknowledgement");
          await action();
        }
        assert.equal(store.state.error, "");
        assert.equal(posts, recovery === "retry" ? 2 : 1);
        assert.equal(store.state.requests.queued.state, recovered.state);
        assert.equal(store.state.draft.text, "keep draft");
      } finally { runtime.dispose(); }
    });
  }
}

test("socket construction retries on the existing timer and only current accepted activity retires connection errors", async () => {
  const clock = runtimeClock(), created = [];
  let attempts = 0;
  const { runtime, store } = fixture(reads, { runtime: {
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    createSocket: () => {
      if (++attempts === 1) throw new Error("socket construction failed");
      const socket = { close() { this.onclose?.(); }, event(event) { this.onmessage?.({ data: JSON.stringify(event) }); } };
      created.push(socket); return socket;
    }
  } });
  try {
    await runtime.open();
    assert.equal(store.state.error, "socket construction failed");
    assert.equal(clock.pending, 1);
    await clock.advance(1999); assert.equal(attempts, 1);
    await clock.advance(1); assert.equal(attempts, 2);
    assert.equal(store.state.error, "socket construction failed");
    const first = created[0]; first.onopen();
    assert.equal(store.state.error, "");
    first.onmessage({ data: "invalid JSON" });
    const malformedError = store.state.error;
    assert.ok(malformedError);
    first.event({ schemaVersion: 2, threadId: "other", epoch: "", seq: 1, type: "history.changed" });
    first.event({ schemaVersion: 2, threadId: "thread", epoch: "", seq: 0, type: "history.changed" });
    assert.equal(store.state.error, malformedError, "ignored frames are not event recovery");
    first.onclose(); await clock.advance(2000);
    const current = created[1]; current.onopen();
    assert.equal(store.state.error, malformedError, "an open socket does not prove an event parse recovered");
    first.event({ schemaVersion: 2, threadId: "thread", epoch: "epoch", seq: 0, type: "sync.required" });
    assert.equal(store.state.error, malformedError, "an old socket cannot clear the event error");
    current.event({ schemaVersion: 2, threadId: "thread", epoch: "epoch", seq: 0, type: "sync.required" });
    await flush();
    assert.equal(store.state.error, "");
    assert.equal(store.state.connection, "connected");
  } finally { runtime.dispose(); assert.equal(clock.pending, 0); }
});

test("accepted socket events and opens preserve an unresolved operation failure", async () => {
  const { runtime, store, sockets } = fixture((url) => {
    if (url.includes("cursor=older")) throw new Error("older still failed");
    return reads(url);
  });
  try {
    await runtime.open();
    store.state.hasMore = true; store.state.olderCursor = "older";
    await runtime.loadOlder();
    sockets[0].onopen();
    assert.equal(store.state.error, "older still failed");
    sockets[0].onmessage({ data: "invalid JSON" });
    assert.notEqual(store.state.error, "older still failed");
    sockets[0].event({ schemaVersion: 2, threadId: "thread", epoch: "epoch", seq: 0, type: "sync.required" });
    await flush();
    assert.equal(store.state.error, "older still failed");
  } finally { runtime.dispose(); }
});

for (const [status, recovery] of [[200, "manual"], [200, "background"], [404, "manual"], [404, "background"]]) {
  test(`a successful ${recovery} confirmation ${status} retires the same receipt's prior check failure`, async () => {
    let response = 503;
    const { runtime, store } = fixture((url) => {
      if (url.endsWith("/requests/lost")) {
        if (response !== 200) throw Object.assign(new Error(response === 503 ? "confirmation unavailable" : "missing receipt"), { status: response });
        return { request: { id: "lost", state: "completed" } };
      }
      return reads(url);
    });
    try {
      store.upsertRequest({ id: "lost", state: "unknown", error: { code: "receipt_not_found" } });
      assert.equal(await runtime.dismissUnknownReceipt("lost"), false);
      assert.equal(store.state.error, "confirmation unavailable");
      response = status;
      if (recovery === "manual") assert.equal(await runtime.dismissUnknownReceipt("lost"), status === 404);
      else await runtime.checkRequest("lost");
      assert.equal(store.state.error, "");
      assert.equal(store.state.requests.lost.state, status === 200 ? "completed" : "unknown");
      if (status === 404) {
        if (recovery === "background") {
          assert.notEqual(store.state.requests.lost.confirmationDismissed, true);
          assert.equal(await runtime.dismissUnknownReceipt("lost"), true);
        } else assert.equal(store.state.requests.lost.confirmationDismissed, true);
      }
    } finally { runtime.dispose(); }
  });
}

test("confirmation failures remain visible until the same receipt is successfully checked", async () => {
  let recovered = false;
  const { runtime, store } = fixture((url) => {
    if (url.endsWith("/requests/lost")) {
      if (!recovered) throw Object.assign(new Error("confirmation unavailable"), { status: 503 });
      return { request: { id: "lost", state: "completed" } };
    }
    if (url.endsWith("/requests/other")) return { request: { id: "other", state: "completed" } };
    return reads(url);
  });
  try {
    store.upsertRequest({ id: "lost", state: "unknown", error: { code: "receipt_not_found" } });
    await runtime.dismissUnknownReceipt("lost");
    await runtime.checkRequest("other");
    assert.equal(store.state.error, "confirmation unavailable");
    await runtime.checkRequest("lost");
    assert.equal(store.state.error, "confirmation unavailable");
    recovered = true;
    await runtime.checkRequest("lost");
    assert.equal(store.state.error, "");
  } finally { runtime.dispose(); }
});

test("an older successful confirmation cannot clear a newer same-receipt failure", async () => {
  const old = deferred();
  let attempts = 0;
  const { runtime, store } = fixture((url) => {
    if (url.endsWith("/requests/lost")) {
      if (++attempts === 1) return old.promise;
      throw Object.assign(new Error("new confirmation failure"), { status: 503 });
    }
    return reads(url);
  });
  try {
    store.upsertRequest({ id: "lost", state: "unknown", error: { code: "receipt_not_found" } });
    const first = runtime.dismissUnknownReceipt("lost");
    await runtime.dismissUnknownReceipt("lost");
    old.resolve({ request: { id: "lost", state: "completed" } });
    await first;
    assert.equal(store.state.error, "new confirmation failure");
  } finally { old.resolve({ request: { id: "lost", state: "completed" } }); runtime.dispose(); }
});

test("running and received requests permit distinct queued followups and steer pins the active turn", async () => {
  const { runtime, store, calls } = fixture((url, options) => {
    if (options.method === "POST") { const body = JSON.parse(options.body); return { request: { id: body.clientRequestId, state: "received", mode: body.mode } }; }
    return reads(url);
  });
  store.upsertTurn({ id: "active", status: "inProgress" });
  store.upsertRequest({ id: "original", state: "running", turnId: "active", input: { text: "first" } });
  await runtime.submit({ ...requestBody, mode: "queue" });
  await runtime.submit({ ...requestBody, mode: "queue" });
  await runtime.submit({ ...requestBody, mode: "steer", expectedTurnId: "active" });
  const bodies = calls.filter((call) => call.method === "POST").map((call) => JSON.parse(call.body));
  assert.deepEqual(bodies.map((body) => body.mode), ["queue", "queue", "steer"]);
  assert.equal(new Set(bodies.map((body) => body.clientRequestId)).size, 3);
  assert.equal(bodies[2].expectedTurnId, "active");
  store.upsertTurn({ id: "active", status: "completed" });
  await assert.rejects(runtime.submit({ ...requestBody, mode: "steer", expectedTurnId: "active" }), /轮次已变化/);
  assert.equal(calls.filter((call) => call.method === "POST").length, 3);
  runtime.dispose();
});

test("promoting a queued message reuses its receipt and deduplicates clicks without touching the draft", async () => {
  const pending = deferred();
  const { runtime, store, calls } = fixture((url) => url.endsWith("/steer") ? pending.promise : reads(url));
  store.upsertTurn({ id: "active", status: "inProgress" });
  const receipt = { id: "queued", state: "received", mode: "queue", input: { text: "keep original", attachments: [{ id: "photo" }] } };
  store.upsertRequest(receipt);
  store.setDraft({ text: "unrelated draft" });
  const first = runtime.promoteQueuedRequest("queued");
  assert.equal(runtime.promoteQueuedRequest("queued"), first);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/requests/queued/steer"));
  assert.deepEqual(JSON.parse(calls[0].body), { expectedTurnId: "active" });
  pending.resolve({ request: { ...receipt, mode: "steer", state: "accepted", turnId: "active" } });
  await first;
  assert.equal(store.state.requests.queued.mode, "steer");
  assert.deepEqual(store.state.requests.queued.input.attachments, [{ id: "photo" }]);
  assert.equal(store.state.draft.text, "unrelated draft");
  assert.deepEqual(store.state.requestOrder, ["queued"]);
  runtime.dispose();
});

test("lost promotion response checks the original receipt without submitting or rejecting a second message", async () => {
  const receipt = { id: "queued", state: "received", mode: "queue", input: { text: "keep original" } };
  const { runtime, store, calls } = fixture((url) => {
    if (url.endsWith("/steer")) throw new Error("connection lost");
    if (url.endsWith("/requests/queued")) return { request: { ...receipt, mode: "steer", state: "running", turnId: "active" } };
    return reads(url);
  });
  store.upsertTurn({ id: "active", status: "inProgress" }); store.upsertRequest(receipt);
  await runtime.promoteQueuedRequest("queued");
  assert.equal(store.state.requests.queued.state, "running");
  assert.equal(store.state.requests.queued.mode, "steer");
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(calls.some((call) => call.url.endsWith("/requests") && call.method === "POST"), false);
  runtime.dispose();
});

test("promotion permits only explicitly unlocked missing receipts and relocks on server rediscovery", async () => {
  const { runtime, store, calls } = fixture((url) => {
    if (url.endsWith("/requests/lost")) throw Object.assign(new Error("missing receipt"), { status: 404 });
    if (url.endsWith("/steer")) return { request: { id: "queued", mode: "steer", state: "accepted", turnId: "active" } };
    return reads(url);
  });
  try {
    store.upsertTurn({ id: "active", status: "inProgress", items: [] });
    store.upsertRequest({ id: "queued", mode: "queue", state: "received", input: { text: "guide me" } });
    store.upsertRequest({ id: "lost", state: "unknown", input: { text: "uncertain" }, error: { code: "receipt_not_found" } });
    store.setDraft({ text: "keep draft" });
    assert.equal(await runtime.promoteQueuedRequest("queued"), null);
    assert.equal(calls.length, 0);
    assert.equal(await runtime.dismissUnknownReceipt("lost"), true);
    const promotion = runtime.promoteQueuedRequest("queued");
    assert.equal(runtime.promoteQueuedRequest("queued"), promotion);
    await promotion;
    assert.equal(calls.filter((call) => call.url.endsWith("/requests/queued/steer")).length, 1);
    assert.equal(store.state.requests.queued.state, "accepted");
    assert.equal(store.state.draft.text, "keep draft");
    store.upsertRequest({ id: "second", mode: "queue", state: "received", input: { text: "next" } });
    store.upsertRequest({ id: "not-missing", state: "unknown", confirmationDismissed: true, error: { code: "connection_lost" } });
    assert.equal(await runtime.promoteQueuedRequest("second"), null);
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
    store.upsertRequest({ id: "not-missing", state: "completed" });
    store.upsertRequest({ id: "lost", state: "unknown", confirmationDismissed: false, error: null });
    assert.equal(await runtime.promoteQueuedRequest("second"), null);
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  } finally { runtime.dispose(); }
});

test("client missing-receipt unlock matches the real service promotion guard without exempting server unknowns", async () => {
  const { CodexThreadService } = await import("../src/sessions/codex/threadService.js");
  const records = new Map([
    ["owner", { id: "owner", state: "running", turnId: "active" }],
    ["queued", { id: "queued", state: "received", mode: "queue", input: { text: "guide me", attachments: [] } }]
  ]);
  const dispatched = [];
  const service = Object.assign(Object.create(CodexThreadService.prototype), {
    bridge: {}, closed: false, config: {}, loaded: new Set(["thread"]), trackedRequests: new Set(),
    active: new Map([["thread", { requestId: "owner", turnId: "active" }]]),
    requests: { get: (_threadId, id) => records.get(id), list: () => [...records.values()] },
    updateRequest: (_threadId, id, patch) => { const next = { ...records.get(id), ...patch }; records.set(id, next); return next; },
    dispatchSteer: (_threadId, id) => dispatched.push(id)
  });
  const { runtime, store, calls } = fixture((url, options) => {
    if (url.endsWith("/requests/lost")) throw Object.assign(new Error("missing receipt"), { status: 404 });
    if (url.endsWith("/requests")) return { requests: [...records.values()] };
    if (url.endsWith("/steer")) return { request: service.promoteQueuedRequest("thread", "queued", JSON.parse(options.body)) };
    return reads(url);
  });
  try {
    store.upsertTurn({ id: "active", status: "inProgress", items: [] });
    for (const receipt of records.values()) store.upsertRequest(receipt);
    store.upsertRequest({ id: "lost", state: "unknown", input: { text: "uncertain" }, error: { code: "receipt_not_found" } });
    assert.equal(await runtime.dismissUnknownReceipt("lost"), true);
    assert.equal(records.has("lost"), false, "the dismissed client receipt is absent from server state");
    await runtime.promoteQueuedRequest("queued"); await flush();
    assert.deepEqual(dispatched, ["queued"]);
    assert.equal(records.get("queued").mode, "steer");
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
    records.set("second", { id: "second", state: "received", mode: "queue", input: { text: "next", attachments: [] } });
    records.set("lost", { id: "lost", state: "unknown", input: { text: "uncertain" }, error: null });
    await runtime.pollRequests();
    assert.equal(store.state.requests.lost.confirmationDismissed, false);
    assert.equal(await runtime.promoteQueuedRequest("second"), null);
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
    assert.throws(() => service.promoteQueuedRequest("thread", "second", { expectedTurnId: "active" }),
      (error) => error.status === 409 && error.code === "confirmation_required");
    assert.deepEqual(dispatched, ["queued"]);
  } finally { runtime.dispose(); }
});

for (const domain of ["metadata", "turns"]) {
  test(`failed ${domain} reads recover with stable empty receipts using existing backoff then stop`, async () => {
    const clock = runtimeClock();
    let attempts = 0;
    const { runtime, store } = fixture((url) => {
      if (domain === "metadata" ? url.endsWith("/threads/thread") : url.includes("/turns?")) {
        attempts += 1;
        if (attempts < 4) throw Object.assign(new Error(`${domain} temporarily unavailable`), { status: 503 });
      }
      return reads(url);
    }, { runtime: { setTimer: clock.setTimer, clearTimer: clock.clearTimer, maxPolls: Infinity } });
    try {
      store.setDraft({ text: "keep the draft" });
      await runtime.open();
      assert.equal(attempts, 1);
      assert.match(store.state.historyReadError, /temporarily unavailable/);
      assert.equal(clock.pendingReads, 1);
      await clock.advance(2000); assert.equal(attempts, 2);
      await clock.advance(2000); assert.equal(attempts, 3);
      await clock.advance(3999); assert.equal(attempts, 3);
      await clock.advance(1); assert.equal(attempts, 4);
      assert.equal(store.state.historyReadError, "");
      assert.equal(store.state.initialized, true);
      assert.equal(store.state.draft.text, "keep the draft");
      assert.equal(clock.pendingReads, 0);
      await clock.advance(60000); assert.equal(attempts, 4);
    } finally { runtime.dispose(); }
  });
}

test("hidden history recovery uses the existing thirty-second floor and disposal cancels its timer", async () => {
  const clock = runtimeClock();
  let attempts = 0;
  const { runtime, store } = fixture((url) => {
    if (url.includes("/turns?")) { attempts += 1; throw new Error("history unavailable"); }
    return reads(url);
  }, { runtime: { visibility: { hidden: true }, setTimer: clock.setTimer, clearTimer: clock.clearTimer, maxPolls: Infinity } });
  await runtime.open();
  assert.equal(attempts, 1);
  assert.equal(clock.pendingReads, 1);
  await clock.advance(29999); assert.equal(attempts, 1);
  await clock.advance(1); assert.equal(attempts, 2);
  const error = store.state.historyReadError;
  runtime.dispose();
  assert.equal(clock.pending, 0);
  await clock.advance(60000);
  assert.equal(attempts, 2);
  assert.equal(store.state.historyReadError, error);
});

test("a healthy empty history starts no recovery reads before or after opening", async () => {
  const clock = runtimeClock();
  const { runtime, store, calls } = fixture(reads, {
    runtime: { setTimer: clock.setTimer, clearTimer: clock.clearTimer, maxPolls: Infinity }
  });
  try {
    assert.equal(store.state.initialized, false);
    assert.equal(calls.length, 0);
    assert.equal(clock.pending, 0);
    await runtime.open();
    assert.equal(store.state.initialized, true);
    assert.equal(store.state.historyReadError, "");
    assert.equal(calls.length, 4);
    assert.equal(calls.filter((call) => call.url.endsWith("/interactions")).length, 1);
    assert.equal(clock.pendingReads, 0);
    await clock.advance(60000);
    assert.equal(calls.length, 4);
  } finally { runtime.dispose(); }
});

test("pending history recovery proceeds independently of a still-failing receipt list", async () => {
  const clock = runtimeClock();
  let historyReads = 0;
  const { runtime, store } = fixture((url) => {
    if (url.endsWith("/requests")) throw new Error("receipts unavailable");
    if (url.includes("/turns?") && ++historyReads === 1) throw new Error("history unavailable");
    return reads(url);
  }, { runtime: { setTimer: clock.setTimer, clearTimer: clock.clearTimer, maxPolls: Infinity } });
  try {
    await runtime.open();
    assert.equal(store.state.initialized, false);
    await clock.advance(2000);
    assert.equal(historyReads, 2);
    assert.equal(store.state.historyReadError, "");
    assert.equal(store.state.initialized, true);
    assert.equal(store.state.requestListError, "receipts unavailable");
    assert.equal(store.state.requestListReady, false);
    assert.equal(clock.pendingReads, 0);
  } finally { runtime.dispose(); }
});

test("stable receipt polls and successful actions preserve an unresolved history failure", async () => {
  let unavailable = true;
  const receipt = { id: "queued", mode: "queue", state: "received", input: { text: "guide me" } };
  const { runtime, store } = fixture((url, options) => {
    if (url.endsWith("/requests") && !options.method) return { requests: [receipt] };
    if (url.includes("/turns?") && unavailable) throw new Error("history unavailable");
    if (url.endsWith("/steer")) return { request: { ...receipt, mode: "steer", state: "accepted", turnId: "active" } };
    if (url.endsWith("/requests") && options.method === "POST") return { request: { id: JSON.parse(options.body).clientRequestId, state: "completed" } };
    return reads(url);
  });
  try {
    await runtime.open(); await runtime.pollRequests();
    store.state.error = "unrelated action failed";
    await runtime.pollRequests();
    assert.equal(store.state.error, "unrelated action failed");
    assert.equal(store.state.historyReadError, "history unavailable");
    store.upsertTurn({ id: "active", status: "inProgress", items: [] });
    await runtime.promoteQueuedRequest("queued");
    assert.equal(store.state.historyReadError, "history unavailable");
    await runtime.submit(requestBody);
    assert.equal(store.state.historyReadError, "history unavailable");
    unavailable = false;
    await runtime.pollRequests();
    assert.equal(store.state.historyReadError, "");
  } finally { runtime.dispose(); }
});

test("latest turn automatically reads one latest window then only new items after its last anchor", async () => {
  const pages = [];
  let advanced = false;
  const { runtime, store, calls } = fixture((url) => {
    if (url.includes("/turns?")) return { turns: [{ id: "turn", status: "completed", items: [{ id: "user", type: "userMessage", position: 0 }] }] };
    if (url.includes("/items?")) {
      pages.push(url);
      const query = new URL(url, "https://example.test").searchParams;
      if (query.get("sortDirection") === "desc") return {
        items: [{ id: "tool", type: "commandExecution", position: 1 }, { id: "answer", type: "agentMessage", text: "initial", position: 2 }],
        nextCursor: "older-window", hasMore: true, latestItemId: "answer"
      };
      assert.equal(query.get("after"), "answer");
      return { items: advanced ? [{ id: "new-item", type: "agentMessage", text: "new", position: 3 }] : [],
        hasMore: false, latestItemId: advanced ? "new-item" : "answer" };
    }
    if (url.endsWith("/items/new-item")) return { item: { id: "new-item", type: "agentMessage", text: "official final", status: "completed" } };
    return reads(url);
  }, { runtime: { yieldPage: async () => {} } });
  await runtime.open();
  await flush();
  assert.deepEqual(store.state.turns.turn.itemOrder, ["user", "tool", "answer"]);
  assert.deepEqual(presentCodexChatSnapshot(store.state).turns[0].items.map((item) => item.id), ["tool", "answer"]);
  assert.equal(pages.length, 1);
  assert.equal(store.state.turns.turn.itemsLatestLoaded, true);
  assert.equal(store.state.turns.turn.itemsPageLoaded, undefined);
  advanced = true;
  await runtime.syncItems("turn", { automatic: true, reconcile: true });
  assert.equal(new URL(pages.at(-1), "https://example.test").searchParams.get("after"), "answer");
  assert.ok(pages.every((url) => new URL(url, "https://example.test").searchParams.get("limit") === "30"));
  assert.equal(store.state.turns.turn.items["new-item"].text, "official final");
  assert.ok(calls.some((call) => call.url.endsWith("/items/new-item")));
  runtime.dispose();
});

test("expanding during a pending latest-window read keeps older history deferred until an upward read", async () => {
  const latest = deferred();
  const source = [
    { id: "user", type: "userMessage", position: 0 },
    { id: "tool", type: "commandExecution", position: 1 },
    { id: "commentary", type: "agentMessage", position: 2, phase: "commentary", text: "progress" },
    { id: "answer", type: "agentMessage", position: 3, text: "final answer" }
  ];
  const pages = [];
  const { runtime, store } = fixture((url) => {
    if (url.includes("/turns?")) return { turns: [{ id: "turn", status: "completed", items: [source[0]] }] };
    if (url.includes("/items?")) {
      const query = new URL(url, "https://example.test").searchParams;
      pages.push(query);
      assert.equal(query.get("sortDirection"), "desc");
      if (query.get("cursor") === "") return latest.promise;
      assert.equal(query.get("cursor"), "older-window");
      assert.equal(query.has("after"), false);
      return { items: source.slice(0, 2), hasMore: false, latestItemId: "tool" };
    }
    return reads(url);
  }, { runtime: { yieldPage: async () => {} } });
  try {
    await runtime.open(); await flush();
    assert.equal(pages.length, 1);
    const expansion = runtime.setProcessExpanded("turn", true);
    await flush();
    assert.equal(pages.length, 1, "expansion shares the pending read slot");
    latest.resolve({ items: source.slice(2), nextCursor: "older-window", hasMore: true, latestItemId: "answer" });
    await expansion; await flush();
    assert.equal(pages.length, 1, "expansion cannot drain older history");
    assert.deepEqual(presentCodexChatSnapshot(store.state).turns[0].items.map((item) => item.id), ["commentary", "answer"]);
    assert.equal(runtime.hasOlderHistory(), true);
    assert.equal(await runtime.loadOlder(), true);
    assert.deepEqual(pages.map((query) => query.get("sortDirection")), ["desc", "desc"]);
    assert.deepEqual(pages.map((query) => query.get("cursor")), ["", "older-window"]);
    assert.deepEqual(store.state.turns.turn.itemOrder, source.map((item) => item.id));
    assert.deepEqual(presentCodexChatSnapshot(store.state).turns[0].items.map((item) => item.id), source.map((item) => item.id));
    assert.equal(store.state.turns.turn.itemsPageLoaded, undefined);
    assert.equal(store.state.turns.turn.itemsLatestHydratedStatus, "completed");
    assert.equal(runtime.hasOlderHistory(), false);
    assert.equal(store.state.turns.turn.items.answer.text, "final answer");
  } finally { runtime.dispose(); }
});

test("latest-window increments follow every forward page without traversing older items or losing a gap", async () => {
  const source = Array.from({ length: 105 }, (_, position) => ({ id: `item-${position}`, type: "agentMessage", position, text: `answer ${position}` }));
  const pages = [];
  let advanced = false;
  const { runtime, store } = fixture((url) => {
    if (url.includes("/turns?")) return { turns: [{ id: "turn", status: "inProgress", items: [source[0]] }] };
    if (url.includes("/items?")) {
      const query = new URL(url, "https://example.test").searchParams;
      pages.push(query);
      if (query.get("sortDirection") === "desc") return { items: source.slice(40, 70), nextCursor: "older-window", hasMore: true, latestItemId: "item-69" };
      if (query.get("cursor") === "forward-100") return { items: source.slice(100), hasMore: false, latestItemId: "item-104" };
      if (query.get("after") === "item-104") return { items: [], hasMore: false, latestItemId: "item-104" };
      assert.equal(query.get("after"), "item-69");
      return { items: advanced ? source.slice(70, 100) : [], hasMore: advanced,
        nextCursor: advanced ? "forward-100" : null, latestItemId: advanced ? "item-99" : "item-69" };
    }
    return reads(url);
  }, { runtime: { yieldPage: async () => {} } });
  try {
    await runtime.open(); await flush();
    assert.equal(pages.length, 1);
    advanced = true;
    await runtime.syncItems("turn", { automatic: true });
    assert.equal(pages.length, 3);
    assert.deepEqual(pages.map((query) => query.get("cursor")), ["", null, "forward-100"]);
    assert.equal(pages[1].get("after"), "item-69");
    assert.deepEqual(store.state.turns.turn.itemOrder, [source[0], ...source.slice(40)].map((item) => item.id));
    assert.deepEqual(presentCodexChatSnapshot(store.state).turns[0].items.map((item) => item.id), source.slice(40).map((item) => item.id));
    assert.equal(store.state.turns.turn.itemsLatestTail, "item-104");
    assert.equal(store.state.turns.turn.itemsLatestNextCursor, null);
    assert.equal(store.state.turns.turn.itemsPageLoaded, undefined);
    await runtime.syncItems("turn", { automatic: true });
    assert.equal(pages.at(-1).get("after"), "item-104");
    assert.equal(pages.some((query) => query.get("cursor") === "older-window"), false);
    assert.deepEqual(store.state.turns.turn.itemOrder, [source[0], ...source.slice(40)].map((item) => item.id));
  } finally { runtime.dispose(); }
});

test("entering a recent turn hydrates steer messages, commentary and files without rereading completed turns", async () => {
  const user = { id: "original", type: "userMessage", position: 0, presentation: { text: "original input" } };
  const commentary = { id: "commentary", type: "agentMessage", position: 1, phase: "commentary", presentation: { text: "middle reply" } };
  const steer = { id: "steer-user", type: "userMessage", position: 2, clientId: "steer-receipt", presentation: { text: "steer input" } };
  const file = { id: "file", type: "fileChange", position: 3, presentation: { fileChanges: [{ path: "a.js", diff: "+kept", additions: 1, deletions: 0 }] } };
  const final = { id: "final", type: "agentMessage", position: 4, status: "completed", presentation: { text: "STEER-OK" } };
  const { runtime, store, calls } = fixture((url) => {
    if (url.includes("/turns?")) return { turns: [
      { id: "past", status: "completed", items: [user, final] }, { id: "latest", status: "completed", items: [] }
    ] };
    if (url.endsWith("/requests")) return { requests: [{ id: "steer-receipt", mode: "steer", state: "completed", turnId: "past",
      input: { text: "steer input" }, userItemId: "steer-user" }] };
    if (url.includes("/turns/past/items?")) {
      const query = new URL(url, "https://example.test").searchParams;
      if (query.get("sortDirection") === "desc") return { items: [user, commentary, steer, file, final], hasMore: false, latestItemId: final.id };
      if (query.get("cursor") === "second") return { items: [steer, file, final], hasMore: false, latestItemId: final.id };
      return { items: [user, commentary], nextCursor: "second", hasMore: true, latestItemId: commentary.id };
    }
    return reads(url);
  }, { runtime: { yieldPage: async () => {} } });
  await runtime.open(); await flush();
  assert.equal(calls.filter((call) => call.url.includes("/turns/past/items?")).length, 0);
  await runtime.setTurnVisibility("past", true); await flush();
  let snapshot = presentCodexChatSnapshot(store.state);
  assert.deepEqual(snapshot.turns[0].items.map((item) => item.id), ["original", "commentary", "steer-user", "file", "final"]);
  assert.equal(snapshot.turns[0].items[1].text, "middle reply");
  assert.equal(snapshot.turns[0].items.filter((item) => item.kind === "UserMessage").length, 2);
  assert.equal(buildThreadViewModel(snapshot).turns[0].fileChanges[0].diff, "+kept");
  assert.equal(calls.filter((call) => call.url.includes("/turns/past/items?")).length, 1);
  await runtime.setProcessExpanded("past", true); await flush();
  assert.equal(store.state.turns.past.itemsPageLoaded, undefined);
  const pastReads = calls.filter((call) => call.url.includes("/turns/past/items?")).length;
  assert.equal(pastReads, 1);
  await runtime.refreshLatest(); await flush();
  assert.equal(calls.filter((call) => call.url.includes("/turns/past/items?")).length, pastReads);
  snapshot = presentCodexChatSnapshot(store.state);
  assert.deepEqual(snapshot.turns[0].items.map((item) => item.id), ["original", "commentary", "steer-user", "file", "final"]);
  runtime.dispose();
});

test("visible turn hydration uses at most two readers, yields between pages and deduplicates repeated refreshes", async () => {
  const turns = Array.from({ length: 10 }, (_, index) => ({ id: `turn-${index}`, status: "completed", items: [] }));
  const pending = [];
  let inFlight = 0, maximum = 0, yielded = 0;
  const { runtime, store, calls } = fixture((url) => {
    if (url.includes("/turns?")) return { turns };
    if (url.includes("/items?")) {
      const parsed = new URL(url, "https://example.test"), turnId = parsed.pathname.split("/").at(-2);
      if (parsed.searchParams.has("after")) return { items: [], hasMore: false };
      const operation = deferred();
      inFlight += 1; maximum = Math.max(maximum, inFlight);
      pending.push({ ...operation, turnId, latest: parsed.searchParams.get("sortDirection") === "desc", second: parsed.searchParams.get("cursor") === "next" });
      return operation.promise.finally(() => { inFlight -= 1; });
    }
    return reads(url);
  }, { runtime: { yieldPage: async () => { yielded += 1; } } });
  await runtime.open(); await flush();
  assert.equal(pending.length, 1, "summary pages do not make offscreen turns visible");
  for (const turn of turns) void runtime.setTurnVisibility(turn.id, true);
  await flush();
  assert.equal(pending.length, 2);
  await runtime.refreshLatest(); await flush();
  assert.equal(pending.length, 2);
  let drained = 0;
  while (pending.length) {
    const operation = pending.shift();
    operation.resolve({ items: [{ id: `${operation.turnId}-last`, type: "agentMessage", position: 1 }],
      nextCursor: "older-window", hasMore: true, latestItemId: `${operation.turnId}-last` });
    drained += 1; await flush();
  }
  assert.equal(maximum, 2);
  assert.equal(drained, 10);
  assert.equal(yielded, 0);
  assert.equal(Object.values(store.state.turns).every((turn) => turn.itemsLatestLoaded && !turn.itemsPageLoaded), true);
  await runtime.refreshLatest(); await flush();
  assert.equal(calls.filter((call) => call.url.includes("/items?cursor=")).length, 10);
  assert.ok(calls.some((call) => new URL(call.url, "https://example.test").searchParams.get("after") === "turn-9-last"));
  for (const turn of turns) void runtime.syncItems(turn.id);
  await flush();
  assert.equal(pending.length, 2);
  drained = 0;
  while (pending.length) {
    const operation = pending.shift();
    assert.equal(operation.latest, false);
    operation.resolve({ items: [{ id: `${operation.turnId}-${operation.second ? "last" : "first"}`, type: "agentMessage", position: operation.second ? 1 : 0 }],
      nextCursor: operation.second ? null : "next", hasMore: !operation.second, latestItemId: `${operation.turnId}-${operation.second ? "last" : "first"}` });
    drained += 1; await flush();
  }
  assert.equal(drained, 20);
  assert.equal(maximum, 2);
  assert.equal(yielded, 10);
  assert.equal(Object.values(store.state.turns).every((turn) => turn.itemsPageLoaded && !turn.hasMore), true);
  assert.ok(calls.filter((call) => call.url.includes("/items?")).every((call) => new URL(call.url, "https://example.test").searchParams.get("limit") === "30"));
  runtime.dispose();
});

test("an upward older-turn read loads that turn's latest window before exposing its messages", async () => {
  const { runtime, store, calls } = fixture((url) => {
    if (url.includes("/turns?") && url.includes("cursor=older")) return { turns: [{ id: "older", status: "completed", items: [] }], hasMore: false };
    if (url.includes("/turns?")) return { turns: [{ id: "latest", status: "completed", items: [] }], hasMore: true, olderCursor: "older" };
    if (url.includes("/turns/older/items?")) return { items: [
      { id: "older-user", type: "userMessage", presentation: { text: "old input" } },
      { id: "older-commentary", type: "agentMessage", phase: "commentary", presentation: { text: "old intermediate reply" } },
      { id: "older-answer", type: "agentMessage", presentation: { text: "old final reply" } }
    ], hasMore: false };
    return reads(url);
  });
  await runtime.open(); await flush();
  assert.equal(await runtime.loadOlder(), true); await flush();
  assert.equal(calls.filter((call) => call.url.includes("/turns/older/items?")).length, 1);
  assert.equal(new URL(calls.find((call) => call.url.includes("/turns/older/items?")).url, "https://example.test").searchParams.get("sortDirection"), "desc");
  assert.equal(store.state.turns.older.items["older-commentary"].presentation.text, "old intermediate reply");
  await runtime.setTurnVisibility("older", true); await flush();
  assert.equal(store.state.turns.older.items["older-commentary"].presentation.text, "old intermediate reply");
  assert.equal(calls.filter((call) => call.url.includes("/turns/older/items?")).length, 2);
  assert.equal(store.state.turns.older.processExpanded, undefined);
  runtime.dispose();
});

test("a formerly active turn finishes incremental hydration when a newer turn becomes latest", async () => {
  let advanced = false;
  const original = { id: "original", type: "userMessage" };
  const { runtime, store, calls } = fixture((url) => {
    if (url.includes("/turns?")) return { turns: [
      { id: "past", status: advanced ? "completed" : "inProgress", items: [original] },
      ...(advanced ? [{ id: "latest", status: "completed", items: [] }] : [])
    ] };
    if (url.includes("/turns/past/items?")) return { items: advanced ? [
      { id: "steer", type: "userMessage", presentation: { text: "followup" } },
      { id: "final", type: "agentMessage", presentation: { text: "final" } }
    ] : [original], hasMore: false };
    return reads(url);
  });
  await runtime.open(); await flush();
  assert.equal(store.state.turns.past.itemsLatestHydratedStatus, "inProgress");
  advanced = true;
  await runtime.refreshLatest(); await flush();
  assert.deepEqual(store.state.turns.past.itemOrder, ["original", "steer", "final"]);
  assert.ok(calls.some((call) => {
    const url = new URL(call.url, "https://example.test");
    return url.pathname.endsWith("/turns/past/items") && url.searchParams.get("after") === "original" && url.searchParams.get("limit") === "30";
  }));
  assert.equal(store.state.turns.past.itemsLatestHydratedStatus, "completed");
  runtime.dispose();
});

test("terminal websocket event automatically reconciles the last item's full content", async () => {
  let completed = false;
  const { runtime, store, sockets } = fixture((url) => {
    if (url.includes("/turns?")) return { turns: [{ id: "turn", status: completed ? "completed" : "inProgress", items: [] }] };
    if (url.includes("/items?")) return { items: [{ id: "answer", type: "agentMessage", text: "bounded", status: completed ? "completed" : "inProgress", hasDetails: true }], hasMore: false };
    if (url.endsWith("/items/answer")) return { item: { id: "answer", type: "agentMessage", text: completed ? "full final reply" : "bounded", status: completed ? "completed" : "inProgress" } };
    return reads(url);
  });
  await runtime.open(); await runtime.syncItems("turn");
  sockets[0].event({ schemaVersion: 2, threadId: "thread", epoch: "epoch", seq: 0, type: "sync.required", payload: {} });
  await flush();
  completed = true;
  sockets[0].event({ schemaVersion: 2, threadId: "thread", epoch: "epoch", seq: 2, type: "turn.upsert", payload: { turn: { id: "turn", status: "completed" } } });
  await flush();
  assert.equal(store.state.turns.turn.items.answer.text, "full final reply");
  runtime.dispose();
});

test("polled metadata finalizes an existing older tail without loading unseen turns or replacing the window", async () => {
  let finish = false;
  const { runtime, store, sockets, calls } = fixture((url) => {
    if (url.includes("/turns?")) return { turns: [{ id: "new", status: "inProgress", items: [] }] };
    if (url.includes("/turns/old/items?")) return { items: [], hasMore: false, latestItemId: "old-answer" };
    if (url.endsWith("/items/old-answer")) return { item: { id: "old-answer", type: "agentMessage",
      text: finish ? "complete final reply" : "preview", status: finish ? "completed" : "inProgress" } };
    return reads(url);
  });
  try {
    await runtime.open();
    sockets[0].event({ schemaVersion: 2, threadId: "thread", epoch: "epoch", seq: 0, type: "sync.required", payload: {} });
    await flush();
    store.applyTurnsPage({ turns: [{ id: "old", status: "inProgress", items: [] }] }, undefined, { older: true });
    store.applyLatestItemsPage("old", { items: [{ id: "old-answer", type: "agentMessage", text: "preview", status: "inProgress" }],
      hasMore: true, nextCursor: "older-old" }, undefined, { reset: true });
    store.state.turns.old.itemsLatestHydratedStatus = "inProgress";
    finish = true;
    const start = calls.length;
    sockets[0].event({ schemaVersion: 2, threadId: "thread", epoch: "epoch", seq: 1, type: "turn.metadata",
      payload: { turn: { id: "old", status: "completed", completedAt: 200 } } });
    sockets[0].event({ schemaVersion: 2, threadId: "thread", epoch: "epoch", seq: 2, type: "turn.metadata",
      payload: { turn: { id: "unseen", status: "completed" } } });
    await flush();
    assert.deepEqual(store.state.turnOrder, ["old", "new"]);
    assert.equal(store.state.turns.old.status, "completed");
    assert.equal(store.state.turns.old.items["old-answer"].text, "complete final reply");
    assert.deepEqual(store.state.turns.old.itemsWindowIds, ["old-answer"]);
    assert.equal(store.state.turns.old.itemsEarlierCursor, "older-old");
    const readsAfterEvent = calls.slice(start);
    assert.equal(readsAfterEvent.filter((call) => call.url.includes("/turns/old/items?")).length, 1);
    assert.ok(readsAfterEvent.some((call) => new URL(call.url, "https://example.test").searchParams.get("after") === "old-answer"));
    assert.equal(readsAfterEvent.some((call) => call.url.includes("/turns/unseen/")), false);
    assert.equal(readsAfterEvent.some((call) => call.url.includes("sortDirection=desc")), false);
  } finally { runtime.dispose(); }
});

test("a server-rejected steer preserves its message and never falls back to a new queue request", async () => {
  const { runtime, store, calls } = fixture((url, options) => {
    const body = JSON.parse(options.body);
    return { request: { id: body.clientRequestId, mode: "steer", state: "rejected", error: { message: "目标轮次已结束" } } };
  });
  store.upsertTurn({ id: "active", status: "inProgress" });
  store.setDraft({ text: "guide this" });
  await runtime.submit({ ...requestBody, input: { text: "guide this", attachments: [] }, mode: "steer", expectedTurnId: "active" });
  assert.equal(store.state.requests["request-1"].state, "rejected");
  assert.equal(store.state.requests["request-1"].input.text, "guide this");
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].body).mode, "steer");
  runtime.dispose();
});

test("automatic request reconciliation continues beyond four polls, backs off when hidden, and stops at terminal", async () => {
  const timers = new Map(), listeners = new Map();
  let timerId = 0, serverState = "received";
  const visibility = { hidden: false, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: (name) => listeners.delete(name) };
  const { runtime, store, calls } = fixture((url, options) => {
    if (options.method === "POST") return { request: { id: "request-1", state: serverState, input: requestBody.input } };
    if (url.endsWith("/requests")) return { requests: [{ id: "request-1", state: serverState, input: requestBody.input }] };
    return reads(url);
  }, { runtime: { maxPolls: Infinity, pollMs: 100, visibility,
    setTimer: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; }, clearTimer: (id) => timers.delete(id) } });
  await runtime.submit(requestBody);
  for (let index = 0; index < 6; index += 1) {
    const [id, timer] = [...timers][0]; timers.delete(id); await timer.callback();
  }
  assert.equal(store.state.requests["request-1"].state, "received");
  assert.ok(calls.filter((call) => call.url.endsWith("/requests") && !call.method).length >= 6);
  visibility.hidden = true;
  const [id, timer] = [...timers][0]; timers.delete(id); await timer.callback();
  assert.ok([...timers.values()][0].delay >= 30000);
  visibility.hidden = false; serverState = "completed";
  listeners.get("visibilitychange")();
  await flush();
  assert.equal(store.state.requests["request-1"].state, "completed");
  assert.equal(timers.size, 0);
  runtime.dispose();
  assert.equal(listeners.size, 0);
});

test("external unknown turns reconcile over HTTP with bounded backoff when WebSocket is unavailable", async () => {
  const clock = runtimeClock(), socketTimes = [], turnTimes = [];
  let serverStatus = "unknown", turnReads = 0;
  const { runtime, store, calls } = fixture((url) => {
    if (url.includes("/turns?")) {
      turnReads += 1; turnTimes.push(clock.now());
      return { threadId: "thread", turns: [{ id: "external", status: serverStatus,
        statusSource: "rollout", statusConfirmed: serverStatus !== "unknown", items: [] }] };
    }
    return reads(url);
  }, { runtime: { maxPolls: Infinity, pollMs: 2000,
    createSocket: () => { socketTimes.push(clock.now()); throw new Error("WebSocket unavailable"); },
    setTimer: clock.setTimer, clearTimer: clock.clearTimer } });
  try {
    await runtime.open(); await flush();
    assert.equal(store.state.connection, "offline");
    assert.equal(store.state.requestOrder.length, 0);
    const delays = [];
    for (const delay of [2000, 2000, 4000, 8000, 10000, 10000]) {
      assert.equal(clock.pending, 2, "one reconnect and one status poll remain independently scheduled");
      const previousReads = turnReads;
      await clock.advance(delay - 1);
      assert.equal(turnReads, previousReads, "reconnects cannot bypass the status poll backoff");
      await clock.advance(1);
      assert.equal(turnReads, previousReads + 1, "unchanged empty receipts must not stop turn status reads");
      delays.push(turnTimes.at(-1) - turnTimes.at(-2));
    }
    assert.deepEqual(delays, [2000, 2000, 4000, 8000, 10000, 10000]);
    serverStatus = "completed";
    await clock.advance(10000);
    assert.equal(store.state.turns.external.status, "completed");
    assert.equal(clock.pending, 1, "completed status stops HTTP polling while unavailable WebSocket still reconnects");
    const finalReads = turnReads;
    await clock.advance(6000);
    assert.equal(turnReads, finalReads);
    assert.deepEqual(socketTimes, Array.from({ length: clock.now() / 2000 + 1 }, (_, index) => index * 2000));
    assert.equal(calls.some((call) => call.method), false);
    assert.equal(calls.filter((call) => call.url.includes("/turns?")).every((call) => call.url.endsWith("/turns?limit=1")), true);
    assert.equal(calls.filter((call) => call.url === "/api/v2/codex/threads/thread").length, 2);
  } finally { runtime.dispose(); assert.equal(clock.pending, 0); }
});

test("HTTP status recovery follows unknown through running to completion during WebSocket reconnects", async () => {
  const timers = new Map();
  let timerId = 0, serverStatus = "unknown", turnReads = 0;
  const { runtime, store, sockets, calls } = fixture((url) => {
    if (url.includes("/turns?")) {
      turnReads += 1;
      return { threadId: "thread", turns: [{ id: "external", status: serverStatus, items: [] }] };
    }
    return reads(url);
  }, { runtime: { maxPolls: Infinity, pollMs: 100,
    setTimer: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; }, clearTimer: (id) => timers.delete(id) } });
  const runPoll = async () => {
    const pending = [...timers].find(([, timer]) => timer.delay < 2000);
    assert.ok(pending, "status polling must continue while WebSocket is unavailable");
    const [id, timer] = pending; timers.delete(id); await timer.callback(); await flush();
  };
  try {
    await runtime.open(); await flush(); sockets[0].onclose();
    serverStatus = "inProgress"; await runPoll();
    assert.equal(store.state.turns.external.status, "inProgress");
    const [id, reconnect] = [...timers].find(([, timer]) => timer.delay === 2000);
    timers.delete(id); reconnect.callback(); sockets.at(-1).onclose();
    serverStatus = "completed"; await runPoll();
    assert.equal(store.state.turns.external.status, "completed");
    assert.equal(turnReads, 3);
    assert.equal([...timers.values()].some((timer) => timer.delay < 2000), false);
    assert.equal(calls.some((call) => call.method), false);
  } finally { runtime.dispose(); }
  assert.equal(timers.size, 0);
});

test("POST is independent of socket readiness; double-click shares one ID but later same text uses a new ID", async () => {
  const post = deferred();
  const { store, runtime, calls, sockets } = fixture((url, options) => {
    if (options.method === "POST") return post.promise;
    return reads(url);
  });
  await runtime.open();
  assert.match(sockets[0].url, /^wss:\/\/example.test\/ws\/codex\?threadId=thread/);
  store.setDraft({ text: "same" });
  const first = runtime.submit(requestBody);
  const duplicate = runtime.submit(requestBody);
  assert.equal(first, duplicate);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(store.state.draft.text, "");
  post.resolve({ request: { id: "request-1", state: "completed", input: requestBody.input } });
  await first;
  const second = runtime.submit(requestBody);
  await second;
  const ids = calls.filter((call) => call.method === "POST").map((call) => JSON.parse(call.body).clientRequestId);
  assert.deepEqual(ids, ["request-1", "request-2"]);
  runtime.dispose();
});

test("lost POST response queries the original ID, preserves it across refresh, and never blindly resends", async () => {
  const first = fixture((url, options) => {
    if (options.method === "POST") throw new TypeError("network lost");
    if (url.endsWith("/request-1")) throw Object.assign(new Error("offline"), { status: 503 });
    return reads(url);
  });
  first.store.setDraft({ text: "same" });
  await first.runtime.submit(requestBody);
  assert.equal(first.store.state.requests["request-1"].state, "unknown");
  assert.equal(first.store.state.submitting, false);
  await assert.rejects(first.runtime.submit(requestBody), /尚未确认/);
  first.runtime.dispose();
  const second = fixture((url) => url.endsWith("/request-1")
    ? { request: { id: "request-1", state: "completed", input: requestBody.input, userItemId: "official" } } : reads(url), { storage: first.storage });
  await second.runtime.open();
  assert.equal(second.store.state.requests["request-1"].state, "completed");
  assert.equal(second.calls.some((call) => call.method === "POST"), false);
  assert.equal(first.calls.filter((call) => call.method === "POST").length, 1);
  second.runtime.dispose();
});

test("a missing saved receipt requires a fresh 404 and explicit dismissal before another submit", async () => {
  const storage = memoryStorage();
  const saved = createCodexChatStore("thread", { storage });
  saved.upsertRequest({ id: "request-lost", threadId: "thread", state: "sending", input: { text: "possibly sent", attachments: [] } });
  let missing = true;
  const { runtime, store, calls } = fixture((url, options) => {
    if (url.endsWith("/requests/request-lost")) {
      if (missing) throw Object.assign(new Error("Request not found"), { status: 404 });
      return { request: { id: "request-lost", state: "completed", input: { text: "possibly sent", attachments: [] } } };
    }
    if (options.method === "POST") return { request: { id: JSON.parse(options.body).clientRequestId, state: "completed" } };
    return reads(url);
  }, { storage });
  await runtime.open();
  assert.equal(store.state.requests["request-lost"].state, "unknown");
  assert.equal(store.state.requests["request-lost"].error.code, "receipt_not_found");
  await assert.rejects(runtime.submit(requestBody), /尚未确认/);
  assert.equal(await runtime.dismissUnknownReceipt("request-lost"), true);
  assert.equal(store.state.requests["request-lost"].confirmationDismissed, true);
  assert.equal(calls.filter((call) => call.method === "POST").length, 0);
  const reloaded = createCodexChatStore("thread", { storage });
  assert.equal(reloaded.state.requests["request-lost"].confirmationDismissed, true);
  await runtime.submit({ ...requestBody, input: { text: "new message", attachments: [] } });
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  missing = false;
  await runtime.checkRequest("request-lost");
  assert.equal(store.state.requests["request-lost"].state, "completed");
  runtime.dispose();
});

test("manually unlocked missing receipts retain uncertainty and persistence without any timed requests", async () => {
  const clock = runtimeClock();
  const handler = (url) => {
    if (url.endsWith("/requests/request-lost")) throw Object.assign(new Error("not found"), { status: 404 });
    return reads(url);
  };
  const { runtime, store, calls, storage } = fixture(handler, { runtime: { ...clock, maxPolls: Infinity, pollMs: 100 } });
  store.upsertRequest({ id: "request-lost", state: "unknown", input: { text: "possibly sent", attachments: [] } });
  await runtime.open();
  assert.equal(clock.pendingReads, 1, "a missing receipt stays under automatic reconciliation before manual unlock");
  assert.equal(await runtime.dismissUnknownReceipt("request-lost"), true);
  assert.equal(clock.pendingReads, 0, "manual unlock cancels its already scheduled poll independently of connection recovery");
  const previousCalls = calls.length;
  await clock.advance(60 * 60 * 1000);
  assert.equal(calls.length, previousCalls, "a still-open page makes no periodic reads for the unlocked receipt");
  assert.equal(store.state.requests["request-lost"].state, "unknown");
  assert.equal(store.state.requests["request-lost"].confirmationDismissed, true);
  assert.equal(calls.filter((call) => call.url.endsWith("/requests/request-lost")).length, 2);
  runtime.dispose();

  const reopened = fixture(handler, { storage, runtime: { ...clock, maxPolls: Infinity, pollMs: 100 } });
  await reopened.runtime.open();
  assert.equal(reopened.calls.filter((call) => call.url.endsWith("/requests/request-lost")).length, 1);
  assert.equal(reopened.store.state.requests["request-lost"].input.text, "possibly sent");
  assert.equal(reopened.store.state.requests["request-lost"].confirmationDismissed, true);
  assert.equal(clock.pendingReads, 0);
  assert.equal([...calls, ...reopened.calls].some((call) => call.method), false);
  reopened.runtime.dispose();
});

test("unlocked receipts recheck on reconnect, sync, foreground and explicit refresh, then relock on official unknown", async () => {
  const clock = runtimeClock(), listeners = new Map();
  const visibility = { hidden: false, addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: (name) => listeners.delete(name) };
  let response = "missing";
  const receipt = { id: "request-lost", state: "unknown", updatedAt: "2026-01-01T00:00:00.000Z" };
  const { runtime, store, sockets, calls } = fixture((url) => {
    if (url.endsWith("/requests/request-lost")) {
      if (response === "missing") throw Object.assign(new Error("not found"), { status: 404 });
      if (response === "offline") throw Object.assign(new Error("offline"), { status: 503 });
      return { request: { ...receipt, state: response } };
    }
    return reads(url);
  }, { runtime: { ...clock, maxPolls: Infinity, pollMs: 100, visibility } });
  store.upsertRequest({ ...receipt, confirmationDismissed: true, error: { code: "receipt_not_found" } });
  const checks = () => calls.filter((call) => call.url.endsWith("/requests/request-lost")).length;
  await runtime.open();
  assert.equal(checks(), 1); assert.equal(clock.pendingReads, 0);
  sockets[0].onclose();
  sockets[0].close = () => {}; // An already closed WebSocket does not emit a second close event.
  await clock.advance(2000); sockets[1].onopen(); await flush();
  assert.equal(checks(), 2); assert.equal(clock.pending, 0);
  sockets[1].event({ schemaVersion: 2, threadId: "thread", epoch: "epoch", seq: 0, type: "sync.required", payload: {} });
  await flush(); assert.equal(checks(), 3);
  visibility.hidden = true; listeners.get("visibilitychange")(); await flush();
  assert.equal(checks(), 3);
  visibility.hidden = false; listeners.get("visibilitychange")(); await flush();
  assert.equal(checks(), 4);
  await runtime.refreshLatest(); assert.equal(checks(), 5);
  response = "offline"; await runtime.checkRequest("request-lost");
  assert.equal(checks(), 6); assert.equal(clock.pendingReads, 0);
  assert.equal(store.state.requests["request-lost"].confirmationDismissed, true);
  await clock.advance(60000); assert.equal(checks(), 6);
  response = "unknown"; await runtime.refreshLatest();
  assert.equal(store.state.requests["request-lost"].confirmationDismissed, false);
  assert.equal(store.state.requests["request-lost"].error, null);
  assert.equal(clock.pendingReads, 1, "official uncertainty restores automatic reconciliation even with the same timestamp");
  await assert.rejects(runtime.submit(requestBody), /尚未确认/);
  response = "completed"; await runtime.checkRequest("request-lost");
  assert.equal(store.state.requests["request-lost"].state, "completed");
  assert.equal(clock.pendingReads, 0);
  assert.equal(calls.some((call) => call.method), false);
  runtime.dispose();
});

test("unlocked missing receipts do not repeat ID reads or stop normal active-turn polling and later list recovery", async () => {
  const clock = runtimeClock();
  let status = "inProgress", recovered = false;
  const receipt = { id: "request-lost", state: "unknown", updatedAt: "2026-01-01T00:00:00.000Z" };
  const { runtime, store, calls } = fixture((url) => {
    if (url.endsWith("/requests/request-lost")) throw Object.assign(new Error("not found"), { status: 404 });
    if (url.endsWith("/requests")) return { requests: recovered ? [{ ...receipt, state: status === "completed" ? "completed" : "unknown" }] : [] };
    if (url.includes("/turns?")) return { turns: [{ id: "active", status, items: [] }] };
    return reads(url);
  }, { runtime: { ...clock, maxPolls: Infinity, pollMs: 100 } });
  store.upsertRequest({ ...receipt, confirmationDismissed: true, error: { code: "receipt_not_found" } });
  await runtime.open(); await clock.advance(10000);
  assert.equal(calls.filter((call) => call.url.endsWith("/requests/request-lost")).length, 1);
  assert.ok(calls.filter((call) => call.url.includes("/turns?")).length > 6, "active turn reads keep their existing bounded backoff");
  assert.equal(store.state.turns.active.status, "inProgress");
  assert.equal(clock.pendingReads, 1);
  recovered = true; await clock.advance(1000);
  assert.equal(store.state.requests["request-lost"].confirmationDismissed, false);
  assert.equal(store.state.requests["request-lost"].error, null);
  await assert.rejects(runtime.submit(requestBody), /尚未确认/);
  status = "completed"; await clock.advance(2000);
  assert.equal(store.state.requests["request-lost"].state, "completed");
  assert.equal(store.state.turns.active.status, "completed");
  assert.equal(clock.pendingReads, 0);
  assert.equal(calls.some((call) => call.method), false);
  runtime.dispose();
});

test("official websocket receipt discovery restores a dismissed send lock until its terminal update", async () => {
  const clock = runtimeClock();
  const receipt = { id: "request-lost", state: "unknown", updatedAt: "2026-01-01T00:00:00.000Z" };
  const { runtime, store, sockets } = fixture((url) => {
    if (url.endsWith("/requests/request-lost")) throw Object.assign(new Error("not found"), { status: 404 });
    return reads(url);
  }, { runtime: { ...clock, maxPolls: Infinity, pollMs: 100 } });
  store.upsertRequest({ ...receipt, confirmationDismissed: true, error: { code: "receipt_not_found" } });
  await runtime.open();
  sockets[0].event({ schemaVersion: 2, threadId: "thread", epoch: "epoch", seq: 0, type: "sync.required", payload: {} });
  await flush();
  sockets[0].event({ schemaVersion: 2, threadId: "thread", epoch: "epoch", seq: 1, type: "request.updated", payload: { request: receipt } });
  assert.equal(store.state.requests["request-lost"].confirmationDismissed, false);
  assert.equal(store.state.requests["request-lost"].error, null);
  await assert.rejects(runtime.submit(requestBody), /尚未确认/);
  assert.equal(clock.pendingReads, 1);
  sockets[0].event({ schemaVersion: 2, threadId: "thread", epoch: "epoch", seq: 2, type: "request.updated", payload: { request: { ...receipt, state: "completed" } } });
  await flush();
  assert.equal(store.state.requests["request-lost"].state, "completed");
  assert.equal(clock.pendingReads, 0);
  runtime.dispose();
});

test("a slow dismissed receipt probe does not hold active receipt or turn synchronization", async () => {
  const clock = runtimeClock(), missing = deferred();
  const listeners = new Map();
  const visibility = { hidden: false, addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: (name) => listeners.delete(name) };
  let turnReads = 0, activeChecks = 0;
  const { runtime, store } = fixture((url) => {
    if (url.endsWith("/requests/request-lost")) return missing.promise;
    if (url.endsWith("/requests/current")) {
      activeChecks += 1;
      return { request: { id: "current", state: "running", turnId: "active" } };
    }
    if (url.includes("/turns?")) {
      turnReads += 1;
      return { turns: [{ id: "active", status: "inProgress", items: [] }] };
    }
    return reads(url);
  }, { runtime: { ...clock, maxPolls: Infinity, pollMs: 100, visibility } });
  store.upsertRequest({ id: "request-lost", state: "unknown", confirmationDismissed: true, error: { code: "receipt_not_found" } });
  store.upsertRequest({ id: "current", state: "received" });
  const opening = runtime.open(); await flush();
  const refreshing = runtime.refreshLatest(); await flush();
  listeners.get("visibilitychange")(); await flush();
  await clock.advance(5000);
  assert.ok(turnReads > 6, "a pending dismissed probe must not hold the shared latest-page refresh");
  assert.ok(activeChecks > 6, "active receipt reads have a reserved serial reader");
  assert.equal(store.state.requests.current.state, "running");
  assert.equal(store.state.requests["request-lost"].state, "unknown");
  missing.reject(Object.assign(new Error("not found"), { status: 404 }));
  await Promise.all([opening, refreshing]);
  runtime.dispose();
  assert.equal(clock.pending, 0);
});

test("event and manual receipt probes share one serial reader and disposal drops queued reads", async () => {
  const clock = runtimeClock(), pending = new Map();
  let active = 0, peak = 0;
  const { runtime, store, calls } = fixture(async (url) => {
    if (/\/requests\/lost-/.test(url)) {
      const id = url.split("/").at(-1), read = deferred();
      pending.set(id, read); active += 1; peak = Math.max(peak, active);
      try { return await read.promise; } finally { active -= 1; }
    }
    return reads(url);
  }, { runtime: { ...clock, maxPolls: Infinity, pollMs: 100 } });
  for (let index = 1; index <= 3; index += 1) store.upsertRequest({ id: `lost-${index}`, state: "unknown",
    confirmationDismissed: true, error: { code: "receipt_not_found" } });
  const opening = runtime.open(); await flush();
  const manual = runtime.checkRequest("lost-1");
  assert.equal(runtime.checkRequest("lost-1"), manual);
  const refreshing = runtime.refreshLatest(); await flush();
  for (let index = 1; index <= 3; index += 1) {
    assert.equal(active, 1);
    pending.get(`lost-${index}`).reject(Object.assign(new Error("not found"), { status: 404 }));
    await flush();
  }
  await Promise.all([opening, refreshing, manual]);
  assert.equal(peak, 1);
  assert.equal(calls.filter((call) => /\/requests\/lost-/.test(call.url)).length, 3);
  assert.equal(clock.pendingReads, 0);
  const later = runtime.refreshLatest(); await flush();
  assert.equal(active, 1);
  runtime.dispose();
  pending.get("lost-1").reject(Object.assign(new Error("not found"), { status: 404 }));
  await later;
  assert.equal(calls.filter((call) => /\/requests\/lost-/.test(call.url)).length, 4);
  assert.equal(clock.pending, 0);
});

test("a failed recheck or a late server receipt cannot dismiss an unknown send", async () => {
  let checks = 0;
  const { runtime, store, calls } = fixture((url) => {
    if (url.endsWith("/requests/request-lost")) {
      checks += 1;
      if (checks === 1) throw Object.assign(new Error("not found"), { status: 404 });
      if (checks === 2) throw Object.assign(new Error("offline"), { status: 503 });
      return { request: { id: "request-lost", state: "unknown", updatedAt: "2026-01-01T00:00:01.000Z" } };
    }
    return reads(url);
  });
  store.upsertRequest({ id: "request-lost", threadId: "thread", state: "sending", updatedAt: "2026-01-01T00:00:00.000Z" });
  await runtime.checkRequest("request-lost");
  assert.equal(await runtime.dismissUnknownReceipt("request-lost"), false);
  assert.equal(store.state.requests["request-lost"].confirmationDismissed, undefined);
  await runtime.checkRequest("request-lost");
  assert.equal(await runtime.dismissUnknownReceipt("request-lost"), false);
  await assert.rejects(runtime.submit(requestBody), /尚未确认/);
  assert.equal(calls.filter((call) => call.method === "POST").length, 0);
  runtime.dispose();
});

test("timeout settles unknown without an endless submit lock, while official late completion remains authoritative", async () => {
  const { runtime, store } = fixture((url, options) => {
    if (options.method === "POST") return new Promise(() => {});
    if (url.includes("/requests/")) throw new Error("still offline");
    return reads(url);
  }, { runtime: { timeoutMs: 5 } });
  await runtime.submit(requestBody);
  assert.equal(store.state.submitting, false);
  assert.equal(store.state.requests["request-1"].state, "unknown");
  store.upsertRequest({ id: "request-1", state: "completed" });
  await runtime.checkRequest("request-1");
  assert.equal(store.state.requests["request-1"].state, "completed");
  runtime.dispose();
});

test("quota failure prevents network submission and retains draft", async () => {
  const { runtime, store, calls } = fixture(reads, { storage: { getItem() {}, setItem() { throw new Error("quota"); } } });
  store.setDraft({ text: "unsent" });
  await assert.rejects(runtime.submit(requestBody), /保存失败/);
  assert.equal(calls.length, 0);
  assert.equal(store.state.draft.text, "unsent");
  assert.equal(store.state.submitting, false);
  runtime.dispose();
});

test("definitive rejection remains visible and explicitly restores the original text and uploaded IDs", async () => {
  const { runtime, store } = fixture(() => { throw Object.assign(new Error("invalid model"), { status: 422 }); });
  const input = { text: "try", attachments: [{ id: "uploaded" }] };
  store.setDraft({ text: input.text, attachments: [{ id: "local", kind: "image", uploadedId: "uploaded", url: "/uploads/a.png" }] });
  await runtime.submit({ ...requestBody, input });
  assert.equal(store.state.requests["request-1"].state, "rejected");
  assert.equal(store.state.requests["request-1"].previewImages[0].url, "/uploads/a.png");
  assert.equal(runtime.restoreRequest("request-1"), true);
  assert.equal(store.state.draft.text, "try");
  assert.equal(store.state.draft.attachments[0].uploadedId, "uploaded");
  assert.equal(store.state.draft.attachments[0].url, "/api/attachments/images/uploaded");
  runtime.dispose();
});

test("HTTP 409 and 429 are explicit rejections that can be restored without automatic resubmission", async () => {
  for (const status of [409, 429]) {
    const { runtime, store, calls } = fixture(() => { throw Object.assign(new Error(`HTTP ${status}`), { status }); });
    await runtime.submit(requestBody);
    assert.equal(store.state.requests["request-1"].state, "rejected");
    assert.equal(calls.length, 1);
    assert.equal(runtime.restoreRequest("request-1"), true);
    assert.equal(store.state.draft.text, "same");
    runtime.dispose();
  }
});

test("socket completion survives a concurrently resolving old HTTP page", async () => {
  const pending = deferred();
  let pageCalls = 0;
  const { runtime, store, sockets } = fixture((url) => {
    if (url.includes("/turns?")) { pageCalls += 1; return pageCalls === 1 ? { turns: [] } : pending.promise; }
    return reads(url);
  });
  await runtime.open();
  const event = (seq, type, payload) => sockets[0].event({ schemaVersion: 2, epoch: "epoch", threadId: "thread", seq, type, payload });
  event(0, "sync.required", {});
  event(1, "item.upsert", { turnId: "turn", item: { id: "answer", type: "agentMessage", text: "complete", status: "completed" } });
  pending.resolve({ turns: [{ id: "turn", items: [{ id: "answer", type: "agentMessage", text: "old", status: "inProgress" }] }] });
  await runtime.refreshLatest();
  assert.equal(store.state.turns.turn.items.answer.text, "complete");
  runtime.dispose();
});

test("pagination and item detail endpoints preserve their cursor and identity; dispose only detaches", async () => {
  const { runtime, store, calls } = fixture((url) => {
    if (url.includes("/items/item")) return { item: { id: "item", type: "fileChange", status: "completed", presentation: { fileChanges: [{ path: "a", diff: "+line" }] } } };
    if (url.includes("/items?")) return { threadId: "thread", turnId: "turn", items: [{ id: "item", type: "fileChange" }], nextCursor: "next", hasMore: true };
    if (url.includes("/turns?")) return { turns: [{ id: "turn", items: [] }], olderCursor: null, hasMore: false };
    return reads(url);
  });
  store.state.hasMore = true; store.state.olderCursor = "older a";
  await runtime.loadOlder();
  await runtime.loadItems("turn");
  await runtime.loadItems("turn");
  await runtime.loadDetail("turn", "item");
  assert.ok(calls.some((call) => call.url.includes("cursor=older+a")));
  assert.ok(calls.some((call) => {
    const url = new URL(call.url, "https://example.test");
    return url.pathname.endsWith("/items") && url.searchParams.get("cursor") === "next" && url.searchParams.get("limit") === "30";
  }));
  assert.equal(store.state.turns.turn.items.item.detailsLoaded, true);
  runtime.dispose();
  assert.equal(calls.some((call) => call.url.endsWith("/interrupt")), false);
});

test("visible primary and file details load automatically while process details wait for expansion", async () => {
  const items = ["agentMessage", "fileChange", "commandExecution"].map((type) => ({ id: type, type, status: "completed",
    hasDetails: true, truncated: true, truncatedFields: ["presentation.text"], presentation: { text: "preview" } }));
  const { runtime, store, calls } = fixture((url) => {
    if (url.includes("/turns?")) return { turns: [{ id: "turn", status: "completed", items }] };
    if (url.includes("/items?")) return { items, hasMore: false };
    const target = items.find((item) => url.endsWith(`/items/${item.id}`));
    if (target) return { item: { ...target, hasDetails: false, truncated: false, truncatedFields: [], presentation: { text: `full ${target.type}` } } };
    return reads(url);
  });
  await runtime.open(); await flush();
  assert.equal(calls.filter((call) => call.url.endsWith("/items/agentMessage")).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith("/items/fileChange")).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith("/items/commandExecution")).length, 0);
  await runtime.setProcessExpanded("turn", true);
  assert.equal(store.state.turns.turn.items.commandExecution.presentation.text, "full commandExecution");
  assert.equal(store.state.turns.turn.items.commandExecution.truncated, false);
  assert.deepEqual(store.state.turns.turn.items.commandExecution.truncatedFields, []);
  await runtime.setProcessExpanded("turn", true);
  assert.equal(calls.filter((call) => call.url.endsWith("/items/commandExecution")).length, 1);
  runtime.dispose();
});

test("detail reads cap concurrency at two, deduplicate visibility updates and stop queued work when collapsed", async () => {
  const pending = [];
  let active = 0, peak = 0;
  const { runtime, store, calls } = fixture((url) => {
    const task = deferred(), id = url.split("/").at(-1);
    active += 1; peak = Math.max(peak, active); pending.push({ ...task, id });
    return task.promise.finally(() => { active -= 1; });
  });
  store.upsertTurn({ id: "turn", status: "completed", items: Array.from({ length: 5 }, (_, index) => ({
    id: `tool-${index}`, type: "commandExecution", status: "completed", hasDetails: true
  })) });
  const visible = store.state.turns.turn.itemOrder.map((itemId) => ({ turnId: "turn", itemId }));
  const loading = runtime.setDetailVisibility(visible);
  await flush();
  void runtime.setDetailVisibility(visible);
  assert.equal(calls.length, 2);
  await runtime.setDetailVisibility([]);
  for (const task of pending) task.resolve({ item: { id: task.id, type: "commandExecution", status: "completed", hasDetails: false, truncated: false } });
  await loading;
  assert.equal(calls.length, 2);
  assert.equal(peak, 2);
  runtime.dispose();
});

test("offscreen primary details wait for their turn and leaving clears queued reads and retries", async () => {
  const clock = runtimeClock(), pending = [], items = Array.from({ length: 3 }, (_, index) => ({
    id: `answer-${index}`, type: "agentMessage", status: "completed", hasDetails: true, presentation: { text: "preview" }
  }));
  let recovering = false;
  const { runtime, store, calls } = fixture((url) => {
    if (url.includes("/items?")) return { items, hasMore: false };
    const id = url.split("/").at(-1);
    if (recovering) return { item: { ...items.find((item) => item.id === id), hasDetails: false, presentation: { text: `full ${id}` } } };
    const task = deferred(); pending.push(task); return task.promise;
  }, { runtime: { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer } });
  store.upsertTurn({ id: "outside", status: "completed", items });
  store.upsertTurn({ id: "latest", status: "completed", items: [] });
  const visible = items.map((item) => ({ turnId: "outside", itemId: item.id }));
  let details;
  try {
    await runtime.setDetailVisibility(visible);
    assert.equal(calls.length, 0, "rendered primary cards do not make an offscreen turn visible");
    await runtime.setTurnVisibility("outside", true); await flush();
    details = runtime.setDetailVisibility(visible); await flush();
    assert.equal(pending.length, 2);
    await runtime.setTurnVisibility("outside", false);
    for (const task of pending) task.reject(Object.assign(new Error("details offline"), { status: 503 }));
    await details; await flush();
    assert.equal(calls.filter((call) => !call.url.includes("/items?")).length, 2);
    assert.equal(clock.pending, 0, "offscreen failures do not schedule automatic retries");
    recovering = true;
    await clock.advance(1000);
    await runtime.setTurnVisibility("outside", true); await runtime.setDetailVisibility(visible);
    assert.equal(items.every((item) => store.state.turns.outside.items[item.id].detailsLoaded), true);
    assert.equal(clock.pending, 0);
  } finally { runtime.dispose(); for (const task of pending) task.resolve({}); await details; }
});

test("transient detail errors remain visible, retry with backoff, and clear after a successful reread", async () => {
  const timers = new Map();
  let clock = 0, timerId = 0, attempts = 0;
  const { runtime, store, calls } = fixture(() => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error("rate limited"), { status: 429 });
    return { item: { id: "tool", type: "commandExecution", status: "completed", presentation: { text: "complete" }, truncated: false, truncatedFields: [], hasDetails: false } };
  }, { runtime: { now: () => clock, setTimer: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; }, clearTimer: (id) => timers.delete(id) } });
  store.upsertTurn({ id: "turn", status: "completed", items: [{ id: "tool", type: "commandExecution", status: "completed", hasDetails: true, truncated: true }] });
  const visible = [{ turnId: "turn", itemId: "tool" }];
  await runtime.setDetailVisibility(visible);
  assert.equal(store.state.turns.turn.items.tool.detailError, "rate limited");
  await runtime.setDetailVisibility(visible);
  assert.equal(calls.length, 1);
  const [id, retry] = [...timers][0]; timers.delete(id); clock += retry.delay; retry.callback(); await flush();
  assert.equal(calls.length, 2);
  assert.equal([...timers.values()][0].delay, 2000);
  await runtime.setDetailVisibility([]);
  assert.equal(timers.size, 0);
  clock = 3000;
  await runtime.setDetailVisibility(visible);
  assert.equal(calls.length, 3);
  assert.equal(store.state.turns.turn.items.tool.detailError, "");
  assert.equal(store.state.turns.turn.items.tool.truncated, false);
  assert.equal(timers.size, 0);
  runtime.dispose();
});

test("an active visible process item is reconciled again on completion and keeps genuine truncation", async () => {
  let finished = false;
  const { runtime, store, calls } = fixture(() => ({ item: { id: "tool", type: "commandExecution", status: finished ? "completed" : "inProgress",
    presentation: { text: finished ? "long completed output" : "initial output" }, hasDetails: true, truncated: finished,
    truncatedFields: finished ? ["aggregatedOutput"] : [] } }));
  store.upsertTurn({ id: "turn", status: "inProgress", items: [{ id: "tool", type: "commandExecution", status: "inProgress", hasDetails: true }] });
  const visible = [{ turnId: "turn", itemId: "tool" }];
  await runtime.setDetailVisibility(visible);
  await runtime.setDetailVisibility(visible);
  assert.equal(calls.length, 1);
  finished = true;
  store.upsertItem("turn", { id: "tool", type: "commandExecution", status: "completed", hasDetails: true, presentation: { text: "bounded completion" } });
  await runtime.setDetailVisibility(visible);
  assert.equal(calls.length, 2);
  assert.equal(store.state.turns.turn.items.tool.presentation.text, "long completed output");
  assert.equal(store.state.turns.turn.items.tool.truncated, true);
  await runtime.setDetailVisibility(visible);
  assert.equal(calls.length, 2);
  runtime.dispose();
});

async function flush() { for (let index = 0; index < 60; index += 1) await Promise.resolve(); await nextTick(); }
function sourceUrl(source) { return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`; }
function compileComponentUrl(file, overrides = {}) {
  if (overrides[file.href]) return overrides[file.href];
  const { descriptor } = parse(fs.readFileSync(file, "utf8"), { filename: file.pathname });
  const compiled = compileScript(descriptor, { id: file.pathname, inlineTemplate: true }).content;
  return sourceUrl(compiled.replace(/from\s+["']([^"']+)["']/g, (_, name) => {
    const resolved = name.startsWith(".") ? new URL(name, file).href : import.meta.resolve(name);
    return `from ${JSON.stringify(overrides[resolved] || (name.endsWith(".vue") ? compileComponentUrl(new URL(resolved), overrides) : resolved))}`;
  }));
}
function elements(root, predicate) {
  return [...(predicate(root) ? [root] : []), ...(root.children || []).flatMap((node) => elements(node, predicate))];
}
function testRenderer() {
  return createRenderer({
    createElement: (type) => markRaw({ type, props: {}, children: [], style: {}, scrollHeight: 48,
      get isConnected() { let node = this; while (node.parent) node = node.parent; return node !== this; },
      contains(target) { return elements(this, (node) => node === target).length > 0; },
      showModal() {
        this.modalOrigin = globalThis.document?.activeElement;
        this.open = true;
        elements(this, (node) => node.type === "button")[0]?.focus();
      },
      close() {
        this.open = false;
        if (this.modalOrigin?.isConnected) this.modalOrigin.focus({ preventScroll: true });
      },
      getBoundingClientRect() { return this.rect || { height: 0 }; },
      querySelector(selector) { return elements(this, (node) => String(node.props?.class || "").split(/\s+/).includes(selector.slice(1)))[0] || null; },
      scrollIntoView() {},
      focus() { if (globalThis.document) globalThis.document.activeElement = this; } }),
    createText: (text) => ({ text }), createComment: (text) => ({ text }),
    setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: (node) => node?.parent || null,
    nextSibling: (node) => node?.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    insert: (node, parent, anchor) => {
      if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node);
      node.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index >= 0) parent.children.splice(index, 0, node); else parent.children.push(node);
    },
    remove: (node) => { if (node?.parent) node.parent.children = node.parent.children.filter((child) => child !== node); node.parent = null; },
    querySelector: (selector) => selector === "body" ? globalThis.document?.body : null,
    patchProp: (node, key, previous, next) => { node.props[key] = next; }
  });
}

test("restored failed attachment offers removal without an unusable retry", async () => {
  const component = (await import(compileComponentUrl(new URL("../web/src/components/composer/AttachmentChips.vue", import.meta.url)))).default;
  const renderer = testRenderer(), root = { children: [] }, removed = [], retried = [];
  const attachment = { id: "stale", kind: "image", name: "old.png", status: "failed" };
  renderer.render(h(component, { attachments: [attachment], onRemove: (id) => removed.push(id), onRetry: (id) => retried.push(id) }), root);
  assert.equal(elements(root, (node) => node.props?.["aria-label"] === "重试 old.png").length, 0);
  elements(root, (node) => node.props?.["aria-label"] === "移除 old.png")[0].props.onClick();
  assert.deepEqual(removed, ["stale"]);
  renderer.render(h(component, { attachments: [{ ...attachment, file: new File(["data"], "old.png") }],
    onRemove: (id) => removed.push(id), onRetry: (id) => retried.push(id) }), root);
  elements(root, (node) => node.props?.["aria-label"] === "重试 old.png")[0].props.onClick();
  assert.deepEqual(retried, ["stale"]);
  assert.equal(elements(root, (node) => node.props?.["aria-label"] === "移除 old.png").length, 1);
  renderer.render(null, root);
});

test("initial chat scrolling respects a user's position when history updates", async () => {
  const previousWindow = globalThis.window;
  const timers = [];
  globalThis.window = { innerHeight: 800, addEventListener() {}, removeEventListener() {},
    setTimeout(callback) { timers.push(callback); return timers.length; }, clearTimeout() {} };
  try {
    const stub = sourceUrl(`import { h } from ${JSON.stringify(import.meta.resolve("vue"))};
      export default { render() { return h('stub'); } };`);
    const component = (await import(compileComponentUrl(new URL("../web/src/components/ChatView.vue", import.meta.url), {
      [new URL("../web/src/components/composer/ChatComposer.vue", import.meta.url).href]: stub,
      [new URL("../web/src/components/thread-item/ThreadTurnTimeline.vue", import.meta.url).href]: stub
    }))).default;
    const renderer = testRenderer(), root = { children: [] };
    const props = { sessionKey: "thread", composerOptions: { attachments: [] }, gitState: {}, threadSnapshot: { version: 1, turns: [] } };
    renderer.render(h(component, props), root); await flush();
    const stream = elements(root, (node) => node.props?.class === "message-stream")[0];
    stream.scrollHeight = 500; stream.clientHeight = 100; stream.scrollTop = 100;
    stream.props.onWheelPassive({ deltaY: -100 });
    stream.props.onScroll({ target: stream });
    renderer.render(h(component, { ...props, threadSnapshot: { version: 2, turns: [] } }), root); await flush();
    for (const callback of timers) callback();
    await flush();
    assert.equal(stream.scrollTop, 100);
    assert.equal(timers.length, 0);
    renderer.render(null, root);
  } finally { globalThis.window = previousWindow; }
});

test("browser scroll restoration and late timeline growth settle at bottom without user input", async () => {
  const previousWindow = globalThis.window, previousObserver = globalThis.ResizeObserver;
  const observers = [];
  globalThis.window = { innerHeight: 800, addEventListener() {}, removeEventListener() {} };
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() {}
  };
  try {
    const composer = sourceUrl("export default { render() { return null; } };");
    const timeline = sourceUrl(`import { h } from ${JSON.stringify(import.meta.resolve("vue"))};
      export default { render() { return h('div', { class: 'thread-turn-timeline' }); } };`);
    const component = (await import(compileComponentUrl(new URL("../web/src/components/ChatView.vue", import.meta.url), {
      [new URL("../web/src/components/composer/ChatComposer.vue", import.meta.url).href]: composer,
      [new URL("../web/src/components/thread-item/ThreadTurnTimeline.vue", import.meta.url).href]: timeline
    }))).default;
    const renderer = testRenderer(), root = { children: [] };
    const props = { sessionKey: "restore", composerOptions: { attachments: [] }, gitState: {}, threadSnapshot: { version: 1, turns: [] } };
    renderer.render(h(component, props), root); await flush();
    const stream = elements(root, (node) => node.props?.class === "message-stream")[0];
    const programmaticScrolls = [];
    stream.scrollTo = (options) => {
      programmaticScrolls.push(options);
      stream.scrollTop = options.top;
      stream.props.onScroll({ target: stream });
    };
    stream.scrollHeight = 600; stream.clientHeight = 100; stream.scrollTop = 250;
    stream.props.onScroll({ target: stream }); await flush();
    assert.equal(stream.scrollTop, 600, "restored position is not treated as user scrolling");
    assert.deepEqual(programmaticScrolls, [{ top: 600, behavior: "instant" }], "programmatic scroll does not start a smooth correction loop");
    const observer = observers.at(-1);
    assert.ok(observer.targets.some((node) => node.props?.class === "thread-turn-timeline"));
    stream.scrollHeight = 900;
    observer.callback(); await flush();
    assert.equal(stream.scrollTop, 900, "image or hydrated layout growth remains pinned");
    assert.deepEqual(programmaticScrolls.at(-1), { top: 900, behavior: "instant" });
    stream.props.onWheelPassive({ deltaY: -100 });
    stream.scrollTop = 100; stream.props.onScroll({ target: stream });
    stream.scrollHeight = 1200;
    observer.callback();
    renderer.render(h(component, { ...props, threadSnapshot: { version: 2, turns: [] } }), root); await flush();
    assert.equal(stream.scrollTop, 100, "later hydration preserves an intentional upward scroll");
    renderer.render(null, root);
  } finally { globalThis.window = previousWindow; globalThis.ResizeObserver = previousObserver; }
});

test("touch, scroll keys and scrollbar dragging count as intentional upward scrolling", async () => {
  const previousWindow = globalThis.window;
  const listeners = new Map();
  globalThis.window = { innerHeight: 800, addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name) => listeners.delete(name) };
  try {
    const stub = sourceUrl("export default { render() { return null; } };");
    const component = (await import(compileComponentUrl(new URL("../web/src/components/ChatView.vue", import.meta.url), {
      [new URL("../web/src/components/composer/ChatComposer.vue", import.meta.url).href]: stub,
      [new URL("../web/src/components/thread-item/ThreadTurnTimeline.vue", import.meta.url).href]: stub
    }))).default;
    const renderer = testRenderer();
    for (const kind of ["touch", "keyboard", "scrollbar"]) {
      const root = { children: [] };
      const props = { sessionKey: kind, composerOptions: { attachments: [] }, gitState: {}, threadSnapshot: { version: 1, turns: [] } };
      renderer.render(h(component, props), root); await flush();
      const stream = elements(root, (node) => node.props?.class === "message-stream")[0];
      stream.scrollHeight = 600; stream.clientHeight = 100; stream.scrollTop = 600;
      if (kind === "touch") {
        stream.props.onTouchstartPassive({ touches: [{ clientX: 20, clientY: 100 }] });
        stream.props.onTouchmovePassive({ touches: [{ clientX: 20, clientY: 150 }] });
      } else if (kind === "keyboard") {
        stream.props.onKeydown({ target: { closest: () => ({}) }, key: "PageUp" });
        stream.scrollTop = 300; stream.props.onScroll({ target: stream }); await flush();
        assert.equal(stream.scrollTop, 600, "typing controls do not unpin the timeline");
        stream.props.onKeydown({ target: { closest: () => null }, key: "PageUp" });
      } else {
        stream.rect = { right: 500, height: 0 };
        stream.props.onPointerdown({ target: stream, pointerType: "mouse", clientX: 495 });
      }
      stream.scrollTop = 100; stream.props.onScroll({ target: stream });
      if (kind === "scrollbar") listeners.get("pointerup")();
      renderer.render(h(component, { ...props, threadSnapshot: { version: 2, turns: [] } }), root); await flush();
      assert.equal(stream.scrollTop, 100, `${kind} scroll must survive history changes`);
      renderer.render(null, root);
    }
  } finally { globalThis.window = previousWindow; }
});

test("ChatView forwards the supplied model, visibility and question controls through the real timeline", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { innerHeight: 800, addEventListener() {}, removeEventListener() {}, setTimeout() {}, clearTimeout() {} };
  const stub = sourceUrl("export default { render() { return null; } };");
  const card = sourceUrl(`import { h, onMounted } from ${JSON.stringify(import.meta.resolve("vue"))};
    export default { props: ['turn', 'canAnswerQuestions'], emits: ['turn-visibility', 'question-answer'], setup(props, { emit }) {
      onMounted(() => emit('turn-visibility', true)); return () => h('turn-probe', { turn: props.turn,
        canAnswerQuestions: props.canAnswerQuestions, onAnswer: (payload) => emit('question-answer', payload) }); } };`);
  const component = (await import(compileComponentUrl(new URL("../web/src/components/ChatView.vue", import.meta.url), {
    [new URL("../web/src/components/composer/ChatComposer.vue", import.meta.url).href]: stub,
    [new URL("../web/src/components/thread-item/ThreadTurnCard.vue", import.meta.url).href]: card
  }))).default;
  const renderer = testRenderer(), root = { children: [] };
  const turn = { id: "provided", fileChanges: [] };
  const visibility = [], answers = [];
  const props = { composerOptions: { attachments: [] }, gitState: {}, threadSnapshot: { version: 1, turns: [] }, onTurnVisibility: (payload) => visibility.push(payload),
    threadViewModel: { version: 1, turns: [turn], latestFileChangeTurnId: "" }, canAnswerQuestions: true, onQuestionAnswer: (payload) => answers.push(payload) };
  try {
    renderer.render(h(component, props), root); await flush();
    assert.equal(elements(root, (node) => node.type === "turn-probe")[0].props.turn, turn);
    assert.deepEqual(visibility, [{ turnId: "provided", visible: true }]);
    const questionProbe = elements(root, (node) => node.type === "turn-probe")[0];
    assert.equal(questionProbe.props.canAnswerQuestions, true);
    const answer = { question: { callId: "call" }, index: 0, answer: "choice" };
    questionProbe.props.onAnswer(answer);
    assert.deepEqual(answers, [answer]);
    renderer.render(h(component, { ...props, threadViewModel: null,
      threadSnapshot: { version: 2, turns: [{ id: "fallback", items: [] }] } }), root); await flush();
    assert.equal(elements(root, (node) => node.type === "turn-probe")[0].props.turn.id, "fallback");
  } finally { renderer.render(null, root); globalThis.window = previousWindow; }
});

test("thread image preview traps keyboard focus and restores its opener", async () => {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const listeners = new Map();
  globalThis.window = { addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: (name) => listeners.delete(name) };
  const body = { children: [] };
  globalThis.document = { activeElement: null, body };
  const renderer = testRenderer(), root = { children: [], parent: body }; body.children.push(root);
  try {
    const component = (await import(compileComponentUrl(new URL("../web/src/components/thread-item/ThreadItemRenderer.vue", import.meta.url)))).default;
    renderer.render(h(component, { item: { id: "image", category: "user", imageItems: [{ url: "/image.png", alt: "image" }] } }), root);
    await flush();
    const opener = elements(root, (node) => node.props?.["aria-label"] === "查看图片 1")[0];
    globalThis.document.activeElement = opener;
    opener.props.onClick({ currentTarget: opener }); await flush();
    const dialog = elements(body, (node) => node.props?.role === "dialog")[0];
    assert.equal(dialog.type, "dialog");
    assert.equal(dialog.open, true);
    assert.equal(dialog.props["aria-modal"], "true");
    const close = elements(dialog, (node) => node.props?.["aria-label"] === "关闭预览")[0];
    assert.equal(globalThis.document.activeElement.props["aria-label"], close.props["aria-label"]);
    let prevented = 0;
    dialog.props.onKeydown({ key: "Tab", preventDefault() { prevented += 1; }, stopPropagation() {} });
    assert.equal(globalThis.document.activeElement.props["aria-label"], close.props["aria-label"]);
    dialog.props.onKeydown({ key: "Escape", preventDefault() { prevented += 1; }, stopPropagation() {} });
    await flush();
    assert.equal(elements(body, (node) => node.props?.role === "dialog").length, 0);
    assert.equal(globalThis.document.activeElement, opener);
    assert.equal(prevented, 2);
  } finally { renderer.render(null, root); globalThis.window = previousWindow; globalThis.document = previousDocument; }
});
async function mountThreadView(api = {}) {
  const previousWindow = globalThis.window, previousSocket = globalThis.WebSocket;
  const calls = [], sockets = [];
  const history = declaredHistoryPages();
  const settings = { model: "model", reasoningEffort: "high", permissionMode: "default", git: { isGitRepo: true, currentBranch: "main", cwd: "/tmp" } };
  globalThis.window = { localStorage: api.storage || memoryStorage() };
  globalThis.WebSocket = class { constructor() { sockets.push(this); } close() {} };
  globalThis.__codexChatTestApi = {
    supportsInitialHistory: () => api.supportsInitialHistory === true,
    recheckInitialHistorySupport: (...args) => api.recheckInitialHistorySupport?.(...args) ?? Promise.resolve(api.supportsInitialHistory === true),
    request: async (url, options = {}) => {
      calls.push({ url, ...options });
      if (api.request) { const handled = api.request(url, options); if (handled !== undefined) return history.remember(url, await handled); }
      if (url === "/api/config") return { codexDefaults: settings, providers: [{ id: "codex", models: ["model"] }] };
      if (url.endsWith("/requests") && options.method === "POST") {
        const body = JSON.parse(options.body);
        return { request: { id: body.clientRequestId, state: "completed", input: body.input } };
      }
      return history.read(url) ?? reads(url);
    },
    requestThreadComposerState: async (...args) => { calls.push({ url: "composer-state", composer: "read", args }); return api.composerRead ? api.composerRead(...args) : settings; },
    patchThreadComposerState: async (...args) => api.patch ? api.patch(...args) : settings,
    requestWorkspaceGit: async (...args) => { calls.push({ url: "workspace-git", git: "read", args }); return api.gitRead ? api.gitRead(...args) : { isGitRepo: true, currentBranch: "main" }; },
    requestWorkspaceGitCheckout: async (...args) => { calls.push({ git: "checkout", args }); },
    requestWorkspaceGitBranchCreate: async (...args) => { calls.push({ git: "create", args }); }
  };
  const mockApi = sourceUrl(Object.keys(globalThis.__codexChatTestApi).map((name) =>
    `export const ${name} = (...args) => globalThis.__codexChatTestApi.${name}(...args);`).join("\n"));
  let runtime, store;
  globalThis.__codexChatTestRuntimeFactory = (options) => {
    store = options.store;
    runtime = createCodexChatRuntime({ ...options, ...api.runtime });
    return runtime;
  };
  const mockRuntime = sourceUrl("export const createCodexChatRuntime = (options) => globalThis.__codexChatTestRuntimeFactory(options);");
  const rendererStub = sourceUrl(`import { defineComponent, h } from ${JSON.stringify(import.meta.resolve("vue"))};
    export default defineComponent({ props: ['item', 'canAnswerQuestions'], emits: ['question-answer'], setup(props, { emit }) {
      return () => h('item-display', { 'data-id': props.item.id, item: props.item, canAnswerQuestions: props.canAnswerQuestions,
        onAnswer: (payload) => emit('question-answer', payload) }, props.item.body); } });`);
  const panelStub = sourceUrl(`export default { render() { return null; } };`);
  const timeline = compileComponentUrl(new URL("../web/src/components/thread-item/ThreadTurnTimeline.vue", import.meta.url), {
    [new URL("../web/src/components/thread-item/ThreadItemRenderer.vue", import.meta.url).href]: rendererStub,
    [new URL("../web/src/components/thread-item/WorkspaceChangesPanel.vue", import.meta.url).href]: panelStub
  });
  const mockChat = sourceUrl(`import { defineComponent, h } from ${JSON.stringify(import.meta.resolve("vue"))};
    import Timeline from ${JSON.stringify(timeline)};
    export default defineComponent({ props: { draft: String, canSend: Boolean, canInterrupt: Boolean, allowFollowups: Boolean,
      canSteer: Boolean, canAnswerQuestions: Boolean, runningTask: Boolean, followUpMode: String, interrupting: Boolean, processExpanded: Object, loading: Boolean, historyLoading: Boolean, hasOlder: Boolean, loadingOlder: Boolean, onReachTop: Function,
      composerOptions: Object, models: Array, gitState: Object, threadSnapshot: Object, threadViewModel: Object, statusText: String },
      setup(props, { emit, slots }) { globalThis.__codexChatTestChat = { props, emit }; return () => h('chat-view', [
        h('history-start', slots['history-start']?.({ loadOlder: props.onReachTop })), h(Timeline, { snapshot: props.threadSnapshot, threadViewModel: props.threadViewModel, processExpanded: props.processExpanded,
          canAnswerQuestions: props.canAnswerQuestions, onQuestionAnswer: (payload) => emit('question-answer', payload),
          onProcessToggle: (payload) => emit('process-toggle', payload), onTurnVisibility: (payload) => emit('turn-visibility', payload) }, {
          'turn-footer': slots['turn-footer'], 'item-footer': slots['item-footer'] }),
        h('composer-top', slots['composer-top']?.())]); } });`);
  const file = new URL("../web/src/components/CodexThreadView.vue", import.meta.url);
  const { descriptor } = parse(fs.readFileSync(file, "utf8"), { filename: file.pathname });
  const compiled = compileScript(descriptor, { id: "codex-thread-runtime-test", inlineTemplate: true }).content;
  const source = compiled.replace(/from\s+["']([^"']+)["']/g, (_, name) => `from ${JSON.stringify(
    name === "vue" ? import.meta.resolve("vue") : name === "./ChatView.vue" ? mockChat : name === "../lib/api.js" ? mockApi
      : name === "../lib/codex-chat-runtime.js" ? mockRuntime : name.endsWith(".vue") ? compileComponentUrl(new URL(name, file)) : new URL(name, file).href)}`);
  const Component = (await import(sourceUrl(source))).default;
  const renderer = testRenderer();
  const root = { children: [] };
  const viewProps = api.loadConfig ? { loadConfig: api.loadConfig } : {};
  renderer.render(h(Component, { threadId: "thread", ...viewProps }), root);
  await flush();
  return { calls, sockets, root, get chat() { return globalThis.__codexChatTestChat; }, storage: globalThis.window.localStorage,
    get runtime() { return runtime; },
    get store() { return store; },
    switchThread(id) { renderer.render(h(Component, { threadId: id, ...viewProps }), root); },
    close() {
      renderer.render(null, root);
      globalThis.window = previousWindow; globalThis.WebSocket = previousSocket;
      delete globalThis.__codexChatTestApi; delete globalThis.__codexChatTestChat;
      delete globalThis.__codexChatTestRuntimeFactory;
    } };
}

function submissionFeedback(harness) {
  const composer = elements(harness.root, (node) => node.type === "composer-top")[0];
  return elements(composer, (node) => String(node.props?.class || "").split(/\s+/).includes("codex-submission-feedback"))[0];
}
function nodeText(node) { return node ? [node.text || "", ...(node.children || []).map(nodeText)].join(" ") : ""; }

test("mounted initial history shows loading, failure and empty states without waiting for settings", async () => {
  const firstPage = deferred(), options = deferred();
  let attempt = 0;
  const harness = await mountThreadView({ composerRead: () => options.promise, request: (url) => {
    if (url.includes("/turns?")) return ++attempt === 1 ? firstPage.promise : reads(url);
  }, runtime: { maxPolls: 0 } });
  const historyText = () => nodeText(elements(harness.root, (node) => node.type === "history-start")[0]);
  try {
    assert.match(historyText(), /正在加载消息/);
    assert.doesNotMatch(historyText(), /从一个想法开始/);
    firstPage.reject(new Error("history unavailable"));
    await flush();
    assert.match(historyText(), /history unavailable/);
    assert.match(historyText(), /重试加载/);
    assert.doesNotMatch(historyText(), /正在加载消息|从一个想法开始/);
    await harness.runtime.refreshLatest(); await flush();
    assert.match(historyText(), /从一个想法开始/);
    assert.doesNotMatch(historyText(), /正在加载消息|history unavailable|重试加载/);
    assert.equal(harness.chat.props.loading, true, "settings still protect submission after history settles");
  } finally { options.resolve({ model: "model" }); harness.close(); }
});

test("mounted capable chat renders the combined window while settings still protect sending", async () => {
  const options = deferred();
  const harness = await mountThreadView({ supportsInitialHistory: true, composerRead: () => options.promise,
    runtime: { maxPolls: 0 }, request: (url) => {
      if (url.endsWith("/initial-history")) return {
        turnsPage: { threadId: "thread", turns: [{ id: "turn", status: "completed", items: [
          { id: "answer", type: "agentMessage", text: "short summary" }
        ] }], hasMore: false, olderCursor: null },
        itemsPage: { threadId: "thread", turnId: "turn", items: [
          { id: "answer", type: "agentMessage", text: "full combined answer", status: "completed" }
        ], hasMore: false, nextCursor: null, latestItemId: "answer" }
      };
      if (url.includes("/items?")) return { items: [], hasMore: false, latestItemId: "answer" };
    } });
  try {
    assert.equal(harness.chat.props.historyLoading, false);
    assert.deepEqual(elements(harness.root, (node) => node.type === "item-display").map((node) => node.text), ["full combined answer"]);
    assert.equal(harness.chat.props.loading, true);
    assert.equal(harness.chat.props.canSend, false);
    assert.equal(harness.calls.filter((call) => call.url.endsWith("/initial-history")).length, 1);
    assert.equal(harness.calls.some((call) => call.url.includes("/turns?")), false);
    assert.equal(harness.calls.some((call) => call.url.includes("sortDirection=desc")), false);
    options.resolve({ model: "model" }); await flush();
    harness.chat.emit("update:draft", "new message"); await flush();
    assert.equal(harness.chat.props.loading, false);
    assert.equal(harness.chat.props.canSend, true);
  } finally { options.resolve({ model: "model" }); harness.close(); }
});

test("mounted chat waits eighteen seconds for the latest window without showing an older summary or empty state", async () => {
  const latest = deferred(), clock = runtimeClock();
  const harness = await mountThreadView({ runtime: { maxPolls: 0, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer }, request: (url) => {
    if (url.includes("/turns?")) return { turns: [{ id: "turn", status: "completed", items: [
      { id: "old", type: "agentMessage", text: "older summary must stay hidden" }
    ] }], hasMore: false };
    if (url.includes("/items?")) return latest.promise;
  } });
  const history = () => nodeText(elements(harness.root, (node) => node.type === "history-start")[0]);
  try {
    assert.match(history(), /正在加载消息/);
    assert.doesNotMatch(history(), /从一个想法开始/);
    assert.equal(elements(harness.root, (node) => node.type === "item-display").length, 0);
    assert.equal(harness.chat.props.historyLoading, true);
    await clock.advance(18000);
    assert.match(history(), /正在加载消息/);
    assert.doesNotMatch(history(), /从一个想法开始/);
    assert.equal(elements(harness.root, (node) => node.type === "item-display").length, 0);
    latest.resolve({ items: [{ id: "latest", type: "agentMessage", text: "newest answer" }], hasMore: false, latestItemId: "latest" });
    await flush();
    assert.equal(harness.chat.props.historyLoading, false);
    assert.doesNotMatch(history(), /正在加载消息|从一个想法开始/);
    assert.deepEqual(elements(harness.root, (node) => node.type === "item-display").map((node) => node.text), ["newest answer"]);
    const pages = harness.calls.filter((call) => call.url.includes("/items?"));
    assert.equal(pages.length, 1);
    assert.equal(new URL(pages[0].url, "https://example.test").searchParams.get("sortDirection"), "desc");
    assert.ok(harness.calls.filter((call) => call.url.includes("/turns?")).every((call) => call.url.endsWith("/turns?limit=1")));
  } finally { latest.resolve({ items: [], hasMore: false }); harness.close(); }
});

for (const combined of [true, false]) {
  test(`mounted ${combined ? "combined" : "legacy"} history keeps early receipts behind the initial window`, async () => {
    const firstPage = deferred(), latest = deferred(), storage = memoryStorage();
    let retryItems = false;
    const receipt = { id: "old-request", threadId: "thread", state: "failed", turnId: "old-turn",
      input: { text: "old saved input" }, error: { message: "old failure" } };
    storage.setItem("codex-chat-v2:thread", JSON.stringify({ threadId: "thread", draft: { text: "", attachments: [] }, requests: [receipt] }));
    const harness = await mountThreadView({ storage, supportsInitialHistory: combined, runtime: { maxPolls: 0 }, request: (url) => {
      if (url.endsWith("/initial-history") || url.includes("/turns?")) return firstPage.promise;
      if (url.includes("/items?")) return retryItems ? itemsPage : latest.promise;
      if (url.endsWith("/requests")) return { requests: [receipt] };
    } });
    const history = () => nodeText(elements(harness.root, (node) => node.type === "history-start")[0]);
    const turnsPage = { threadId: "thread", turns: [{ id: "latest-turn", status: "completed", items: [] }], hasMore: false, olderCursor: null };
    const itemsPage = { threadId: "thread", turnId: "latest-turn", items: [
      { id: "latest-answer", type: "agentMessage", text: "latest complete answer" }
    ], hasMore: false, nextCursor: null, latestItemId: "latest-answer" };
    try {
      assert.equal(harness.store.state.requestListReady, true);
      assert.equal(harness.store.state.initialized, false);
      assert.equal(harness.chat.props.historyLoading, true, "an early receipt must not reveal the timeline");
      assert.match(history(), /正在加载消息/);
      if (combined) firstPage.resolve({ turnsPage, itemsPage });
      else {
        firstPage.resolve(turnsPage); await flush();
        assert.equal(harness.chat.props.historyLoading, true, "turn metadata is not the latest content window");
        assert.match(history(), /正在加载消息/);
        latest.reject(new Error("latest page unavailable")); await flush();
        assert.equal(harness.chat.props.historyLoading, true);
        assert.match(history(), /latest page unavailable/);
        assert.match(history(), /重试加载/);
        retryItems = true;
        await harness.runtime.setTurnVisibility("latest-turn", true);
      }
      await flush();
      assert.equal(harness.chat.props.historyLoading, false);
      assert.doesNotMatch(history(), /正在加载消息|从一个想法开始|latest page unavailable/);
      assert.ok(elements(harness.root, (node) => node.type === "item-display" && node.text === "latest complete answer").length);
      assert.equal(harness.store.state.requests[receipt.id].error.message, "old failure", "receipt recovery data remains intact");
    } finally { firstPage.resolve({ turnsPage, itemsPage }); latest.resolve(itemsPage); harness.close(); }
  });
}

test("a live turn arriving during legacy initialization cannot strand the initial history window", async () => {
  const turns = deferred();
  const previousObserver = globalThis.IntersectionObserver;
  // A hidden browser timeline has no visible turns to trigger observer hydration.
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
  const harness = await mountThreadView({ runtime: { maxPolls: 0 }, request: (url) => {
    if (url.includes("/turns?")) return turns.promise;
    if (url.includes("/items?")) {
      const live = url.includes("/turns/live/");
      return { items: [{ id: live ? "live-item" : "initial-item", type: "agentMessage", text: live ? "live output" : "initial complete history" }], hasMore: false };
    }
  } });
  try {
    const socket = harness.sockets[0];
    const send = (seq, type, payload) => socket.onmessage({ data: JSON.stringify({ schemaVersion: 2, threadId: "thread", epoch: "epoch", seq, type, payload }) });
    send(0, "sync.required", {});
    send(1, "turn.upsert", { turn: { id: "live", status: "inProgress", items: [
      { id: "live-item", type: "agentMessage", text: "live output" }
    ] } });
    await flush();
    assert.equal(harness.chat.props.historyLoading, true, "live events cannot open the initial timeline");
    turns.resolve({ threadId: "thread", turns: [{ id: "initial", status: "completed", items: [] }], hasMore: false });
    await flush();
    assert.equal(harness.chat.props.historyLoading, false);
    assert.equal(harness.store.state.turns.initial.itemsLatestLoaded, true);
    assert.deepEqual(harness.store.state.turnOrder, ["initial", "live"]);
    assert.ok(elements(harness.root, (node) => node.type === "item-display" && node.text === "live output").length);
  } finally { turns.resolve({ turns: [], hasMore: false }); harness.close(); globalThis.IntersectionObserver = previousObserver; }
});

test("mounted chat returns false for a failed within-turn older read and retries that cursor without loading another turn", async () => {
  let attempts = 0;
  const harness = await mountThreadView({ runtime: { maxPolls: 0 }, request: (url) => {
    if (url.includes("/turns?")) return { turns: [{ id: "turn", status: "completed", items: [
      { id: "old", type: "agentMessage", text: "older summary" }
    ] }], hasMore: false };
    if (url.includes("/items?")) {
      const query = new URL(url, "https://example.test").searchParams;
      assert.equal(query.get("sortDirection"), "desc");
      if (query.get("cursor") === "older-items") {
        if (++attempts === 1) throw new Error("older page unavailable");
        return { items: [{ id: "old", type: "agentMessage", text: "older complete" }], hasMore: false, latestItemId: "old" };
      }
      return { items: [{ id: "latest", type: "agentMessage", text: "latest answer" }], nextCursor: "older-items", hasMore: true, latestItemId: "latest" };
    }
  } });
  try {
    assert.equal(harness.chat.props.hasOlder, true, "older items remain available even with no previous turns");
    assert.deepEqual(elements(harness.root, (node) => node.type === "item-display").map((node) => node.text), ["latest answer"]);
    assert.equal(await harness.chat.props.onReachTop(), false); await flush();
    const history = elements(harness.root, (node) => node.type === "history-start")[0];
    assert.match(nodeText(history), /older page unavailable/);
    assert.equal(harness.store.state.errorOwner, "older");
    assert.doesNotMatch(harness.chat.props.statusText, /older page unavailable/);
    elements(history, (node) => node.type === "button" && node.text === "重试加载")[0].props.onClick();
    await flush();
    assert.equal(attempts, 2);
    assert.equal(harness.chat.props.hasOlder, false);
    assert.doesNotMatch(nodeText(history), /older page unavailable/);
    assert.deepEqual(elements(harness.root, (node) => node.type === "item-display").map((node) => node.text), ["older complete", "latest answer"]);
    assert.equal(harness.calls.filter((call) => call.url.includes("/turns?")).length, 1);
  } finally { harness.close(); }
});

function feedbackButton(harness, label) {
  return elements(submissionFeedback(harness) || {}, (node) => node.type === "button" && node.text === label)[0];
}

test("mounted turn observers load visible content and detach across thread switches and unmount", async () => {
  const PreviousObserver = globalThis.IntersectionObserver, observers = [];
  globalThis.IntersectionObserver = class {
    constructor(callback, options) { this.callback = callback; this.options = options; observers.push(this); }
    observe(element) { this.element = element; }
    disconnect() { this.disconnected = true; }
    show(visible) { this.callback([{ target: this.element, isIntersecting: visible }]); }
  };
  let harness;
  try {
    harness = await mountThreadView({ runtime: { maxPolls: 0 }, request: (path) => {
      const url = new URL(path, "http://fixture.test"), next = url.pathname.includes("/threads/next"), threadId = next ? "next" : "thread";
      if (url.pathname.endsWith("/turns")) return { threadId, turns: (next ? ["next-turn"] : ["outside", "latest"]).map((id) => ({
        id, status: "completed", itemsTruncated: true, items: [{ id: `${id}-summary`, type: "agentMessage", presentation: { text: `${id} summary` } }]
      })) };
      if (url.pathname.endsWith("/items")) {
        const id = url.pathname.split("/turns/")[1].split("/")[0];
        return { threadId, turnId: id, items: [{ id: `${id}-full`, type: "agentMessage", presentation: { text: `${id} complete` } }], hasMore: false };
      }
      if (next && url.pathname.endsWith("/threads/next")) return { thread: { id: "next" } };
    } });
    assert.equal(observers.length, 2);
    assert.equal(harness.calls.filter((call) => call.url.includes("/turns/outside/items?")).length, 0);
    assert.equal(elements(harness.root, (node) => node.props?.["data-id"] === "outside-summary").length, 0,
      "an offscreen summary cannot precede its requested latest window");
    const outside = observers[0];
    assert.ok(outside);
    outside.show(true); await flush();
    assert.equal(harness.calls.filter((call) => call.url.includes("/turns/outside/items?")).length, 1);
    assert.ok(elements(harness.root, (node) => node.type === "item-display" && node.text === "outside complete").length);
    outside.show(false); await flush();
    const oldObservers = [...observers];
    harness.switchThread("next"); await flush();
    assert.equal(oldObservers.every((observer) => observer.disconnected), true);
    const count = harness.calls.length;
    outside.show(true); await flush();
    assert.equal(harness.calls.length, count, "late callbacks cannot reach the new thread runtime");
    assert.equal(harness.store.state.threadId, "next");
    harness.close(); harness = null;
    assert.equal(observers.every((observer) => observer.disconnected), true);
  } finally { harness?.close(); globalThis.IntersectionObserver = PreviousObserver; }
});

test("a pending latest window exposes loading and read failures while its old summary stays hidden", async () => {
  const page = deferred();
  let failing = true;
  const harness = await mountThreadView({ runtime: { maxPolls: 0 }, request: (url) => {
    if (url.includes("/turns?")) return { turns: [{ id: "turn", status: "completed", itemsTruncated: true, items: [
      { id: "tool", type: "commandExecution", status: "completed" },
      { id: "answer", type: "agentMessage", presentation: { text: "summary" } }
    ] }] };
    if (url.includes("/items?")) return failing ? page.promise : { items: [{ id: "complete", type: "agentMessage", presentation: { text: "complete body" } }], hasMore: false };
  } });
  try {
    assert.match(nodeText(elements(harness.root, (node) => node.type === "history-start")[0]), /正在加载消息/);
    assert.equal(elements(harness.root, (node) => node.type === "item-display" && node.text === "summary").length, 0);
    assert.equal(harness.chat.props.historyLoading, true);
    page.reject(Object.assign(new Error("primary page offline"), { status: 503 })); await flush();
    assert.match(nodeText(elements(harness.root, (node) => node.type === "history-start")[0]), /primary page offline/);
    assert.doesNotMatch(nodeText(elements(harness.root, (node) => node.type === "history-start")[0]), /从一个想法开始/);
    failing = false;
    await harness.runtime.setTurnVisibility("turn", true); await flush();
    assert.match(nodeText(harness.root), /complete body/);
    assert.doesNotMatch(nodeText(harness.root), /正在读取完整消息|完整消息读取失败/);
  } finally { harness.close(); page.resolve({ items: [], hasMore: false }); }
});

test("composer submission feedback replaces the prior local failure with neutral pending progress", async () => {
  const pending = deferred();
  let submissions = 0;
  const harness = await mountThreadView({ runtime: { maxPolls: 0 }, request: (url, options) => {
    if (url.endsWith("/requests") && options.method === "POST") {
      if (++submissions === 1) throw Object.assign(new Error("first local rejection"), { status: 429 });
      return pending.promise;
    }
  } });
  try {
    harness.chat.emit("update:draft", "first message"); await flush();
    harness.chat.emit("submit"); await flush();
    assert.match(nodeText(submissionFeedback(harness)), /first local rejection/);
    harness.chat.emit("update:draft", "second message"); await flush();
    harness.chat.emit("submit"); await flush();
    assert.match(nodeText(submissionFeedback(harness)), /正在提交/);
    assert.doesNotMatch(nodeText(submissionFeedback(harness)), /first local rejection|已接收/);
    assert.equal(submissionFeedback(harness).props["aria-busy"], true);
    const post = harness.calls.filter((call) => call.method === "POST").at(-1);
    pending.resolve({ request: { id: JSON.parse(post.body).clientRequestId, state: "accepted" } }); await flush();
    assert.equal(submissionFeedback(harness), undefined);
    assert.equal(elements(harness.root, (node) => node.type === "item-display" && node.text === "first message").length, 1);
  } finally { pending.resolve({ request: { id: "cleanup", state: "completed" } }); harness.close(); }
});

test("composer submission feedback ignores old and other-client failures and follows the current authoritative receipt", async () => {
  const result = deferred();
  let index = 0;
  const harness = await mountThreadView({ runtime: { maxPolls: 0, newId: () => `local-${++index}` }, request: (url, options) => {
    if (url.endsWith("/requests") && !options.method) return { requests: [{ id: "old", localOnly: true, state: "rejected", error: { message: "old failure" } }] };
    if (url.endsWith("/requests") && options.method === "POST") return result.promise;
  } });
  try {
    assert.equal(submissionFeedback(harness), undefined);
    harness.store.upsertRequest({ id: "other-client", state: "rejected", error: { message: "remote failure" } }); await flush();
    assert.equal(submissionFeedback(harness), undefined);
    harness.chat.emit("update:draft", "current input"); await flush();
    harness.chat.emit("submit"); await flush();
    harness.store.upsertRequest({ id: "remote-during-submit", state: "rejected", error: { message: "remote during submit" } });
    result.resolve({ request: { id: "local-1", state: "failed", error: { message: "current failure" } } }); await flush();
    assert.match(nodeText(submissionFeedback(harness)), /current failure/);
    const currentFooter = () => elements(harness.root, (node) => node.props?.class === "codex-request" && nodeText(node).includes("current failure"))[0];
    assert.equal(currentFooter().props["aria-live"], "off", "the visible footer does not repeat the input area's same-receipt announcement");
    harness.store.upsertRequest({ id: "newer-remote", state: "rejected", error: { message: "newer remote failure" } }); await flush();
    assert.match(nodeText(submissionFeedback(harness)), /current failure/);
    harness.store.upsertRequest({ id: "blocking-remote", state: "unknown", error: { message: "awaiting remote confirmation" } }); await flush();
    assert.match(nodeText(submissionFeedback(harness)), /正在确认发送状态/);
    assert.doesNotMatch(nodeText(submissionFeedback(harness)), /current failure/);
    assert.equal(currentFooter().props["aria-live"], "polite", "a different receipt keeps its existing live status");
    harness.store.upsertRequest({ id: "blocking-remote", state: "completed", error: null }); await flush();
    assert.match(nodeText(submissionFeedback(harness)), /current failure/);
    for (const state of ["accepted", "running", "completed"]) {
      harness.store.state.requests["local-1"] = { ...harness.store.state.requests["local-1"], state, error: null };
      await flush();
      assert.equal(submissionFeedback(harness), undefined, `${state} retires feedback from the current store`);
    }
  } finally { result.resolve({ request: { id: "local-1", state: "completed" } }); harness.close(); }
});

test("composer settings stay local and do not delay manual submission on a server PATCH", async () => {
  const harness = await mountThreadView({ patch: () => assert.fail("selecting settings must not PATCH the thread") });
  try {
    harness.chat.emit("update:composer-options", { reasoningEffort: "low" }); await flush();
    assert.equal(harness.calls.some((call) => call.method === "POST"), false);
    harness.chat.emit("update:draft", "send with local settings"); await flush();
    harness.chat.emit("submit"); await flush();
    const posts = harness.calls.filter((call) => call.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal(JSON.parse(posts[0].body).options.reasoningEffort, "low");
    assert.equal(submissionFeedback(harness), undefined);
  } finally { harness.close(); }
});

test("composer submission feedback keeps one busy key when an in-flight unknown check becomes a missing receipt", async () => {
  const checking = deferred();
  let checks = 0;
  const harness = await mountThreadView({ runtime: { maxPolls: 0 }, request: (url, options) => {
    if (url.endsWith("/requests") && !options.method) return { requests: [{ id: "changing", state: "unknown", error: { message: "not yet known" } }] };
    if (url.endsWith("/requests/changing")) {
      if (++checks === 1) throw Object.assign(new Error("initially unavailable"), { status: 503 });
      return checking.promise;
    }
  } });
  try {
    feedbackButton(harness, "再次核对").props.onClick(); await flush();
    harness.store.upsertRequest({ ...harness.store.state.requests.changing, error: { code: "receipt_not_found" } }); await flush();
    const unlock = feedbackButton(harness, "核对并解除锁定");
    assert.equal(unlock.props.disabled, true);
    const footer = elements(harness.root, (node) => node.props?.class === "codex-request")[0];
    const footerUnlock = elements(footer, (node) => node.type === "button" && node.text === "核对并解除锁定")[0];
    assert.equal(footerUnlock.props.disabled, true);
    unlock.props.onClick(); footerUnlock.props.onClick(); await flush();
    assert.equal(checks, 2, "the initial check plus one manual read, with no concurrent dismiss read");
    checking.reject(Object.assign(new Error("still missing"), { status: 404 })); await flush();
    assert.notEqual(feedbackButton(harness, "核对并解除锁定").props.disabled, true);
    assert.equal(harness.store.state.requests.changing.confirmationDismissed, false);
    assert.equal(harness.calls.some((call) => call.method === "POST"), false);
  } finally { checking.resolve({ request: { id: "changing", state: "completed" } }); harness.close(); }
});

test("composer submission feedback handles multiple unknown receipts in stable order with shared footer busy state", async () => {
  const check = deferred();
  let firstReads = 0;
  const receipts = ["first-unknown", "second-unknown"].map((id) => ({ id, state: "unknown", input: { text: id }, error: { code: "receipt_not_found" } }));
  const harness = await mountThreadView({ runtime: { maxPolls: 0 }, request: (url, options) => {
    if (url.endsWith("/requests") && !options.method) return { requests: receipts };
    if (url.endsWith("/requests/first-unknown")) {
      if (++firstReads === 1) throw Object.assign(new Error("initially missing"), { status: 404 });
      return check.promise;
    }
    if (url.endsWith("/requests/second-unknown")) throw Object.assign(new Error("still missing"), { status: 404 });
  } });
  try {
    harness.chat.emit("update:draft", "new draft"); await flush();
    assert.ok(submissionFeedback(harness));
    assert.doesNotMatch(nodeText(submissionFeedback(harness)), /发送失败|请求被拒绝|first-unknown/);
    assert.equal(harness.chat.props.canSend, false);
    const initialFirstReads = harness.calls.filter((call) => call.url.endsWith("/requests/first-unknown")).length;
    const initialSecondReads = harness.calls.filter((call) => call.url.endsWith("/requests/second-unknown")).length;
    const footer = elements(harness.root, (node) => node.props?.class === "codex-request" && nodeText(node).includes("核对并解除锁定"))[0];
    const footerButton = elements(footer, (node) => node.type === "button")[0];
    feedbackButton(harness, "核对并解除锁定").props.onClick(); footerButton.props.onClick(); await flush();
    assert.equal(feedbackButton(harness, "核对并解除锁定").props.disabled, true);
    assert.equal(footerButton.props.disabled, true);
    assert.equal(harness.calls.filter((call) => call.url.endsWith("/requests/first-unknown")).length, initialFirstReads + 1);
    check.reject(Object.assign(new Error("still missing"), { status: 404 })); await flush();
    assert.equal(harness.chat.props.canSend, false, "one dismissal cannot unlock another unknown receipt");
    feedbackButton(harness, "核对并解除锁定").props.onClick(); await flush();
    assert.equal(harness.calls.filter((call) => call.url.endsWith("/requests/second-unknown")).length, initialSecondReads + 1);
    assert.equal(harness.chat.props.canSend, true);
    assert.equal(harness.chat.props.draft, "new draft");
    assert.equal(harness.calls.some((call) => call.method === "POST"), false);
  } finally { check.resolve({ request: { id: "first-unknown", state: "completed" } }); harness.close(); }
});

test("composer submission feedback checks a nonmissing unknown without unlocking and clears on authoritative acceptance", async () => {
  let answer = null;
  const harness = await mountThreadView({ runtime: { maxPolls: 0 }, request: (url, options) => {
    if (url.endsWith("/requests") && !options.method) return { requests: [{ id: "uncertain", state: "unknown", confirmationDismissed: true,
      error: { code: "connection_lost", message: "connection unavailable" } }] };
    if (url.endsWith("/requests/uncertain")) {
      if (answer) return { request: answer };
      throw Object.assign(new Error("read unavailable"), { status: 503 });
    }
  } });
  try {
    harness.chat.emit("update:draft", "preserved input"); await flush();
    assert.ok(feedbackButton(harness, "再次核对"));
    assert.equal(feedbackButton(harness, "核对并解除锁定"), undefined);
    feedbackButton(harness, "再次核对").props.onClick(); await flush();
    assert.equal(harness.chat.props.canSend, false);
    assert.match(nodeText(submissionFeedback(harness)), /正在确认发送状态/);
    answer = { id: "uncertain", state: "accepted" };
    feedbackButton(harness, "再次核对").props.onClick(); await flush();
    assert.equal(submissionFeedback(harness), undefined);
    assert.equal(harness.chat.props.canSend, true);
    assert.equal(harness.chat.props.draft, "preserved input");
    assert.equal(harness.calls.some((call) => call.method === "POST"), false);
  } finally { harness.close(); }
});

test("composer submission feedback restores local text and images while protecting a new draft", async () => {
  const harness = await mountThreadView({ runtime: { maxPolls: 0, newId: () => "local-image" }, request: (url, options) => {
    if (url === "/api/attachments/images") return { attachment: { id: "original-image", url: "/image.png" } };
    if (url.endsWith("/requests") && options.method === "POST") throw Object.assign(new Error("local image rejected"), { status: 429 });
  } });
  try {
    harness.chat.emit("update:draft", "original text");
    harness.chat.emit("add-attachments", { files: [new File(["pixels"], "original.png", { type: "image/png" })], kindHint: "image" }); await flush();
    harness.chat.emit("submit"); await flush();
    assert.match(nodeText(submissionFeedback(harness)), /local image rejected/);
    assert.doesNotMatch(nodeText(submissionFeedback(harness)), /original text|original.png/);
    harness.chat.emit("update:draft", "new draft"); await flush();
    feedbackButton(harness, "恢复到输入框").props.onClick(); await flush();
    assert.equal(harness.chat.props.draft, "new draft");
    assert.match(harness.chat.props.statusText, /请先处理当前草稿/);
    assert.ok(feedbackButton(harness, "恢复到输入框"));
    harness.chat.emit("update:draft", ""); await flush();
    feedbackButton(harness, "恢复到输入框").props.onClick(); await flush();
    assert.equal(harness.chat.props.draft, "original text");
    assert.equal(harness.chat.props.composerOptions.attachments[0].uploadedId, "original-image");
    assert.equal(submissionFeedback(harness), undefined);
    assert.equal(harness.calls.filter((call) => call.method === "POST" && call.url.endsWith("/requests")).length, 1);
    assert.equal(elements(harness.root, (node) => node.type === "item-display" && node.text === "original text").length, 1);
    assert.ok(elements(harness.root, (node) => node.props?.class === "codex-request" && nodeText(node).includes("local image rejected")).length);
  } finally { harness.close(); }
});

test("composer submission feedback preserves uncertainty after local manual unlock until the next submission", async () => {
  const second = deferred();
  let posts = 0;
  const harness = await mountThreadView({ runtime: { maxPolls: 0, newId: () => `local-${posts + 1}` }, request: (url, options) => {
    if (url.endsWith("/requests") && options.method === "POST") {
      if (++posts === 1) throw Object.assign(new Error("gateway unavailable"), { status: 503 });
      return second.promise;
    }
    if (url.endsWith("/requests/local-1")) throw Object.assign(new Error("missing"), { status: 404 });
  } });
  try {
    harness.chat.emit("update:draft", "uncertain message"); await flush();
    harness.chat.emit("submit"); await flush();
    feedbackButton(harness, "核对并解除锁定").props.onClick(); await flush();
    assert.match(nodeText(submissionFeedback(harness)), /仍未确认|状态仍/);
    assert.doesNotMatch(nodeText(submissionFeedback(harness)), /未执行|发送失败/);
    harness.chat.emit("update:draft", "different draft"); await flush();
    assert.equal(harness.chat.props.canSend, true);
    assert.ok(submissionFeedback(harness));
    harness.chat.emit("submit"); await flush();
    assert.match(nodeText(submissionFeedback(harness)), /正在提交/);
    assert.doesNotMatch(nodeText(submissionFeedback(harness)), /解除|仍未确认/);
    second.resolve({ request: { id: "local-2", state: "completed" } }); await flush();
    assert.equal(submissionFeedback(harness), undefined);
    assert.equal(posts, 2);
  } finally { second.resolve({ request: { id: "local-2", state: "completed" } }); harness.close(); }
});

test("composer submission feedback rejects late ownership from a disposed thread context", async () => {
  const old = deferred();
  const harness = await mountThreadView({ runtime: { maxPolls: 0, newId: () => "same-id" }, request: (url, options) => {
    if (url.endsWith("/threads/thread/requests") && options.method === "POST") return old.promise;
    if (url.endsWith("/threads/thread-two/requests") && options.method === "POST") return { request: { id: "same-id", state: "rejected", error: { message: "new context failure" } } };
  } });
  try {
    harness.chat.emit("update:draft", "old send"); await flush();
    harness.chat.emit("submit"); await flush();
    assert.match(nodeText(submissionFeedback(harness)), /正在提交/);
    harness.switchThread("thread-two"); await flush();
    assert.equal(submissionFeedback(harness), undefined);
    harness.chat.emit("update:draft", "new send"); await flush();
    harness.chat.emit("submit"); await flush();
    assert.match(nodeText(submissionFeedback(harness)), /new context failure/);
    old.resolve({ request: { id: "same-id", state: "rejected", error: { message: "late old failure" } } }); await flush();
    assert.match(nodeText(submissionFeedback(harness)), /new context failure/);
    assert.doesNotMatch(nodeText(submissionFeedback(harness)), /late old failure/);
  } finally { old.resolve({ request: { id: "same-id", state: "completed" } }); harness.close(); }
});

test("mounted thread history and sending do not wait for config or repeat composer Git", async () => {
  const config = deferred();
  const harness = await mountThreadView({ loadConfig: () => config.promise, request: (url) => {
    if (url.includes("/turns?")) return { turns: [{ id: "past", status: "completed", items: [{ id: "answer", type: "agentMessage", text: "already visible" }] }] };
  } });
  try {
    assert.equal(harness.chat.props.threadSnapshot.turns[0].items[0].text, "already visible");
    harness.chat.emit("update:draft", "send while model catalog waits"); await flush();
    assert.equal(harness.chat.props.canSend, true);
    assert.equal(harness.chat.props.gitState.currentBranch, "main");
    assert.equal(harness.calls.filter((call) => call.composer === "read").length, 1);
    assert.equal(harness.calls.filter((call) => call.git === "read").length, 0);
    harness.chat.emit("submit"); await flush();
    assert.equal(harness.calls.filter((call) => call.url.endsWith("/requests") && call.method === "POST").length, 1);
  } finally { harness.close(); config.resolve({}); }
});

test("mounted composer still waits for its settings read and receipt list before sending", async () => {
  const settings = deferred(), receipts = deferred();
  const harness = await mountThreadView({ composerRead: () => settings.promise, request: (url, options) => {
    if (url.endsWith("/requests") && !options.method) return receipts.promise;
  } });
  try {
    harness.chat.emit("update:draft", "wait safely"); await flush();
    assert.equal(harness.chat.props.canSend, false);
    receipts.resolve({ requests: [] }); await flush();
    assert.equal(harness.chat.props.canSend, false);
    settings.resolve({ model: "confirmed", permissionMode: "auto-review", git: {} }); await flush();
    assert.equal(harness.chat.props.canSend, true);
    assert.equal(harness.chat.props.composerOptions.permissionMode, "auto-review");
  } finally { harness.close(); }
});

test("mounted composer cannot POST after its first receipt list fails and recovers after an explicit retry", async () => {
  let unavailable = true;
  const harness = await mountThreadView({ request: (url, options) => {
    if (url.endsWith("/requests") && !options.method && unavailable) throw Object.assign(new Error("receipt list unavailable"), { status: 503 });
  } });
  try {
    harness.chat.emit("update:draft", "must remain a draft"); await flush();
    assert.equal(harness.chat.props.loading, false);
    assert.equal(harness.chat.props.canSend, false);
    assert.match(harness.chat.props.statusText, /receipt list unavailable/);
    harness.chat.emit("submit"); await flush();
    assert.equal(harness.calls.some((call) => call.url.endsWith("/requests") && call.method === "POST"), false);
    unavailable = false;
    elements(harness.root, (node) => node.type === "button" && node.text === "重试连接")[0].props.onClick(); await flush();
    assert.equal(harness.chat.props.canSend, true);
    harness.chat.emit("submit"); await flush();
    assert.equal(harness.calls.filter((call) => call.url.endsWith("/requests") && call.method === "POST").length, 1);
  } finally { harness.close(); }
});

test("read recovery stays in composer controls while history exposes automatic pagination without a permanent button", async () => {
  let unavailable = true;
  const harness = await mountThreadView({ runtime: { maxPolls: 0 }, patch: () => assert.fail("read recovery must not save settings"), request: (url, options) => {
    if (url.endsWith("/requests") && !options.method && unavailable) throw new Error("receipt list unavailable");
    if (url.includes("/turns?")) return { turns: [], hasMore: true, olderCursor: "older" };
  } });
  try {
    harness.chat.emit("update:draft", "keep my current draft");
    const attachment = { id: "saved-image", uploadedId: "saved-image", kind: "image", status: "uploaded", name: "saved.png", url: "/saved.png" };
    harness.chat.emit("update:composer-options", { attachments: [attachment] }); await flush();
    const controls = elements(harness.root, (node) => node.type === "composer-top")[0];
    const history = elements(harness.root, (node) => node.type === "history-start")[0];
    const retry = elements(controls, (node) => node.type === "button" && node.text === "重试连接");
    assert.equal(retry.length, 1);
    assert.equal(elements(history, (node) => node.type === "button" && node.text === "重试连接").length, 0);
    assert.equal(elements(history, (node) => node.type === "button").length, 0);
    assert.equal(harness.chat.props.hasOlder, true);
    assert.equal(typeof harness.chat.props.onReachTop, "function");
    unavailable = false;
    retry[0].props.onClick(); await flush();
    assert.equal(harness.chat.props.statusText, "");
    assert.equal(harness.chat.props.canSend, true);
    assert.equal(harness.chat.props.draft, "keep my current draft");
    assert.equal(harness.chat.props.composerOptions.attachments[0].uploadedId, "saved-image");
    assert.equal(harness.calls.some((call) => call.method && call.method !== "GET"), false);
  } finally { harness.close(); }
});

test("read recovery disables repeated clicks until config history and settings reads settle", async () => {
  const catalog = deferred(), receipt = deferred(), settings = deferred();
  let configReads = 0, receiptReads = 0, settingsReads = 0;
  const harness = await mountThreadView({ runtime: { maxPolls: 0 },
    loadConfig: () => ++configReads === 1 ? {} : catalog.promise,
    composerRead: () => ++settingsReads === 1 ? { model: "model", git: {} } : settings.promise,
    request: (url, options) => {
      if (url.endsWith("/requests") && !options.method) {
        if (++receiptReads === 1) throw new Error("receipt list unavailable");
        return receipt.promise;
      }
    }
  });
  try {
    harness.chat.emit("update:draft", "preserved during retry"); await flush();
    const retry = elements(harness.root, (node) => node.type === "button" && node.text === "重试连接")[0];
    retry.props.onClick(); retry.props.onClick(); await flush();
    const busy = () => elements(harness.root, (node) => node.type === "button" && node.text === "正在重试…")[0];
    assert.ok(busy()); assert.equal(busy().props.disabled, true); assert.equal(busy().props["aria-busy"], true);
    assert.equal(configReads, 2); assert.equal(receiptReads, 2);
    receipt.resolve({ requests: [] }); await flush();
    assert.ok(busy(), "a pending catalog read keeps the action busy");
    assert.equal(settingsReads, 2, "settings recovery must not wait for the model catalog");
    settings.resolve({ model: "model", git: {} }); await flush();
    assert.ok(busy(), "settled settings cannot release the pending catalog retry");
    catalog.resolve({ providers: [] }); await flush();
    assert.equal(busy(), undefined);
    assert.equal(harness.chat.props.statusText, "");
    assert.equal(harness.chat.props.draft, "preserved during retry");
    assert.equal(harness.calls.some((call) => call.method && call.method !== "GET"), false);
  } finally { catalog.resolve({}); receipt.resolve({ requests: [] }); settings.resolve({}); harness.close(); }
});

test("ordinary restore and guide failures do not offer a connection retry", async () => {
  for (const action of ["restore", "guide"]) {
    let metadataFailed = false;
    const harness = await mountThreadView({ runtime: { maxPolls: 0 }, request: (url, options) => {
      if (url.endsWith("/threads/thread") && metadataFailed) throw new Error("metadata temporarily unavailable");
      if (url.includes("/turns?")) return { turns: [{ id: "active", status: "inProgress", items: [] }] };
      if (url.endsWith("/requests") && !options.method) return { requests: [
        { id: "owner", state: "running", turnId: "active" },
        { id: "recover", state: "rejected", input: { text: "original" } },
        { id: "waiting", state: "received", mode: "queue", input: { text: "queued original" } }
      ] };
      if (url.endsWith("/requests/waiting/steer")) throw new Error("guide temporarily unavailable");
      if (url.endsWith("/requests/waiting")) return { request: { id: "waiting", state: "received", mode: "queue", input: { text: "queued original" } } };
    } });
    try {
      harness.sockets[0].onopen();
      harness.chat.emit("update:draft", "do not replace me"); await flush();
      const button = elements(harness.root, (node) => node.type === "button" && (action === "restore"
        ? node.text === "恢复到输入框" : node.props?.["aria-label"] === "引导排队消息：queued original"))[0];
      button.props.onClick(); await flush();
      assert.match(harness.chat.props.statusText, action === "restore" ? /先处理当前草稿/ : /guide temporarily unavailable/);
      assert.equal(elements(harness.root, (node) => node.type === "button" && node.text === "重试连接").length, 0);
      assert.equal(harness.chat.props.draft, "do not replace me");
      const actionError = harness.chat.props.statusText;
      const posts = harness.calls.filter((call) => call.method === "POST").length;
      metadataFailed = true;
      await harness.runtime.refreshLatest(); await flush();
      const retry = elements(harness.root, (node) => node.type === "button" && node.text === "重试连接")[0];
      assert.ok(retry, "an independent history read failure still has its own recovery action");
      metadataFailed = false;
      retry.props.onClick(); await flush();
      assert.equal(harness.chat.props.statusText, actionError, "read recovery must not erase the action's error");
      assert.equal(elements(harness.root, (node) => node.type === "button" && node.text === "重试连接").length, 0);
      assert.equal(harness.calls.filter((call) => call.method === "POST").length, posts, "retry never replays the failed operation");
    } finally { harness.close(); }
  }
});

test("a late initial catalog success cannot clear the current retry catalog failure", async () => {
  const initial = deferred();
  let catalogReads = 0;
  const harness = await mountThreadView({ runtime: { maxPolls: 0 },
    loadConfig: () => ++catalogReads === 1 ? initial.promise : Promise.reject(new Error("current catalog offline")),
    request: (url, options) => {
      if (url.endsWith("/requests") && !options.method && catalogReads === 1) throw new Error("first receipt unavailable");
    }
  });
  try {
    harness.sockets[0].onopen();
    harness.chat.emit("update:draft", "keep current input"); await flush();
    elements(harness.root, (node) => node.type === "button" && node.text === "重试连接")[0].props.onClick(); await flush();
    assert.match(harness.chat.props.statusText, /current catalog offline/);
    initial.resolve({ providers: [{ id: "codex", models: ["stale-catalog-model"] }] }); await flush();
    assert.match(harness.chat.props.statusText, /current catalog offline/);
    assert.equal(harness.chat.props.models.some((model) => model.value === "stale-catalog-model"), false);
    assert.equal(harness.chat.props.draft, "keep current input");
    assert.equal(harness.calls.some((call) => call.method && call.method !== "GET"), false);
  } finally { initial.resolve({}); harness.close(); }
});

test("mounted stable receipt polls retain failed history feedback and retry until history recovers", async () => {
  let unavailable = true, turnsReads = 0;
  const harness = await mountThreadView({ runtime: { maxPolls: 0 }, request: (url, options) => {
    if (url.endsWith("/requests") && !options.method) return { requests: [{ id: "waiting", state: "queued",
      mode: "queue", executionRoute: "desktopQueue", input: { text: "later" } }] };
    if (url.includes("/turns?")) {
      turnsReads += 1;
      if (unavailable) throw Object.assign(new Error("history unavailable"), { status: 503 });
      return { turns: [{ id: "past", status: "completed", items: [{ id: "answer", type: "agentMessage", text: "history recovered" }] }] };
    }
  } });
  try {
    harness.sockets[0].onopen();
    harness.chat.emit("update:draft", "keep the draft"); await flush();
    const retries = () => elements(harness.root, (node) => node.type === "button" && node.text === "重试连接");
    assert.equal(retries().length, 1);
    await harness.runtime.pollRequests(); await harness.runtime.pollRequests(); await flush();
    assert.equal(turnsReads, 3, "a stable receipt list still retries failed history");
    assert.match(harness.chat.props.statusText, /history unavailable/);
    assert.equal(retries().length, 1);
    assert.equal(harness.chat.props.threadSnapshot.turns.some((turn) => turn.id === "past"), false);
    unavailable = false;
    retries()[0].props.onClick(); await flush();
    assert.equal(turnsReads, 4);
    assert.equal(harness.chat.props.statusText, "");
    assert.equal(retries().length, 0);
    assert.equal(harness.chat.props.threadSnapshot.turns.some((turn) => turn.id === "past"), true);
    assert.equal(harness.chat.props.draft, "keep the draft");
    assert.equal(harness.calls.some((call) => call.method === "POST"), false);
  } finally { harness.close(); }
});

test("mounted top reach loads once, shows status and exposes a manual retry after failure", async () => {
  let olderReads = 0;
  const harness = await mountThreadView({ runtime: { maxPolls: 0 }, request: (url) => {
    if (url.includes("cursor=older")) {
      if (++olderReads === 1) throw Object.assign(new Error("older UI failure"), { status: 503 });
      return { turns: [{ id: "older", status: "completed", items: [] }], hasMore: false };
    }
    if (url.includes("/turns?")) return { turns: [{ id: "latest", status: "completed", items: [] }], hasMore: true, olderCursor: "older" };
  } });
  try {
    harness.chat.emit("update:draft", "preserved compiled draft"); await flush();
    assert.equal(olderReads, 0, "opening with older pages available does not load them");
    await harness.chat.props.onReachTop(); await flush();
    assert.equal(harness.chat.props.statusText, "", "the top pagination error is not duplicated below the composer");
    assert.match(nodeText(elements(harness.root, (node) => node.type === "history-start")[0]), /older UI failure/);
    const retry = elements(harness.root, (node) => node.type === "button" && node.text?.trim() === "重试加载")[0];
    assert.ok(retry);
    retry.props.onClick(); await flush();
    assert.equal(harness.chat.props.threadSnapshot.turns.some((turn) => turn.id === "older"), true);
    assert.equal(harness.chat.props.statusText, "");
    assert.equal(harness.chat.props.draft, "preserved compiled draft");
    assert.equal(elements(harness.root, (node) => node.type === "button" && node.text === "重试连接").length, 0);
  } finally { harness.close(); }
});

test("mounted top reach keeps one older page pending and clears its status after prepend", async () => {
  const page = deferred();
  let olderReads = 0;
  const harness = await mountThreadView({ runtime: { maxPolls: 0 }, request: (url) => {
    if (url.includes("cursor=older")) { olderReads += 1; return page.promise; }
    if (url.includes("/turns?")) return { turns: [{ id: "latest", status: "completed", items: [] }], hasMore: true, olderCursor: "older" };
  } });
  let pending;
  try {
    pending = harness.chat.props.onReachTop(); await flush();
    assert.equal(harness.chat.props.loadingOlder, true);
    assert.match(nodeText(elements(harness.root, (node) => node.type === "history-start")[0]), /正在加载更早消息/);
    assert.equal(await harness.chat.props.onReachTop(), false);
    assert.equal(olderReads, 1);
    page.resolve({ turns: [{ id: "older", status: "completed", items: [] }], hasMore: false }); await pending; await flush();
    assert.equal(harness.chat.props.loadingOlder, false);
    assert.equal(harness.chat.props.hasOlder, false);
    assert.equal(harness.chat.props.threadSnapshot.turns[0].id, "older");
    assert.doesNotMatch(nodeText(elements(harness.root, (node) => node.type === "history-start")[0]), /正在加载更早消息|重试加载/);
  } finally { page.resolve({ turns: [], hasMore: false }); harness.close(); await pending; }
});

test("retrying top history clears its own error while preserving a newer unrelated action failure", async () => {
  let olderReads = 0;
  const harness = await mountThreadView({ runtime: { maxPolls: 0 }, request: (url) => {
    if (url.endsWith("/interrupt")) throw new Error("interrupt remains unavailable");
    if (url.includes("cursor=older")) {
      if (++olderReads === 1) throw new Error("older unavailable");
      return { turns: [], hasMore: false };
    }
    if (url.includes("/turns?")) return { turns: [], hasMore: true, olderCursor: "older" };
  } });
  try {
    await harness.chat.props.onReachTop(); await flush();
    assert.equal(harness.chat.props.statusText, "");
    await harness.runtime.interrupt(); await flush();
    assert.equal(harness.chat.props.statusText, "interrupt remains unavailable");
    elements(harness.root, (node) => node.type === "button" && node.text?.trim() === "重试加载")[0].props.onClick(); await flush();
    assert.equal(olderReads, 2);
    assert.equal(harness.chat.props.statusText, "interrupt remains unavailable");
    assert.doesNotMatch(nodeText(elements(harness.root, (node) => node.type === "history-start")[0]), /older unavailable|重试加载/);
  } finally { harness.close(); }
});

test("a newer action error with the same text as top history remains visible and keeps its owner", async () => {
  let olderReads = 0;
  const harness = await mountThreadView({ runtime: { maxPolls: 0 }, request: (url) => {
    if (url.endsWith("/interrupt")) throw new Error("Failed to fetch");
    if (url.includes("cursor=older")) {
      if (++olderReads === 1) throw new Error("Failed to fetch");
      return { turns: [], hasMore: false };
    }
    if (url.includes("/turns?")) return { turns: [], hasMore: true, olderCursor: "older" };
  } });
  try {
    await harness.chat.props.onReachTop(); await flush();
    assert.equal(harness.chat.props.statusText, "");
    await harness.runtime.interrupt(); await flush();
    assert.equal(harness.chat.props.statusText, "Failed to fetch");
    elements(harness.root, (node) => node.type === "button" && node.text?.trim() === "重试加载")[0].props.onClick(); await flush();
    assert.equal(harness.chat.props.statusText, "Failed to fetch");
    assert.equal(harness.store.state.errorOwner, "interrupt");
  } finally { harness.close(); }
});

test("mounted interrupt recovery clears its visible failure while preserving current input", async () => {
  let posts = 0;
  const harness = await mountThreadView({ runtime: { maxPolls: 0 }, request: (url, options) => {
    if (url.includes("/turns?")) return { turns: [{ id: "active", status: "inProgress", items: [] }] };
    if (url.endsWith("/requests") && !options.method) return { requests: [{ id: "owner", state: "running", turnId: "active" }] };
    if (url.endsWith("/interrupt")) {
      if (++posts === 1) throw Object.assign(new Error("interrupt UI failure"), { status: 503 });
      return {};
    }
  } });
  try {
    harness.chat.emit("update:draft", "keep this input"); await flush();
    harness.chat.emit("interrupt"); await flush();
    assert.equal(harness.chat.props.statusText, "interrupt UI failure");
    harness.chat.emit("interrupt"); await flush();
    assert.equal(posts, 2);
    assert.equal(harness.chat.props.statusText, "");
    assert.equal(harness.chat.props.draft, "keep this input");
    assert.equal(harness.chat.props.interrupting, false);
  } finally { harness.close(); }
});

test("mounted manual unknown unlock enables a working guide without replaying the missing send", async () => {
  let receiptReads = 0;
  const harness = await mountThreadView({ runtime: { maxPolls: 0, newId: () => "lost-user-send" }, request: (url, options) => {
    if (url.includes("/turns?")) return { turns: [{ id: "active", status: "inProgress", items: [] }] };
    if (url.endsWith("/requests") && !options.method) return { requests: [
      { id: "owner", mode: "queue", state: "running", turnId: "active", input: { text: "working" } },
      { id: "queued", mode: "queue", state: "received", input: { text: "guide me" } }
    ] };
    if (url.endsWith("/requests") && options.method === "POST") throw Object.assign(new Error("gateway unavailable"), { status: 503 });
    if (url.endsWith("/requests/lost-user-send")) { receiptReads += 1; throw Object.assign(new Error("missing receipt"), { status: 404 }); }
    if (url.endsWith("/requests/queued/steer")) return { request: { id: "queued", mode: "steer", state: "accepted", turnId: "active", input: { text: "guide me" } } };
  } });
  try {
    harness.sockets[0].onopen();
    harness.chat.emit("update:draft", "network lost send"); await flush();
    harness.chat.emit("submit"); await flush();
    const guide = () => elements(harness.root, (node) => node.props?.["aria-label"] === "引导排队消息：guide me")[0];
    assert.equal(guide().props.disabled, true);
    elements(harness.root, (node) => node.type === "button" && node.text === "核对并解除锁定")[0].props.onClick(); await flush();
    assert.equal(receiptReads, 2);
    assert.notEqual(guide().props.disabled, true);
    harness.chat.emit("update:draft", "keep another draft"); await flush();
    guide().props.onClick(); guide().props.onClick(); await flush();
    const promotions = harness.calls.filter((call) => call.url.endsWith("/requests/queued/steer") && call.method === "POST");
    assert.equal(promotions.length, 1);
    assert.deepEqual(JSON.parse(promotions[0].body), { expectedTurnId: "active" });
    assert.equal(harness.calls.filter((call) => call.url.endsWith("/requests") && call.method === "POST").length, 1);
    assert.equal(harness.chat.props.draft, "keep another draft");
    assert.equal(harness.chat.props.threadSnapshot.turns.some((turn) => turn.id === "request:queued"), false);
  } finally { harness.close(); }
});

test("receipt list readiness survives unrelated errors but cannot be replaced by clearing their message", async () => {
  let listFails = true, threadFails = false;
  const clock = runtimeClock();
  const { runtime, store } = fixture((url) => {
    if (url.endsWith("/requests") && listFails) throw new Error("missing receipts");
    if (url.endsWith("/threads/thread") && threadFails) throw new Error("thread metadata unavailable");
    return reads(url);
  }, { runtime: { setTimer: clock.setTimer, clearTimer: clock.clearTimer, maxPolls: Infinity } });
  try {
    await runtime.open();
    assert.equal(clock.pendingReads, 0, "an initial receipt failure does not start permanent idle polling");
    store.state.error = "";
    store.upsertThread({ id: "thread", name: "updated independently" });
    store.applyTurnsPage({ turns: [] });
    assert.equal(store.state.requestListReady, false);
    assert.equal(store.state.requestListError, "missing receipts");
    listFails = false; threadFails = true;
    await runtime.refreshLatest();
    assert.equal(store.state.requestListReady, true);
    assert.equal(store.state.requestListError, "");
    assert.equal(store.state.historyReadError, "thread metadata unavailable");
    assert.equal(store.state.error, "");
  } finally { runtime.dispose(); }
});

test("an invalid successful receipt response cannot unlock mounted sending", async () => {
  for (const payload of [{}, { requests: null }, { requests: {} }]) {
    const harness = await mountThreadView({ request: (url, options) => url.endsWith("/requests") && !options.method ? payload : undefined });
    try {
      harness.chat.emit("update:draft", "unverified"); await flush();
      assert.equal(harness.chat.props.canSend, false);
      assert.match(harness.chat.props.statusText, /回执列表格式无效/);
      harness.chat.emit("submit"); await flush();
      assert.equal(harness.calls.some((call) => call.url.endsWith("/requests") && call.method === "POST"), false);
    } finally { harness.close(); }
  }
});

test("a previous thread receipt response cannot unlock the next thread after its own list fails", async () => {
  const previous = deferred();
  const harness = await mountThreadView({ request: (url, options) => {
    if (!url.endsWith("/requests") || options.method) return undefined;
    if (url.includes("/thread-two/")) throw new Error("current receipt list unavailable");
    return previous.promise;
  } });
  try {
    harness.switchThread("thread-two"); await flush();
    harness.chat.emit("update:draft", "current draft"); await flush();
    assert.equal(harness.chat.props.canSend, false);
    previous.resolve({ requests: [] }); await flush();
    assert.equal(harness.chat.props.canSend, false);
    harness.chat.emit("submit"); await flush();
    assert.equal(harness.calls.some((call) => call.url.endsWith("/requests") && call.method === "POST"), false);
  } finally { harness.close(); previous.resolve({ requests: [] }); }
});

test("a metadata failure does not block mounted sending once receipt and settings reads succeeded", async () => {
  const harness = await mountThreadView({ request: (url) => {
    if (url.endsWith("/threads/thread")) throw new Error("metadata unavailable");
  } });
  try {
    harness.chat.emit("update:draft", "confirmed safe to send"); await flush();
    assert.match(harness.chat.props.statusText, /metadata unavailable/);
    assert.equal(harness.chat.props.canSend, true);
    harness.chat.emit("submit"); await flush();
    assert.equal(harness.calls.filter((call) => call.url.endsWith("/requests") && call.method === "POST").length, 1);
  } finally { harness.close(); }
});

test("mounted Git refresh uses the confirmed composer cwd when metadata is unavailable", async () => {
  const git = deferred();
  const harness = await mountThreadView({
    composerRead: async () => ({ model: "model", permissionMode: "default", git: { available: true, isGitRepo: true, cwd: "/confirmed-cwd", currentBranch: "main" } }),
    request: (url) => { if (url.endsWith("/threads/thread")) throw new Error("metadata unavailable"); },
    gitRead: () => git.promise
  });
  try {
    harness.chat.emit("refresh-git"); await flush();
    assert.deepEqual(harness.calls.filter((call) => call.git === "read").map((call) => call.args), [["/confirmed-cwd"]]);
    assert.equal(harness.chat.props.gitState.loading, true);
    harness.chat.emit("update:draft", "Git refresh does not lock input"); await flush();
    assert.equal(harness.chat.props.canSend, true);
    assert.equal(harness.chat.props.draft, "Git refresh does not lock input");
    git.resolve({ available: true, isGitRepo: true, cwd: "/confirmed-cwd", currentBranch: "confirmed" }); await flush();
    assert.equal(harness.chat.props.gitState.currentBranch, "confirmed");
    assert.equal(harness.chat.props.gitState.loading, false);
    assert.equal(harness.calls.some((call) => call.url.endsWith("/requests") && call.method === "POST"), false);
  } finally { harness.close(); git.resolve({}); }
});

test("mounted settings and sending proceed while background Git waits, then recover its failed read", async () => {
  const firstGit = deferred(), retryGit = deferred();
  const settings = { model: "model", reasoningEffort: "high", permissionMode: "default", cwd: "/confirmed-settings" };
  const patches = [];
  let gitReads = 0;
  const harness = await mountThreadView({
    composerRead: async () => settings,
    patch: async (provider, threadId, patch) => { patches.push({ provider, threadId, patch }); Object.assign(settings, patch); return { ...settings }; },
    request: (url) => { if (url.endsWith("/threads/thread")) throw new Error("metadata unavailable"); },
    gitRead: () => ++gitReads === 1 ? firstGit.promise : retryGit.promise
  });
  try {
    assert.deepEqual(harness.calls.filter((call) => call.git === "read").map((call) => call.args), [["/confirmed-settings"]]);
    assert.equal(harness.chat.props.gitState.loading, true);
    harness.chat.emit("update:draft", "send without waiting for Git"); await flush();
    assert.equal(harness.chat.props.canSend, true);
    harness.chat.emit("update:composer-options", { permissionMode: "auto-review" }); await flush();
    assert.equal(patches.length, 0);
    assert.equal(harness.chat.props.composerOptions.permissionMode, "auto-review");
    assert.equal(harness.chat.props.canSend, true);
    assert.equal(gitReads, 1, "saving settings shares the ongoing background read");
    harness.chat.emit("submit"); await flush();
    const posts = harness.calls.filter((call) => call.url.endsWith("/requests") && call.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal(JSON.parse(posts[0].body).options.permissionMode, "auto-review");
    firstGit.reject(new Error("Git timed out")); await flush();
    assert.equal(harness.chat.props.gitState.available, false);
    assert.equal(harness.chat.props.gitState.cwd, "/confirmed-settings");
    assert.match(harness.chat.props.gitState.error, /Git timed out/);
    assert.equal(harness.chat.props.composerOptions.permissionMode, "auto-review");
    harness.chat.emit("refresh-git"); await flush();
    assert.equal(gitReads, 2);
    assert.deepEqual(harness.calls.filter((call) => call.git === "read").map((call) => call.args), [["/confirmed-settings"], ["/confirmed-settings"]]);
    retryGit.resolve({ available: true, isGitRepo: true, cwd: "/confirmed-settings", currentBranch: "recovered" }); await flush();
    assert.equal(harness.chat.props.gitState.available, true);
    assert.equal(harness.chat.props.gitState.currentBranch, "recovered");
    assert.equal(harness.chat.props.gitState.error, "");
    assert.equal(patches.length, 0);
  } finally { harness.close(); firstGit.resolve({}); retryGit.resolve({}); }
});

test("a failed initial settings read never allows mounted submission", async () => {
  const harness = await mountThreadView({ composerRead: async () => { throw new Error("settings unavailable"); } });
  try {
    harness.chat.emit("update:draft", "retain this"); await flush();
    assert.equal(harness.chat.props.canSend, false);
    harness.chat.emit("submit"); await flush();
    assert.equal(harness.calls.some((call) => call.url.endsWith("/requests") && call.method === "POST"), false);
    assert.equal(harness.chat.props.draft, "retain this");
  } finally { harness.close(); }
});

test("late config cannot replace confirmed options, local edits, or image attachments", async () => {
  const config = deferred();
  const harness = await mountThreadView({ loadConfig: () => config.promise,
    patch: (provider, id, patch) => ({ model: "model", reasoningEffort: "high", permissionMode: "default", ...patch, git: {} }),
    request: (url) => url === "/api/attachments/images" ? { attachment: { id: "image", url: "/image" } } : undefined });
  try {
    harness.chat.emit("update:composer-options", { permissionMode: "auto-review" }); await flush();
    harness.chat.emit("add-attachments", { files: [new File(["pixels"], "image.png", { type: "image/png" })], kindHint: "image" }); await flush();
    config.resolve({ codexDefaults: { model: "wrong", permissionMode: "full-access", reasoningEffort: "low" }, providers: [{ id: "codex", models: ["wrong"] }] });
    await flush();
    assert.equal(harness.chat.props.composerOptions.model, "model");
    assert.equal(harness.chat.props.composerOptions.permissionMode, "auto-review");
    assert.equal(harness.chat.props.composerOptions.reasoningEffort, "high");
    assert.equal(harness.chat.props.composerOptions.attachments[0].uploadedId, "image");
    assert.ok(harness.chat.props.models.some((model) => model.value === "model"));
  } finally { harness.close(); }
});

test("config failure retries through the existing connection action without blocking confirmed sending", async () => {
  let attempts = 0;
  const harness = await mountThreadView({ loadConfig: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("catalog offline");
    return { providers: [{ id: "codex", models: ["recovered"] }] };
  } });
  try {
    harness.chat.emit("update:draft", "usable"); await flush();
    assert.equal(harness.chat.props.canSend, true);
    assert.match(harness.chat.props.statusText, /catalog offline/);
    elements(harness.root, (node) => node.type === "button" && node.text === "重试连接")[0].props.onClick();
    await flush();
    assert.equal(attempts, 2);
    assert.equal(harness.chat.props.statusText, "");
    assert.ok(harness.chat.props.models.some((model) => model.value === "recovered"));
  } finally { harness.close(); }
});

test("a disposed thread config response cannot populate the newly selected thread", async () => {
  const first = deferred(), second = deferred();
  let count = 0;
  const harness = await mountThreadView({ loadConfig: () => (++count === 1 ? first : second).promise });
  try {
    harness.switchThread("thread-two"); await flush();
    second.resolve({ providers: [{ id: "codex", models: ["current"] }] }); await flush();
    first.resolve({ providers: [{ id: "codex", models: ["stale"] }] }); await flush();
    assert.ok(harness.chat.props.models.some((model) => model.value === "current"));
    assert.equal(harness.chat.props.models.some((model) => model.value === "stale"), false);
  } finally { harness.close(); }
});

async function mountEntryApp(api = {}) {
  const previousWindow = globalThis.window;
  const storage = new Map(api.savedToken ? [["codex-web-terminal.saved-token", api.savedToken]] : []);
  const listeners = new Map(), calls = [], views = [];
  const route = reactive({ name: api.routeName || "chat", params: { sessionId: api.routeId || "history:codex:thread" }, query: {}, fullPath: "/chat/thread" });
  const navigate = async (target) => {
    if (typeof target === "string") return;
    Object.assign(route, { params: {}, query: {}, ...target });
  };
  globalThis.window = { location: { protocol: "http:", host: "localhost" },
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: (name) => listeners.delete(name),
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout };
  globalThis.__entryAppTest = { route, router: { push: navigate, replace: navigate }, views,
    requestAuthSession: () => api.auth ? api.auth() : Promise.resolve({ authenticated: true }),
    request: async (url, options) => { calls.push({ url, options }); return api.request ? api.request(url, options) : {}; },
    requestSessionById: async (id) => api.session ? api.session(id) : null,
    requestHistoryMessages: async () => { calls.push({ url: "history-messages" }); return api.history ? api.history() : { session: { provider: "claude" }, messages: [], threadSnapshot: { turns: [] } }; },
    ...api.methods
  };
  const realApi = await import("../web/src/lib/api.js");
  const apiUrl = sourceUrl(Object.keys(realApi).map((name) => name === "AUTH_EXPIRED_EVENT"
    ? `export const AUTH_EXPIRED_EVENT = 'codex-auth-expired';`
    : `export const ${name} = (...args) => globalThis.__entryAppTest.${name}?.(...args);`).join("\n"));
  const routerUrl = sourceUrl("export const useRoute = () => globalThis.__entryAppTest.route; export const useRouter = () => globalThis.__entryAppTest.router;");
  const asyncUrl = sourceUrl(`import { h } from ${JSON.stringify(import.meta.resolve("vue"))};
    export function defineAppView(loader) { const name = loader.toString().match(/components\\/(\\w+)/)[1];
      return { preload: () => Promise.resolve(true), props: ['threadId', 'loadConfig', 'groups', 'loaded', 'complete', 'counts', 'loading', 'loadError', 'searchQuery'], setup(props, { emit }) { globalThis.__entryAppTest.views.push({name, props, emit}); return () => h(name); } }; }`);
  const previewUrl = sourceUrl("export const previewState = { open: false }; export const closeLocalPreview = () => {}; export const invalidateLocalPreviewPosition = () => {};");
  const panelUrl = sourceUrl("export default { render() { return null; } };");
  const file = new URL("../web/src/App.vue", import.meta.url);
  const { descriptor } = parse(fs.readFileSync(file, "utf8"), { filename: file.pathname });
  const compiled = compileScript(descriptor, { id: "entry-app-test", inlineTemplate: true }).content;
  const overrides = { "./lib/api.js": apiUrl, "vue-router": routerUrl, "./lib/async-view.js": asyncUrl,
    "./lib/preview.js": previewUrl, "./components/preview/PreviewHost.vue": panelUrl,
    ...(api.runtimeModule ? { "./lib/session-runtime.js": api.runtimeModule } : {}) };
  const source = compiled.replace(/from\s+["']([^"']+)["']/g, (_, name) => `from ${JSON.stringify(overrides[name] || (name === "vue" ? import.meta.resolve("vue") : new URL(name, file).href))}`);
  const Component = (await import(sourceUrl(source))).default;
  const renderer = testRenderer(), root = { children: [] };
  renderer.render(h(Component), root); await flush();
  return { calls, views, route, storage, state: window.__codexWebDebug.state,
    expire: () => listeners.get("codex-auth-expired")(),
    close() { renderer.render(null, root); globalThis.window = previousWindow; delete globalThis.__entryAppTest; } };
}

test("legacy mounted App passes partial completeness and totals, cancels the cold read on leave and retains rows on return", async () => {
  const pending = deferred(), retry = deferred();
  const requests = [];
  const runtimeModule = sourceUrl(`import { createSessionRuntimeController as create } from ${JSON.stringify(new URL("../web/src/lib/session-runtime.js", import.meta.url).href)};
    export const createSessionRuntimeController = (options) => create({ ...options, pagedCatalog: false });`);
  const harness = await mountEntryApp({ runtimeModule, routeName: "sessions", request: (url, options) => {
    if (!url.startsWith("/api/sessions?")) return {};
    requests.push({ url, options }); return requests.length === 1 ? pending.promise : retry.promise;
  } });
  try {
    const counts = { sessionsTotal: 40, activitiesTotal: 40, runningTotal: 3, groups: [{ key: "project", total: 40, running: 3 }] };
    requests[0].options.onSidebarBootstrap({ counts, payload: { sidebarFormat: "compact-v1", sessions: [{ id: "first", name: "First" }],
      projectGroups: [{ id: "project", name: "Project", sessionIds: ["first"] }] } }); await flush();
    const list = harness.views.find((view) => view.name === "SessionListView");
    assert.equal(list.props.loaded, true); assert.equal(list.props.complete, false); assert.deepEqual(list.props.counts, counts);
    assert.equal(list.props.groups[0].sessions[0].id, "first");
    harness.route.name = "chat"; await flush();
    assert.equal(requests[0].options.signal.aborted, true); assert.equal(harness.state.sessionListLoading, false);
    assert.equal(harness.state.sessionListError, null);
    harness.route.name = "sessions"; await flush();
    assert.equal(requests.length, 2); assert.equal(harness.state.sessions[0].id, "first");
    pending.resolve({ sessions: [{ id: "late" }] }); await flush();
    assert.equal(harness.state.sessions[0].id, "first"); assert.equal(harness.state.sessionListLoading, true);
    retry.resolve({ sessions: [{ id: "full" }], projectGroups: [] }); await flush();
    assert.equal(harness.state.sessionListComplete, true); assert.equal(harness.state.sessionListCounts, null);
  } finally { pending.resolve({ sessions: [] }); retry.resolve({ sessions: [] }); harness.close(); await flush(); }
});

function pagedCatalogPayload(url, sessions = []) {
  const params = new URL(url, "http://fixture.test").searchParams;
  return { catalogFormat: "paged-v1", revision: "mounted-catalog", view: params.get("view") || "groups", query: params.get("q") || "", sessions,
    projectGroups: sessions.length ? [{ id: "project", name: "Project", sessions, catalogPage: { total: sessions.length, running: 0, nextCursor: null } }] : [],
    catalogPage: { total: sessions.length, runningTotal: 0, sessionsTotal: sessions.length, activitiesTotal: sessions.length, nextCursor: null } };
}

test("mounted App passes catalog loading and retry feedback without duplicating the error as a general notice", async () => {
  const first = deferred();
  let reads = 0;
  const harness = await mountEntryApp({ routeName: "sessions", request: (url) => {
    if (url.startsWith("/api/session-catalog?")) return ++reads === 1 ? first.promise : pagedCatalogPayload(url);
    return {};
  } });
  try {
    const list = harness.views.find((view) => view.name === "SessionListView");
    assert.equal(list.props.loaded, false);
    assert.equal(list.props.loading, true);
    first.reject(new Error("catalog offline")); await flush();
    assert.equal(list.props.loading, false);
    assert.equal(list.props.loadError, "catalog offline");
    assert.equal(harness.state.statusText, "");
    list.emit("retry"); await flush();
    assert.equal(list.props.loaded, true);
    assert.equal(list.props.loadError, "");
    list.emit("update:searchQuery", "retained query"); await flush();
    assert.equal(harness.state.sessionSearch, "retained query");
    harness.expire(); await flush();
    assert.equal(harness.state.sessionSearch, "");
  } finally { harness.close(); }
});

test("mounted App exposes a degraded sidebar as recoverable feedback until a successful retry", async () => {
  let reads = 0;
  const harness = await mountEntryApp({ routeName: "sessions", request: (url) => {
    if (url.startsWith("/api/session-catalog?")) return ++reads === 1
      ? { ...pagedCatalogPayload(url), sidebarStatus: { degraded: true, warnings: ["database locked"] } }
      : pagedCatalogPayload(url, [{ id: "recovered", name: "Available" }]);
    return {};
  } });
  try {
    const list = harness.views.find((view) => view.name === "SessionListView");
    assert.equal(list.props.loaded, false);
    assert.equal(list.props.loading, false);
    assert.match(list.props.loadError, /暂时无法读取/);
    assert.equal(harness.state.statusText, "");
    list.emit("retry"); await flush();
    assert.equal(list.props.loaded, true);
    assert.equal(list.props.loadError, "");
    assert.equal(harness.state.sessions[0].id, "recovered");
  } finally { harness.close(); }
});

test("mounted App returns to the list with one error owner and no stale failure after retry", async () => {
  const read = deferred();
  let reads = 0;
  const harness = await mountEntryApp({ request: (url) => {
    if (url.startsWith("/api/session-catalog?")) return ++reads === 1 ? read.promise : pagedCatalogPayload(url);
    return {};
  } });
  try {
    harness.route.name = "sessions"; await flush();
    read.reject(new Error("return list offline")); await flush();
    const list = harness.views.findLast((view) => view.name === "SessionListView");
    assert.equal(list.props.loadError, "return list offline");
    assert.equal(harness.state.statusText, "");
    list.emit("retry"); await flush();
    assert.equal(list.props.loaded, true);
    assert.equal(list.props.loadError, "");
    assert.equal(harness.state.statusText, "");
  } finally { harness.close(); }
});

test("mounted App ignores a prior list failure after identity expiry and successful login", async () => {
  const old = deferred();
  let reads = 0;
  const harness = await mountEntryApp({ request: (url) => {
    if (url.startsWith("/api/session-catalog?")) return ++reads === 1 ? old.promise : pagedCatalogPayload(url);
    return {};
  } });
  try {
    harness.route.name = "sessions"; await flush();
    harness.expire(); await flush();
    harness.state.accessToken = "new-test-token";
    harness.views.findLast((view) => view.name === "LoginView").emit("submit"); await flush();
    assert.equal(harness.state.isAuthenticated, true);
    harness.route.name = "sessions"; await flush();
    assert.equal(harness.state.sessionListReady, true);
    old.reject(new Error("previous identity list offline")); await flush();
    assert.equal(harness.state.sessionListError, null);
    assert.equal(harness.state.statusText, "");
  } finally { harness.close(); }
});

test("mounted App exposes auth read timeouts in login without auto-login or discarding saved credentials", async () => {
  for (const savedToken of ["", "saved-timeout-token"]) {
    const harness = await mountEntryApp({ savedToken, auth: async () => {
      throw Object.assign(new Error("读取超时，请重试。"), { code: "READ_TIMEOUT" });
    } });
    try {
      assert.equal(harness.state.ready, true);
      assert.equal(harness.state.isAuthenticated, false);
      assert.equal(harness.state.loading, false);
      assert.equal(harness.state.statusText, "读取超时，请重试。");
      assert.equal(harness.state.accessToken, savedToken);
      assert.equal(harness.state.rememberToken, Boolean(savedToken));
      assert.ok(harness.views.some((view) => view.name === "LoginView"));
      assert.equal(harness.calls.length, 0, "a timed-out auth check must not initiate automatic login or workspace reads");
      assert.equal(harness.storage.get("codex-web-terminal.saved-token"), savedToken || undefined);
    } finally { harness.close(); }
  }
});

test("mounted App authenticates and mounts Codex before model config, and config failure preserves the token", async () => {
  const config = deferred();
  const harness = await mountEntryApp({ savedToken: "valid", auth: async () => { throw new Error("transient"); },
    request: (url) => url === "/api/config" ? config.promise : {} });
  try {
    assert.equal(harness.state.ready, true);
    assert.equal(harness.state.isAuthenticated, true);
    assert.ok(harness.views.some((view) => view.name === "CodexThreadView"));
    assert.equal(harness.calls.filter((call) => call.url === "/api/config").length, 1);
    config.reject(new Error("catalog offline")); await flush();
    assert.equal(harness.state.isAuthenticated, true);
    assert.equal(harness.storage.get("codex-web-terminal.saved-token"), "valid");
  } finally { harness.close(); }
});

test("mounted App cannot revive after auth expiry during its initial check or automatic login", async () => {
  for (const phase of ["auth", "auto-login"]) {
    const pending = deferred();
    const harness = await mountEntryApp({ savedToken: "old", auth: () => phase === "auth" ? pending.promise : Promise.reject(new Error("transient")),
      request: (url) => url === "/api/login" ? pending.promise : {} });
    try {
      harness.expire(); await flush();
      pending.resolve(phase === "auth" ? { authenticated: true } : {}); await flush();
      assert.equal(harness.state.isAuthenticated, false);
      assert.equal(harness.state.ready, true);
      assert.equal(harness.route.name, "login");
      assert.equal(harness.calls.some((call) => call.url === "/api/config"), false);
    } finally { harness.close(); }
  }
});

test("mounted App rejects invalid automatic credentials without restoring the token", async () => {
  const harness = await mountEntryApp({ savedToken: "invalid", auth: async () => { throw new Error("unauthorized"); },
    request: async (url) => { if (url === "/api/login") throw Object.assign(new Error("unauthorized"), { status: 401 }); return {}; } });
  try {
    assert.equal(harness.state.ready, true);
    assert.equal(harness.state.isAuthenticated, false);
    assert.equal(harness.state.accessToken, "");
    assert.equal(harness.state.rememberToken, false);
    assert.equal(harness.storage.has("codex-web-terminal.saved-token"), false);
  } finally { harness.close(); }
});

test("mounted App retains saved credentials when automatic login has a transient network or service failure", async () => {
  for (const status of [undefined, 429, 503]) {
    const harness = await mountEntryApp({ savedToken: "valid", auth: async () => { throw new Error("auth connection interrupted"); },
      request: async (url) => { if (url === "/api/login") throw Object.assign(new Error("temporary login failure"), { status }); return {}; } });
    try {
      assert.equal(harness.state.isAuthenticated, false);
      assert.equal(harness.state.accessToken, "valid");
      assert.equal(harness.state.rememberToken, true);
      assert.equal(harness.storage.get("codex-web-terminal.saved-token"), "valid");
      assert.equal(harness.state.statusText, "temporary login failure");
    } finally { harness.close(); }
  }
});

test("mounted App retains config readiness for the legacy CC history route", async () => {
  const config = deferred();
  const harness = await mountEntryApp({ routeId: "history:claude:cc-thread", request: (url) => url === "/api/config" ? config.promise : {} });
  try {
    assert.equal(harness.calls.some((call) => call.url === "history-messages"), false);
    config.resolve({ providers: [{ id: "claude", models: ["cc-model"] }] }); await flush();
    assert.ok(harness.calls.some((call) => call.url === "history-messages"));
    assert.ok(harness.views.some((view) => view.name === "ChatView"));
  } finally { harness.close(); }
});

for (const scenario of ["new-live-empty", "history-empty", "history-sonnet"]) {
  test(`mounted App keeps CC model ownership in serialized ${scenario} requests`, { timeout: 6000 }, async () => {
    const previousFetch = globalThis.fetch, previousSocket = globalThis.WebSocket;
    const sockets = new Set(), http = [], inputReceived = deferred();
    class Socket {
      static OPEN = 1;
      constructor() { this.readyState = 1; this.listeners = new Map(); sockets.add(markRaw(this)); }
      addEventListener(name, handler) { this.listeners.set(name, handler); }
      removeEventListener(name) { this.listeners.delete(name); }
      close() { this.readyState = 3; sockets.delete(this); const handler = this.listeners.get("close"); queueMicrotask(() => handler?.()); }
    }
    globalThis.WebSocket = Socket;
    const api = await import("../web/src/lib/api.js");
    const model = scenario === "history-sonnet" ? "sonnet" : "";
    const permissionMode = scenario === "history-sonnet" ? "auto-review" : "default";
    const isLive = scenario === "new-live-empty";
    const live = { id: "cc-live", provider: "cc", kind: "live", status: "running", name: "CC QA", cwd: "/cc-probe",
      model, reasoningEffort: "medium", permissionMode };
    globalThis.fetch = async (url, options = {}) => {
      const body = JSON.parse(options.body);
      http.push({ url, method: options.method, body });
      inputReceived.resolve();
      return new Response(JSON.stringify({ session: { ...live, id: isLive ? live.id : "cc-resumed" } }), { status: 200 });
    };
    let harness;
    try {
      harness = await mountEntryApp({ routeId: isLive ? live.id : "history:cc:cc-thread", session: () => live,
        history: () => ({ session: live, messages: [], threadSnapshot: { threadId: "cc-thread", turns: [] } }),
        methods: {
          requestThreadComposerState: async () => ({ provider: "cc", threadId: "cc-thread", model, reasoningEffort: "medium", permissionMode, cwd: live.cwd }),
          requestSessionInput: api.requestSessionInput, requestThreadInput: api.requestThreadInput,
          requestWorkspaceGit: async () => ({ isGitRepo: false, available: true, cwd: live.cwd })
        },
        request: (url, options) => {
          if (url === "/api/config") return { codexDefaults: { model: "gpt-r18-only", reasoningEffort: "high", permissionMode: "full-access" },
            providers: [{ id: "codex", models: ["gpt-r18-only"] }, { id: "cc", defaultModel: "", models: [] }] };
          if (url === "/api/sessions" && options?.method === "POST") return { session: { ...live, id: "cc-resumed", resumeSessionId: "cc-thread" } };
          return { sessions: [], projectGroups: [] };
        }
      });
      await flush();
      const debug = window.__codexWebDebug;
      assert.equal(debug.composerOptions.value.model, model);
      assert.equal(debug.composerOptions.value.permissionMode, permissionMode);
      const view = harness.views.findLast((item) => item.name === "ChatView");
      assert.ok(view);
      view.emit("update:draft", "r18 bounded QA"); await flush();
      view.emit("submit"); await inputReceived.promise; await flush();
      assert.deepEqual(http, [{ url: isLive ? "/api/sessions/cc-live/input" : "/api/threads/cc/cc-thread/input", method: "POST",
        body: { type: "input", data: "r18 bounded QA\n", model, reasoningEffort: "medium", permissionMode, attachments: [] } }]);
      const resume = harness.calls.find((call) => call.url === "/api/sessions" && call.options?.method === "POST");
      if (isLive) assert.equal(resume, undefined);
      else assert.deepEqual(JSON.parse(resume.options.body), { provider: "cc", cwd: live.cwd, name: "CC QA", resumeSessionId: "cc-thread",
        model, reasoningEffort: "medium", permissionMode });
    } finally {
      harness?.close(); await flush();
      for (const socket of [...sockets]) socket.close();
      await flush();
      globalThis.fetch = previousFetch;
      globalThis.WebSocket = previousSocket;
      assert.equal(sockets.size, 0);
    }
  });
}

test("mounted App creates a thread with server defaults while config is pending or stale", async () => {
  for (const configState of ["pending", "stale"]) {
    const config = deferred();
    const harness = await mountEntryApp({ routeName: "sessions", request: (url) => {
      if (url === "/api/config") return configState === "pending" ? config.promise
        : { codexDefaults: { model: "stale-model", reasoningEffort: "low", permissionMode: "full-access" } };
      if (url.startsWith("/api/sessions")) return { sessions: [], projectGroups: [] };
      if (url === "/api/v2/codex/threads") return { thread: { id: "new-thread" } };
      return {};
    } });
    try {
      harness.views.find((view) => view.name === "SessionListView").emit("create-group-session", { cwd: "/tmp", projectId: "project" });
      await flush();
      const created = harness.calls.find((call) => call.url === "/api/v2/codex/threads" && call.options.method === "POST");
      assert.deepEqual(JSON.parse(created.options.body), { cwd: "/tmp", projectId: "project" });
      assert.equal(harness.route.name, "chat");
      assert.equal(harness.route.params.sessionId, "history:codex:new-thread");
      assert.ok(harness.views.some((view) => view.name === "CodexThreadView" && view.props.threadId === "new-thread"));
    } finally { harness.close(); config.resolve({}); }
  }
});

test("mounted App upgrades a legacy session with its existing choices while workspace config is pending", async () => {
  const config = deferred();
  const harness = await mountEntryApp({ routeId: "old-live", session: () => ({ id: "old-live", provider: "codex", cwd: "/tmp", name: "Old live", projectId: "project",
    model: "selected-model", reasoningEffort: "low", permissionMode: "read-only" }), request: (url) => {
    if (url === "/api/config") return config.promise;
    if (url === "/api/v2/codex/threads") return { thread: { id: "replacement" } };
    return {};
  } });
  try {
    const created = harness.calls.find((call) => call.url === "/api/v2/codex/threads" && call.options.method === "POST");
    assert.deepEqual(JSON.parse(created.options.body), { cwd: "/tmp", name: "Old live", projectId: "project",
      model: "selected-model", reasoningEffort: "low", permissionMode: "read-only" });
    assert.equal(harness.route.params.sessionId, "history:codex:replacement");
  } finally { harness.close(); config.resolve({}); }
});

test("mounted V2 streaming passes the shared model and retains historical renderer inputs", async () => {
  const harness = await mountThreadView({ request: (url) => {
    if (url.includes("/turns?")) return { turns: (url.includes("cursor=older") ? ["past"] : ["live"]).map((id) => ({ id,
      status: id === "past" ? "completed" : "inProgress", items: [
        { id: `${id}-answer`, type: "agentMessage", text: id, status: id === "past" ? "completed" : "inProgress" }
      ] })), hasMore: !url.includes("cursor=older"), olderCursor: url.includes("cursor=older") ? null : "older" };
  } });
  try {
    assert.deepEqual(harness.chat.props.threadViewModel.turns.map((turn) => turn.id), ["live"]);
    assert.equal(await harness.runtime.loadOlder(), true); await flush();
    const first = harness.chat.props.threadViewModel;
    const pastItem = first.turns[0].segments[0].items[0];
    assert.equal(elements(harness.root, (node) => node.props?.["data-id"] === "past-answer")[0].props.item, pastItem);
    harness.sockets[0].onmessage({ data: JSON.stringify({ schemaVersion: 2, epoch: "", threadId: "thread", seq: 1,
      type: "item.delta", payload: { turnId: "live", itemId: "live-answer", field: "text", text: " delta" } }) });
    await flush();
    const next = harness.chat.props.threadViewModel;
    assert.ok(next.version > first.version);
    assert.equal(next.turns[0], first.turns[0]);
    assert.equal(elements(harness.root, (node) => node.props?.["data-id"] === "past-answer")[0].props.item, pastItem);
    assert.equal(elements(harness.root, (node) => node.props?.["data-id"] === "live-answer")[0].props.item,
      next.turns[1].segments[0].items[0]);
    assert.equal(elements(harness.root, (node) => node.props?.["data-id"] === "live-answer")[0].text, "live delta");
  } finally { harness.close(); }
});

test("mounted V2 composer rejects a failed local setting save without changing its selected value", async () => {
  const harness = await mountThreadView({ patch: () => assert.fail("no remote setting writes") });
  try {
    const previous = harness.chat.props.composerOptions.model;
    harness.storage.setItem = () => { throw new Error("local settings storage failed"); };
    harness.chat.emit("update:composer-options", { model: "new-model" }); await flush();
    assert.equal(harness.chat.props.composerOptions.model, previous);
    assert.match(harness.chat.props.statusText, /local settings storage failed/);
    assert.equal(harness.calls.some((call) => call.method === "POST"), false);
  } finally { harness.close(); }
});

test("an unchanged desktop composer sends no per-turn setting overrides", async () => {
  const harness = await mountThreadView({ patch: () => ({ model: "model", reasoningEffort: "low", permissionMode: "default", git: {} }), request: (url) => {
    if (url.endsWith("/threads/thread")) return { thread: { id: "thread", originator: "Codex Desktop", name: "Desk" } };
  } });
  try {
    harness.chat.emit("update:draft", "continue on desktop");
    await flush();
    harness.chat.emit("submit");
    await flush();
    const post = harness.calls.find((call) => call.url.endsWith("/requests") && call.method === "POST");
    assert.deepEqual(JSON.parse(post.body).options, {});
    assert.equal(elements(harness.root, (node) => node.text?.includes("桌面会话当前的模型和权限设置")).length, 0);
    harness.chat.emit("update:composer-options", { reasoningEffort: "low" });
    await flush();
    assert.equal(harness.chat.props.composerOptions.reasoningEffort, "low");
    assert.equal(elements(harness.root, (node) => node.text?.includes("请恢复原设置后发送")).length, 0);
  } finally { harness.close(); }
});

test("retrying the first settings read establishes a desktop baseline without clearing later overrides", async () => {
  let reads = 0;
  const settings = { model: "model", reasoningEffort: "high", permissionMode: "default", git: {} };
  const harness = await mountThreadView({
    composerRead: async () => {
      if (++reads === 1) throw new Error("initial settings offline");
      if (reads === 3) throw new Error("later settings offline");
      return { ...settings };
    },
    patch: async (provider, threadId, patch) => Object.assign(settings, patch),
    request: (url) => {
      if (url.endsWith("/threads/thread")) return { thread: { id: "thread", originator: "Codex Desktop" } };
    }
  });
  const retryConnection = elements(harness.root, (node) => node.type === "button" && node.text === "重试连接")[0].props.onClick;
  const retry = async () => {
    retryConnection();
    await flush();
  };
  try {
    harness.chat.emit("update:draft", "continue with original settings"); await flush();
    assert.equal(harness.chat.props.canSend, false);
    await retry();
    assert.equal(harness.chat.props.canSend, true);
    harness.chat.emit("submit"); await flush();
    const posts = () => harness.calls.filter((call) => call.url.endsWith("/requests") && call.method === "POST");
    assert.deepEqual(JSON.parse(posts()[0].body).options, {});
    assert.equal(harness.chat.props.statusText, "");

    harness.chat.emit("update:composer-options", { reasoningEffort: "low" }); await flush();
    assert.equal(elements(harness.root, (node) => node.text?.includes("请恢复原设置后发送")).length, 0);
    harness.chat.emit("update:draft", "retain my chosen setting"); await flush();
    await retry();
    assert.equal(reads, 3);
    assert.equal(harness.chat.props.canSend, false);
    assert.match(harness.chat.props.statusText, /会话设置读取失败/);
    await retry();
    assert.equal(reads, 4);
    assert.equal(harness.chat.props.canSend, true);
    harness.chat.emit("submit"); await flush();
    assert.deepEqual(JSON.parse(posts()[1].body).options, { model: "model", permissionMode: "default", reasoningEffort: "low" });
  } finally { harness.close(); }
});

for (const [field, original, selected] of [["permissionMode", "full-access", "default"], ["reasoningEffort", "high", "low"]]) {
  test(`the first retry snapshot preserves an explicit ${field} change made while it was loading`, async () => {
    const retryRead = deferred();
    let reads = 0;
    const settings = { model: "model", reasoningEffort: "high", permissionMode: "full-access", git: {}, [field]: original };
    const harness = await mountThreadView({
      composerRead: () => {
        if (++reads === 1) throw new Error("first settings offline");
        return retryRead.promise;
      },
      patch: async (provider, threadId, patch) => ({ ...settings, ...patch }),
      request: (url) => url.endsWith("/threads/thread") ? { thread: { id: "thread", originator: "Codex Desktop" } } : undefined
    });
    try {
      harness.chat.emit("update:draft", "retain explicit settings"); await flush();
      elements(harness.root, (node) => node.type === "button" && node.text === "重试连接")[0].props.onClick(); await flush();
      assert.equal(reads, 2);
      harness.chat.emit("update:composer-options", { [field]: selected }); await flush();
      assert.equal(harness.chat.props.canSend, false);
      harness.chat.emit("submit"); await flush();
      assert.equal(harness.calls.some((call) => call.method === "POST"), false);
      retryRead.resolve({ ...settings }); await flush();
      assert.equal(harness.chat.props.composerOptions[field], selected);
      assert.equal(harness.chat.props.canSend, true);
      const warnings = elements(harness.root, (node) => node.text?.includes("请恢复原设置后发送")).length;
      harness.chat.emit("submit"); await flush();
      const post = harness.calls.find((call) => call.url.endsWith("/requests") && call.method === "POST");
      assert.deepEqual(JSON.parse(post.body).options, { model: "model", reasoningEffort: "high", permissionMode: "full-access", [field]: selected });
      assert.equal(warnings, 0);
    } finally { retryRead.resolve(settings); harness.close(); }
  });
}

test("a stale initial settings success cannot clear a newer retry failure or unlock an empty baseline", async () => {
  const oldRead = deferred();
  let reads = 0;
  const settings = { model: "confirmed-model", reasoningEffort: "high", permissionMode: "full-access", git: {} };
  const harness = await mountThreadView({ loadConfig: async () => { throw new Error("catalog offline"); }, composerRead: () => {
    reads += 1;
    if (reads === 1) return oldRead.promise;
    if (reads === 2) throw new Error("newest settings offline");
    return settings;
  } });
  try {
    harness.chat.emit("update:draft", "wait for confirmed settings"); await flush();
    const retry = elements(harness.root, (node) => node.type === "button" && node.text === "重试连接")[0].props.onClick;
    retry(); await flush();
    assert.equal(reads, 2);
    assert.equal(harness.chat.props.canSend, false);
    const latestError = harness.chat.props.statusText;
    assert.match(latestError, /会话设置读取失败/);
    oldRead.resolve(settings); await flush();
    assert.equal(harness.chat.props.canSend, false);
    assert.equal(harness.chat.props.statusText, latestError);
    assert.equal(harness.chat.props.composerOptions.model, "");
    harness.chat.emit("submit"); await flush();
    assert.equal(harness.calls.some((call) => call.method === "POST"), false);
    retry(); await flush();
    assert.equal(reads, 3);
    assert.equal(harness.chat.props.composerOptions.model, "confirmed-model");
    assert.equal(harness.chat.props.canSend, true);
    harness.chat.emit("submit"); await flush();
    const post = harness.calls.find((call) => call.url.endsWith("/requests") && call.method === "POST");
    assert.deepEqual(JSON.parse(post.body).options, {});
  } finally { oldRead.resolve(settings); harness.close(); }
});

test("a late initial settings read cannot establish the newly selected thread baseline", async () => {
  const first = deferred();
  const harness = await mountThreadView({ composerRead: (provider, threadId) => threadId === "thread" ? first.promise
    : { model: "other-model", reasoningEffort: "low", permissionMode: "auto-review", git: {} } });
  try {
    assert.equal(harness.chat.props.loading, true);
    harness.switchThread("thread-two"); await flush();
    harness.chat.emit("update:draft", "new thread draft"); await flush();
    first.resolve({ model: "old-model", reasoningEffort: "high", permissionMode: "default", git: {} }); await flush();
    assert.equal(harness.chat.props.composerOptions.model, "other-model");
    assert.equal(harness.chat.props.composerOptions.permissionMode, "auto-review");
    assert.equal(harness.chat.props.draft, "new thread draft");
    harness.chat.emit("submit"); await flush();
    const post = harness.calls.find((call) => call.url.endsWith("/requests") && call.method === "POST");
    assert.match(post.url, /threads\/thread-two\/requests$/);
    assert.deepEqual(JSON.parse(post.body).options, {});
  } finally { first.resolve({}); harness.close(); }
});

test("a late settings retry cannot alter the newly selected thread or unlock its failed settings", async () => {
  const retryRead = deferred();
  let reads = 0;
  const harness = await mountThreadView({ composerRead: (provider, threadId) => {
    if (threadId === "thread-two") throw new Error("new thread settings offline");
    if (++reads === 1) throw new Error("first thread settings offline");
    return retryRead.promise;
  } });
  try {
    elements(harness.root, (node) => node.type === "button" && node.text === "重试连接")[0].props.onClick(); await flush();
    assert.equal(reads, 2);
    assert.equal(elements(harness.root, (node) => node.type === "button" && node.text === "正在重试…")[0].props.disabled, true);
    harness.switchThread("thread-two"); await flush();
    assert.equal(elements(harness.root, (node) => node.type === "button" && node.text === "正在重试…").length, 0);
    assert.notEqual(elements(harness.root, (node) => node.type === "button" && node.text === "重试连接")[0].props.disabled, true);
    harness.chat.emit("update:draft", "retain second thread draft"); await flush();
    retryRead.resolve({ model: "old-model", reasoningEffort: "high", permissionMode: "full-access", git: {} }); await flush();
    assert.equal(harness.chat.props.canSend, false);
    assert.equal(harness.chat.props.draft, "retain second thread draft");
    assert.notEqual(harness.chat.props.composerOptions.permissionMode, "full-access");
    assert.match(harness.chat.props.statusText, /会话设置读取失败/);
    harness.chat.emit("submit"); await flush();
    assert.equal(harness.calls.some((call) => call.method === "POST"), false);
  } finally { retryRead.resolve({}); harness.close(); }
});

test("a successful settings retry preserves newer local choices without writing to the desktop", async () => {
  const retryRead = deferred(); let reads = 0;
  const settings = { model: "model", reasoningEffort: "high", permissionMode: "default", git: {} };
  const harness = await mountThreadView({ loadConfig: async () => { throw new Error("catalog offline"); },
    composerRead: () => ++reads === 1 ? settings : retryRead.promise,
    patch: () => assert.fail("no remote setting writes") });
  try {
    elements(harness.root, (node) => node.type === "button" && node.text === "重试连接")[0].props.onClick(); await flush();
    harness.chat.emit("update:composer-options", { reasoningEffort: "low" }); await flush();
    retryRead.resolve(settings); await flush();
    assert.equal(harness.chat.props.composerOptions.reasoningEffort, "low");
    harness.chat.emit("update:draft", "keep this choice"); await flush();
    harness.chat.emit("submit"); await flush();
    const post = harness.calls.find((call) => call.method === "POST");
    assert.equal(JSON.parse(post.body).options.reasoningEffort, "low");
  } finally { retryRead.resolve(settings); harness.close(); }
});

test("mounted image preupload failure retains File and draft, retry sends uploaded ID and interrupt reaches v2", async () => {
  let uploadCount = 0;
  const harness = await mountThreadView({ request: (url) => {
    if (url === "/api/attachments/images") {
      uploadCount += 1;
      if (uploadCount === 1) return Promise.reject(new Error("image offline"));
      return { attachment: { id: "image-server", url: "/uploads/image.png" } };
    }
  } });
  try {
    const file = new File(["pixels"], "image.png", { type: "image/png" });
    harness.chat.emit("update:draft", "with image");
    harness.chat.emit("add-attachments", { files: [file], kindHint: "image" });
    await flush();
    const failed = harness.chat.props.composerOptions.attachments[0];
    assert.equal(failed.file, file);
    assert.equal(failed.status, "failed");
    assert.equal(harness.chat.props.draft, "with image");
    harness.chat.emit("retry-attachment", failed.id);
    await flush();
    assert.equal(harness.chat.props.composerOptions.attachments[0].uploadedId, "image-server");
    harness.chat.emit("submit");
    await flush();
    const post = harness.calls.find((call) => call.url.endsWith("/requests") && call.method === "POST");
    assert.deepEqual(JSON.parse(post.body).input.attachments, [{ id: "image-server" }]);
    assert.equal(harness.chat.props.draft, "");
    assert.equal(harness.chat.props.composerOptions.attachments.length, 0);
    harness.chat.emit("interrupt");
    await flush();
    assert.ok(harness.calls.some((call) => call.url === "/api/v2/codex/threads/thread/interrupt"));
  } finally { harness.close(); }
});

for (const text of ["", "with image"]) test(`mounted ${text ? "mixed" : "image-only"} submission waits for an existing preupload and sends only its uploaded ID`, async () => {
  const upload = deferred();
  const uploadedId = "00000000-0000-4000-8000-000000000001";
  const harness = await mountThreadView({ request: (url) => url === "/api/attachments/images" ? upload.promise : undefined });
  try {
    harness.chat.emit("update:draft", text);
    harness.chat.emit("add-attachments", { files: [new File(["pixels"], "photo.png", { type: "image/png" })], kindHint: "image" });
    await flush();
    assert.equal(harness.chat.props.composerOptions.attachments[0].status, "uploading");
    harness.chat.emit("submit"); await flush();
    assert.equal(harness.calls.some((call) => call.url.endsWith("/requests") && call.method === "POST"), false);
    upload.resolve({ attachment: { id: uploadedId, url: `/api/attachments/images/${uploadedId}` } });
    await flush();
    assert.equal(harness.calls.filter((call) => call.url === "/api/attachments/images").length, 1);
    const posts = harness.calls.filter((call) => call.url.endsWith("/requests") && call.method === "POST");
    assert.equal(posts.length, 1);
    assert.deepEqual(JSON.parse(posts[0].body).input, { text, attachments: [{ id: uploadedId }] });
    assert.equal(harness.chat.props.draft, "");
    assert.equal(harness.chat.props.composerOptions.attachments.length, 0);
  } finally { upload.resolve({ attachment: { id: uploadedId } }); harness.close(); }
});

test("a failed shared preupload preserves the pending submission draft and file until an explicit retry", async () => {
  const upload = deferred();
  let attempts = 0;
  const harness = await mountThreadView({ request: (url) => {
    if (url === "/api/attachments/images") return ++attempts === 1 ? upload.promise :
      { attachment: { id: "00000000-0000-4000-8000-000000000001" } };
  } });
  try {
    const file = new File(["pixels"], "photo.png", { type: "image/png" });
    harness.chat.emit("update:draft", "keep this text");
    harness.chat.emit("add-attachments", { files: [file], kindHint: "image" }); await flush();
    harness.chat.emit("submit"); await flush();
    upload.reject(new Error("upload unavailable")); await flush();
    assert.equal(harness.chat.props.draft, "keep this text");
    assert.equal(harness.chat.props.composerOptions.attachments[0].file, file);
    assert.equal(harness.chat.props.composerOptions.attachments[0].status, "failed");
    assert.equal(harness.calls.some((call) => call.url.endsWith("/requests") && call.method === "POST"), false);
    harness.chat.emit("submit"); await flush();
    const posts = harness.calls.filter((call) => call.url.endsWith("/requests") && call.method === "POST");
    assert.equal(attempts, 2);
    assert.equal(posts.length, 1);
    assert.deepEqual(JSON.parse(posts[0].body).input, { text: "keep this text", attachments: [{ id: "00000000-0000-4000-8000-000000000001" }] });
  } finally { upload.resolve({}); harness.close(); }
});

test("a submission waiting for shared preupload cannot send or replace a draft after thread navigation", async () => {
  const upload = deferred();
  const harness = await mountThreadView({ request: (url) => url === "/api/attachments/images" ? upload.promise : undefined });
  try {
    harness.chat.emit("update:draft", "original text");
    harness.chat.emit("add-attachments", { files: [new File(["pixels"], "photo.png", { type: "image/png" })], kindHint: "image" }); await flush();
    harness.chat.emit("submit"); await flush();
    harness.switchThread("thread-two"); await flush();
    harness.chat.emit("update:draft", "new thread text"); await flush();
    upload.resolve({ attachment: { id: "00000000-0000-4000-8000-000000000001" } }); await flush();
    assert.equal(harness.chat.props.draft, "new thread text");
    assert.equal(harness.chat.props.composerOptions.attachments.length, 0);
    assert.equal(harness.calls.some((call) => call.url.endsWith("/requests") && call.method === "POST"), false);
  } finally { upload.resolve({}); harness.close(); }
});

for (const outcome of ["success", "failure"]) {
  test(`a disposed image preupload ${outcome} cannot overwrite a newer draft after thread navigation`, async () => {
    const upload = deferred();
    const harness = await mountThreadView({ request: (url) => url === "/api/attachments/images" ? upload.promise : undefined });
    try {
      harness.chat.emit("update:draft", "original draft");
      harness.chat.emit("add-attachments", { files: [new File(["pixels"], "image.png", { type: "image/png" })], kindHint: "image" });
      await flush();
      harness.switchThread("thread-two"); await flush();
      harness.chat.emit("update:draft", "other thread draft"); await flush();
      harness.switchThread("thread"); await flush();
      harness.chat.emit("update:draft", "edited after return"); await flush();
      harness.switchThread("thread-two"); await flush();
      const savedDraft = () => JSON.parse(harness.storage.getItem("codex-chat-v2:thread")).draft;
      assert.equal(savedDraft().text, "edited after return");

      if (outcome === "success") upload.resolve({ attachment: { id: "late-image", url: "/image.png" } });
      else upload.reject(new Error("old upload failed"));
      await flush();
      assert.equal(savedDraft().text, "edited after return");
      assert.equal(harness.chat.props.draft, "other thread draft");
      assert.doesNotMatch(harness.chat.props.statusText, /old upload failed/);
      harness.switchThread("thread"); await flush();
      assert.equal(harness.chat.props.draft, "edited after return");
    } finally { upload.resolve({ attachment: { id: "cleanup" } }); harness.close(); }
  });
}

test("mounted thread switching keeps independent drafts and cannot mutate Git branches", async () => {
  const harness = await mountThreadView();
  try {
    harness.chat.emit("update:draft", "thread one");
    harness.switchThread("thread-two");
    await flush();
    assert.equal(harness.chat.props.draft, "");
    harness.chat.emit("update:draft", "thread two");
    harness.switchThread("thread");
    await flush();
    assert.equal(harness.chat.props.draft, "thread one");
    harness.chat.emit("switch-git-branch", "topic");
    await flush();
    harness.chat.emit("create-git-branch", "new-branch");
    await flush();
    assert.equal(harness.calls.some((call) => call.git === "checkout"), false);
    assert.equal(harness.calls.some((call) => call.git === "create"), false);
  } finally { harness.close(); }
});

test("failure recovery appears beside its message without opening a disclosure", async () => {
  const harness = await mountThreadView({ request: (url, options) => {
    if (url.endsWith("/requests") && options.method === "POST") return Promise.reject(Object.assign(new Error("rate limit reached"), { status: 429 }));
  } });
  try {
    harness.chat.emit("update:draft", "keep my message");
    await flush();
    harness.chat.emit("submit");
    await flush();
    const failure = elements(harness.root, (node) => node.text === "rate limit reached")[0];
    assert.ok(failure);
    assert.equal(failure.parent.props.class, "codex-request");
    assert.equal(failure.parent.parent.props.class, "turn-segment-items");
    assert.ok(failure.parent.parent.children.some((node) => node.type === "item-display" && node.text === "keep my message"));
    assert.equal(elements(harness.root, (node) => node.type === "details").length, 0);
    const restore = elements(failure.parent, (node) => node.type === "button" && node.text === "恢复到输入框")[0];
    restore.props.onClick();
    await flush();
    assert.equal(harness.chat.props.draft, "keep my message");
  } finally { harness.close(); }
});

test("mounted unknown receipt exposes an explicit unlock without resubmitting its message", async () => {
  let posts = 0, missingReads = 0;
  const harness = await mountThreadView({ request: (url, options) => {
    if (url.endsWith("/requests") && options.method === "POST") {
      posts += 1;
      if (posts === 1) return Promise.reject(new TypeError("connection lost"));
      return { request: { id: JSON.parse(options.body).clientRequestId, state: "completed" } };
    }
    if (url.includes("/requests/") && !options.method) {
      missingReads += 1;
      return Promise.reject(Object.assign(new Error("Request not found"), { status: 404 }));
    }
  } });
  try {
    harness.chat.emit("update:draft", "possibly sent"); await flush();
    harness.chat.emit("submit"); await flush();
    assert.equal(posts, 1);
    const unlock = elements(harness.root, (node) => node.type === "button" && node.text === "核对并解除锁定")[0];
    assert.ok(unlock);
    unlock.props.onClick(); await flush();
    assert.ok(missingReads >= 2);
    assert.equal(posts, 1);
    harness.chat.emit("update:draft", "different message"); await flush();
    assert.equal(harness.chat.props.canSend, true);
    assert.equal(elements(harness.root, (node) => node.type === "button" && node.text === "核对并解除锁定").length, 0);
    harness.chat.emit("submit"); await flush();
    assert.equal(posts, 2);
  } finally { harness.close(); }
});

test("cross-browser recovery restores original options and uploaded image without uploading again", async () => {
  const originalOptions = { model: "original-model", reasoningEffort: "high", permissionMode: "full-access" };
  const harness = await mountThreadView({
    patch: (provider, threadId, patch) => ({ ...originalOptions, ...patch, git: {} }),
    request: (url, options) => {
      if (url.endsWith("/requests") && !options.method) return { requests: [{ id: "server-receipt", state: "rejected",
        input: { text: "", attachments: [{ id: "saved-image" }] }, options: originalOptions, error: { message: "temporary rejection" } }] };
    }
  });
  try {
    elements(harness.root, (node) => node.type === "button" && node.text === "恢复到输入框")[0].props.onClick();
    await flush();
    assert.equal(harness.chat.props.composerOptions.model, "original-model");
    assert.equal(harness.chat.props.composerOptions.attachments[0].url, "/api/attachments/images/saved-image");
    harness.chat.emit("submit");
    await flush();
    const post = harness.calls.find((call) => call.url.endsWith("/requests") && call.method === "POST");
    assert.deepEqual(JSON.parse(post.body).options, originalOptions);
    assert.deepEqual(JSON.parse(post.body).input.attachments, [{ id: "saved-image" }]);
    assert.equal(harness.calls.some((call) => call.url === "/api/attachments/images"), false);
  } finally { harness.close(); }
});

test("user-only live turns and exhausted latest windows never show an empty process entry", async () => {
  const harness = await mountThreadView({ request: (url) => {
    if (url.includes("/turns?")) return { turns: [{ id: "turn", status: "inProgress", hasMoreItems: true,
      items: [{ id: "user", type: "userMessage", text: "Hello" }] }] };
    if (url.includes("/items?")) return { items: [{ id: "user", type: "userMessage", text: "Hello" }], hasMore: false, latestItemId: "user" };
  } });
  try {
    const toggles = () => elements(harness.root, (node) => node.type === "button" &&
      (/执行过程/.test(node.text || "") || node.props.class === "turn-process-toggle"));
    assert.equal(harness.store.state.turns.turn.itemsLatestLoaded, true);
    assert.equal(harness.store.state.turns.turn.itemsPageLoaded, undefined);
    assert.equal(toggles().length, 0);
    harness.store.upsertTurn({ id: "fresh", status: "inProgress", items: [{ id: "fresh-user", type: "userMessage", text: "Another input" }] });
    await flush();
    assert.equal(toggles().length, 0);
    harness.store.upsertItem("fresh", { id: "real-tool", type: "commandExecution", status: "completed", presentation: { text: "Actual output" } });
    await flush();
    assert.equal(toggles().length, 1);
    toggles()[0].props.onClick(); await flush();
    assert.ok(elements(harness.root, (node) => node.type === "item-display" && node.text === "Actual output").length);
  } finally { harness.close(); }
});

test("expanding a process automatically fills details without any manual load button or stale truncation notice", async () => {
  const harness = await mountThreadView({ request: (url) => {
    if (url.includes("/turns?")) return { threadId: "thread", olderCursor: "older", hasMore: true, turns: [{
      id: "turn", status: "completed", hasMoreItems: true, items: [
        { id: "user", type: "userMessage", presentation: { text: "question" } },
        { id: "command", type: "commandExecution", status: "completed", hasDetails: true, truncated: true, presentation: { text: "command output" } },
        { id: "answer", type: "agentMessage", presentation: { text: "answer" } }
      ] }] };
    if (url.endsWith("/items/command")) return { item: { id: "command", type: "commandExecution", status: "completed", truncated: false, truncatedFields: [], hasDetails: false, presentation: { text: "full output" } } };
  } });
  try {
    assert.equal(harness.chat.props.hasOlder, true);
    assert.equal(typeof harness.chat.props.onReachTop, "function");
    assert.equal(elements(harness.root, (node) => node.type === "button" && node.text?.trim() === "加载更早消息").length, 0);
    assert.equal(elements(harness.root, (node) => node.type === "button" && ["加载本轮更多内容", "查询发送状态", "刷新历史"].includes(node.text?.trim())).length, 0);
    assert.ok(harness.calls.some((call) => call.url.includes("/turns/turn/items?")));
    const toggle = elements(harness.root, (node) => node.type === "button" && node.props.class === "turn-process-toggle")[0];
    toggle.props.onClick();
    await flush();
    assert.equal(elements(harness.root, (node) => node.type === "button" && /加载.*详情/.test(node.text || "")).length, 0);
    assert.equal(elements(harness.root, (node) => node.text === "内容较长，已显示部分").length, 0);
    assert.ok(harness.calls.some((call) => call.url.endsWith("/turns/turn/items/command")));
    assert.ok(elements(harness.root, (node) => node.type === "item-display" && node.text === "full output").length);
  } finally { harness.close(); }
});

test("compact process groups expand independently and hydrate only their visible details", async () => {
  const harness = await mountThreadView({ request: (url) => {
    if (url.includes("/turns?")) return { turns: [{ id: "turn", status: "completed", items: [
      { id: "before", type: "commandExecution", status: "completed", hasDetails: true, truncated: true, presentation: { text: "preview before" } },
      { id: "primary", type: "agentMessage", presentation: { text: "progress message" } },
      { id: "after", type: "commandExecution", status: "completed", hasDetails: true, truncated: true, presentation: { text: "preview after" } }
    ] }] };
    if (/\/items\/(before|after)$/.test(url)) return { item: { id: url.split("/").at(-1), type: "commandExecution", status: "completed",
      truncated: false, hasDetails: false, presentation: { text: `full ${url.split("/").at(-1)}` } } };
  } });
  try {
    const toggles = elements(harness.root, (node) => node.type === "button" && node.props.class === "turn-process-toggle");
    assert.equal(toggles.length, 2);
    assert.equal(toggles[0].props["aria-expanded"], false);
    assert.equal(toggles[1].props["aria-expanded"], false);
    toggles[0].props.onClick(); await flush();
    assert.ok(elements(harness.root, (node) => node.type === "item-display" && node.text === "full before").length);
    assert.equal(elements(harness.root, (node) => node.type === "item-display" && /after/.test(node.text || "")).length, 0);
    assert.equal(harness.calls.some((call) => call.url.endsWith("/items/after")), false);
    toggles[1].props.onClick(); await flush();
    toggles[0].props.onClick(); await flush();
    assert.equal(elements(harness.root, (node) => node.type === "item-display" && /before/.test(node.text || "")).length, 0);
    assert.ok(elements(harness.root, (node) => node.type === "item-display" && node.text === "full after").length);
  } finally { harness.close(); }
});

test("process page failures stay visible when expansion is keyed by the segment", async () => {
  let unavailable = false;
  const harness = await mountThreadView({ request: (url) => {
    if (url.includes("/turns?")) return { turns: [{ id: "turn", status: "completed", hasMoreItems: true, items: [
      { id: "command", type: "commandExecution", presentation: { text: "output" } },
      { id: "answer", type: "agentMessage", presentation: { text: "answer" } }
    ] }] };
    if (url.includes("/turns/turn/items?") && unavailable) return Promise.reject(Object.assign(new Error("process history offline"), { status: 503 }));
  } });
  try {
    const toggle = elements(harness.root, (node) => node.type === "button" && node.props.class === "turn-process-toggle")[0];
    unavailable = true;
    toggle.props.onClick(); await flush();
    assert.ok(elements(harness.root, (node) => node.props?.class === "codex-detail-note" && /process history offline/.test(node.text || "")).length);
  } finally { harness.close(); }
});

test("subagent state and duration remain visible beside collapsed tool groups", async () => {
  const activity = { event: "started", state: "completed", label: "Check files", agentThreadId: "child", startedItemId: "begin",
    startedAt: "2026-10-17T00:00:00Z", completedAt: "2026-10-17T00:04:34.393Z", durationMs: 274393 };
  const harness = await mountThreadView({ request: (url) => {
    if (url.includes("/turns?")) return { turns: [{ id: "turn", status: "completed", items: [
      { id: "command", type: "commandExecution", presentation: { text: "command output" } },
      { id: "begin", type: "subAgentActivity", kind: "interacted", presentation: { activity } },
      { id: "end", type: "subAgentActivity", kind: "completed", presentation: { activity: { ...activity, event: "completed" } } }
    ] }] };
  } });
  try {
    assert.equal(elements(harness.root, (node) => node.type === "item-display").length, 0);
    assert.equal(elements(harness.root, (node) => node.props?.class === "subagent-activity").length, 1);
    assert.equal(elements(harness.root, (node) => node.props?.class === "subagent-activity-duration")[0].text, "4分34秒");
    assert.equal(elements(harness.root, (node) => node.props?.class === "subagent-activity-name")[0].props.href, "#/chat/history:codex:child");
  } finally { harness.close(); }
});

test("genuine long content gets one quiet note while API failures remain distinct and visible", async () => {
  for (const failure of [false, true]) {
    const harness = await mountThreadView({ request: (url) => {
      if (url.includes("/turns?")) return { turns: [{ id: "turn", status: "completed", items: [
        { id: "answer", type: "agentMessage", status: "completed", hasDetails: true, truncated: true, presentation: { text: "preview" } }
      ] }] };
      if (url.endsWith("/items/answer")) {
        if (failure) return Promise.reject(Object.assign(new Error("没有读取权限"), { status: 403 }));
        return { item: { id: "answer", type: "agentMessage", status: "completed", hasDetails: true,
          truncated: true, truncatedFields: ["presentation.text"], presentation: { text: "long partial content" } } };
      }
    } });
    try {
      assert.equal(elements(harness.root, (node) => node.text === "内容较长，已显示部分").length, failure ? 0 : 1);
      assert.equal(elements(harness.root, (node) => String(node.text || "").includes("详情读取失败：没有读取权限")).length, failure ? 1 : 0);
      assert.equal(elements(harness.root, (node) => node.type === "button" && /加载.*详情/.test(node.text || "")).length, 0);
      await flush();
      assert.equal(harness.calls.filter((call) => call.url.endsWith("/items/answer")).length, 1);
    } finally { harness.close(); }
  }
});

test("older visible turn hydrates automatically but keeps execution history collapsed until expanded", async () => {
  const harness = await mountThreadView({ request: (url) => {
    if (url.includes("/turns?")) return { turns: [
      { id: "old", status: "completed", hasMoreItems: true, items: [{ id: "user", type: "userMessage", presentation: { text: "old question" } }, { id: "answer", type: "agentMessage", presentation: { text: "old answer" } }] },
      { id: "latest", status: "completed", items: [] }
    ] };
    if (url.includes("/turns/old/items?")) return { items: [{ id: "command", type: "commandExecution", status: "completed", presentation: { text: "old command output" } }], hasMore: false };
  } });
  try {
    assert.equal(harness.calls.filter((call) => call.url.includes("/turns/old/items?")).length, 1);
    assert.equal(elements(harness.root, (node) => node.type === "item-display" && node.text === "old command output").length, 0);
    const entry = elements(harness.root, (node) => node.type === "button" && node.props.class === "turn-process-toggle")[0];
    assert.ok(entry);
    entry.props.onClick();
    await flush();
    const itemReads = harness.calls.filter((call) => call.url.includes("/turns/old/items?"));
    assert.equal(itemReads.length, 1, "expansion only reveals the already loaded window");
    assert.equal(new URL(itemReads[0].url, "https://example.test").searchParams.get("sortDirection"), "desc");
    assert.ok(elements(harness.root, (node) => node.type === "item-display" && node.text === "old command output").length);
  } finally { harness.close(); }
});

test("mounted V2 view sends queue and steer followups while its own turn is running", async () => {
  const harness = await mountThreadView({ request: (url, options) => {
    if (url.includes("/turns?")) return { turns: [{ id: "running-turn", status: "inProgress", items: [] }] };
    if (url.endsWith("/requests") && !options.method) return { requests: [{ id: "owned-turn", mode: "queue", state: "running",
      turnId: "running-turn", input: { text: "started here" } }] };
  } });
  try {
    harness.chat.emit("update:draft", "queue this"); await flush();
    assert.equal(harness.chat.props.allowFollowups, true);
    assert.equal(harness.chat.props.canSend, true);
    harness.chat.emit("submit", { mode: "queue" }); await flush();
    harness.chat.emit("update:draft", "guide now"); await flush();
    assert.equal(harness.chat.props.canSteer, true);
    harness.chat.emit("submit", { mode: "steer" }); await flush();
    const bodies = harness.calls.filter((call) => call.url.endsWith("/requests") && call.method === "POST").map((call) => JSON.parse(call.body));
    assert.deepEqual(bodies.map((body) => body.mode), ["queue", "steer"]);
    assert.equal(bodies[1].expectedTurnId, "running-turn");
  } finally { harness.close(); }
});

test("mounted active queue remains one compact expandable row during delayed POST, dispatch and withdrawal", async () => {
  const post = deferred();
  const input = "next queued message\nwith a complete second line";
  const harness = await mountThreadView({ runtime: { maxPolls: 0 }, request: (url, options) => {
    if (url.includes("/turns?")) return { turns: [{ id: "active", status: "inProgress", items: [] }] };
    if (url.endsWith("/requests") && options.method === "POST") return post.promise;
    if (url.endsWith("/cancel")) return { request: { id: url.split("/").at(-2), state: "cancelled" } };
  } });
  try {
    harness.chat.emit("update:draft", input); await flush();
    harness.chat.emit("submit", { mode: "queue" }); await flush();
    const body = JSON.parse(harness.calls.find((call) => call.method === "POST").body);
    const composer = elements(harness.root, (node) => node.type === "composer-top")[0];
    const rows = () => elements(composer, (node) => node.type === "li");
    assert.deepEqual(rows().map((row) => row.props["data-request-id"]), [body.clientRequestId]);
    assert.equal(elements(harness.root, (node) => node.props?.["aria-label"] === "消息提交状态").length, 0,
      "pending progress is confined to the queue row");
    assert.equal(elements(rows()[0], (node) => node.text === "提交中").length, 1);
    assert.equal(elements(rows()[0], (node) => node.props?.["aria-label"]?.startsWith("引导排队消息")).length, 0);
    const preview = elements(rows()[0], (node) => node.props?.["aria-label"]?.startsWith("查看待发送消息"))[0];
    assert.equal(preview.props["aria-expanded"], false);
    preview.props.onClick(); await flush();
    assert.equal(elements(rows()[0], (node) => node.props?.["aria-expanded"] === true).length, 1);
    assert.ok(elements(rows()[0], (node) => node.type === "p" && node.text === input).length);
    for (const state of ["received", "dispatching", "queued"]) {
      if (state === "received") { post.resolve({ request: { id: body.clientRequestId, state } }); await flush(); }
      else { harness.store.upsertRequest({ id: body.clientRequestId, state }); await flush(); }
      assert.equal(rows().length, 1);
      assert.deepEqual(harness.chat.props.threadSnapshot.turns.map((turn) => turn.id), ["active"]);
      assert.equal(elements(harness.root, (node) => node.type === "item-display" && node.text === input).length, 0);
    }
    harness.chat.emit("update:draft", "new draft"); await flush();
    elements(rows()[0], (node) => node.props?.["aria-label"]?.startsWith("撤回排队消息"))[0].props.onClick(); await flush();
    assert.equal(rows().length, 0);
    assert.deepEqual(harness.chat.props.threadSnapshot.turns.map((turn) => turn.id), ["active"]);
    assert.equal(harness.chat.props.draft, "new draft");
    assert.doesNotMatch(nodeText(composer), /已中断|已撤回/);
  } finally { post.resolve({ request: { id: "unused", state: "queued" } }); harness.close(); }
});

test("mounted queued failure keeps a single recovery control and removes its card only after explicit restoration", async () => {
  const harness = await mountThreadView({ runtime: { maxPolls: 0 }, request: (url, options) => {
    if (url.includes("/turns?")) return { turns: [{ id: "active", status: "inProgress", items: [] }] };
    if (url.endsWith("/requests") && options.method === "POST") return Promise.reject(Object.assign(new Error("rejected input"), { status: 400 }));
  } });
  try {
    harness.chat.emit("update:draft", "restore original"); await flush();
    harness.chat.emit("submit", { mode: "queue" }); await flush();
    const composer = elements(harness.root, (node) => node.type === "composer-top")[0];
    const feedback = () => elements(harness.root, (node) => node.props?.["aria-label"] === "消息提交状态");
    assert.equal(elements(composer, (node) => node.type === "li").length, 1);
    assert.equal(feedback().length, 1, "the same failure must not be repeated above the queue");
    assert.match(nodeText(feedback()[0]), /请求被拒绝|rejected input/);
    const restore = () => elements(feedback()[0], (node) => node.props?.["aria-label"] === "恢复这条消息到输入框")[0];
    harness.chat.emit("update:draft", "new draft"); await flush();
    restore().props.onClick(); await flush();
    assert.equal(harness.chat.props.draft, "new draft");
    assert.equal(elements(composer, (node) => node.type === "li").length, 1);
    harness.chat.emit("update:draft", ""); await flush();
    restore().props.onClick(); await flush();
    assert.equal(harness.chat.props.draft, "restore original");
    assert.equal(elements(composer, (node) => node.type === "li").length, 0);
    assert.equal(feedback().length, 0);
    assert.deepEqual(harness.chat.props.threadSnapshot.turns.map((turn) => turn.id), ["active"]);
    assert.equal(harness.calls.filter((call) => call.method === "POST").length, 1);
  } finally { harness.close(); }
});

test("mounted waiting messages stay above the composer and their guide action promotes the original receipt", async () => {
  const harness = await mountThreadView({ request: (url) => {
    if (url.includes("/turns?")) return { turns: [{ id: "running-turn", status: "inProgress", items: [] }] };
    if (url.endsWith("/requests")) return { requests: [
      { id: "owned-turn", mode: "queue", state: "running", turnId: "running-turn", input: { text: "started here" } },
      { id: "queued-text", mode: "queue", state: "received", input: { text: "next queued message" } },
      { id: "queued-image", mode: "queue", state: "received", input: { text: "", attachments: [{ id: "photo" }] } }
    ] };
    if (url.endsWith("/requests/queued-text/steer")) return { request: {
      id: "queued-text", mode: "steer", state: "accepted", turnId: "running-turn", input: { text: "next queued message" }
    } };
  } });
  try {
    const composer = elements(harness.root, (node) => node.type === "composer-top")[0];
    assert.equal(elements(composer, (node) => node.props?.["aria-label"] === "待发送消息").length, 1);
    assert.deepEqual(harness.chat.props.threadSnapshot.turns.map((turn) => turn.id), ["running-turn"]);
    assert.deepEqual(elements(composer, (node) => node.type === "li").map((node) => node.props["data-request-id"]), ["queued-text", "queued-image"]);
    assert.equal(elements(composer, (node) => node.type === "img")[0].props.src, "/api/attachments/images/photo");
    assert.equal(elements(harness.root, (node) => node.type === "item-display" && node.text === "next queued message").length, 0);
    harness.chat.emit("update:draft", "keep this draft"); await flush();
    const guide = elements(harness.root, (node) => node.props?.["aria-label"] === "引导排队消息：next queued message")[0];
    assert.equal(guide.props.disabled, false);
    guide.props.onClick(); guide.props.onClick(); await flush();
    assert.equal(harness.chat.props.threadSnapshot.turns.some((turn) => turn.id === "request:queued-text"), false);
    assert.equal(harness.chat.props.threadSnapshot.turns.some((turn) => turn.id === "request:queued-image"), false);
    assert.deepEqual(elements(composer, (node) => node.type === "li").map((node) => node.props["data-request-id"]), ["queued-image"]);
    assert.equal(harness.chat.props.threadSnapshot.turns[0].items.filter((item) => item.request?.id === "queued-text").length, 1);
    assert.equal(harness.chat.props.draft, "keep this draft");
    assert.equal(harness.calls.filter((call) => call.url.endsWith("/requests/queued-text/steer") && call.method === "POST").length, 1);
    const promotion = harness.calls.find((call) => call.url.endsWith("/requests/queued-text/steer"));
    assert.deepEqual(JSON.parse(promotion.body), { expectedTurnId: "running-turn" });
  } finally { harness.close(); }
});

test("desktop queued messages offer withdrawal above the composer using the original receipt ID", async () => {
  const harness = await mountThreadView({ request: (url, options) => {
    if (url.endsWith("/requests") && !options.method) return { requests: [{ id: "desktop-queued", mode: "queue", state: "queued",
      executionRoute: "desktopQueue", input: { text: "next from phone", attachments: [] } }] };
    if (url.endsWith("/requests/desktop-queued/cancel")) return { request: { id: "desktop-queued", mode: "queue", state: "cancelled",
      executionRoute: "desktopQueue", input: { text: "next from phone", attachments: [] } } };
  } });
  try {
    const composer = elements(harness.root, (node) => node.type === "composer-top")[0];
    assert.equal(elements(composer, (node) => node.props?.["aria-label"] === "待发送消息").length, 1);
    assert.equal(harness.chat.props.threadSnapshot.turns.length, 0);
    assert.match(nodeText(composer), /next from phone/);
    assert.equal(elements(harness.root, (node) => node.text === "等待执行").length, 0, "the compact queue has no extra heading");
    const guide = elements(harness.root, (node) => node.props?.["aria-label"]?.startsWith("引导排队消息"))[0];
    assert.equal(guide.props.disabled, true);
    assert.match(nodeText(composer), /当前没有正在执行的回复/);
    elements(harness.root, (node) => node.props?.["aria-label"] === "撤回排队消息：next from phone")[0].props.onClick();
    await flush();
    assert.equal(harness.calls.filter((call) => call.url.endsWith("/requests/desktop-queued/cancel") && call.method === "POST").length, 1);
    assert.equal(elements(composer, (node) => node.props?.["aria-label"] === "待发送消息").length, 0);
    assert.equal(harness.chat.props.threadSnapshot.turns.length, 0);
    assert.equal(harness.store.state.requests["desktop-queued"].state, "cancelled", "the audit receipt remains available");
    assert.equal(elements(harness.root, (node) => node.type === "button" && node.text === "恢复到输入框").length, 0);
  } finally { harness.close(); }
});

test("an official running turn does not repeat receipt progress beneath its user message", async () => {
  const harness = await mountThreadView({ request: (url, options) => {
    if (url.includes("/turns?")) return { turns: [{ id: "desktop-turn", status: "inProgress", items: [
      { id: "desktop-user", type: "userMessage", clientId: "desktop-running", text: "continue" }
    ] }] };
    if (url.endsWith("/requests") && !options.method) return { requests: [{ id: "desktop-running", mode: "queue",
      state: "running", turnId: "desktop-turn", input: { text: "continue", attachments: [] } }] };
  } });
  try {
    assert.equal(harness.chat.props.threadSnapshot.turns[0].items[0].request.state, "running");
    assert.equal(elements(harness.root, (node) => node.text === "正在生成").length, 0);
    assert.equal(elements(harness.root, (node) => node.text === "进行中").length, 1);
  } finally { harness.close(); }
});

test("a desktop-owned running turn without remote control capability keeps stop unavailable", async () => {
  const harness = await mountThreadView({ request: (url) => {
    if (url.includes("/turns?")) return { turns: [{ id: "desktop-turn", status: "inProgress", items: [] }] };
  } });
  try {
    assert.equal(harness.chat.props.canInterrupt, false);
    assert.equal(harness.chat.props.canSteer, false);
    harness.chat.emit("update:draft", "follow up"); await flush();
    harness.chat.emit("submit", { mode: "steer" }); await flush();
    assert.equal(harness.calls.some((call) => call.url.endsWith("/requests") && call.method === "POST"), false);
  } finally { harness.close(); }
});

test("desktop stop is enabled without a web receipt, targets the visible turn and preserves the draft", async () => {
  let turnStatus = "inProgress";
  const stop = deferred();
  const harness = await mountThreadView({ request: (url, options) => {
    if (url.endsWith("/threads/thread")) return { thread: { id: "thread", capabilities: { desktopInterrupt: true } } };
    if (url.includes("/turns?")) return { turns: [{ id: "desktop-active", status: turnStatus, items: [] }] };
    if (url.endsWith("/interrupt")) return stop.promise;
  } });
  try {
    assert.equal(harness.chat.props.canInterrupt, true);
    assert.equal(harness.chat.props.canSteer, false, "stop capability does not grant steering");
    harness.chat.emit("update:draft", "keep this draft"); await flush();
    harness.chat.emit("interrupt"); harness.chat.emit("interrupt"); await flush();
    const posts = harness.calls.filter((call) => call.url.endsWith("/interrupt"));
    assert.equal(posts.length, 1);
    assert.deepEqual(JSON.parse(posts[0].body), { expectedTurnId: "desktop-active" });
    assert.equal(harness.chat.props.interrupting, true);
    turnStatus = "interrupted"; stop.resolve({ ok: true, turnId: "desktop-active" }); await flush();
    assert.equal(harness.chat.props.runningTask, false);
    assert.equal(harness.chat.props.canInterrupt, false);
    assert.equal(harness.chat.props.interrupting, false);
    assert.equal(harness.chat.props.draft, "keep this draft");
    assert.equal(harness.chat.props.statusText, "");
  } finally { stop.resolve({ ok: true }); harness.close(); }
});

test("an uncertain stop refreshes real status without repeating the mutation", async () => {
  let status = "inProgress";
  const harness = await mountThreadView({ request: (url) => {
    if (url.endsWith("/threads/thread")) return { thread: { id: "thread", capabilities: { desktopInterrupt: true } } };
    if (url.includes("/turns?")) return { turns: [{ id: "desktop-active", status, items: [] }] };
    if (url.endsWith("/interrupt")) { status = "interrupted"; throw Object.assign(new Error("停止结果待确认"), { code: "interrupt_unconfirmed" }); }
  } });
  try {
    await harness.runtime.interrupt(); await flush();
    assert.equal(harness.calls.filter((call) => call.url.endsWith("/interrupt")).length, 1);
    assert.equal(harness.chat.props.canInterrupt, false);
    assert.equal(harness.chat.props.runningTask, false);
  } finally { harness.close(); }
});

for (const followUpQueueMode of ["queue", "steer"]) test(`normal followups use the loaded ${followUpQueueMode} desktop preference for an owned active turn`, async () => {
  const harness = await mountThreadView({ composerRead: () => ({ model: "model", followUpQueueMode, git: {} }), request: (url, options) => {
    if (url.includes("/turns?")) return { turns: [{ id: "active", status: "inProgress", items: [] }] };
    if (url.endsWith("/requests") && !options.method) return { requests: [{ id: "owner", state: "running", turnId: "active" }] };
  } });
  try {
    assert.equal(harness.chat.props.followUpMode, followUpQueueMode);
    assert.equal(harness.chat.props.runningTask, true);
    harness.chat.emit("update:draft", "normal followup"); await flush();
    harness.chat.emit("submit"); await flush();
    const body = JSON.parse(harness.calls.find((call) => call.method === "POST" && call.url.endsWith("/requests")).body);
    assert.equal(body.mode, followUpQueueMode);
    assert.equal(body.expectedTurnId, followUpQueueMode === "steer" ? "active" : undefined);
    assert.equal(Object.hasOwn(body.options, "followUpQueueMode"), false);
  } finally { harness.close(); }
});

test("external active steer preference preserves the draft and explains the limitation while explicit queue still sends", async () => {
  const harness = await mountThreadView({ composerRead: () => ({ model: "model", followUpQueueMode: "steer", git: {} }), request: (url) => {
    if (url.includes("/turns?")) return { turns: [{ id: "external", status: "inProgress", items: [] }] };
  } });
  try {
    harness.chat.emit("update:draft", "must not silently queue"); await flush();
    assert.equal(harness.chat.props.runningTask, true);
    assert.equal(harness.chat.props.canSend, true);
    assert.equal(harness.chat.props.canSteer, false);
    assert.equal(harness.chat.props.canInterrupt, false);
    harness.chat.emit("submit"); await flush();
    harness.chat.emit("submit", { mode: "steer" }); await flush();
    assert.match(harness.chat.props.statusText, /当前任务由桌面执行.*选择加入队列/);
    assert.equal(harness.chat.props.draft, "must not silently queue");
    assert.equal(harness.calls.filter((call) => call.method === "POST" && call.url.endsWith("/requests")).length, 0);
    harness.chat.emit("submit", { mode: "queue" }); await flush();
    const posts = harness.calls.filter((call) => call.method === "POST" && call.url.endsWith("/requests"));
    assert.equal(posts.length, 1);
    assert.equal(JSON.parse(posts[0].body).mode, "queue");
  } finally { harness.close(); }
});

test("external active queue preference sends normally and idle steer preference starts a new turn", async () => {
  for (const active of [true, false]) {
    const harness = await mountThreadView({ composerRead: () => ({ model: "model", followUpQueueMode: active ? "queue" : "steer", git: {} }), request: (url) => {
      if (url.includes("/turns?")) return { turns: active ? [{ id: "external", status: "inProgress", items: [] }] : [] };
    } });
    try {
      harness.chat.emit("update:draft", "send normally"); await flush();
      harness.chat.emit("submit"); await flush();
      const posts = harness.calls.filter((call) => call.method === "POST" && call.url.endsWith("/requests"));
      assert.equal(posts.length, 1);
      const body = JSON.parse(posts[0].body);
      assert.equal(body.mode, "queue");
      assert.equal(body.expectedTurnId, undefined);
    } finally { harness.close(); }
  }
});

test("composer preference read remains mandatory and wins over a later global config response", async () => {
  const options = deferred(), config = deferred();
  const harness = await mountThreadView({ composerRead: () => options.promise, loadConfig: () => config.promise });
  try {
    harness.chat.emit("update:draft", "keep until settings arrive"); await flush();
    harness.chat.emit("submit"); await flush();
    assert.equal(harness.calls.filter((call) => call.method === "POST").length, 0);
    options.resolve({ model: "model", followUpQueueMode: "queue", git: {} }); await flush();
    assert.equal(harness.chat.props.followUpMode, "queue");
    config.resolve({ codexFollowUpQueueMode: "steer", providers: [] }); await flush();
    assert.equal(harness.chat.props.followUpMode, "queue");
    assert.equal(harness.chat.props.canSend, true);
  } finally { options.resolve({ model: "model" }); config.resolve({}); harness.close(); }
});

test("legacy settings responses follow the official steer default and foreground refresh rereads the desktop preference", async () => {
  const listeners = new Map();
  const visibility = { hidden: false, addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: (name) => listeners.delete(name) };
  let reads = 0;
  const harness = await mountThreadView({ runtime: { maxPolls: 0, visibility }, composerRead: () => ({ model: "model", git: {},
    ...(reads++ ? { followUpQueueMode: "queue" } : {}) }) });
  try {
    assert.equal(harness.chat.props.followUpMode, "steer");
    visibility.hidden = true; listeners.get("visibilitychange")(); await flush();
    assert.equal(reads, 1);
    visibility.hidden = false; listeners.get("visibilitychange")(); await flush();
    assert.equal(reads, 2);
    assert.equal(harness.chat.props.followUpMode, "queue");
    assert.equal(harness.calls.filter((call) => call.method === "POST").length, 0);
  } finally { harness.close(); }
});

test("a late initial preference read cannot replace a newer foreground preference", async () => {
  const initial = deferred(), listeners = new Map();
  const visibility = { hidden: false, addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: (name) => listeners.delete(name) };
  let reads = 0;
  const harness = await mountThreadView({ runtime: { maxPolls: 0, visibility }, composerRead: () => ++reads === 1 ? initial.promise :
    { model: "model", followUpQueueMode: "queue", git: {} } });
  try {
    visibility.hidden = true; listeners.get("visibilitychange")();
    visibility.hidden = false; listeners.get("visibilitychange")(); await flush();
    assert.equal(harness.chat.props.followUpMode, "queue");
    initial.resolve({ model: "model", followUpQueueMode: "steer", git: {} }); await flush();
    assert.equal(reads, 2);
    assert.equal(harness.chat.props.followUpMode, "queue");
    assert.equal(harness.calls.filter((call) => call.method === "POST").length, 0);
  } finally { initial.resolve({ model: "model" }); harness.close(); }
});

test("ChatComposer retains stop alongside a follow-up draft without submitting or clearing it; legacy remains unchanged", async () => {
  const component = (await import(compileComponentUrl(new URL("../web/src/components/composer/ChatComposer.vue", import.meta.url), {
    [new URL("../web/src/components/composer/ComposerPopover.vue", import.meta.url).href]: sourceUrl("export default { render() { return null; } };")
  }))).default;
  const renderer = testRenderer(), root = { children: [] }, submitted = [], stopped = [], draftUpdates = [];
  const props = { draft: "follow up", composerOptions: { attachments: [] }, gitState: {}, canSend: true,
    canInterrupt: true, canSteer: true, allowFollowups: true, runningTask: true, followUpMode: "queue",
    onSubmit: (body) => submitted.push(body), onInterrupt: () => stopped.push(true), "onUpdate:draft": (draft) => draftUpdates.push(draft) };
  try {
    renderer.render(h(component, props), root); await flush();
    const textarea = elements(root, (node) => node.type === "textarea")[0];
    assert.equal(textarea.props.disabled, false);
    assert.equal(elements(root, (node) => node.props?.["aria-label"] === "添加图片")[0].props.disabled, false);
    elements(root, (node) => node.props?.["aria-label"] === "加入队列")[0].props.onClick();
    textarea.props.onKeydown({ key: "Enter", ctrlKey: true, preventDefault() {} });
    textarea.props.onKeydown({ key: "Enter", preventDefault() {} });
    assert.deepEqual(submitted.map((body) => body.mode), ["queue", "steer", "queue"]);
    const stopWithDraft = elements(root, (node) => node.props?.["aria-label"] === "停止生成")[0];
    assert.equal(stopWithDraft.props.disabled, false);
    stopWithDraft.props.onClick();
    assert.equal(stopped.length, 1);
    assert.deepEqual(submitted.map((body) => body.mode), ["queue", "steer", "queue"]);
    assert.deepEqual(draftUpdates, []);
    assert.equal(textarea.props.value, "follow up");
    renderer.render(h(component, { ...props, loading: true }), root); await flush();
    assert.equal(elements(root, (node) => node.props?.["aria-label"] === "停止生成")[0].props.disabled, false);
    assert.equal(elements(root, (node) => node.props?.["aria-label"] === "加入队列")[0].props.disabled, true);
    renderer.render(h(component, { ...props, draft: "", canSend: false, loading: true }), root); await flush();
    assert.equal(elements(root, (node) => node.props?.["aria-label"] === "停止生成")[0].props.disabled, false);
    assert.equal(elements(root, (node) => node.props?.["aria-label"] === "加入队列").length, 0);
    elements(root, (node) => node.props?.["aria-label"] === "停止生成")[0].props.onClick();
    assert.equal(stopped.length, 2);
    renderer.render(h(component, { ...props, allowFollowups: false, canSteer: false }), root); await flush();
    assert.equal(elements(root, (node) => node.type === "textarea")[0].props.disabled, true);
    assert.equal(elements(root, (node) => node.props?.["aria-label"] === "加入队列").length, 0);
    elements(root, (node) => node.props?.["aria-label"] === "停止生成")[0].props.onClick();
    assert.equal(stopped.length, 3);
  } finally { renderer.render(null, root); }
});

test("compact send control follows a configured queue default and reveals the explicit steer override", async () => {
  const component = (await import(compileComponentUrl(new URL("../web/src/components/composer/ComposerSendActions.vue", import.meta.url), {
    [new URL("../web/src/components/composer/ComposerPopover.vue", import.meta.url).href]: sourceUrl(`
      import { h } from ${JSON.stringify(import.meta.resolve("vue"))};
      export default { props: ['open'], setup(props, {slots}) { return () => props.open ? h('popover', slots.default?.()) : null; } };`)
  }))).default;
  const renderer = testRenderer(), root = { children: [] }, submitted = [], stopped = [];
  const props = { runningTask: true, hasInput: true, canInterrupt: true, followUpMode: "queue", disabled: false, canSteer: true,
    onSubmit: (body) => submitted.push(body), onInterrupt: () => stopped.push(true) };
  try {
    renderer.render(h(component, props), root); await flush();
    assert.equal(elements(root, (node) => node.props?.role === "dialog").length, 0);
    elements(root, (node) => node.props?.["aria-label"] === "加入队列")[0].props.onClick();
    elements(root, (node) => node.props?.["aria-label"] === "选择发送方式")[0].props.onClick(); await flush();
    const menu = elements(root, (node) => node.props?.class === "send-menu")[0];
    assert.ok(menu);
    assert.equal(menu.props.role, undefined, "the shared popover owns dialog semantics");
    const choices = elements(menu, (node) => node.type === "button");
    assert.equal(choices.length, 2);
    choices[1].props.onClick(); await flush();
    assert.deepEqual(submitted.map((body) => body.mode), ["queue", "steer"]);
    assert.equal(elements(root, (node) => node.props?.role === "dialog").length, 0);
    renderer.render(h(component, { ...props, disabled: true }), root); await flush();
    assert.equal(elements(root, (node) => node.props?.["aria-label"] === "停止生成")[0].props.disabled, false);
    renderer.render(h(component, { ...props, disabled: true, hasInput: false }), root); await flush();
    const stop = elements(root, (node) => node.props?.["aria-label"] === "停止生成")[0];
    assert.equal(stop.props.disabled, false);
    stop.props.onClick(); assert.equal(stopped.length, 1);
    renderer.render(h(component, { ...props, runningTask: false, canInterrupt: false }), root); await flush();
    assert.equal(elements(root, (node) => node.props?.["aria-label"] === "选择发送方式").length, 0);
    assert.equal(elements(root, (node) => node.type === "button").length, 1);
  } finally { renderer.render(null, root); }
});

test("the running primary button treats images as input throughout upload and never stops on empty Enter", async () => {
  const component = (await import(compileComponentUrl(new URL("../web/src/components/composer/ChatComposer.vue", import.meta.url), {
    [new URL("../web/src/components/composer/ComposerPopover.vue", import.meta.url).href]: sourceUrl("export default { render() { return null; } };")
  }))).default;
  const renderer = testRenderer(), root = { children: [] }, submitted = [], stopped = [];
  const props = { draft: "", composerOptions: { attachments: [] }, gitState: {}, canSend: false,
    runningTask: true, followUpMode: "queue", canInterrupt: true, canSteer: true, allowFollowups: true,
    onSubmit: (payload) => submitted.push(payload), onInterrupt: () => stopped.push(true) };
  const byLabel = (label) => elements(root, (node) => node.props?.["aria-label"] === label);
  try {
    for (const draft of ["", " \n\t"]) {
      renderer.render(h(component, { ...props, draft }), root); await flush();
      assert.equal(byLabel("停止生成").length, 1);
      assert.equal(byLabel("加入队列").length, 0);
      elements(root, (node) => node.type === "textarea")[0].props.onKeydown({ key: "Enter", preventDefault() {} });
    }
    assert.deepEqual(stopped, []); assert.deepEqual(submitted, []);
    for (const status of ["pending", "uploading", "uploaded", "failed"]) {
      for (const loading of [false, true]) {
        renderer.render(h(component, { ...props, loading, canSend: true,
          composerOptions: { attachments: [{ id: "image", kind: "image", status, url: "/image.png" }] } }), root); await flush();
        assert.equal(byLabel("停止生成").length, 1, `${status} image keeps stopping independently available`);
        assert.equal(byLabel("加入队列").length, 1);
        assert.equal(byLabel("加入队列")[0].props.disabled, loading);
      }
    }
    renderer.render(h(component, { ...props, canInterrupt: false }), root); await flush();
    const externalStop = byLabel("停止生成")[0];
    assert.equal(externalStop.props.disabled, true);
    assert.match(externalStop.props.title, /桌面端/);
    externalStop.props.onClick(); assert.deepEqual(stopped, []);
    renderer.render(h(component, { ...props, interrupting: true }), root); await flush();
    byLabel("停止生成")[0].props.onClick(); assert.deepEqual(stopped, []);
    renderer.render(h(component, { ...props, runningTask: false, canInterrupt: false }), root); await flush();
    assert.equal(byLabel("停止生成").length, 0);
    assert.equal(byLabel("发送消息")[0].props.disabled, true);
  } finally { renderer.render(null, root); }
});

test("stopping with an attachment preserves the draft and image without submitting across upload states", async () => {
  const component = (await import(compileComponentUrl(new URL("../web/src/components/composer/ChatComposer.vue", import.meta.url), {
    [new URL("../web/src/components/composer/ComposerPopover.vue", import.meta.url).href]: sourceUrl("export default { render() { return null; } };")
  }))).default;
  const renderer = testRenderer(), root = { children: [] }, events = [];
  try {
    for (const status of ["pending", "uploading", "uploaded", "failed"]) {
      for (const loading of [false, true]) {
        events.length = 0;
        const attachment = { id: "keep-image", name: "keep.png", kind: "image", status, url: "/image.png" };
        renderer.render(h(component, { draft: "keep this draft", composerOptions: { attachments: [attachment] }, gitState: {},
          runningTask: true, canInterrupt: true, canSteer: true, canSend: true, allowFollowups: true, loading,
          onInterrupt: () => events.push("interrupt"), onSubmit: () => events.push("submit"),
          "onUpdate:draft": () => events.push("draft"), "onUpdate:composer-options": () => events.push("options"),
          onRemoveAttachment: () => events.push("remove") }), root); await flush();
        const stop = elements(root, (node) => node.props?.["aria-label"] === "停止生成")[0];
        assert.equal(stop.props.disabled, false);
        stop.props.onClick();
        assert.deepEqual(events, ["interrupt"]);
        assert.equal(elements(root, (node) => node.type === "textarea")[0].props.value, "keep this draft");
        assert.equal(elements(root, (node) => node.props?.["aria-label"] === "移除 keep.png").length, 1);
        assert.equal(attachment.status, status);
      }
    }
  } finally { renderer.render(null, root); }
});

test("configured steer follows button and Enter while the send menu can explicitly override it to queue", async () => {
  const popover = sourceUrl(`import { h } from ${JSON.stringify(import.meta.resolve("vue"))};
    export default { props: ['open'], setup(props, { slots }) { return () => props.open ? h('popover', slots.default?.()) : null; } };`);
  const component = (await import(compileComponentUrl(new URL("../web/src/components/composer/ChatComposer.vue", import.meta.url), {
    [new URL("../web/src/components/composer/ComposerPopover.vue", import.meta.url).href]: popover
  }))).default;
  const renderer = testRenderer(), root = { children: [] }, submitted = [];
  const props = { draft: "follow up", composerOptions: { attachments: [] }, gitState: {}, canSend: true,
    runningTask: true, followUpMode: "steer", canInterrupt: true, canSteer: true, allowFollowups: true,
    onSubmit: (payload) => submitted.push(payload) };
  try {
    renderer.render(h(component, props), root); await flush();
    elements(root, (node) => node.props?.["aria-label"] === "立即引导")[0].props.onClick();
    elements(root, (node) => node.type === "textarea")[0].props.onKeydown({ key: "Enter", preventDefault() {} });
    elements(root, (node) => node.props?.["aria-label"] === "选择发送方式")[0].props.onClick(); await flush();
    const menu = elements(root, (node) => node.props?.class === "send-menu")[0];
    elements(menu, (node) => node.type === "button")[0].props.onClick(); await flush();
    assert.deepEqual(submitted.map((entry) => entry.mode), ["steer", "steer", "queue"]);
    renderer.render(h(component, { ...props, canInterrupt: false, canSteer: false }), root); await flush();
    const externalStop = elements(root, (node) => node.props?.["aria-label"] === "停止生成")[0];
    assert.equal(externalStop.props.disabled, true);
    assert.match(externalStop.props.title, /桌面端/);
    assert.equal(elements(root, (node) => node.type === "textarea")[0].props.disabled, false);
    elements(root, (node) => node.props?.["aria-label"] === "立即引导")[0].props.onClick();
    elements(root, (node) => node.type === "textarea")[0].props.onKeydown({ key: "Enter", metaKey: true, preventDefault() {} });
    assert.deepEqual(submitted.slice(-2).map((entry) => entry.mode), ["steer", "steer"], "the parent explains unsupported desktop steering instead of silently queueing");
  } finally { renderer.render(null, root); }
});

test("steer stays before new assistant output while its official user item is delayed, then yields to history order", async () => {
  const { runtime, store } = fixture((url, options) => {
    if (options.method === "POST") { const body = JSON.parse(options.body); return { request: { id: body.clientRequestId, mode: 'steer', state: 'accepted', turnId: 'active' } }; }
    return reads(url);
  });
  const item = (id, type, text, extra = {}) => ({ id, type, text, presentation: { text }, ...extra });
  const original = item('user', 'userMessage', 'original');
  const comment = item('comment', 'agentMessage', 'earlier output');
  const answer = item('answer', 'agentMessage', 'new answer');
  store.upsertTurn({ id: 'active', status: 'inProgress', items: [original, comment] });
  await runtime.submit({ ...requestBody, mode: 'steer', expectedTurnId: 'active' });
  store.upsertItem('active', answer);
  assert.deepEqual(presentCodexChatSnapshot(store.state).turns[0].items.map(i => i.id), ['user', 'comment', 'request:request-1', 'answer']);
  const followup = item('followup', 'userMessage', 'same', { clientId: 'request-1' });
  store.upsertItem('active', followup);
  assert.deepEqual(presentCodexChatSnapshot(store.state).turns[0].items.map(i => i.id), ['user', 'comment', 'followup', 'answer']);
  store.applyTurnsPage({ turns: [{id:'active', status:'inProgress', itemsView:'summary', items:[original, comment, followup, answer]}] });
  assert.deepEqual(presentCodexChatSnapshot(store.state).turns[0].items.map(i => i.id), ['user', 'comment', 'followup', 'answer']);
  const intermediate = item('intermediate', 'agentMessage', 'finished before accepting steer');
  store.applyItemsPage('active', { items: [original, comment, intermediate, followup, answer], hasMore: false });
  assert.deepEqual(presentCodexChatSnapshot(store.state).turns[0].items.map(i => i.id), ['user', 'comment', 'intermediate', 'followup', 'answer']);
  runtime.dispose();
});

test("a captured empty steer anchor still precedes assistant output that arrives after submission", async () => {
  const { runtime, store } = fixture((url, options) => {
    if (options.method === "POST") return { request: { id: JSON.parse(options.body).clientRequestId, mode:'steer', state:'accepted', turnId:'active' } };
    return reads(url);
  });
  store.upsertTurn({ id:'active', status:'inProgress', items:[] });
  store.upsertRequest({id:'original',mode:'queue',state:'accepted',turnId:'active',input:{text:'original'}});
  await runtime.submit({...requestBody,mode:'steer',expectedTurnId:'active'});
  store.upsertItem('active',{id:'answer',type:'agentMessage',text:'new answer'});
  assert.deepEqual(presentCodexChatSnapshot(store.state).turns[0].items.map(i=>i.id),['request:original','request:request-1','answer']);
  runtime.dispose();
});

test("queued messages promoted in reverse queue order follow actual guide order before later assistant output", () => {
  const store = createCodexChatStore('thread', {storage: memoryStorage()});
  store.upsertTurn({ id: 'active', status: 'inProgress', items: [{id:'anchor',type:'agentMessage',text:'before'}] });
  store.upsertRequest({ id: 'first-queued', state: 'accepted', mode: 'steer', turnId: 'active', steerAfterItemId: 'anchor', steerQueuedAt: 2, input: {text:'second guide'} });
  store.upsertRequest({ id: 'second-queued', state: 'accepted', mode: 'steer', turnId: 'active', steerAfterItemId: 'anchor', steerQueuedAt: 1, input: {text:'first guide'} });
  store.upsertItem('active', {id:'answer',type:'agentMessage',text:'after'});
  assert.deepEqual(presentCodexChatSnapshot(store.state).turns[0].items.map(i=>i.id), ['anchor','request:second-queued','request:first-queued','answer']);
});

test("refresh with a sparse summary keeps a confirmed steer before the final reply while its anchor is loading", () => {
  const storage=memoryStorage();
  const previous=createCodexChatStore('thread',{storage});
  previous.upsertRequest({id:'steer',mode:'steer',state:'completed',turnId:'turn',expectedTurnId:'turn',steerAfterItemId:'omitted-comment',steerQueuedAt:1,input:{text:'question'}});
  const restored=createCodexChatStore('thread',{storage});
  restored.applyTurnsPage({turns:[{id:'turn',status:'completed',items:[
    {id:'original',type:'userMessage',text:'original'},
    {id:'answer',type:'agentMessage',text:'response to question'}
  ]}]});
  assert.deepEqual(presentCodexChatSnapshot(restored.state).turns[0].items.map(i=>i.id),['original','request:steer','answer']);
});

for (const draft of ["", "ordinary draft"]) test(`mounted native interaction answers preserve ${draft ? 'existing' : 'empty'} chat input, images and the unknown receipt barrier`, async () => {
  const interaction = { id: "native-handle", threadId: "thread", turnId: "native-turn", itemId: "native-item",
    method: "item/tool/requestUserInput", params: { isBlocking: true, questions: [{ id: "answer", question: "Continue?", isSecret: true }] },
    status: "pending", version: 1 };
  const harness = await mountThreadView({ runtime: { maxPolls: 0 }, request: (url, options) => {
    if (url.endsWith("/interactions")) return { interactions: [interaction], epoch: "registry", revision: 1 };
    if (url.endsWith("/interactions/native-handle/respond")) return { interaction: { ...interaction, status: "submitted", version: 2 }, epoch: "registry", revision: 2 };
    if (url === "/api/attachments/images") return { attachment: { id: "uploaded-image", url: "/image" } };
  } });
  try {
    harness.chat.emit("update:draft", draft);
    harness.chat.emit("add-attachments", { files: [new File(["png"], "photo.png", { type: "image/png" })], kindHint: "image" });
    await flush();
    harness.store.upsertRequest({ id: "unknown-chat", state: "unknown", input: { text: "previous" } });
    harness.store.interactions.setDraft("native-handle", { answers: { answer: "private-answer" } }); await flush();
    assert.equal(harness.chat.props.canSend, false);
    const form = elements(harness.root, (node) => node.type === "form" && node.props.class === "interaction-form")[0];
    form.props.onSubmit({ preventDefault() {} }); await flush();
    const post = harness.calls.filter((call) => call.method === "POST").find((call) => call.url.endsWith("/respond"));
    assert.deepEqual(JSON.parse(post.body).response, { answers: { answer: { answers: ["private-answer"] } } });
    assert.equal(harness.chat.props.draft, draft);
    assert.equal(harness.chat.props.composerOptions.attachments[0].uploadedId, "uploaded-image");
    assert.equal(harness.chat.props.canSend, false);
    assert.equal(harness.calls.some((call) => call.method === "POST" && call.url.endsWith("/requests")), false);
    assert.doesNotMatch(harness.storage.getItem("codex-chat-v2:thread"), /private-answer/);
    assert.equal(harness.store.state.interactionState.drafts["native-handle"], undefined);
  } finally { harness.close(); }
});

function desktopQuestionItem(callId = "call_mobile_question", extra = {}) {
  return { id: callId, type: "agentMessage", presentation: { text: "Choose a direction", question: {
    callId, source: "desktop", delivery: "async", questions: [{ id: "0", title: "Choose a direction", options: ["Keep going", "Pause"] }], ...extra
  } } };
}

for (const initialCapability of [false, undefined]) test(`an idle unanswered question recovers ${initialCapability === false ? "false" : "missing"} capability through bounded metadata-only polling`, async () => {
  const clock = runtimeClock(), question = desktopQuestionItem();
  let available = initialCapability, metadataReads = 0;
  const { runtime, store, calls } = fixture((url) => {
    if (url.endsWith("/threads/thread")) {
      metadataReads += 1;
      return { thread: { id: "thread", ...(available === undefined ? {} : { capabilities: { desktopQuestionAnswers: available } }) } };
    }
    if (url.includes("/turns?")) return { turns: [{ id: "ended", status: "completed", items: [question], hasMoreItems: false }] };
    if (url.includes("/items?")) return { items: [question], hasMore: false };
    return reads(url);
  }, { runtime: { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, maxPolls: Infinity } });
  try {
    store.setDraft({ text: "untouched draft" });
    await runtime.open(); await flush();
    assert.equal(metadataReads, 1);
    const historyReads = calls.filter((call) => /\/turns\?|\/items\?/.test(call.url)).length;
    const requestReads = calls.filter((call) => call.url.endsWith("/requests")).length;
    available = true;
    await clock.advance(9999);
    assert.equal(metadataReads, 1);
    assert.notEqual(store.state.thread.capabilities?.desktopQuestionAnswers, true);
    await clock.advance(1);
    assert.equal(metadataReads, 2);
    assert.equal(store.state.thread.capabilities.desktopQuestionAnswers, true);
    assert.equal(calls.filter((call) => /\/turns\?|\/items\?/.test(call.url)).length, historyReads);
    assert.equal(calls.filter((call) => call.url.endsWith("/requests")).length, requestReads);
    assert.equal(store.state.draft.text, "untouched draft");
    assert.equal(clock.pendingReads, 0);
    await clock.advance(60000);
    assert.equal(metadataReads, 2);
    assert.equal(calls.some((call) => call.method === "POST"), false);
  } finally { runtime.dispose(); }
});

test("capability probe failures keep their error and retry without reloading question history", async () => {
  const clock = runtimeClock(), question = desktopQuestionItem();
  let metadataReads = 0;
  const { runtime, store, calls } = fixture((url) => {
    if (url.endsWith("/threads/thread")) {
      metadataReads += 1;
      if (metadataReads === 2) throw new Error("desktop metadata unavailable");
      return { thread: { id: "thread", capabilities: { desktopQuestionAnswers: metadataReads > 2 } } };
    }
    if (url.includes("/turns?")) return { turns: [{ id: "ended", status: "completed", items: [question], hasMoreItems: false }] };
    if (url.includes("/items?")) return { items: [question], hasMore: false };
    return reads(url);
  }, { runtime: { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, maxPolls: Infinity } });
  try {
    await runtime.open(); await flush();
    const historyReads = calls.filter((call) => /\/turns\?|\/items\?/.test(call.url)).length;
    await clock.advance(10000);
    assert.equal(metadataReads, 2);
    assert.equal(store.state.thread.capabilities.desktopQuestionAnswers, false);
    assert.equal(store.state.historyReadError, "desktop metadata unavailable");
    await clock.advance(9999);
    assert.equal(metadataReads, 2);
    await clock.advance(1);
    assert.equal(metadataReads, 3);
    assert.equal(store.state.thread.capabilities.desktopQuestionAnswers, true);
    assert.equal(store.state.historyReadError, "");
    assert.equal(calls.filter((call) => /\/turns\?|\/items\?/.test(call.url)).length, historyReads);
    assert.equal(clock.pendingReads, 0);
  } finally { runtime.dispose(); }
});

test("returning to the foreground immediately rechecks an unavailable question capability", async () => {
  const clock = runtimeClock(), handlers = new Map(), question = desktopQuestionItem();
  const visibility = { hidden: false, addEventListener: (name, callback) => handlers.set(name, callback), removeEventListener: (name) => handlers.delete(name) };
  let available = false, metadataReads = 0;
  const { runtime, store } = fixture((url) => {
    if (url.endsWith("/threads/thread")) { metadataReads += 1; return { thread: { id: "thread", capabilities: { desktopQuestionAnswers: available } } }; }
    if (url.includes("/turns?")) return { turns: [{ id: "ended", status: "completed", items: [question], hasMoreItems: false }] };
    if (url.includes("/items?")) return { items: [question], hasMore: false };
    return reads(url);
  }, { runtime: { visibility, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, maxPolls: Infinity } });
  try {
    await runtime.open(); await runtime.pollRequests(); await flush();
    const before = metadataReads;
    visibility.hidden = true; handlers.get("visibilitychange")();
    available = true;
    visibility.hidden = false; handlers.get("visibilitychange")(); await flush();
    assert.equal(clock.now(), 0, "foreground discovery does not wait for the retry interval");
    assert.equal(metadataReads, before + 1);
    assert.equal(store.state.thread.capabilities.desktopQuestionAnswers, true);
  } finally { runtime.dispose(); }
});

test("hidden question capability probes retain the thirty-second floor and ignore late results after disposal", async () => {
  const clock = runtimeClock(), question = desktopQuestionItem(), pending = deferred();
  let metadataReads = 0;
  const { runtime, store, sockets } = fixture((url) => {
    if (url.endsWith("/threads/thread")) {
      metadataReads += 1;
      return metadataReads > 1 ? pending.promise : { thread: { id: "thread", capabilities: { desktopQuestionAnswers: false } } };
    }
    if (url.includes("/turns?")) return { turns: [{ id: "ended", status: "completed", items: [question], hasMoreItems: false }] };
    if (url.includes("/items?")) return { items: [question], hasMore: false };
    return reads(url);
  }, { runtime: { visibility: { hidden: true }, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, maxPolls: Infinity } });
  await runtime.open(); sockets[0].onopen(); await flush();
  await clock.advance(29999);
  assert.equal(metadataReads, 1);
  const probing = clock.advance(1); await flush();
  assert.equal(metadataReads, 2);
  runtime.dispose();
  pending.resolve({ thread: { id: "thread", capabilities: { desktopQuestionAnswers: true } } });
  await probing;
  assert.equal(store.state.thread.capabilities.desktopQuestionAnswers, false);
  assert.equal(clock.pending, 0);
});

test("answered desktop questions do not keep an otherwise idle capability probe alive", async () => {
  const clock = runtimeClock(), question = desktopQuestionItem();
  const answered = { id: "official-answer", type: "userMessage", text: buildQuestionAnswer(question.presentation.question, 0, "Keep going") };
  const { runtime, calls } = fixture((url) => {
    if (url.endsWith("/threads/thread")) return { thread: { id: "thread", capabilities: { desktopQuestionAnswers: false } } };
    if (url.includes("/turns?")) return { turns: [{ id: "ended", status: "completed", items: [question, answered], hasMoreItems: false }] };
    if (url.includes("/items?")) return { items: [question, answered], hasMore: false };
    return reads(url);
  }, { runtime: { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, maxPolls: Infinity } });
  try {
    await runtime.open(); await flush();
    const before = calls.length;
    assert.equal(clock.pendingReads, 0);
    await clock.advance(60000);
    assert.equal(calls.length, before);
  } finally { runtime.dispose(); }
});

function mountOwnedQuestionView(api = {}) {
  return mountThreadView({ ...api, request: (url, options) => {
    const handled = api.request?.(url, options);
    if (handled !== undefined) return handled;
    if (url === "/api/v2/codex/threads/thread/requests" && !options.method) return { requests: [
      { id: "question-owner", mode: "queue", state: "running", turnId: "active", input: { text: "started here" } }
    ] };
  } });
}
function questionProbe(harness, callId = "call_mobile_question") {
  return elements(harness.root, (node) => node.type === "item-display" && node.props.item.question?.callId === callId)[0];
}

test("a question in an externally owned desktop turn stays read-only and never queues a purported answer", async () => {
  const harness = await mountThreadView({ runtime: { maxPolls: 0 }, composerRead: () => ({ model: "model", followUpQueueMode: "queue", git: {} }), request: (url) => {
    if (url.includes("/turns?")) return { turns: [{ id: "active", status: "inProgress", items: [desktopQuestionItem()] }] };
  } });
  try {
    harness.chat.emit("update:draft", "ordinary draft"); await flush();
    assert.equal(harness.chat.props.canSend, true);
    assert.equal(harness.chat.props.canAnswerQuestions, false);
    assert.equal(questionProbe(harness).props.canAnswerQuestions, false);
    questionProbe(harness).props.onAnswer({ question: questionProbe(harness).props.item.question, index: 0, answer: "Keep going" }); await flush();
    assert.equal(harness.calls.filter((call) => call.method === "POST" && call.url.endsWith("/requests")).length, 0);
    assert.equal(harness.chat.props.draft, "ordinary draft");
  } finally { harness.close(); }
});

test("a discovered desktop owner accepts question replies without queueing, claiming ownership or touching drafts", async () => {
  const response = deferred();
  const harness = await mountThreadView({ runtime: { maxPolls: 0, newId: () => "desktop-answer" },
    composerRead: () => ({ model: "model", followUpQueueMode: "queue", git: {} }), request: (url, options) => {
      if (url === "/api/v2/codex/threads/thread") return { thread: { id: "thread", capabilities: { desktopQuestionAnswers: true } } };
      if (url.includes("/turns?")) return { turns: [{ id: "active", status: "inProgress", items: [desktopQuestionItem()] }] };
      if (url.endsWith("/questions/call_mobile_question/respond")) return response.promise;
      if (url === "/api/attachments/images") return { attachment: { id: "draft-image", url: "/draft-image" } };
    } });
  try {
    harness.chat.emit("update:draft", "ordinary draft");
    harness.chat.emit("add-attachments", { files: [new File(["png"], "draft.png", { type: "image/png" })], kindHint: "image" });
    await flush();
    const attachment = harness.chat.props.composerOptions.attachments[0];
    const probe = questionProbe(harness);
    assert.equal(probe.props.canAnswerQuestions, true);
    assert.equal(harness.chat.props.canInterrupt, false);
    const payload = { question: probe.props.item.question, index: 0, answer: "Keep going" };
    probe.props.onAnswer(payload); probe.props.onAnswer(payload); await flush();
    const posts = harness.calls.filter((call) => call.method === "POST" && call.url.includes("/api/v2/"));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, "/api/v2/codex/threads/thread/questions/call_mobile_question/respond");
    assert.deepEqual(JSON.parse(posts[0].body), { clientRequestId: "desktop-answer", expectedTurnId: "active", index: 0, answer: "Keep going" });
    const receipt = harness.store.state.requests["desktop-answer"];
    response.resolve({ request: { ...receipt, state: "accepted", turnId: "active" } }); await flush();
    assert.equal(harness.chat.props.canInterrupt, false, "desktop response receipt does not grant ordinary turn control");
    assert.equal(harness.chat.props.canSteer, false);
    assert.equal(harness.chat.props.draft, "ordinary draft");
    assert.equal(harness.chat.props.composerOptions.attachments[0], attachment);
    assert.equal(questionProbe(harness).props.item.question.pendingResponse, true);
    harness.store.upsertItem("active", { id: "official-answer", clientId: "desktop-answer", type: "userMessage", text: receipt.input.text });
    await flush();
    assert.equal(questionProbe(harness).props.item.question.status, "answered");
    const replies = harness.chat.props.threadSnapshot.turns.flatMap((turn) => turn.items).filter((item) => item.questionReplies);
    assert.equal(replies.length, 1);
  } finally { response.resolve({ request: {} }); harness.close(); }
});

test("failed desktop question answers stay on the question path and cannot be restored as queued ordinary text", async () => {
  const harness = await mountThreadView({ runtime: { maxPolls: 0, newId: () => "failed-desktop-answer" }, request: (url, options) => {
    if (url === "/api/v2/codex/threads/thread") return { thread: { id: "thread", capabilities: { desktopQuestionAnswers: true } } };
    if (url.includes("/turns?")) return { turns: [{ id: "active", status: "inProgress", items: [desktopQuestionItem()] }] };
    if (url.endsWith("/respond")) throw Object.assign(new Error("Desktop unavailable"), { status: 409 });
  } });
  try {
    const probe = questionProbe(harness);
    probe.props.onAnswer({ question: probe.props.item.question, index: 0, answer: "Keep going" }); await flush();
    const receipt = harness.store.state.requests["failed-desktop-answer"];
    assert.equal(receipt.state, "rejected");
    assert.equal(harness.runtime.restoreRequest(receipt.id), false);
    assert.equal(harness.chat.props.draft, "");
    assert.equal(questionProbe(harness).props.canAnswerQuestions, true);
    assert.equal(questionProbe(harness).props.item.question.pendingResponse, false);
    assert.equal(elements(harness.root, (node) => node.type === "button" && String(node.text || "").includes("恢复到输入框")).length, 0);
  } finally { harness.close(); }
});

test("an unanswered desktop question remains actionable after its original turn completes", async () => {
  const harness = await mountThreadView({ runtime: { maxPolls: 0 }, request: (url, options) => {
    if (url === "/api/v2/codex/threads/thread") return { thread: { id: "thread", capabilities: { desktopQuestionAnswers: true } } };
    if (url.includes("/turns?")) return { turns: [{ id: "ended", status: "completed", items: [desktopQuestionItem()] }] };
    if (url.endsWith("/respond")) return { request: { id: JSON.parse(options.body).clientRequestId, state: "accepted", executionRoute: "desktopQuestion", turnId: "new-turn" } };
  } });
  try {
    const probe = questionProbe(harness);
    assert.equal(probe.props.item.question.status, "pending");
    assert.equal(probe.props.canAnswerQuestions, true);
    probe.props.onAnswer({ question: probe.props.item.question, index: 0, answer: "Keep going" }); await flush();
    const posts = harness.calls.filter((call) => call.method === "POST");
    assert.equal(posts.length, 1);
    assert.ok(posts[0].url.endsWith("/questions/call_mobile_question/respond"));
    assert.equal(JSON.parse(posts[0].body).expectedTurnId, "ended");
    assert.equal(harness.chat.props.canInterrupt, false);
  } finally { harness.close(); }
});

for (const draft of ["", "a separate draft"]) test(`desktop question answers preserve ${draft ? "existing" : "empty"} text and image drafts and send one exact reply`, async () => {
  const response = deferred();
  const harness = await mountOwnedQuestionView({ runtime: { maxPolls: 0, newId: () => "question-answer" }, request: (url, options) => {
    if (url.includes("/turns?")) return { turns: [{ id: "active", status: "inProgress", items: [desktopQuestionItem()] }] };
    if (url.endsWith("/requests") && options.method === "POST") return response.promise;
    if (url === "/api/attachments/images") return { attachment: { id: "draft-image", url: "/draft-image" } };
  } });
  try {
    harness.chat.emit("update:draft", draft);
    harness.chat.emit("add-attachments", { files: [new File(["png"], "draft.png", { type: "image/png" })], kindHint: "image" });
    await flush();
    const before = harness.chat.props.composerOptions.attachments[0];
    const probe = questionProbe(harness);
    assert.equal(probe.props.canAnswerQuestions, true);
    // A stale or modified event must never replace the authoritative question title.
    const payload = { question: { ...probe.props.item.question, questions: [{ id: "0", title: "changed in an old event" }] }, index: 0, answer: "Keep going" };
    probe.props.onAnswer(payload); probe.props.onAnswer(payload); await flush();
    const posts = harness.calls.filter((call) => call.method === "POST" && call.url.endsWith("/requests"));
    assert.equal(posts.length, 1);
    const body = JSON.parse(posts[0].body);
    assert.deepEqual(Object.keys(body).sort(), ["clientRequestId", "expectedTurnId", "input", "mode", "options"]);
    assert.deepEqual(body.input.attachments, []);
    assert.deepEqual(body.options, {});
    assert.equal(body.mode, "steer");
    assert.equal(body.expectedTurnId, "active");
    assert.equal(body.input.text, '<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"call_mobile_question\\",0]","question":"Choose a direction","answer":"Keep going"}]\n</send_user_message_question_reply>');
    assert.deepEqual(harness.store.state.requests["question-answer"].previewImages, []);
    assert.equal(harness.chat.props.draft, draft);
    assert.equal(harness.chat.props.composerOptions.attachments[0], before);
    assert.equal(questionProbe(harness).props.canAnswerQuestions, false);
    response.resolve({ request: { id: "question-answer", state: "accepted", mode: "steer", turnId: "active", input: body.input } });
    await flush();
    assert.equal(questionProbe(harness).props.item.question.status, "pending");
    assert.equal(questionProbe(harness).props.item.question.pendingResponse, true);
    probe.props.onAnswer(payload); await flush();
    assert.equal(harness.calls.filter((call) => call.method === "POST" && call.url.endsWith("/requests")).length, 1);
    const answer = harness.chat.props.threadSnapshot.turns.flatMap((turn) => turn.items).find((item) => item.request?.id === "question-answer");
    assert.equal(answer.text, "回答：Keep going");
    assert.equal(elements(harness.root, (node) => node.props?.["aria-label"] === "待发送消息").length, 0);
    assert.equal(harness.chat.props.draft, draft);
    assert.equal(harness.chat.props.composerOptions.attachments[0], before);
  } finally { response.resolve({ request: { id: "question-answer", state: "accepted" } }); harness.close(); }
});

test("desktop question answers obey settings and unknown-receipt gates and recheck current question state", async () => {
  const settings = deferred();
  const harness = await mountOwnedQuestionView({ runtime: { maxPolls: 0 }, composerRead: () => settings.promise, request: (url) => {
    if (url.includes("/turns?")) return { turns: [{ id: "active", status: "inProgress", items: [desktopQuestionItem()] }] };
  } });
  try {
    const payload = { question: { callId: "call_mobile_question" }, index: 0, answer: "Keep going" };
    assert.equal(harness.chat.props.canAnswerQuestions, false);
    harness.chat.emit("question-answer", payload); await flush();
    settings.resolve({ model: "model", git: {} }); await flush();
    assert.equal(harness.chat.props.canAnswerQuestions, true, "question answering does not require a chat draft");
    harness.store.upsertRequest({ id: "unconfirmed", state: "unknown", input: { text: "unconfirmed earlier send" } }); await flush();
    assert.equal(harness.chat.props.canAnswerQuestions, false);
    harness.chat.emit("question-answer", payload); await flush();
    harness.store.upsertRequest({ id: "unconfirmed", state: "completed" }); await flush();
    harness.chat.emit("question-answer", { ...payload, question: { callId: "call_different" } });
    harness.chat.emit("question-answer", { ...payload, index: 7 });
    harness.chat.emit("question-answer", { ...payload, answer: " " }); await flush();
    harness.store.upsertTurn({ id: "active", status: "completed" }); await flush();
    harness.chat.emit("question-answer", payload); await flush();
    assert.equal(harness.calls.filter((call) => call.method === "POST" && call.url.endsWith("/requests")).length, 0);
  } finally { settings.resolve({ model: "model" }); harness.close(); }
});

test("an uncertain desktop question reply keeps its receipt and draft without a second send", async () => {
  const harness = await mountOwnedQuestionView({ runtime: { maxPolls: 0, newId: () => "uncertain-answer" }, request: (url, options) => {
    if (url.includes("/turns?")) return { turns: [{ id: "active", status: "inProgress", items: [desktopQuestionItem()] }] };
    if (url.endsWith("/requests") && options.method === "POST") throw Object.assign(new Error("gateway unavailable"), { status: 503 });
    if (url.endsWith("/requests/uncertain-answer")) throw Object.assign(new Error("receipt unavailable"), { status: 503 });
  } });
  try {
    harness.chat.emit("update:draft", "keep my message"); await flush();
    const payload = { question: questionProbe(harness).props.item.question, index: 0, answer: "Keep going" };
    harness.chat.emit("question-answer", payload); await flush();
    assert.equal(harness.store.state.requests["uncertain-answer"].state, "unknown");
    assert.equal(harness.chat.props.canAnswerQuestions, false);
    assert.equal(harness.chat.props.draft, "keep my message");
    harness.chat.emit("question-answer", payload); await flush();
    assert.equal(harness.calls.filter((call) => call.method === "POST" && call.url.endsWith("/requests")).length, 1);
    assert.equal(harness.calls.filter((call) => call.url.endsWith("/requests/uncertain-answer")).length, 1);
  } finally { harness.close(); }
});

test("each desktop question waits on its own receipt while another unanswered question remains available", async () => {
  let serial = 0;
  const harness = await mountOwnedQuestionView({ runtime: { maxPolls: 0, newId: () => `answer-${++serial}` }, request: (url, options) => {
    if (url.includes("/turns?")) return { turns: [{ id: "active", status: "inProgress", items: [desktopQuestionItem("call_mobile_question", {
      questions: [{ id: "0", title: "First question", options: [] }, { id: "1", title: "Second question", options: [] }]
    })] }] };
    if (url.endsWith("/requests") && options.method === "POST") {
      const body = JSON.parse(options.body);
      return { request: { id: body.clientRequestId, mode: "steer", state: "accepted", turnId: "active", input: body.input } };
    }
  } });
  try {
    const payload = { question: questionProbe(harness).props.item.question, index: 0, answer: "first answer" };
    harness.chat.emit("question-answer", payload); await flush();
    assert.equal(questionProbe(harness).props.item.question.pendingResponse, false);
    assert.deepEqual(questionProbe(harness).props.item.question.pendingResponses, { 0: "accepted" });
    harness.chat.emit("question-answer", payload); await flush();
    assert.equal(harness.calls.filter((call) => call.method === "POST" && call.url.endsWith("/requests")).length, 1);
    harness.chat.emit("question-answer", { ...payload, index: 1, answer: "second answer" }); await flush();
    assert.equal(harness.calls.filter((call) => call.method === "POST" && call.url.endsWith("/requests")).length, 2);
    assert.deepEqual(questionProbe(harness).props.item.question.pendingResponses, { 0: "accepted", 1: "accepted" });
    assert.equal(questionProbe(harness).props.item.question.pendingResponse, true);
    assert.equal(questionProbe(harness).props.item.question.status, "pending");
  } finally { harness.close(); }
});

test("an explicitly rejected desktop answer can be retried only by a new user action without losing the draft", async () => {
  let serial = 0, attempts = 0;
  const harness = await mountOwnedQuestionView({ runtime: { maxPolls: 0, newId: () => `answer-${++serial}` }, request: (url, options) => {
    if (url.includes("/turns?")) return { turns: [{ id: "active", status: "inProgress", items: [desktopQuestionItem()] }] };
    if (url.endsWith("/requests") && options.method === "POST") {
      if (++attempts === 1) throw Object.assign(new Error("not accepted"), { status: 403 });
      const body = JSON.parse(options.body);
      return { request: { id: body.clientRequestId, mode: "steer", state: "accepted", turnId: "active", input: body.input } };
    }
  } });
  try {
    harness.chat.emit("update:draft", "keep separate input"); await flush();
    const payload = { question: questionProbe(harness).props.item.question, index: 0, answer: "Keep going" };
    harness.chat.emit("question-answer", payload); await flush();
    assert.equal(harness.store.state.requests["answer-1"].state, "rejected");
    assert.equal(questionProbe(harness).props.item.question.pendingResponse, false);
    assert.equal(harness.chat.props.canAnswerQuestions, true);
    assert.equal(attempts, 1);
    harness.chat.emit("question-answer", payload); await flush();
    assert.equal(attempts, 2);
    assert.equal(harness.store.state.requests["answer-2"].state, "accepted");
    assert.equal(harness.chat.props.draft, "keep separate input");
  } finally { harness.close(); }
});

test("desktop answer persistence failure never POSTs and retains the ordinary draft", async () => {
  const harness = await mountOwnedQuestionView({ runtime: { maxPolls: 0 }, request: (url) => {
    if (url.includes("/turns?")) return { turns: [{ id: "active", status: "inProgress", items: [desktopQuestionItem()] }] };
  } });
  try {
    harness.chat.emit("update:draft", "keep separate input"); await flush();
    harness.storage.setItem = () => { throw new Error("quota"); };
    harness.chat.emit("question-answer", { question: questionProbe(harness).props.item.question, index: 0, answer: "Keep going" }); await flush();
    assert.match(harness.chat.props.statusText, /保存失败/);
    assert.equal(harness.chat.props.draft, "keep separate input");
    assert.equal(harness.chat.props.loading, false);
    assert.deepEqual(harness.store.state.requestOrder, ["question-owner"]);
    assert.equal(harness.calls.filter((call) => call.method === "POST" && call.url.endsWith("/requests")).length, 0);
  } finally { harness.close(); }
});

test("a late desktop question reply cannot change the next thread's draft or feedback", async () => {
  const pending = deferred();
  const harness = await mountOwnedQuestionView({ runtime: { maxPolls: 0, newId: () => "old-answer" }, request: (url, options) => {
    if (url.includes("/threads/thread/turns?")) return { turns: [{ id: "active", status: "inProgress", items: [desktopQuestionItem()] }] };
    if (url.endsWith("/requests") && options.method === "POST") return pending.promise;
    if (url.endsWith("/threads/next")) return { thread: { id: "next", name: "next", cwd: "/tmp" } };
  } });
  try {
    harness.chat.emit("update:draft", "old draft"); await flush();
    harness.chat.emit("question-answer", { question: questionProbe(harness).props.item.question, index: 0, answer: "Keep going" }); await flush();
    const body = JSON.parse(harness.calls.find((call) => call.method === "POST" && call.url.endsWith("/requests")).body);
    harness.switchThread("next"); await flush();
    harness.chat.emit("update:draft", "new draft"); await flush();
    pending.resolve({ request: { id: "old-answer", state: "accepted", mode: "steer", turnId: "active", input: body.input } }); await flush();
    assert.equal(harness.chat.props.draft, "new draft");
    assert.equal(harness.store.state.requests["old-answer"], undefined);
    assert.equal(submissionFeedback(harness), undefined);
    const old = JSON.parse(harness.storage.getItem("codex-chat-v2:thread"));
    assert.equal(old.draft.text, "old draft");
    assert.equal(old.requests.find((request) => request.id === "old-answer").state, "accepted");
  } finally { pending.resolve({ request: { id: "old-answer", state: "accepted" } }); harness.close(); }
});

test("changing settings while running stays local and makes the next manual send a new queued turn", async () => {
  const harness = await mountThreadView({ patch: () => assert.fail("must not change the running desktop"),
    request: (url, options) => {
      if (url.includes("/turns?")) return { turns: [{ id: "active", status: "inProgress", items: [] }] };
      if (url.endsWith("/requests") && !options.method) return { requests: [{ id: "owner", state: "running", turnId: "active" }] };
    } });
  try {
    assert.equal(harness.chat.props.canInterrupt, true);
    harness.chat.emit("update:composer-options", { model: "new-model", permissionMode: "manual-review" }); await flush();
    assert.equal(harness.chat.props.composerOptions.model, "new-model");
    assert.equal(harness.chat.props.followUpMode, "queue");
    assert.equal(harness.chat.props.canSteer, false);
    assert.equal(harness.calls.some((c) => c.method === "POST"), false);
    harness.chat.emit("update:draft", "next settings turn"); await flush();
    harness.chat.emit("submit", { mode: "steer" }); await flush();
    const sent = JSON.parse(harness.calls.find((c) => c.method === "POST").body);
    assert.equal(sent.mode, "queue"); assert.equal(sent.expectedTurnId, undefined);
    assert.deepEqual(sent.options, { model: "new-model", reasoningEffort: "high", permissionMode: "manual-review" });
    harness.chat.emit("update:composer-options", { model: "later-model" }); await flush();
    assert.equal(sent.options.model, "new-model");
  } finally { harness.close(); }
});

test("thread navigation restores local settings without applying them until a manual send", async () => {
  const harness = await mountThreadView({ patch: () => assert.fail("must not PATCH") });
  try {
    harness.chat.emit("update:composer-options", { reasoningEffort: "low" }); await flush();
    harness.switchThread("thread-two"); await flush();
    assert.equal(harness.chat.props.composerOptions.reasoningEffort, "high");
    harness.switchThread("thread"); await flush();
    assert.equal(harness.chat.props.composerOptions.reasoningEffort, "low");
    assert.equal(harness.calls.some((c) => c.method === "POST"), false);
  } finally { harness.close(); }
});

test("custom desktop permissions require an explicit choice instead of sending a mapped default with a model change", async () => {
  const harness = await mountThreadView({ composerRead: () => ({ model: "model", reasoningEffort: "high", permissionMode: "default", permissionPolicyUnsupported: true, git: {} }) });
  try {
    harness.chat.emit("update:composer-options", { model: "new-model" }); await flush();
    harness.chat.emit("update:draft", "custom permissions"); await flush(); harness.chat.emit("submit"); await flush();
    const posts = () => harness.calls.filter((c) => c.method === "POST");
    assert.equal(Object.hasOwn(JSON.parse(posts()[0].body).options, "permissionMode"), false);
    harness.chat.emit("update:composer-options", { permissionMode: "default" }); await flush();
    harness.chat.emit("update:draft", "explicit permissions"); await flush(); harness.chat.emit("submit"); await flush();
    assert.equal(JSON.parse(posts()[1].body).options.permissionMode, "default");
  } finally { harness.close(); }
});

test('review baseline survives a later unchanged turn', async () => {
 const harness=await mountThreadView({runtime:{maxPolls:0}});
 try {
  harness.chat.emit('update:composer-options',{model:'new-model'}); await flush();
  const options={model:'new-model',reasoningEffort:'high',permissionMode:'default'};
  harness.store.upsertTurn({id:'changed-turn',status:'inProgress',items:[]});
  harness.store.upsertRequest({id:'changed-request',mode:'queue',state:'running',turnId:'changed-turn',options}); await flush();
  assert.equal(harness.chat.props.followUpMode,'steer');
  harness.store.upsertTurn({id:'changed-turn',status:'completed'});
  harness.store.upsertRequest({id:'changed-request',mode:'queue',state:'completed',turnId:'changed-turn',options});
  harness.store.upsertTurn({id:'unchanged-turn',status:'inProgress',items:[]});
  harness.store.upsertRequest({id:'unchanged-request',mode:'queue',state:'running',turnId:'unchanged-turn',options:{}}); await flush();
  assert.equal(harness.chat.props.followUpMode,'steer','no new selection should retain configured steer');
 } finally {harness.close();}
});

test('r40 review stop-only capability does not enable queued steering', async()=>{
 const harness=await mountThreadView({runtime:{maxPolls:0},request:(url,options)=>{
 if(url.endsWith('/threads/thread'))return{thread:{id:'thread',capabilities:{desktopInterrupt:true,desktopQuestionAnswers:false}}};
 if(url.includes('/turns?'))return{turns:[{id:'desktop-active',status:'inProgress',items:[]}]};
 if(url.endsWith('/requests')&&!options.method)return{requests:[{id:'waiting-request',state:'received',mode:'queue',initialPlacement:'composer',input:{text:'queued for desktop',attachments:[]}}]};
 }});
 try{assert.equal(harness.chat.props.canInterrupt,true);assert.equal(harness.chat.props.canSteer,false);
 const guide=elements(harness.root,node=>node.props?.['aria-label']==='引导排队消息：queued for desktop')[0];assert.equal(guide.props.disabled,true);assert.match(nodeText(harness.root),/正在连接当前任务/);
 }finally{harness.close();}
});
 test('r40 review stopped desktop discovery recovers during active polling', async()=>{
 const clock=runtimeClock();let online=false,metadataReads=0;
 const harness=await mountThreadView({runtime:{now:clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer},request:(url)=>{
 if(url.endsWith('/threads/thread')){metadataReads++;return{thread:{id:'thread',capabilities:{desktopInterrupt:online,desktopQuestionAnswers:false}}};}
 if(url.includes('/turns?'))return{turns:[{id:'desktop-active',status:'inProgress',items:[]}]};
 }});
 try{await clock.advance(3000);assert.equal(harness.chat.props.canInterrupt,false);const before=metadataReads;online=true;await clock.advance(30000);assert.ok(metadataReads>before,'active desktop should recheck a missing stop capability');assert.equal(harness.chat.props.canInterrupt,true);
 }finally{harness.close();}
});

test("a bounded completion rereads final detail without shrinking the running full text", async () => {
  let completed = false;
  const initialText = "long response ".repeat(1500);
  const summary = () => ({ id: "answer", type: "agentMessage", status: completed ? "completed" : "inProgress",
    hasDetails: true, truncated: true, presentation: { text: initialText.slice(0, 100) } });
  const { runtime, store, calls } = fixture((url) => {
    if (url.includes("/turns?")) return { turns: [{ id: "turn", status: "inProgress", items: [summary()] }] };
    if (url.includes("/items?")) return { items: [summary()], hasMore: false };
    if (url.endsWith("/items/answer")) return { item: { ...summary(), hasDetails: false, truncated: false,
      presentation: { text: initialText + (completed ? "FINAL SUFFIX" : "") } } };
    return reads(url);
  });
  try {
    await runtime.open(); await flush();
    assert.equal(store.state.turns.turn.items.answer.presentation.text, initialText);
    const before = calls.filter((call) => call.url.endsWith("/items/answer")).length;
    completed = true;
    store.applyTurnsPage({ turns: [{ id: "turn", items: [summary()] }] });
    assert.equal(store.state.turns.turn.items.answer.presentation.text, initialText);
    await runtime.setDetailVisibility([{ turnId: "turn", itemId: "answer" }]);
    assert.equal(calls.filter((call) => call.url.endsWith("/items/answer")).length, before + 1);
    assert.equal(store.state.turns.turn.items.answer.presentation.text, initialText + "FINAL SUFFIX");
  } finally { runtime.dispose(); }
});


test("queued settings explain next-turn execution instead of advertising unavailable guidance", async () => {
  const harness = await mountThreadView({ request: (url, options) => {
    if (url.endsWith("/requests") && !options.method) return { requests: [{ id: "settings-waiting", state: "received",
      mode: "queue", executionRoute: "settingsQueue", initialPlacement: "composer", options: { model: "next-model" },
      input: { text: "use new settings", attachments: [] } }] };
  } });
  try {
    assert.match(nodeText(harness.root), /包含新设置，等待下一轮执行/);
    assert.equal(elements(harness.root, (node) => node.props?.["aria-label"] === "引导排队消息：use new settings").length, 0);
    assert.equal(elements(harness.root, (node) => node.props?.["aria-label"] === "撤回排队消息：use new settings").length, 1);
    assert.equal(harness.calls.filter((call) => call.url.endsWith("/steer")).length, 0);
  } finally { harness.close(); }
});


test("phone guidance promotes a desktop queue receipt without enabling web-owned controls", async () => {
  const pending = deferred();
  const original = { id: "mobile-queued", mode: "queue", state: "queued", executionRoute: "desktopQueue",
    input: { text: "guide from phone", attachments: [] } };
  const harness = await mountThreadView({ request: (url, options) => {
    if (url.endsWith("/threads/thread")) return { thread: { id: "thread", capabilities: { desktopQueuedSteer: true, desktopInterrupt: true } } };
    if (url.includes("/turns?")) return { turns: [{ id: "desktop-active", status: "inProgress", items: [] }] };
    if (url.endsWith("/requests") && !options.method) return { requests: [original] };
    if (url.endsWith("/requests/mobile-queued/steer")) return pending.promise;
  } });
  try {
    harness.chat.emit("update:draft", "keep draft"); await flush();
    const guide = elements(harness.root, (node) => node.props?.["aria-label"] === "引导排队消息：guide from phone")[0];
    assert.equal(guide.props.disabled, false);
    guide.props.onClick(); guide.props.onClick(); await flush();
    assert.equal(harness.calls.filter((call) => call.url.endsWith("/requests/mobile-queued/steer")).length, 1);
    const call = harness.calls.find((call) => call.url.endsWith("/requests/mobile-queued/steer"));
    assert.deepEqual(JSON.parse(call.body), { expectedTurnId: "desktop-active" });
    pending.resolve({ request: { ...original, state: "accepted", mode: "steer", executionRoute: "desktopSteer", turnId: "desktop-active" } });
    await flush();
    assert.equal(harness.chat.props.draft, "keep draft");
    assert.equal(harness.chat.props.canSteer, false, "desktop acceptance must not grant web ownership");
    assert.equal(harness.store.state.requests["mobile-queued"].state, "accepted");
    assert.equal(elements(harness.root, (node) => node.props?.["aria-label"] === "引导排队消息：guide from phone").length, 0);
  } finally { pending.resolve({ request: original }); harness.close(); }
});
