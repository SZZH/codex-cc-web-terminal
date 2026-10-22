import test from "node:test";
import assert from "node:assert/strict";
import { createCodexChatStore } from "../web/src/lib/codex-chat-store.js";
import { createCodexChatRuntime } from "../web/src/lib/codex-chat-runtime.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
function fixture(handler = () => undefined) {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  const store = createCodexChatStore("thread", { storage });
  const calls = [];
  const timers = new Map();
  let nextTimer = 0;
  const runtime = createCodexChatRuntime({ store, maxPolls: 0, visibility: null,
    newId: () => "request-1", setTimer(callback, delay) {
      timers.set(++nextTimer, { callback, delay }); return nextTimer;
    }, clearTimer: (id) => timers.delete(id), request(path, options = {}) {
      const result = handler(path, options);
      if (result !== undefined) return Promise.resolve(result);
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const call = { path, options, resolve, reject };
      calls.push(call);
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      return promise;
    } });
  function drain() {
    for (const call of calls) {
      call.resolve(call.options.method === "POST" ? { request: { id: "request-1", threadId: "thread", state: "accepted" } }
        : call.path.endsWith("/requests") ? { requests: [] }
          : call.path.includes("/items?") ? { items: [], hasMore: false }
            : call.path.includes("/turns?") ? { turns: [], hasMore: false }
              : { thread: { id: "thread" } });
    }
  }
  return { store, runtime, calls, timers, storage, drain };
}

for (const status of [408, 500, 502, 503, 504]) {
  test(`HTTP ${status} after acceptance checks the original request instead of permitting a duplicate`, async () => {
    let submissions = 0, checks = 0;
    const accepted = { id: "request-1", threadId: "thread", state: "accepted", turnId: "turn" };
    const { runtime, store, storage } = fixture((path, options) => {
      if (options.method === "POST") {
        submissions += 1;
        assert.equal(JSON.parse(options.body).clientRequestId, accepted.id);
        throw Object.assign(new Error("upstream response unavailable"), { status });
      }
      assert.ok(path.endsWith(`/requests/${accepted.id}`));
      checks += 1;
      return { request: accepted };
    });
    try {
      store.setDraft({ text: "execute once" });
      const receipt = await runtime.submit({ input: { text: "execute once", attachments: [] }, options: {} });
      assert.equal(receipt.state, "accepted");
      assert.equal(checks, 1);
      assert.equal(submissions, 1);
      assert.equal(runtime.restoreRequest(accepted.id), false);
      const reopened = createCodexChatStore("thread", { storage });
      assert.equal(reopened.state.requests[accepted.id].state, "accepted");
      assert.equal(reopened.state.draft.text, "");
    } finally { runtime.dispose(); }
  });
}

test("a client clock ahead or behind the server cannot leave an acknowledged send pending", async () => {
  const RealDate = Date;
  const serverNow = 1800000000000;
  try {
    for (const offset of [-60000, 60000]) {
      globalThis.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : [serverNow + offset])); }
        static now() { return serverNow + offset; }
      };
      let posts = 0;
      const { runtime, store, storage } = fixture((_path, options) => {
        assert.equal(options.method, "POST"); posts += 1;
        return { request: { id: "request-1", state: "accepted", turnId: "turn", updatedAt: new RealDate(serverNow).toISOString() } };
      });
      try {
        await runtime.submit({ input: { text: "once", attachments: [] }, options: {} });
        assert.equal(store.state.requests["request-1"].state, "accepted");
        assert.equal(createCodexChatStore("thread", { storage }).state.requests["request-1"].state, "accepted");
        assert.equal(posts, 1);
      } finally { runtime.dispose(); }
    }
  } finally { globalThis.Date = RealDate; }
});

test("an observed server acceptance does not regress while a late gateway failure is reconciled", async () => {
  const RealDate = Date;
  const serverNow = 1800000000000;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [serverNow + 60000])); }
    static now() { return serverNow + 60000; }
  };
  let store;
  const accepted = { id: "request-1", state: "accepted", turnId: "turn", updatedAt: new RealDate(serverNow).toISOString() };
  const f = fixture((_path, options) => {
    if (options.method !== "POST") return undefined;
    store.upsertRequest(accepted);
    throw Object.assign(new Error("late gateway failure"), { status: 502 });
  });
  store = f.store;
  const submission = f.runtime.submit({ input: { text: "once", attachments: [] }, options: {} });
  try {
    await flush();
    assert.equal(store.state.requests["request-1"].state, "accepted");
    assert.equal(f.calls.length, 1);
    f.calls[0].resolve({ request: accepted });
    await submission;
    assert.equal(store.state.requests["request-1"].state, "accepted");
  } finally {
    f.runtime.dispose(); f.drain(); await submission;
    globalThis.Date = RealDate;
  }
});

for (const state of ["received", "dispatching", "queued", "accepted", "running"]) {
  for (const status of [404, 503]) {
    test(`receipt GET ${status} cannot downgrade a confirmed ${state} after a gateway failure`, async () => {
      let store, checks = 0, posts = 0;
      const confirmed = { id: "request-1", state, turnId: "turn", localOnly: false };
      const f = fixture((_path, options) => {
        if (options.method === "POST") {
          posts += 1;
          store.upsertRequest(confirmed);
          throw Object.assign(new Error("late gateway failure"), { status: 502 });
        }
        checks += 1;
        throw Object.assign(new Error("receipt read unavailable"), { status });
      });
      store = f.store;
      try {
        await f.runtime.submit({ input: { text: "once", attachments: [] }, options: {} });
        assert.equal(store.state.requests[confirmed.id].state, state);
        assert.notEqual(store.state.requests[confirmed.id].error?.code, "receipt_not_found");
        assert.equal(createCodexChatStore("thread", { storage: f.storage }).state.requests[confirmed.id].state, state);
        assert.equal(f.runtime.restoreRequest(confirmed.id), false);
        assert.equal(await f.runtime.dismissUnknownReceipt(confirmed.id), false);
        assert.equal(checks, 1);
        assert.equal(posts, 1);
      } finally { f.runtime.dispose(); }
    });
  }
}

test("an already unknown server receipt still requires a fresh 404 before explicit unlock", async () => {
  let checks = 0;
  const { runtime, store } = fixture((_path, options) => {
    assert.notEqual(options.method, "POST");
    checks += 1;
    throw Object.assign(new Error("receipt missing"), { status: 404 });
  });
  store.upsertRequest({ id: "unknown", state: "unknown", localOnly: false, input: { text: "keep original" } });
  try {
    await runtime.checkRequest("unknown");
    assert.equal(store.state.requests.unknown.state, "unknown");
    assert.equal(store.state.requests.unknown.error.code, "receipt_not_found");
    assert.equal(await runtime.dismissUnknownReceipt("unknown"), true);
    assert.equal(store.state.requests.unknown.confirmationDismissed, true);
    assert.equal(store.state.requests.unknown.input.text, "keep original");
    assert.equal(checks, 2);
  } finally { runtime.dispose(); }
});

test("an unavailable receipt after a gateway error remains unknown and cannot be restored as a failed send", async () => {
  let submissions = 0, checks = 0;
  const { runtime, store } = fixture((_path, options) => {
    if (options.method === "POST") {
      submissions += 1;
      throw Object.assign(new Error("gateway timeout"), { status: 504 });
    }
    checks += 1;
    throw Object.assign(new Error("receipt not found"), { status: 404 });
  });
  try {
    const receipt = await runtime.submit({ input: { text: "uncertain send", attachments: [] }, options: {} });
    assert.equal(receipt.state, "unknown");
    assert.equal(receipt.error.code, "receipt_not_found");
    assert.equal(runtime.restoreRequest(receipt.id), false);
    await assert.rejects(runtime.submit({ input: { text: "uncertain send", attachments: [] }, options: {} }), /尚未确认/);
    assert.equal(store.state.requests[receipt.id].input.text, "uncertain send");
    assert.equal(submissions, 1);
    assert.equal(checks, 1);
  } finally { runtime.dispose(); }
});

for (const status of [400, 403, 409, 422]) {
  test(`definitive HTTP ${status} rejection remains recoverable without probing or resending`, async () => {
    let submissions = 0;
    const { runtime, store } = fixture((_path, options) => {
      assert.equal(options.method, "POST");
      submissions += 1;
      throw Object.assign(new Error("input rejected"), { status });
    });
    try {
      const receipt = await runtime.submit({ input: { text: "rejected send", attachments: [] }, options: {} });
      assert.equal(receipt.state, "rejected");
      assert.equal(runtime.restoreRequest(receipt.id), true);
      assert.equal(store.state.draft.text, "rejected send");
      assert.equal(submissions, 1);
    } finally { runtime.dispose(); }
  });
}

test("disposing an opening thread aborts all four pending reads and clears their deadlines", async () => {
  const { runtime, store, calls, timers, drain } = fixture();
  const opening = runtime.open();
  try {
    await flush();
    assert.equal(calls.length, 4);
    assert.equal(calls.filter((call) => call.path.endsWith("/interactions")).length, 1);
    assert.equal(timers.size, 8);
    runtime.dispose();
    assert.equal(calls.filter((call) => call.options.signal.aborted).length, 4);
    await opening;
    assert.equal(timers.size, 0);
    assert.equal(store.state.thread, null);
    assert.deepEqual(store.state.turnOrder, []);
    assert.equal(store.state.requestListReady, false);
    assert.equal(store.state.error, "");
    assert.equal(store.state.requestListError, "");
  } finally { runtime.dispose(); drain(); await opening; }
});

test("disposing settles reads even if an injected transport ignores its abort signal", async () => {
  const signals = [];
  const { runtime, timers } = fixture((_path, options) => {
    signals.push(options.signal);
    return new Promise(() => {});
  });
  let settled = false;
  const opening = runtime.open().then(() => { settled = true; });
  try {
    await flush();
    runtime.dispose();
    await flush();
    assert.equal(settled, true);
    assert.equal(signals.length, 4);
    assert.ok(signals.every((signal) => signal.aborted));
    assert.equal(timers.size, 0);
    await opening;
  } finally { runtime.dispose(); }
});

test("disposing hydration aborts active item pages without starting queued turns", async () => {
  const turns = ["one", "two", "three", "four"].map((id) => ({ id, status: "completed", items: [] }));
  const { runtime, calls, drain, timers } = fixture((path) => {
    if (path.includes("/items?")) return undefined;
    if (path.endsWith("/requests")) return { requests: [] };
    if (path.includes("/turns?")) return { turns, hasMore: false };
    return { thread: { id: "thread" } };
  });
  let syncs = [];
  try {
    await runtime.open(); await flush();
    syncs = turns.map((turn) => runtime.setTurnVisibility(turn.id, true));
    await flush();
    assert.equal(calls.length, 2);
    runtime.dispose();
    assert.ok(calls.every((call) => call.options.signal.aborted));
    await Promise.all(syncs);
    await assert.rejects(runtime.loadItems("one"), { name: "AbortError" });
    assert.equal(calls.length, 2);
    assert.equal(timers.size, 0);
  } finally { runtime.dispose(); drain(); await Promise.all(syncs); }
});

test("disposing detail reads cancels active downloads and releases queued details", async () => {
  const { runtime, store, calls, timers, drain } = fixture();
  store.upsertTurn({ id: "turn", status: "completed", items: ["a", "b", "c"].map((id) =>
    ({ id, type: "commandExecution", hasDetails: true })) });
  const details = ["a", "b", "c"].map((id) => runtime.loadDetail("turn", id));
  try {
    await flush();
    assert.equal(calls.length, 2);
    runtime.dispose();
    assert.ok(calls.every((call) => call.options.signal.aborted));
    await Promise.all(details);
    assert.equal(calls.length, 2);
    assert.equal(timers.size, 0);
    assert.equal(store.state.turns.turn.items.a.detailsLoaded, undefined);
    assert.equal(store.state.turns.turn.items.a.detailError, undefined);
  } finally { runtime.dispose(); drain(); await Promise.all(details); }
});

test("disposing reads preserves an in-flight send and records its single definitive receipt", async () => {
  const { runtime, store, calls, timers, drain } = fixture();
  store.setDraft({ text: "send once" });
  const submission = runtime.submit({ input: { text: "send once", attachments: [] }, options: {} });
  const reading = runtime.refreshLatest();
  try {
    await flush();
    const mutation = calls.find((call) => call.options.method === "POST");
    const reads = calls.filter((call) => call !== mutation);
    assert.equal(reads.length, 4);
    assert.equal(reads.filter((call) => call.path.endsWith("/interactions")).length, 1);
    runtime.dispose();
    assert.ok(reads.every((call) => call.options.signal.aborted));
    assert.equal(mutation.options.signal.aborted, false);
    await reading;
    assert.equal(timers.size, 1);
    mutation.resolve({ request: { id: "request-1", threadId: "thread", state: "accepted" } });
    await submission;
    assert.equal(store.state.requests["request-1"].state, "accepted");
    assert.equal(calls.filter((call) => call.options.method === "POST").length, 1);
    assert.equal(calls.some((call) => call.path.endsWith("/interrupt")), false);
    assert.equal(timers.size, 0);
  } finally { runtime.dispose(); drain(); await Promise.all([submission, reading]); }
});

test("a send still expires at 15 seconds and checks its receipt without posting again", async () => {
  const accepted = { id: "request-1", threadId: "thread", state: "accepted", turnId: "turn" };
  let checks = 0;
  const { runtime, store, calls, timers, drain } = fixture((path, options) => {
    if (options.method === "POST") return undefined;
    assert.ok(path.endsWith("/requests/request-1"));
    checks += 1;
    return { request: accepted };
  });
  const submission = runtime.submit({ input: { text: "send once", attachments: [] }, options: {} });
  try {
    await flush();
    assert.equal(calls.length, 1);
    const sendDeadline = [...timers.values()].find((timer) => timer.delay === 15000);
    assert.ok(sendDeadline);
    sendDeadline.callback();
    const receipt = await submission;
    assert.equal(receipt.state, "accepted");
    assert.equal(store.state.requests["request-1"].state, "accepted");
    assert.equal(checks, 1);
    assert.equal(calls.filter((call) => call.options.method === "POST").length, 1);
    assert.equal(calls[0].options.signal.aborted, true);
    assert.equal(calls[0].options.signal.reason.message, "连接超时，发送状态将自动核对。");
    assert.equal(timers.size, 0);
  } finally { runtime.dispose(); drain(); await submission; }
});

for (const outcome of ["accepted", "rejected", "unknown"]) {
  test(`a detached ${outcome} send preserves the new context draft and other receipts`, async () => {
    const { runtime, store, calls, timers, storage, drain } = fixture();
    store.setDraft({ text: "original send" });
    const submission = runtime.submit({ input: { text: "original send", attachments: [] }, options: {} });
    try {
      await flush();
      const mutation = calls.find((call) => call.options.method === "POST");
      runtime.dispose();
      const current = createCodexChatStore("thread", { storage });
      current.setDraft({ text: "new context draft", attachments: [
        { id: "local-image", uploadedId: "new-image", kind: "image", name: "new.png", url: "/api/attachments/images/new-image" }
      ] });
      current.upsertRequest({ id: "new-request", state: "queued", input: { text: "another send" } });
      const draft = JSON.parse(storage.getItem(store.storageKey)).draft;
      if (outcome === "accepted") mutation.resolve({ request: { id: "request-1", state: "accepted" } });
      else mutation.reject(outcome === "rejected" ? Object.assign(new Error("definitive rejection"), { status: 400 }) : new TypeError("network lost"));
      await submission;
      let saved = JSON.parse(storage.getItem(store.storageKey));
      assert.deepEqual(saved.draft, draft);
      assert.equal(saved.requests.find((request) => request.id === "new-request").state, "queued");
      assert.equal(saved.requests.find((request) => request.id === "request-1").state, outcome);
      assert.equal(saved.requests.find((request) => request.id === "request-1").input.text, "original send");
      current.setDraft({ text: "new context draft after receipt" });
      saved = JSON.parse(storage.getItem(store.storageKey));
      assert.equal(saved.requests.find((request) => request.id === "request-1").state, outcome);
      assert.equal(saved.draft.attachments[0].uploadedId, "new-image");
      assert.equal(mutation.options.signal.aborted, false);
      assert.equal(calls.filter((call) => call.options.method === "POST").length, 1);
      assert.equal(calls.length, 1);
      assert.equal(timers.size, 0);
    } finally { runtime.dispose(); drain(); await submission; }
  });
}

test("a late successful send cannot roll back the new context's completed receipt", async () => {
  const { runtime, store, calls, storage, drain } = fixture();
  const submission = runtime.submit({ input: { text: "once", attachments: [] }, options: {} });
  try {
    await flush();
    runtime.dispose();
    const current = createCodexChatStore("thread", { storage });
    current.upsertRequest({ id: "request-1", state: "completed", turnId: "finished-turn" });
    current.setDraft({ text: "latest" });
    calls[0].resolve({ request: { id: "request-1", state: "accepted" } });
    await submission;
    const restored = createCodexChatStore("thread", { storage });
    assert.equal(restored.state.requests["request-1"].state, "completed");
    assert.equal(restored.state.requests["request-1"].turnId, "finished-turn");
    assert.equal(restored.state.draft.text, "latest");
  } finally { runtime.dispose(); drain(); await submission; }
});

test("disposing an old runtime again cannot write over a newer context", () => {
  const { runtime, store, storage } = fixture();
  store.setDraft({ text: "old draft" });
  runtime.dispose();
  const current = createCodexChatStore("thread", { storage });
  current.setDraft({ text: "new draft" });
  const saved = storage.getItem(store.storageKey);
  runtime.dispose();
  assert.equal(storage.getItem(store.storageKey), saved);
});
