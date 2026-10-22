import test from "node:test";
import assert from "node:assert/strict";
import { AUTH_EXPIRED_EVENT, request, requestAuthSession } from "../web/src/lib/api.js";
import { createCodexReadRequests } from "../web/src/lib/codex-read-requests.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function reply(status = 200, payload = { ready: true }, body) {
  return { status, ok: status >= 200 && status < 300, statusText: `HTTP ${status}`,
    json: () => body || Promise.resolve(payload) };
}

function streamedReply(t, status = 200) {
  let controller, cancelled = 0, ended = false;
  const stream = new ReadableStream({
    start(value) { controller = value; },
    cancel() { cancelled += 1; ended = true; }
  });
  const response = new Response(stream, { status, headers: { "Content-Type": "application/json" } });
  const close = () => { if (!ended) { ended = true; controller.close(); } };
  t.after(close);
  return { response, stream, close,
    send: (value) => controller.enqueue(typeof value === "string" ? new TextEncoder().encode(value) : value),
    get cancelled() { return cancelled; } };
}

async function flush() { await new Promise(setImmediate); }

function observe(promise) {
  const state = {};
  promise.then((value) => { state.value = value; state.settled = true; },
    (error) => { state.error = error; state.settled = true; });
  return state;
}

function harness(t, respond, savedToken = "saved-token") {
  const calls = [], events = [], timers = new Map();
  let now = 0, nextTimer = 0;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: { getItem: () => savedToken }, dispatchEvent: (event) => events.push(event.type)
  } });
  t.mock.method(globalThis, "fetch", (url, options) => {
    calls.push({ url: String(url), options });
    return respond(String(url), options, calls.length);
  });
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    const id = ++nextTimer;
    timers.set(id, { callback, due: now + delay });
    return id;
  });
  t.mock.method(globalThis, "clearTimeout", (id) => timers.delete(id));
  t.after(() => {
    assert.equal(timers.size, 0, "the operation must release every deadline timer");
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  });
  return { calls, events, timers, advance(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.due <= now) { timers.delete(id); timer.callback(); }
    }
  } };
}

function trackedController(t) {
  const controller = new AbortController(), listeners = new Set();
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  t.mock.method(controller.signal, "addEventListener", (type, listener, options) => {
    if (type === "abort") listeners.add(listener);
    return add(type, listener, options);
  });
  t.mock.method(controller.signal, "removeEventListener", (type, listener, options) => {
    if (type === "abort") listeners.delete(listener);
    return remove(type, listener, options);
  });
  t.after(() => assert.equal(listeners.size, 0, "caller abort listeners must be removed"));
  return controller;
}

const reads = [
  ["config", (options) => request(new URL("http://localhost/api/config?refresh=1"), options), 15000],
  ["sessions", (options) => request("/api/sessions?provider=codex&limit=50", options), 30000],
  ["composer state", (options) => request("/api/threads/codex/thread%2Fid/composer-state?git=0", options), 15000],
  ["auth session", (options) => requestAuthSession(options), 15000],
  ["paged catalog", (options) => request("/api/session-catalog?limit=20", options), 30000],
  ["Codex runtime", (options) => createCodexReadRequests({ request }).call("/api/v2/codex/threads/thread/turns?limit=10", options), 30000]
];

for (const [label, read, timeoutMs] of reads) {
  for (const stage of ["headers", "JSON body"]) {
    test(`${label} times out after ${timeoutMs / 1000} seconds while ${stage} hangs`, async (t) => {
      const pending = deferred();
      const h = harness(t, () => stage === "headers" ? pending.promise : reply(200, null, pending.promise));
      const caller = trackedController(t);
      const state = observe(read({ signal: caller.signal }));
      await flush();
      h.advance(timeoutMs - 1);
      await flush();
      assert.equal(state.settled, undefined);
      h.advance(1);
      await flush();
      assert.equal(state.error?.code, "READ_TIMEOUT");
      assert.match(state.error.message, /超时.*重试/);
      assert.equal(state.error.status, undefined);
      assert.equal(h.calls[0].options.signal.aborted, true);
      assert.deepEqual(h.events, []);
      pending.reject(new Error("late transport rejection"));
      await flush();
      assert.equal(h.calls.length, 1);
      assert.deepEqual(h.events, []);
    });
  }
}

for (const [label, read] of reads) {
  test(`${label} skips fetch for a caller already cancelled`, async (t) => {
    const h = harness(t, () => reply());
    const caller = trackedController(t);
    caller.abort();
    const state = observe(read({ signal: caller.signal }));
    await flush();
    assert.equal(state.error?.name, "AbortError");
    assert.equal(h.calls.length, 0);
    assert.equal(h.timers.size, 0);
  });
}

for (const stage of ["headers", "JSON body", "auth recovery"]) {
  test(`caller cancellation during ${stage} aborts its read and suppresses late 401 effects`, async (t) => {
    const pending = deferred();
    const h = harness(t, (_url, _options, count) => {
      if (stage === "auth recovery") return count === 1 ? reply(401) : pending.promise;
      return stage === "headers" ? pending.promise : reply(401, null, pending.promise);
    }, stage === "JSON body" ? "" : "saved-token");
    const caller = trackedController(t);
    const state = observe(request("/api/config", { signal: caller.signal }));
    await flush();
    caller.abort();
    await flush();
    assert.equal(state.error?.name, "AbortError");
    assert(h.calls.every(({ options }) => options.signal.aborted));
    pending.resolve(stage === "JSON body" ? { error: "expired" } : reply(stage === "auth recovery" ? 200 : 401));
    await flush();
    assert.equal(h.calls.length, stage === "auth recovery" ? 2 : 1);
    assert.deepEqual(h.events, []);
  });
}

for (const [label, read] of [reads[0], reads[3]]) {
  test(`${label} shares one deadline across 401, saved login and retried JSON`, async (t) => {
    const first = deferred(), login = deferred(), body = deferred();
    const h = harness(t, (_url, _options, count) => count === 1 ? first.promise : count === 2 ? login.promise : reply(200, null, body.promise));
    const state = observe(read());
    h.advance(5000);
    first.resolve(reply(401));
    await flush();
    assert.equal(h.calls.length, 2);
    h.advance(5000);
    login.resolve(reply());
    await flush();
    assert.equal(h.calls.length, 3);
    h.advance(4999);
    await flush();
    assert.equal(state.settled, undefined);
    h.advance(1);
    await flush();
    assert.equal(state.error?.code, "READ_TIMEOUT");
    assert(h.calls.every(({ options }) => options.signal.aborted));
    body.resolve({ authenticated: true });
    await flush();
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.events, []);
  });
}

for (const lateStage of ["401 headers", "recovery success", "recovery rejection", "401 body"]) {
  test(`timeout suppresses late ${lateStage} and consumes rejected transports`, async (t) => {
    const late = deferred();
    const h = harness(t, (_url, _options, count) => {
      if (lateStage === "401 headers") return late.promise;
      if (lateStage === "401 body") return reply(401, null, late.promise);
      return count === 1 ? reply(401) : late.promise;
    }, lateStage === "401 body" ? "" : "saved-token");
    const state = observe(request("/api/config"));
    await flush();
    h.advance(15000);
    await flush();
    assert.equal(state.error?.code, "READ_TIMEOUT");
    const callCount = h.calls.length;
    if (lateStage === "recovery rejection") late.reject(new Error("late login network error"));
    else late.resolve(lateStage === "401 body" ? { error: "expired" } : reply(lateStage === "401 headers" ? 401 : 200));
    await flush();
    assert.equal(h.calls.length, callCount);
    assert.deepEqual(h.events, []);
  });
}

for (const [label, read] of [reads[0], reads[3]]) {
  test(`${label} times out on an unsuccessful response body without reporting HTTP failure`, async (t) => {
    const body = deferred();
    const h = harness(t, () => reply(503, null, body.promise), "");
    const state = observe(read());
    await flush();
    h.advance(15000);
    await flush();
    assert.equal(state.error?.code, "READ_TIMEOUT");
    assert.equal(state.error.status, undefined);
    body.resolve({ error: "slow unavailable", code: "BACKEND_BUSY", executionState: "unknown" });
    await flush();
    assert.deepEqual(h.events, []);
  });
}

for (const [label, read] of [reads[0], reads[3]]) {
  test(`${label} success and HTTP failures release transports, timers and caller listeners`, async (t) => {
    const payloads = [reply(), reply(502, { error: "uncertain", code: "WORKSPACE_COMMAND_TIMEOUT", executionState: "unknown" })];
    const h = harness(t, () => payloads.shift());
    const caller = trackedController(t);
    assert.deepEqual(await read({ signal: caller.signal }), { ready: true });
    assert.equal(h.timers.size, 0);
    await assert.rejects(read({ signal: caller.signal }), {
      message: "uncertain", status: 502, code: "WORKSPACE_COMMAND_TIMEOUT", executionState: "unknown"
    });
    assert.equal(h.timers.size, 0);
    assert(h.calls.every(({ options }) => options.signal !== caller.signal && options.signal.aborted));
    assert.equal(caller.signal.aborted, false);
    const reasons = h.calls.map(({ options }) => options.signal.reason);
    caller.abort(new Error("caller finished"));
    assert.deepEqual(h.calls.map(({ options }) => options.signal.reason), reasons);
    assert.deepEqual(h.events, []);
  });
}

for (const [label, read] of [reads[0], reads[3]]) {
  test(`${label} recovery finishes within budget and aborts all unused response transports`, async (t) => {
    const h = harness(t, (_url, _options, count) => reply(count === 1 ? 401 : 200));
    const caller = trackedController(t);
    assert.deepEqual(await read({ signal: caller.signal }), { ready: true });
    assert.equal(h.calls.length, 3);
    assert.equal(new Set(h.calls.map(({ options }) => options.signal)).size, 1);
    assert(h.calls.every(({ options }) => options.signal.aborted));
    assert.equal(caller.signal.aborted, false);
    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.events, []);
  });
}

for (const [label, read] of [reads[0], reads[3]]) {
  test(`${label} failed recovery waits for the original error body and retains its metadata`, async (t) => {
    const body = deferred();
    const h = harness(t, (_url, _options, count) => count === 1 ? reply(401, null, body.promise) : reply(403));
    const state = observe(read());
    await flush();
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.events, []);
    h.advance(14000);
    body.resolve({ error: "session expired", code: "SESSION_EXPIRED", executionState: "not-applied" });
    await flush();
    assert.equal(state.error?.status, 401);
    assert.equal(state.error?.message, "session expired");
    assert.equal(state.error?.code, "SESSION_EXPIRED");
    assert.equal(state.error?.executionState, "not-applied");
    assert.deepEqual(h.events, label === "config" ? [AUTH_EXPIRED_EVENT] : []);
    assert.equal(h.timers.size, 0);
    assert(h.calls.every(({ options }) => options.signal.aborted));
  });
}

for (const failureStage of ["fetch", "JSON body", "saved login"]) {
  test(`transport rejection during ${failureStage} releases its read resources without expiry`, async (t) => {
    const failure = new TypeError("connection lost");
    const h = harness(t, (_url, _options, count) => {
      if (failureStage === "JSON body") return reply(200, null, Promise.reject(failure));
      if (failureStage === "saved login" && count === 1) return reply(401);
      throw failure;
    });
    const caller = trackedController(t);
    await assert.rejects(request("/api/config", { signal: caller.signal }), (error) => error === failure);
    assert.equal(h.timers.size, 0);
    assert.equal(caller.signal.aborted, false);
    assert(h.calls.every(({ options }) => options.signal.aborted));
    assert.deepEqual(h.events, []);
  });
}

test("bounded read retains HTTP fallback when an error JSON body rejects before the deadline", async (t) => {
  const h = harness(t, () => reply(502, null, Promise.reject(new SyntaxError("invalid JSON"))));
  await assert.rejects(request("/api/sessions"), { message: "HTTP 502", status: 502 });
  assert.equal(h.timers.size, 0);
});

test("only exact initialization read routes receive a deadline", async (t) => {
  const pending = deferred();
  const h = harness(t, () => pending.promise);
  const paths = ["/api/config/extra", "/api/sessions/thread", "/api/sessions/", "/api/workspace-git",
    "/api/threads/codex/thread/history", "/api/threads/codex/thread/composer-state/extra", "/api/threads/codex/composer-state"];
  const states = paths.map((path) => observe(request(path)));
  for (const method of ["POST", "PATCH", "DELETE"]) {
    states.push(observe(request("/api/config", { method })));
    states.push(observe(request("/api/sessions", { method })));
  }
  states.push(observe(request("/api/login", { method: "POST" })));
  states.push(observe(request("/api/threads/codex/thread/composer-state?git=0", { method: "PATCH" })));
  h.advance(30000);
  await flush();
  assert(states.every((state) => !state.settled));
  assert.equal(h.timers.size, 0);
  assert(h.calls.every(({ options }) => options.signal === undefined));
  pending.resolve(reply());
  await flush();
  assert(states.every((state) => state.value?.ready));
});

test("business POST recovery keeps its original signal and remains outside the read deadline", async (t) => {
  const login = deferred();
  const h = harness(t, (url, _options, count) => url === "/api/login" ? login.promise : reply(count === 1 ? 401 : 200));
  const caller = new AbortController();
  const state = observe(request("/api/sessions/thread/input", { method: "POST", signal: caller.signal, body: "{}" }));
  await flush();
  h.advance(30000);
  await flush();
  assert.equal(state.settled, undefined);
  assert.equal(h.calls[0].options.signal, caller.signal);
  assert.equal(h.calls[1].options.signal, undefined);
  login.resolve(reply());
  await flush();
  assert.deepEqual(state.value, { ready: true });
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].options.signal, caller.signal);
  assert.deepEqual(h.events, []);
});

test("sessions accept headers after 15 seconds and give the JSON body a fresh idle budget", async (t) => {
  const headers = deferred(), body = deferred();
  const h = harness(t, () => headers.promise);
  const caller = trackedController(t), state = observe(request("/api/sessions?compact=1", { signal: caller.signal }));
  h.advance(20000);
  headers.resolve(reply(200, null, body.promise));
  await flush();
  assert.equal(state.settled, undefined);
  h.advance(29999);
  await flush();
  assert.equal(state.settled, undefined);
  body.resolve({ sessions: [] });
  await flush();
  assert.deepEqual(state.value, { sessions: [] });
  assert.equal(h.timers.size, 0);
  assert.equal(caller.signal.aborted, false);
  assert.equal(h.calls[0].options.signal.aborted, true);
});

test("sessions JSON byte progress spans 15 seconds, preserves split UTF-8, and still requires EOF", async (t) => {
  const s = streamedReply(t), h = harness(t, () => s.response), caller = trackedController(t);
  const payload = { sessions: [{ id: "first", name: "中文会话" }] };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const split = bytes.findIndex((value) => value > 127) + 1;
  const state = observe(request("/api/sessions?compact=1", { signal: caller.signal }));
  await flush();
  h.advance(20000); s.send(bytes.slice(0, split)); await flush();
  assert.equal(state.settled, undefined);
  h.advance(20000); s.send(bytes.slice(split)); await flush();
  assert.equal(state.settled, undefined);
  h.advance(29999); await flush(); assert.equal(state.settled, undefined);
  s.close(); await flush();
  assert.deepEqual(state.value, payload);
  assert.equal(s.stream.locked, false);
  assert.equal(s.cancelled, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(caller.signal.aborted, false);
});

test("sessions JSON stops after 30 idle seconds and empty body chunks do not postpone it", async (t) => {
  const s = streamedReply(t), h = harness(t, () => s.response), caller = trackedController(t);
  const state = observe(request("/api/sessions", { signal: caller.signal }));
  await flush();
  h.advance(20000); s.send('{"sessions":'); await flush();
  h.advance(29999); s.send(new Uint8Array()); await flush();
  assert.equal(state.settled, undefined);
  h.advance(1); await flush();
  assert.equal(state.error?.code, "READ_TIMEOUT");
  assert.equal(s.cancelled, 1);
  assert.equal(s.stream.locked, false);
  assert.equal(h.timers.size, 0);
  assert.equal(caller.signal.aborted, false);
  assert.deepEqual(h.events, []);
});

test("sessions JSON continuous bytes cannot extend the 120 second total budget", async (t) => {
  const s = streamedReply(t), h = harness(t, () => s.response);
  const state = observe(request("/api/sessions"));
  await flush();
  for (let elapsed = 20000; elapsed <= 100000; elapsed += 20000) {
    h.advance(20000); s.send(" "); await flush();
    assert.equal(state.settled, undefined);
  }
  h.advance(19999); s.send(" "); await flush();
  assert.equal(state.settled, undefined);
  h.advance(1); await flush();
  assert.equal(state.error?.code, "READ_TIMEOUT");
  assert.equal(s.cancelled, 1);
  assert.equal(s.stream.locked, false);
  assert.equal(h.timers.size, 0);
});

test("sessions track a slow HTTP error body and preserve its error metadata", async (t) => {
  const s = streamedReply(t, 502), h = harness(t, () => s.response);
  const state = observe(request("/api/sessions"));
  await flush();
  h.advance(20000); s.send('{"error":"busy",'); await flush();
  h.advance(20000); s.send('"code":"BACKEND_BUSY","executionState":"unknown"}'); s.close(); await flush();
  assert.equal(state.error?.status, 502);
  assert.equal(state.error?.message, "busy");
  assert.equal(state.error?.code, "BACKEND_BUSY");
  assert.equal(state.error?.executionState, "unknown");
  assert.equal(s.stream.locked, false);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.events, []);
});

test("sessions JSON caller cancellation releases its reader, timers and abort listeners", async (t) => {
  const s = streamedReply(t), caller = trackedController(t), listeners = new Set();
  const h = harness(t, (_url, options) => {
    const signal = options.signal, add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
    t.mock.method(signal, "addEventListener", (type, listener, options) => { listeners.add(listener); return add(type, listener, options); });
    t.mock.method(signal, "removeEventListener", (type, listener) => { listeners.delete(listener); return remove(type, listener); });
    return s.response;
  });
  const state = observe(request("/api/sessions", { signal: caller.signal }));
  await flush();
  s.send('{"sessions":'); await flush();
  caller.abort(new DOMException("left catalog", "AbortError")); await flush();
  assert.equal(state.error?.message, "left catalog");
  assert.equal(s.cancelled, 1);
  assert.equal(s.stream.locked, false);
  assert.equal(listeners.size, 0);
  assert.equal(h.timers.size, 0);
});

for (const cancel of [false, true]) {
  test(`sessions ignore late headers after ${cancel ? "caller cancellation" : "idle timeout"}`, async (t) => {
    const headers = deferred(), h = harness(t, () => headers.promise), caller = trackedController(t);
    const state = observe(request("/api/sessions", { signal: caller.signal }));
    await flush();
    if (cancel) caller.abort(); else h.advance(30000);
    await flush();
    assert.equal(cancel ? state.error?.name : state.error?.code, cancel ? "AbortError" : "READ_TIMEOUT");
    headers.resolve(reply(401)); await flush();
    assert.equal(h.calls.length, 1);
    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.events, []);
  });
}

test("sessions share their original total budget across slow 401, login, retry and JSON bytes", async (t) => {
  const first = deferred(), login = deferred(), retry = deferred(), s = streamedReply(t);
  const h = harness(t, (_url, _options, count) => count === 1 ? first.promise : count === 2 ? login.promise : retry.promise);
  const state = observe(request("/api/sessions"));
  h.advance(20000); first.resolve(reply(401)); await flush();
  assert.equal(state.settled, undefined); assert.equal(h.calls.length, 2);
  h.advance(20000); login.resolve(reply()); await flush();
  assert.equal(state.settled, undefined); assert.equal(h.calls.length, 3);
  h.advance(20000); retry.resolve(s.response); await flush();
  h.advance(20000); s.send('{"sessions":'); await flush();
  h.advance(20000); s.send("["); await flush();
  h.advance(19999); s.send(" "); await flush();
  assert.equal(state.settled, undefined);
  h.advance(1); await flush();
  assert.equal(state.error?.code, "READ_TIMEOUT");
  assert.equal(new Set(h.calls.map(({ options }) => options.signal)).size, 1);
  assert(h.calls.every(({ options }) => options.signal.aborted));
  assert.equal(s.cancelled, 1); assert.equal(s.stream.locked, false);
  assert.equal(h.timers.size, 0); assert.deepEqual(h.events, []);
});

test("sessions 401 headers reset the idle budget while a stalled login cannot reopen it", async (t) => {
  const first = deferred(), login = deferred();
  const h = harness(t, (_url, _options, count) => count === 1 ? first.promise : login.promise);
  const state = observe(request("/api/sessions"));
  h.advance(20000); first.resolve(reply(401)); await flush();
  h.advance(29999); await flush(); assert.equal(state.settled, undefined);
  h.advance(1); await flush(); assert.equal(state.error?.code, "READ_TIMEOUT");
  login.resolve(reply()); await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.events, []);
});

test("Codex runtime accepts slow headers and JSON bytes without nesting a 15 second API deadline", async (t) => {
  const headers = deferred(), s = streamedReply(t), h = harness(t, () => headers.promise);
  const reads = createCodexReadRequests({ request });
  t.after(() => reads.dispose());
  const payload = { turns: [{ id: "turn", text: "中文正文" }], hasMore: false };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const split = bytes.findIndex((value) => value > 127) + 1;
  const state = observe(reads.call("/api/v2/codex/threads/thread/turns?limit=10"));
  h.advance(20000); headers.resolve(s.response); await flush();
  assert.equal(state.settled, undefined);
  h.advance(20000); s.send(bytes.slice(0, split)); await flush();
  h.advance(20000); s.send(bytes.slice(split)); await flush();
  assert.equal(state.settled, undefined, "a complete JSON value still waits for EOF");
  s.close(); await flush();
  assert.deepEqual(state.value, payload);
  assert.equal(h.calls.length, 1);
  assert.equal(Object.hasOwn(h.calls[0].options, "readContext"), false);
  assert.equal(s.stream.locked, false);
  assert.equal(s.cancelled, 0);
  assert.equal(h.timers.size, 0);
});

test("Codex runtime stops stalled body reads after 30 seconds and ignores empty chunks", async (t) => {
  const s = streamedReply(t), h = harness(t, () => s.response), reads = createCodexReadRequests({ request });
  t.after(() => reads.dispose());
  const state = observe(reads.call("/api/v2/codex/threads/thread/turns/turn/items?limit=20"));
  await flush();
  h.advance(20000); s.send('{"items":'); await flush();
  h.advance(29999); s.send(new Uint8Array()); await flush();
  assert.equal(state.settled, undefined);
  h.advance(1); await flush();
  assert.equal(state.error?.code, "READ_TIMEOUT");
  assert.equal(s.cancelled, 1);
  assert.equal(s.stream.locked, false);
  assert.equal(h.calls[0].options.signal.aborted, true);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.events, []);
});

test("Codex runtime keeps the same 120 second budget across recovery and body progress", async (t) => {
  const first = deferred(), login = deferred(), retry = deferred(), s = streamedReply(t);
  const h = harness(t, (_url, _options, count) => count === 1 ? first.promise : count === 2 ? login.promise : retry.promise);
  const reads = createCodexReadRequests({ request });
  t.after(() => reads.dispose());
  const state = observe(reads.call("/api/v2/codex/threads/thread"));
  h.advance(20000); first.resolve(reply(401)); await flush();
  h.advance(20000); login.resolve(reply()); await flush();
  h.advance(20000); retry.resolve(s.response); await flush();
  h.advance(20000); s.send('{"thread":'); await flush();
  h.advance(20000); s.send("{"); await flush();
  h.advance(19999); s.send(" "); await flush();
  assert.equal(state.settled, undefined);
  h.advance(1); await flush();
  assert.equal(state.error?.code, "READ_TIMEOUT");
  assert.equal(h.calls.length, 3);
  assert.equal(new Set(h.calls.map(({ options }) => options.signal)).size, 1);
  assert(h.calls.every(({ options }) => options.signal.aborted && !Object.hasOwn(options, "readContext")));
  assert.equal(s.cancelled, 1);
  assert.equal(s.stream.locked, false);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.events, []);
});

for (const stage of ["headers", "login", "body"]) {
  test(`disposing a Codex runtime read during ${stage} suppresses late authentication effects`, async (t) => {
    const pending = deferred();
    const h = harness(t, (_url, _options, count) => stage === "body" ? reply(401, null, pending.promise)
      : stage === "login" && count === 1 ? reply(401) : pending.promise, stage === "body" ? "" : "saved-token");
    const reads = createCodexReadRequests({ request });
    const state = observe(reads.call("/api/v2/codex/threads/thread/interactions"));
    await flush();
    reads.dispose(); await flush();
    assert.equal(state.error?.name, "AbortError");
    pending.resolve(stage === "body" ? { error: "expired" } : reply(stage === "headers" ? 401 : 200));
    await flush();
    assert.equal(h.calls.length, stage === "login" ? 2 : 1);
    assert(h.calls.every(({ options }) => options.signal.aborted));
    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.events, []);
  });
}

test("an explicit Codex runtime timeout remains a hard budget even while body bytes arrive", async (t) => {
  const s = streamedReply(t), h = harness(t, () => s.response), reads = createCodexReadRequests({ request, timeoutMs: 50 });
  t.after(() => reads.dispose());
  const state = observe(reads.call("/api/v2/codex/threads/thread/turns?limit=10"));
  await flush();
  h.advance(49); s.send(" "); await flush();
  assert.equal(state.settled, undefined);
  h.advance(1); await flush();
  assert.equal(state.error?.code, "READ_TIMEOUT");
  assert.equal(s.cancelled, 1);
  assert.equal(s.stream.locked, false);
  assert.equal(h.timers.size, 0);
});

test("Codex runtime caller cancellation releases the streaming body and caller listener", async (t) => {
  const s = streamedReply(t), h = harness(t, () => s.response), caller = trackedController(t);
  const reads = createCodexReadRequests({ request });
  t.after(() => reads.dispose());
  const state = observe(reads.call("/api/v2/codex/threads/thread/turns?limit=10", { signal: caller.signal }));
  await flush();
  s.send('{"turns":'); await flush();
  caller.abort(new DOMException("left conversation", "AbortError")); await flush();
  assert.equal(state.error?.message, "left conversation");
  assert.equal(s.cancelled, 1);
  assert.equal(s.stream.locked, false);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.events, []);
});
