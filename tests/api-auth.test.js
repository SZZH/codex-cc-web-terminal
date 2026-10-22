import test from "node:test";
import assert from "node:assert/strict";
import { AUTH_EXPIRED_EVENT, request, requestAuthSession, requestHistoryMessages,
  requestSessionInputStream, requestThreadInputStream, requestThreadComposerState, patchThreadComposerState,
  supportsInitialHistory, recheckInitialHistorySupport } from "../web/src/lib/api.js";

function harness(t, respond, savedToken = "saved-test-token") {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const calls = [];
  const events = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: { getItem: () => savedToken },
    dispatchEvent: (event) => { events.push(event.type); }
  } });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return respond(url, options, calls.length);
  });
  return { calls, events };
}

function json(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

test("initial history capability requires explicit authenticated version one and is not retained across old backends", async (t) => {
  let payload;
  harness(t, () => json(200, payload));
  for (const [auth, supported] of [
    [{ authenticated: true, capabilities: { initialHistory: 1 } }, true],
    [{ authenticated: true }, false],
    [{ authenticated: true, capabilities: { initialHistory: "1" } }, false],
    [{ authenticated: false, capabilities: { initialHistory: 1 } }, false]
  ]) {
    payload = auth;
    assert.deepEqual(await requestAuthSession(), auth);
    assert.equal(supportsInitialHistory(), supported);
  }
});

test("login advertises capability without an extra auth read and login/logout immediately invalidate previous support", async (t) => {
  const pending = deferred();
  const { calls } = harness(t, (url) => url === "/api/login" ? pending.promise : json(200, { ok: true }));
  const login = request("/api/login", { method: "POST" });
  assert.equal(supportsInitialHistory(), false);
  pending.resolve(json(200, { ok: true, capabilities: { initialHistory: 1 } }));
  await login;
  assert.equal(supportsInitialHistory(), true);
  const logout = request("/api/logout", { method: "POST" });
  assert.equal(supportsInitialHistory(), false);
  await logout;
  assert.deepEqual(calls.map(({ url }) => url), ["/api/login", "/api/logout"]);
});

test("auth capability response from before a new login cannot overwrite the new backend capability", async (t) => {
  const old = deferred();
  harness(t, (url) => url === "/api/auth/session" ? old.promise : json(200, { ok: true }));
  const reading = requestAuthSession();
  await request("/api/login", { method: "POST" });
  old.resolve(json(200, { authenticated: true, capabilities: { initialHistory: 1 } }));
  await reading;
  assert.equal(supportsInitialHistory(), false);
});

test("rollback capability recheck distinguishes supported backend, old backend and expired authentication", async (t) => {
  let payload = { authenticated: true, capabilities: { initialHistory: 1 } };
  const { events } = harness(t, () => json(200, payload));
  assert.equal(await recheckInitialHistorySupport(), true);
  payload = { authenticated: true };
  assert.equal(await recheckInitialHistorySupport(), false);
  assert.deepEqual(events, []);
  payload = { authenticated: false, capabilities: { initialHistory: 1 } };
  await assert.rejects(recheckInitialHistorySupport(), { status: 401 });
  assert.equal(supportsInitialHistory(), false);
  assert.deepEqual(events, [AUTH_EXPIRED_EVENT]);
});

test("a rejected rollback auth recheck enters the existing expiry flow", async (t) => {
  const { events } = harness(t, () => json(401, { error: "Unauthorized" }), "");
  await assert.rejects(recheckInitialHistorySupport(), { status: 401 });
  assert.deepEqual(events, [AUTH_EXPIRED_EVENT]);
  assert.equal(supportsInitialHistory(), false);
});

test("composer settings use the Git-free read and write query without changing auth handling", async (t) => {
  const { calls, events } = harness(t, () => json(200, { model: "saved" }));
  await requestThreadComposerState("codex", "thread-a");
  await patchThreadComposerState("codex", "thread-a", { permissionMode: "auto-review" });
  assert(calls.every((call) => call.url === "/api/threads/codex/thread-a/composer-state?git=0"));
  assert.equal(calls[1].options.method, "PATCH");
  assert.deepEqual(events, []);
});

test("HTTP errors preserve only valid workspace error codes and execution states", async (t) => {
  const values = [{ error: "refresh", code: "WORKSPACE_COMMAND_EXIT", executionState: "applied" },
    { error: "uncertain", code: "WORKSPACE_COMMAND_TIMEOUT", executionState: "unknown" },
    { error: "invalid metadata", code: { secret: true }, executionState: "success" }];
  const { events } = harness(t, () => json(502, values.shift()));
  await assert.rejects(request("/workspace"), { code: "WORKSPACE_COMMAND_EXIT", executionState: "applied", status: 502 });
  await assert.rejects(request("/workspace"), { code: "WORKSPACE_COMMAND_TIMEOUT", executionState: "unknown" });
  await assert.rejects(request("/workspace"), (error) => error.code === undefined && error.executionState === undefined);
  assert.deepEqual(events, []);
});

test("login rejection reaches its caller once without saved-token recovery or auth expiry", async (t) => {
  const { calls, events } = harness(t, () => json(401, { error: "Unauthorized" }));
  for (const url of ["/api/login", "/api/login?source=restore"]) {
    await assert.rejects(request(url, { method: "POST", body: JSON.stringify({ token: "entered-test-token" }) }),
      (error) => error.status === 401 && error.message === "Unauthorized");
  }
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ url }) => url), ["/api/login", "/api/login?source=restore"]);
  assert.deepEqual(events, []);
});

test("protected reads still retry once after saved-token authentication succeeds", async (t) => {
  const { calls, events } = harness(t, (url, options, count) => {
    if (url === "/api/login") {
      assert.equal(options.method, "POST");
      assert.equal(JSON.parse(options.body).token, "saved-test-token");
      return json(200, { ok: true });
    }
    return count === 1 ? json(401, { error: "Unauthorized" }) : json(200, { value: "ready" });
  });
  assert.deepEqual(await request("/api/config"), { value: "ready" });
  assert.deepEqual(calls.map(({ url }) => url), ["/api/config", "/api/login", "/api/config"]);
  assert.deepEqual(events, []);
});

for (const supported of [true, false]) {
  test(`saved-token recovery remembers initial history support ${supported} without an extra auth read`, async (t) => {
    const { calls, events } = harness(t, (url, _options, count) => {
      if (url === "/api/auth/session") return json(200, { authenticated: true, capabilities: { initialHistory: 1 } });
      if (url === "/api/login") return json(200, { ok: true, ...(supported ? { capabilities: { initialHistory: 1 } } : {}) });
      return count === 2 ? json(401, { error: "Unauthorized" }) : json(200, { value: "ready" });
    });
    await requestAuthSession();
    assert.equal(supportsInitialHistory(), true);
    assert.deepEqual(await request("/api/config"), { value: "ready" });
    assert.equal(supportsInitialHistory(), supported);
    assert.deepEqual(calls.map(({ url }) => url), ["/api/auth/session", "/api/config", "/api/login", "/api/config"]);
    assert.deepEqual(events, []);
  });
}

test("a stale saved-login JSON body cannot replace capabilities from a newer login or retry", async (t) => {
  const body = deferred();
  const { calls, events } = harness(t, (url, _options, count) => {
    if (url !== "/api/login") return json(401, { error: "Old session expired" });
    return count === 2 ? { ok: true, status: 200, json: () => body.promise } : json(200, { ok: true });
  });
  const stale = request("/api/v2/codex/threads/thread/requests");
  await new Promise(setImmediate);
  assert.equal(calls.length, 2);
  await request("/api/login", { method: "POST" });
  body.resolve({ ok: true, capabilities: { initialHistory: 1 } });
  await assert.rejects(stale, { status: 401 });
  assert.equal(supportsInitialHistory(), false);
  assert.equal(calls.length, 3);
  assert.deepEqual(events, []);
});

test("cancelled saved-login JSON cannot enable the capability or retry its protected read", async (t) => {
  const body = deferred(), controller = new AbortController();
  const { calls, events } = harness(t, (url) => url === "/api/login"
    ? { ok: true, status: 200, json: () => body.promise } : json(401, { error: "Unauthorized" }));
  const reading = request("/api/config", { signal: controller.signal });
  await new Promise(setImmediate);
  assert.equal(calls.length, 2);
  controller.abort();
  await assert.rejects(reading, { name: "AbortError" });
  body.resolve({ ok: true, capabilities: { initialHistory: 1 } });
  await new Promise(setImmediate);
  assert.equal(supportsInitialHistory(), false);
  assert.equal(calls.length, 2);
  assert.deepEqual(events, []);
});

test("failed protected-read recovery emits expiry once and preserves the original error", async (t) => {
  const { calls, events } = harness(t, () => json(401, { error: "Unauthorized" }));
  await assert.rejects(request("/api/config"), (error) => error.status === 401);
  assert.deepEqual(calls.map(({ url }) => url), ["/api/config", "/api/login"]);
  assert.deepEqual(events, [AUTH_EXPIRED_EVENT]);
});

test("a repeated protected rejection after successful login cannot loop recovery", async (t) => {
  const { calls, events } = harness(t, (url) => json(url === "/api/login" ? 200 : 401, { error: "Unauthorized" }));
  await assert.rejects(request("/api/config"), (error) => error.status === 401);
  assert.deepEqual(calls.map(({ url }) => url), ["/api/config", "/api/login", "/api/config"]);
  assert.deepEqual(events, [AUTH_EXPIRED_EVENT]);
});

test("login transport errors do not trigger recovery or auth expiry", async (t) => {
  const failure = new TypeError("Network unavailable");
  const { calls, events } = harness(t, () => { throw failure; });
  await assert.rejects(request("/api/login", { method: "POST" }), (error) => error === failure);
  assert.equal(calls.length, 1);
  assert.deepEqual(events, []);
});

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

for (const stage of ["pending", "completed"]) {
  test(`old protected 401 cannot recover credentials or expire a new ${stage} login`, async (t) => {
    const old = deferred();
    const login = deferred();
    const { calls, events } = harness(t, (url) => url === "/api/login" ? login.promise : old.promise);
    const stale = request("/api/config");
    const renewed = request("/api/login", { method: "POST", body: JSON.stringify({ token: "new-test-token" }) });
    if (stage === "completed") {
      login.resolve(json(200, { ok: true }));
      await renewed;
    }
    old.resolve(json(401, { error: "Old session expired" }));
    await assert.rejects(stale, (error) => error.status === 401);
    assert.deepEqual(calls.map(({ url }) => url), ["/api/config", "/api/login"]);
    assert.deepEqual(events, []);
    if (stage === "pending") {
      login.resolve(json(200, { ok: true }));
      await renewed;
    }
  });
}

for (const [label, operation] of [
  ["auth session", () => requestAuthSession()],
  ["legacy history", () => requestHistoryMessages({ provider: "claude", resumeSessionId: "old-thread" }, { value: true })],
  ["legacy session stream", () => requestSessionInputStream("old-session", {})],
  ["legacy thread stream", () => requestThreadInputStream("claude", "old-thread", {})]
]) {
  test(`old ${label} rejection cannot expire or retry after a new login`, async (t) => {
    const old = deferred();
    const { calls, events } = harness(t, (url) => url === "/api/login" ? json(200, { ok: true }) : old.promise);
    const stale = operation();
    await request("/api/login", { method: "POST", body: JSON.stringify({ token: "new-test-token" }) });
    old.resolve(json(401, { error: "Old session expired" }));
    await assert.rejects(stale, (error) => error.status === 401);
    assert.equal(calls.length, 2);
    assert.deepEqual(events, []);
  });
}

test("saved-token recovery finishing after a new login cannot retry the old operation", async (t) => {
  const recovery = deferred();
  const { calls, events } = harness(t, (url, _options, count) => {
    if (url !== "/api/login") return json(401, { error: "Old session expired" });
    return count === 2 ? recovery.promise : json(200, { ok: true });
  });
  const stale = request("/api/config");
  await new Promise(setImmediate);
  assert.equal(calls.length, 2);
  await request("/api/login", { method: "POST", body: JSON.stringify({ token: "new-test-token" }) });
  recovery.resolve(json(200, { ok: true }));
  await assert.rejects(stale, (error) => error.status === 401);
  assert.equal(calls.length, 3);
  assert.deepEqual(events, []);
});
