import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";

import { AppServerBridge } from "../src/appServerBridge.js";

function fixture(t, { timeout = 5_000, send } = {}) {
  const timers = new Set();
  const cleared = [];
  const messages = [];
  const requests = [];
  const controllers = [];
  let disconnected = 0;
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    const timer = { callback, delay };
    timers.add(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => {
    cleared.push(timer);
    timers.delete(timer);
  });
  const bridge = new AppServerBridge({ codexAppServerRequestTimeoutMs: timeout });
  const socket = {
    readyState: 1,
    send(payload) {
      const message = JSON.parse(payload);
      messages.push(message);
      send?.(message, bridge);
    }
  };
  bridge.on("disconnected", () => { disconnected += 1; });
  function connect() {
    bridge.ws = socket;
    bridge.connected = true;
    bridge.initialized = true;
  }
  connect();
  return {
    bridge, socket, messages, timers, cleared, connect,
    get disconnected() { return disconnected; },
    controller() {
      const controller = new AbortController();
      controllers.push(controller);
      return controller;
    },
    request(method, params, options) {
      const promise = bridge.request(method, params, options);
      promise.catch(() => {});
      requests.push(promise);
      return promise;
    },
    reply(id, result) {
      bridge.handleMessage(JSON.stringify({ jsonrpc: "2.0", id, result }));
    },
    error(id, error) {
      bridge.handleMessage(JSON.stringify({ jsonrpc: "2.0", id, error }));
    },
    fire(timer = [...timers][0]) {
      assert.ok(timer, "a request deadline must exist");
      timers.delete(timer);
      timer.callback();
    },
    clean() {
      assert.equal(bridge.pending.size, 0);
      assert.equal(timers.size, 0);
      for (const controller of controllers) {
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      }
    },
    async close() {
      try {
        bridge.resetConnectionState();
        await Promise.allSettled(requests);
        this.clean();
      } finally {
        t.mock.restoreAll();
      }
    }
  };
}

const aborted = (error) => error.name === "AbortError" && error.code === "ABORT_ERR"
  && !error.uncertain && !error.rpcError;

test("pre-aborted requests allocate no id, pending entry, deadline or wire message", async (t) => {
  const f = fixture(t);
  try {
    const controller = f.controller();
    controller.abort();
    const request = f.request("thread/read", { threadId: "cancelled" }, { signal: controller.signal });
    assert.equal(f.bridge.nextId, 1);
    assert.deepEqual(f.messages, []);
    f.clean();
    await assert.rejects(request, aborted);
    const write = f.request("turn/start", { threadId: "survivor" });
    assert.equal(f.messages[0].id, 1);
    f.reply(1, { turn: "unbound-write" });
    assert.deepEqual(await write, { turn: "unbound-write" });
  } finally { await f.close(); }
});

test("abort during serialization prevents sending and releases its local wait", async (t) => {
  const f = fixture(t);
  try {
    const controller = f.controller();
    const params = { toJSON() { controller.abort(); return { threadId: "cancelled" }; } };
    const request = f.request("thread/read", params, { signal: controller.signal });
    assert.deepEqual(f.messages, []);
    f.clean();
    await assert.rejects(request, aborted);
    assert.equal(f.bridge.ws, f.socket);
    assert.equal(f.disconnected, 0);
  } finally { await f.close(); }
});

test("abort during send wins over a synchronous reply and send exception", async (t) => {
  let controller;
  const sendError = new Error("send failed after abort");
  const f = fixture(t, { send(message, bridge) {
    controller.abort();
    bridge.handleMessage(JSON.stringify({ id: message.id, result: "late" }));
    throw sendError;
  } });
  try {
    controller = f.controller();
    const request = f.request("thread/items/list", {}, { signal: controller.signal });
    f.clean();
    await assert.rejects(request, aborted);
    assert.equal(f.messages.length, 1);
    assert.equal(f.cleared.length, 1);
    assert.equal(f.bridge.ws, f.socket);
  } finally { await f.close(); }
});

test("cancelling one id preserves another read, an unbound write and the shared socket", async (t) => {
  const f = fixture(t);
  try {
    const cancelled = f.controller();
    const survivor = f.controller();
    const first = f.request("thread/read", { threadId: "cancelled" }, { signal: cancelled.signal });
    const second = f.request("thread/read", { threadId: "survivor" }, { signal: survivor.signal });
    const write = f.request("turn/start", { threadId: "write" });
    cancelled.abort();
    assert.equal(f.bridge.pending.size, 2);
    assert.equal(f.timers.size, 2);
    assert.equal(getEventListeners(cancelled.signal, "abort").length, 0);
    assert.equal(getEventListeners(survivor.signal, "abort").length, 1);
    await assert.rejects(first, aborted);
    f.reply(1, "late success");
    f.error(1, { code: -1, message: "late error" });
    assert.equal(f.bridge.pending.size, 2);
    f.reply(2, { thread: "survivor" });
    f.reply(3, { turn: "written" });
    assert.deepEqual(await second, { thread: "survivor" });
    assert.deepEqual(await write, { turn: "written" });
    assert.deepEqual(f.messages, [
      { jsonrpc: "2.0", id: 1, method: "thread/read", params: { threadId: "cancelled" } },
      { jsonrpc: "2.0", id: 2, method: "thread/read", params: { threadId: "survivor" } },
      { jsonrpc: "2.0", id: 3, method: "turn/start", params: { threadId: "write" } }
    ]);
    assert.equal(f.bridge.ws, f.socket);
    assert.equal(f.socket.readyState, 1);
    assert.equal(f.disconnected, 0);
    f.clean();
  } finally { await f.close(); }
});

for (const first of ["abort", "reply", "rpc-error", "timeout", "reset"]) {
  test(`${first} settles once when abort, reply, error, deadline and reset compete`, async (t) => {
    const f = fixture(t);
    try {
      const controller = f.controller();
      const request = f.request("thread/turns/list", {}, { signal: controller.signal });
      const pending = f.bridge.pending.get(1);
      const timer = [...f.timers][0];
      const rpcError = { code: -32001, message: "rpc rejected", data: { field: "cursor" } };
      if (first === "abort") controller.abort();
      if (first === "reply") f.reply(1, "first reply");
      if (first === "rpc-error") f.error(1, rpcError);
      if (first === "timeout") f.fire(timer);
      if (first === "reset") f.bridge.resetConnectionState();
      f.clean();
      controller.abort();
      f.reply(1, "late reply");
      f.error(1, { code: -1, message: "late error" });
      f.fire(timer);
      pending.resolve("stale callback");
      pending.reject(new Error("stale rejection"));
      f.bridge.resetConnectionState();
      assert.equal(f.cleared.length, 1);
      if (first === "reply") assert.equal(await request, "first reply");
      else if (first === "abort") await assert.rejects(request, aborted);
      else if (first === "rpc-error") await assert.rejects(request, (error) => {
        assert.equal(error.message, "rpc rejected");
        assert.equal(error.rpcError, true);
        assert.equal(error.code, rpcError.code);
        assert.deepEqual(error.data, rpcError.data);
        assert.equal(error.uncertain, undefined);
        return true;
      });
      else await assert.rejects(request, (error) => {
        assert.equal(error.uncertain, true);
        assert.match(error.message, first === "timeout" ? /request timeout: thread\/turns\/list/ : /connection closed/);
        assert.equal(error.rpcError, undefined);
        return true;
      });
      f.clean();
    } finally { await f.close(); }
  });
}

test("legacy two-argument RPCs preserve wire ids, default/minimum deadlines and timeout uncertainty", async (t) => {
  const f = fixture(t);
  try {
    for (const [configured, expected] of [[undefined, 20_000], [0, 20_000], [-10, 1_000], [5, 1_000], ["2500", 2_500]]) {
      f.bridge.config.codexAppServerRequestTimeoutMs = configured;
      const request = f.request("arbitrary/method", { value: configured ?? "default" });
      const message = f.messages.at(-1);
      assert.equal(message.id, f.messages.length);
      assert.equal([...f.timers][0].delay, expected);
      f.reply(message.id + 100, "unknown response");
      assert.equal(f.bridge.pending.size, 1);
      f.fire();
      await assert.rejects(request, (error) => error.uncertain === true && /request timeout: arbitrary\/method/.test(error.message));
      f.reply(message.id, "late reply");
      f.clean();
    }
    const write = f.request("turn/start", { threadId: "after-timeout" });
    f.reply(f.messages.at(-1).id, "write succeeded");
    assert.equal(await write, "write succeeded");
  } finally { await f.close(); }
});

for (const stage of ["serialize", "send"]) {
  test(`${stage} failure cleans up and preserves the original error before later abort`, async (t) => {
    const original = new Error(`${stage} failed`);
    const f = fixture(t, { send() { if (stage === "send") throw original; } });
    try {
      const controller = f.controller();
      const params = stage === "serialize" ? { toJSON() { throw original; } } : {};
      const request = f.request("thread/read", params, { signal: controller.signal });
      f.clean();
      controller.abort();
      f.reply(1, "late reply");
      await assert.rejects(request, (error) => error === original);
      assert.equal(f.messages.length, stage === "send" ? 1 : 0);
      assert.equal(f.cleared.length, 1);
      assert.equal(f.disconnected, 0);
    } finally { await f.close(); }
  });
}

test("connection reset cleans all local waits and accepts a fresh request after reconnect", async (t) => {
  const f = fixture(t);
  try {
    const controller = f.controller();
    const read = f.request("thread/read", {}, { signal: controller.signal });
    const write = f.request("turn/start", {});
    f.bridge.resetConnectionState();
    f.clean();
    assert.equal(f.bridge.ws, null);
    assert.equal(f.disconnected, 1);
    for (const request of [read, write]) await assert.rejects(request, (error) => error.uncertain === true && /connection closed/.test(error.message));
    f.reply(1, "late read");
    f.error(2, { message: "late write" });
    controller.abort();
    const disconnected = f.request("turn/start", {});
    await assert.rejects(disconnected, /websocket not connected/);
    assert.equal(f.bridge.nextId, 3);
    assert.equal(f.timers.size, 0);
    f.connect();
    const next = f.request("turn/start", { threadId: "fresh" });
    assert.equal(f.messages.at(-1).id, 3);
    f.reply(3, { turn: "fresh" });
    assert.deepEqual(await next, { turn: "fresh" });
    f.clean();
  } finally { await f.close(); }
});
