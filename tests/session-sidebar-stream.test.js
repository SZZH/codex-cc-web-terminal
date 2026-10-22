import test from "node:test";
import assert from "node:assert/strict";
import { request } from "../web/src/lib/api.js";
import { readSessionSidebarStream } from "../web/src/lib/session-sidebar-stream.js";

const protocol = "session-sidebar-progressive-v1", snapshotId = "A".repeat(43);
function fixture() {
  const sessions = [{ id: "first", provider: "codex", name: "中文首条", activityState: "running" },
    { id: "last", provider: "codex", inputPreview: "末条完整预览" }];
  const payload = { sidebarFormat: "compact-v1", sessions, projectGroups: [{ id: "project:a", name: "项目", sessionIds: sessions.map(({ id }) => id) }] };
  const bootstrap = { protocol, snapshotId, type: "bootstrap", complete: false,
    counts: { sessionsTotal: 2, activitiesTotal: 2, runningTotal: 1, groups: [{ key: "project:a", total: 2, running: 1 }] },
    payload: { ...payload, sessions: sessions.slice(0, 1), projectGroups: [{ ...payload.projectGroups[0], sessionIds: ["first"] }] } };
  return { bootstrap, complete: { protocol, snapshotId, type: "complete", complete: true, payload }, payload };
}
function controlledResponse(t) {
  let controller, cancelled = 0;
  const stream = new ReadableStream({ start(value) { controller = value; }, cancel() { cancelled += 1; } });
  const response = new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
  let ended = false;
  const send = (text) => controller.enqueue(typeof text === "string" ? new TextEncoder().encode(text) : text);
  const close = () => { if (!ended) { ended = true; try { controller.close(); } catch { /* Already cancelled. */ } } };
  t.after(close);
  return { response, stream, send, close, get cancelled() { return cancelled; } };
}
const line = (frame) => `${JSON.stringify(frame)}\n`;
const flush = () => new Promise(setImmediate);

function apiHarness(t, respond, token = "saved-test-token") {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const calls = [], events = [], timers = new Map();
  let now = 0, timerId = 0;
  globalThis.window = { localStorage: { getItem: () => token }, dispatchEvent: (event) => events.push(event.type) };
  t.mock.method(globalThis, "fetch", (url, options) => {
    const call = { url, options }; calls.push(call); return respond(call, calls.length);
  });
  t.mock.method(globalThis, "setTimeout", (callback, delay) => { timers.set(++timerId, { callback, due: now + delay }); return timerId; });
  t.mock.method(globalThis, "clearTimeout", (id) => timers.delete(id));
  t.after(() => {
    assert.equal(timers.size, 0, "all read deadlines are released");
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else delete globalThis.window;
  });
  return { calls, events, timers, advance(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.callback(); }
  } };
}

function observe(promise) {
  const state = {};
  promise.then((value) => { state.value = value; state.settled = true; }, (error) => { state.error = error; state.settled = true; });
  return state;
}

test("standard chunked reader publishes a UTF-8 bootstrap but requires complete and EOF", async (t) => {
  const f = fixture(), stream = controlledResponse(t), seen = [];
  let settled = false;
  const result = readSessionSidebarStream(stream.response, { onSidebarBootstrap: (frame) => seen.push(frame) }).then((payload) => { settled = true; return payload; });
  const bytes = new TextEncoder().encode(line(f.bootstrap));
  const split = bytes.findIndex((value) => value > 127) + 1;
  stream.send(bytes.slice(0, split)); await flush(); assert.equal(seen.length, 0);
  stream.send(bytes.slice(split)); await flush();
  assert.equal(settled, false);
  stream.send(line(f.complete)); stream.close();
  assert.deepEqual(await result, f.payload);
  assert.equal(seen.length, 1); assert.equal(seen[0].payload.sessions[0].name, "中文首条");
  assert.equal(stream.response.body.locked, false); assert.equal(settled, true);
});

test("bootstrap is visible while the complete frame and EOF are still pending", async (t) => {
  const f = fixture(), s = controlledResponse(t), seen = [];
  let settled = false;
  const pending = readSessionSidebarStream(s.response, { onSidebarBootstrap: (frame) => seen.push(frame) }).then((payload) => { settled = true; return payload; });
  s.send(line(f.bootstrap)); await flush();
  assert.equal(seen.length, 1); assert.equal(settled, false);
  s.send(line(f.complete)); await flush(); assert.equal(settled, false);
  s.close(); assert.deepEqual(await pending, f.payload); assert.equal(s.stream.locked, false);
});

test("invalid orders, references, versions, counts and truncated or additional frames reject", async () => {
  const f = fixture();
  const invalid = [line(f.bootstrap), line(f.complete), line(f.bootstrap) + line(f.complete).trimEnd(),
    line({ ...f.bootstrap, protocol: "wrong" }) + line(f.complete),
    line(f.bootstrap) + line({ ...f.complete, snapshotId: "B".repeat(43) }),
    line(f.bootstrap) + line(f.bootstrap), line(f.bootstrap) + line(f.complete) + line(f.complete),
    line({ ...f.bootstrap, counts: { ...f.bootstrap.counts, sessionsTotal: 0 } }) + line(f.complete),
    line({ ...f.bootstrap, payload: { ...f.bootstrap.payload, projectGroups: [{ id: "project:a", sessionIds: ["missing"] }] } }) + line(f.complete),
    line(f.bootstrap) + line({ ...f.complete, payload: { ...f.payload, sessions: f.payload.sessions.slice(0, 1), projectGroups: f.bootstrap.payload.projectGroups } }),
    line(f.bootstrap) + "{invalid JSON}\n", new Uint8Array([0xff])];
  for (const text of invalid) {
    const response = new Response(text);
    await assert.rejects(readSessionSidebarStream(response), (error) => {
      assert.equal(error.message, "会话列表尚未完整加载，请重试。");
      assert(error.cause instanceof Error, "diagnostic parser detail remains in cause");
      return true;
    });
    assert.equal(response.body.locked, false);
  }
});

test("bootstrap running totals describe the full activity winner even when an unseen newer alias is idle", async () => {
  const f = fixture();
  Object.assign(f.payload.sessions[0], { resumeSessionId: "same-thread", updatedAt: "2026-01-01T00:00:00Z" });
  Object.assign(f.payload.sessions[1], { resumeSessionId: "same-thread", updatedAt: "2026-01-02T00:00:00Z" });
  f.bootstrap.counts.activitiesTotal = 1; f.bootstrap.counts.runningTotal = 0;
  const response = new Response(line(f.bootstrap) + line(f.complete));
  assert.deepEqual(await readSessionSidebarStream(response), f.payload);
});

test("abort releases a pending standard reader without publishing late frames", async (t) => {
  const f = fixture(), s = controlledResponse(t), controller = new AbortController(), seen = [];
  const pending = readSessionSidebarStream(s.response, { signal: controller.signal, onSidebarBootstrap: (frame) => seen.push(frame) });
  s.send(line(f.bootstrap)); await flush();
  controller.abort(new DOMException("owned cancel", "AbortError"));
  await assert.rejects(pending, /owned cancel/);
  assert.equal(seen.length, 1); assert.equal(s.cancelled, 1); assert.equal(s.stream.locked, false);
});

test("request preserves legacy JSON and keeps the callback out of fetch options", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const f = fixture(), calls = [], seen = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return calls.length === 1
    ? new Response(line(f.bootstrap) + line(f.complete), { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } })
    : new Response(JSON.stringify(f.payload), { headers: { "Content-Type": "application/json" } }); };
  assert.deepEqual(await request("/api/sessions?compact=1&progressive=1", { onSidebarBootstrap: (frame) => seen.push(frame) }), f.payload);
  assert.deepEqual(await request("/api/sessions?compact=1"), f.payload);
  assert.equal(seen.length, 1); assert.equal(Object.hasOwn(calls[0].options, "onSidebarBootstrap"), false);
});

test("shared budgets cover 401 recovery, bootstrap, and a hanging complete body", async (t) => {
  const f = fixture(), s = controlledResponse(t), seen = [];
  let first, login;
  const h = apiHarness(t, (_call, count) => count === 1 ? new Promise((resolve) => { first = resolve; })
    : count === 2 ? new Promise((resolve) => { login = resolve; }) : s.response);
  const state = observe(request("/api/sessions?compact=1&progressive=1", { onSidebarBootstrap: (frame) => seen.push(frame) }));
  h.advance(5000); first(new Response("{}", { status: 401 })); await flush();
  h.advance(5000); login(new Response("{}")); await flush();
  s.send(line(f.bootstrap)); await flush();
  assert.equal(seen.length, 1); assert.equal(h.calls.length, 3); assert.equal(h.timers.size, 2);
  assert.equal(new Set(h.calls.map(({ options }) => options.signal)).size, 1);
  h.advance(29999); await flush(); assert.equal(state.settled, undefined);
  h.advance(1); await flush();
  assert.equal(state.error?.code, "READ_TIMEOUT"); assert.equal(s.cancelled, 1); assert.equal(s.stream.locked, false);
  assert.equal(h.timers.size, 0); assert.deepEqual(h.events, []);
});

test("NDJSON bytes refresh the idle budget before frames finish and completion still requires EOF", async (t) => {
  const f = fixture(), s = controlledResponse(t), seen = [];
  const h = apiHarness(t, () => s.response);
  const state = observe(request("/api/sessions?compact=1&progressive=1", { onSidebarBootstrap: (frame) => seen.push(frame) }));
  const bootstrap = line(f.bootstrap), complete = line(f.complete);
  await flush();
  h.advance(20000); s.send(bootstrap.slice(0, 100)); await flush();
  assert.equal(state.settled, undefined); assert.equal(seen.length, 0);
  h.advance(20000); s.send(bootstrap.slice(100)); await flush();
  assert.equal(state.settled, undefined); assert.equal(seen.length, 1);
  h.advance(20000); s.send(complete.slice(0, 100)); await flush();
  assert.equal(state.settled, undefined);
  h.advance(20000); s.send(complete.slice(100)); await flush();
  assert.equal(state.settled, undefined);
  h.advance(29999); await flush(); assert.equal(state.settled, undefined);
  s.close(); await flush();
  assert.deepEqual(state.value, f.payload);
  assert.equal(s.cancelled, 0); assert.equal(s.stream.locked, false);
  assert.equal(h.timers.size, 0); assert.deepEqual(h.events, []);
});

test("NDJSON progress cannot extend the total budget and a bootstrap never confirms the full catalog", async (t) => {
  const f = fixture(), s = controlledResponse(t), seen = [];
  const h = apiHarness(t, () => s.response);
  const state = observe(request("/api/sessions?compact=1&progressive=1", { onSidebarBootstrap: (frame) => seen.push(frame) }));
  await flush();
  s.send(line(f.bootstrap)); await flush();
  const complete = line(f.complete), chunkSize = Math.ceil(complete.length / 6);
  for (let index = 0; index < 5; index += 1) {
    h.advance(20000); s.send(complete.slice(index * chunkSize, (index + 1) * chunkSize)); await flush();
    assert.equal(state.settled, undefined);
  }
  h.advance(19999); s.send(complete.slice(5 * chunkSize)); await flush();
  assert.equal(state.settled, undefined); assert.equal(seen.length, 1);
  h.advance(1); await flush();
  assert.equal(state.error?.code, "READ_TIMEOUT");
  assert.equal(state.value, undefined); assert.equal(s.cancelled, 1); assert.equal(s.stream.locked, false);
  assert.equal(h.timers.size, 0); assert.deepEqual(h.events, []);
});

test("authenticated retry returns the complete compact payload and calls bootstrap exactly once", async (t) => {
  const f = fixture(), seen = [];
  const h = apiHarness(t, (_call, count) => count === 1 ? new Response("{}", { status: 401 })
    : count === 2 ? new Response("{}")
      : new Response(line(f.bootstrap) + line(f.complete), { headers: { "Content-Type": "application/x-ndjson" } }));
  assert.deepEqual(await request("/api/sessions?compact=1&progressive=1", { onSidebarBootstrap: (frame) => seen.push(frame) }), f.payload);
  assert.deepEqual(h.calls.map(({ url }) => url), ["/api/sessions?compact=1&progressive=1", "/api/login", "/api/sessions?compact=1&progressive=1"]);
  assert.equal(seen.length, 1); assert(h.calls.every(({ options }) => options.signal.aborted));
  assert.deepEqual(h.events, []);
});

test("caller abort removes reader and signal listeners before any late bootstrap can publish", async (t) => {
  const s = controlledResponse(t), caller = new AbortController(), seen = [], listeners = new Set();
  let readSignal;
  const h = apiHarness(t, ({ options }) => {
    readSignal = options.signal;
    const add = readSignal.addEventListener.bind(readSignal), remove = readSignal.removeEventListener.bind(readSignal);
    t.mock.method(readSignal, "addEventListener", (type, listener, options) => { listeners.add(listener); return add(type, listener, options); });
    t.mock.method(readSignal, "removeEventListener", (type, listener) => { listeners.delete(listener); return remove(type, listener); });
    return s.response;
  });
  const pending = request("/api/sessions?compact=1&progressive=1", { signal: caller.signal, onSidebarBootstrap: (frame) => seen.push(frame) });
  await flush(); assert.equal(listeners.size, 1);
  caller.abort(new DOMException("left list", "AbortError"));
  await assert.rejects(pending, /left list/); await flush();
  assert.equal(readSignal.aborted, true); assert.equal(s.cancelled, 1); assert.equal(s.stream.locked, false);
  assert.equal(listeners.size, 0); assert.equal(seen.length, 0); assert.equal(h.timers.size, 0);
});

test("read ownership rejects a late bootstrap and failed auth recovery never invokes the decoder", async (t) => {
  const f = fixture(), s = controlledResponse(t), seen = [];
  let current = true;
  const pending = readSessionSidebarStream(s.response, { assertActive() { if (!current) throw new Error("obsolete read"); },
    onSidebarBootstrap: (frame) => seen.push(frame) });
  current = false; s.send(line(f.bootstrap));
  await assert.rejects(pending, /obsolete read/); assert.equal(seen.length, 0); assert.equal(s.stream.locked, false);
  const h = apiHarness(t, () => new Response(JSON.stringify({ error: "expired" }), { status: 401 }), "");
  await assert.rejects(request("/api/sessions?compact=1&progressive=1", { onSidebarBootstrap: (frame) => seen.push(frame) }), { status: 401 });
  assert.equal(seen.length, 0); assert.deepEqual(h.events, ["codex-auth-expired"]);
});

