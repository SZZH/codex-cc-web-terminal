import test from "node:test";
import assert from "node:assert/strict";
import { createCodexInteractionState } from "../web/src/lib/codex-interactions/state.js";
import { createCodexInteractionRuntime, createInteractionResponseId } from "../web/src/lib/codex-interactions/runtime.js";
import { createCodexChatStore } from "../web/src/lib/codex-chat-store.js";
import { createCodexChatRuntime } from "../web/src/lib/codex-chat-runtime.js";

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const row = (patch = {}) => ({ id: "one", threadId: "thread", turnId: "turn", itemId: "item", method: "item/tool/requestUserInput",
  params: { isBlocking: true, questions: [{ id: "question", question: "Which?" }] }, status: "pending", version: 1, ...patch });
const packet = (interaction, revision = interaction.version) => ({ interaction, epoch: "registry", revision });
function fixture(handler) {
  const calls = [], store = createCodexInteractionState("thread");
  store.applySnapshot({ interactions: [row()], epoch: "registry", revision: 1 });
  const runtime = createCodexInteractionRuntime({ store, base: "/thread", newId: () => "response-id", call: async (url, options = {}) => {
    calls.push({ url, ...options }); return handler(url, options);
  } });
  return { store, runtime, calls };
}

test("response IDs remain valid UUIDs without randomUUID on an HTTP browser origin", () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(createInteractionResponseId({ getRandomValues(bytes) { bytes.fill(7); } }), uuid);
  assert.match(createInteractionResponseId({}), uuid);
});

test("a response uses its original handle, deduplicates clicks and clears answers after submission", async () => {
  const pending = deferred();
  const { runtime, store, calls } = fixture(() => pending.promise);
  store.setDraft("one", { question: "secret" });
  const response = { answers: { question: { answers: ["secret"] } } };
  const first = runtime.respond("one", response), second = runtime.respond("one", response);
  assert.equal(first, second);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/thread/interactions/one/respond");
  assert.deepEqual(JSON.parse(calls[0].body), { responseId: "response-id", response });
  pending.resolve(packet(row({ status: "submitted", version: 2 })));
  await first;
  assert.equal(store.state.interactions.one.status, "submitted");
  assert.equal(store.state.drafts.one, undefined);
  assert.equal(await runtime.respond("one", response), null);
  runtime.dispose();
});

test("lost mutation responses become unknown and only GET checks the original interaction", async () => {
  const { runtime, store, calls } = fixture((url, options) => {
    if (options.method === "POST") throw new Error("connection lost");
    return packet(row({ status: "resolved", version: 3 }));
  });
  await runtime.respond("one", { answers: {} });
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(calls[1].url, "/thread/interactions/one");
  assert.equal(store.state.interactions.one.status, "resolved");
  runtime.dispose();
});

test("a stale pending GET never unlocks a response whose delivery remains unknown", async () => {
  const { runtime, store, calls } = fixture((url, options) => {
    if (options.method === "POST") throw new Error("timeout");
    return packet(row());
  });
  await runtime.respond("one", { answers: {} });
  assert.equal(store.state.actions.one.status, "unknown");
  await runtime.respond("one", { answers: {} });
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  runtime.dispose();
});

test("already-handled conflicts reconcile without treating the action as declined", async () => {
  const { runtime, store, calls } = fixture((url, options) => {
    if (options.method === "POST") throw Object.assign(new Error("handled elsewhere"), { status: 409 });
    return packet(row({ status: "resolved", version: 2 }));
  });
  await runtime.respond("one", { answers: {} });
  assert.equal(store.state.interactions.one.status, "resolved");
  assert.equal(calls.length, 2);
  assert.equal(store.state.responseErrors.one, undefined);
  runtime.dispose();
});

test("failed refresh retains pending, and disposed reads cannot publish or restore secrets", async () => {
  const pending = deferred();
  let count = 0;
  const { runtime, store } = fixture(() => ++count === 1 ? Promise.reject(new Error("read failed")) : pending.promise);
  await runtime.refresh();
  assert.match(store.state.error, /交互读取失败/);
  assert.equal(store.state.interactions.one.status, "pending");
  store.setDraft("one", { question: "secret" });
  const refresh = runtime.refresh();
  runtime.dispose();
  pending.resolve({ interactions: [row({ status: "resolved", version: 2 })], epoch: "registry", revision: 2 });
  await refresh;
  assert.equal(store.state.interactions.one.status, "pending");
  assert.deepEqual(Object.keys(store.state.drafts), []);
});

test("a multi-client resolved event wins a late failed response without leaving unknown actions", async () => {
  const pending = deferred();
  const { runtime, store, calls } = fixture(() => pending.promise);
  const response = runtime.respond("one", { answers: {} });
  store.applyUpdate(packet(row({ status: "resolved", version: 3 })));
  pending.reject(new Error("late connection lost"));
  await response;
  assert.equal(store.state.interactions.one.status, "resolved");
  assert.equal(store.state.actions.one, undefined);
  assert.equal(calls.length, 1);
  runtime.dispose();
});

test("late POST failures and successes cannot revive actions after removal or an epoch reset", async (t) => {
  for (const epoch of ["registry", "replacement"]) for (const outcome of ["failure", "success"]) {
    await t.test(`${epoch}: ${outcome}`, async () => {
      const pending = deferred();
      const { runtime, store, calls } = fixture(() => pending.promise);
      store.setDraft("one", { question: "secret" });
      const response = runtime.respond("one", { answers: {} });
      store.applySnapshot({ interactions: [], epoch, revision: 2 });
      store.applySnapshot({ interactions: [], epoch, revision: 3 });
      if (outcome === "failure") pending.reject(new Error("late connection lost"));
      else pending.resolve(packet(row({ status: "submitted", version: 8 })));
      assert.equal(await response, null);
      assert.equal(store.state.interactions.one, undefined);
      assert.deepEqual(Object.keys(store.state.actions), []);
      assert.deepEqual(Object.keys(store.state.responseErrors), []);
      assert.deepEqual(Object.keys(store.state.drafts), []);
      assert.equal(runtime.needsRecovery(), false);
      assert.equal(calls.length, 1);
      runtime.dispose();
    });
  }
});

test("late POST completion cannot change or deduplicate a replacement request with the same handle", async (t) => {
  for (const outcome of ["failure", "success"]) await t.test(outcome, async () => {
    const old = deferred(), current = deferred();
    const { runtime, store, calls } = fixture(() => calls.length === 1 ? old.promise : current.promise);
    const previous = runtime.respond("one", { answers: {} });
    store.applySnapshot({ interactions: [row({ itemId: "replacement-item" })], epoch: "replacement", revision: 1 });
    store.setDraft("one", { question: "new answer" });
    const next = runtime.respond("one", { answers: {} });
    assert.notEqual(previous, next);
    assert.equal(calls.length, 2);
    if (outcome === "failure") old.reject(Object.assign(new Error("old rejection"), { status: 400 }));
    else old.resolve(packet(row({ status: "submitted", version: 8 })));
    await previous;
    assert.equal(store.state.epoch, "replacement");
    assert.equal(store.state.interactions.one.itemId, "replacement-item");
    assert.equal(store.state.actions.one.status, "submitting");
    assert.equal(store.state.drafts.one.question, "new answer");
    assert.equal(store.state.responseErrors.one, undefined);
    assert.equal(runtime.respond("one", { answers: {} }), next);
    current.resolve({ ...packet(row({ itemId: "replacement-item", status: "submitted", version: 2 })), epoch: "replacement" });
    await next;
    assert.equal(store.state.interactions.one.status, "submitted");
    runtime.dispose();
  });
});

test("late checks cannot publish errors or restore rows after removal or an epoch reset", async (t) => {
  for (const epoch of ["registry", "replacement"]) for (const outcome of ["failure", "success"]) {
    await t.test(`${epoch}: ${outcome}`, async () => {
      const pending = deferred();
      const { runtime, store } = fixture(() => pending.promise);
      const check = runtime.check("one");
      store.applySnapshot({ interactions: [], epoch, revision: 2 });
      store.applySnapshot({ interactions: [], epoch, revision: 3 });
      if (outcome === "failure") pending.reject(Object.assign(new Error("gone"), { status: 404 }));
      else pending.resolve(packet(row({ status: "resolved", version: 8 })));
      assert.equal(await check, null);
      assert.equal(store.state.interactions.one, undefined);
      assert.deepEqual(Object.keys(store.state.responseErrors), []);
      assert.equal(runtime.needsRecovery(), false);
      runtime.dispose();
    });
  }
});

test("disposed response and check operations cannot restore local state", async (t) => {
  for (const method of ["respond", "check"]) for (const outcome of ["failure", "success"]) {
    await t.test(`${method}: ${outcome}`, async () => {
      const pending = deferred();
      const { runtime, store, calls } = fixture(() => pending.promise);
      store.setDraft("one", { question: "secret" });
      const operation = runtime[method]("one", { answers: {} });
      runtime.dispose();
      if (outcome === "failure") pending.reject(new Error("late failure"));
      else pending.resolve(packet(row({ status: "submitted", version: 2 })));
      assert.equal(await operation, null);
      assert.equal(store.state.interactions.one.status, "pending");
      assert.deepEqual(Object.keys(store.state.actions), []);
      assert.deepEqual(Object.keys(store.state.responseErrors), []);
      assert.deepEqual(Object.keys(store.state.drafts), []);
      assert.equal(runtime.needsRecovery(), false);
      assert.equal(calls.length, 1);
    });
  }
});

test("an old check cannot deduplicate or clear a replacement check using the same handle", async () => {
  const old = deferred(), current = deferred();
  const { runtime, store, calls } = fixture(() => calls.length === 1 ? old.promise : current.promise);
  const previous = runtime.check("one");
  store.applySnapshot({ interactions: [], epoch: "registry", revision: 2 });
  store.applySnapshot({ interactions: [], epoch: "registry", revision: 3 });
  store.applySnapshot({ interactions: [row({ itemId: "replacement-item" })], epoch: "registry", revision: 4 });
  const next = runtime.check("one");
  assert.notEqual(previous, next);
  assert.equal(calls.length, 2);
  old.reject(Object.assign(new Error("old handle gone"), { status: 404 }));
  await previous;
  assert.equal(store.state.responseErrors.one, undefined);
  assert.equal(runtime.check("one"), next);
  current.resolve(packet(row({ itemId: "replacement-item", status: "resolved", version: 2 }), 5));
  await next;
  assert.equal(store.state.interactions.one.status, "resolved");
  runtime.dispose();
});

test("a failed check started before a new submission cannot overwrite that submission", async () => {
  const reading = deferred(), posting = deferred();
  const { runtime, store } = fixture((url, options) => options.method === "POST" ? posting.promise : reading.promise);
  const check = runtime.check("one");
  const response = runtime.respond("one", { answers: {} });
  reading.reject(new Error("old read failed"));
  await check;
  assert.equal(store.state.actions.one.status, "submitting");
  assert.equal(store.state.responseErrors.one, undefined);
  posting.resolve(packet(row({ status: "submitted", version: 2 })));
  await response;
  runtime.dispose();
});

test("a server submitting event preserves the current POST result after clearing its local action", async () => {
  const pending = deferred();
  const { runtime, store } = fixture(() => pending.promise);
  const response = runtime.respond("one", { answers: {} });
  store.applyUpdate(packet(row({ status: "submitting", version: 2 })));
  assert.equal(store.state.actions.one, undefined);
  pending.resolve(packet(row({ status: "submitted", version: 3 })));
  await response;
  assert.equal(store.state.interactions.one.status, "submitted");
  runtime.dispose();
});

test("current unknown delivery stays locked through failed checks and pending snapshots", async () => {
  const { runtime, store, calls } = fixture((url, options) => {
    if (options.method === "POST") throw new Error("delivery uncertain");
    throw Object.assign(new Error("not found"), { status: 404 });
  });
  await runtime.respond("one", { answers: {} });
  store.applySnapshot({ interactions: [row()], epoch: "registry", revision: 2 });
  assert.equal(store.state.actions.one.status, "unknown");
  assert.equal(await runtime.respond("one", { answers: {} }), null);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(runtime.needsRecovery(), true);
  store.applySnapshot({ interactions: [], epoch: "registry", revision: 3 });
  assert.equal(store.state.actions.one, undefined);
  assert.equal(runtime.needsRecovery(), false);
  runtime.dispose();
});

test("a failed refresh from the previous epoch cannot create a persistent recovery error", async () => {
  const pending = deferred();
  const { runtime, store } = fixture(() => pending.promise);
  const refresh = runtime.refresh();
  store.applySnapshot({ interactions: [], epoch: "replacement", revision: 1 });
  pending.reject(new Error("old read failed"));
  await refresh;
  assert.equal(store.state.error, "");
  assert.equal(runtime.needsRecovery(), false);
  runtime.dispose();
});

test("the real chat runtime refreshes interactions on open reconnect foreground sync and explicit reads while preserving composer state", async () => {
  const store = createCodexChatStore("thread"), calls = [], sockets = [], listeners = new Map();
  store.state.draft = { text: "draft stays", attachments: [{ id: "picture", uploadedId: "image" }] };
  let current = row();
  const runtime = createCodexChatRuntime({ store, maxPolls: 0, location: { protocol: "https:", host: "example.test" },
    visibility: { hidden: false, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: (name) => listeners.delete(name) },
    createSocket: () => { const socket = { close() {} }; sockets.push(socket); return socket; }, request: async (url, options = {}) => {
      calls.push({ url, ...options });
      if (url.endsWith("/interactions")) return { interactions: [current], epoch: "registry", revision: current.version };
      if (url.endsWith("/respond")) { current = row({ status: "submitted", version: 2 }); return packet(current); }
      if (url.endsWith("/requests")) return { requests: [] };
      if (url.includes("/turns?")) return { threadId: "thread", turns: [] };
      return { thread: { id: "thread" } };
    } });
  const flush = async () => { for (let index = 0; index < 35; index += 1) await Promise.resolve(); };
  const reads = () => calls.filter((call) => call.url.endsWith("/interactions")).length;
  try {
    await runtime.open(); await flush(); assert.equal(reads(), 1);
    sockets[0].onopen(); await flush(); assert.equal(reads(), 2);
    sockets[0].onmessage({ data: JSON.stringify({ schemaVersion: 2, threadId: "thread", epoch: "wire", seq: 0, type: "sync.required", payload: {} }) });
    await flush(); assert.equal(reads(), 3);
    listeners.get("visibilitychange")(); await flush(); assert.ok(reads() >= 4);
    const before = reads(); await runtime.refreshLatest(); await flush(); assert.equal(reads(), before + 1);
    await runtime.interactions.respond("one", { answers: { question: { answers: ["native answer"] } } });
    assert.equal(store.state.draft.text, "draft stays"); assert.equal(store.state.draft.attachments[0].uploadedId, "image");
    assert.equal(calls.filter((call) => call.method === "POST" && call.url.endsWith("/requests")).length, 0);
    assert.equal(store.state.requestOrder.length, 0);
  } finally { runtime.dispose(); }
  assert.equal(listeners.size, 0);
});
