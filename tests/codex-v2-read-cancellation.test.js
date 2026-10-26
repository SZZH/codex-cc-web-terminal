import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter, getEventListeners } from "node:events";
import Koa from "koa";
import { CodexHistoryReader } from "../src/sessions/codex/historyReader.js";
import { CodexThreadService } from "../src/sessions/codex/threadService.js";
import { handleCodexV2Route } from "../src/routes/codexV2.js";
import { installResponseRuntime } from "../src/runtime/http/response.js";

const thread = { id: "synthetic", cwd: "", historyMode: "paginated", status: { type: "idle" }, turns: [] };
const item = (id = "target") => ({ id, type: "agentMessage", text: `synthetic ${id}`, phase: "final_answer" });
const page = (items = []) => ({ data: items, nextCursor: null });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function bounded(promise, milliseconds = 350) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("bounded wait expired")), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function until(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "bounded condition wait");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
const aborted = (error) => error?.name === "AbortError";

function readerFixture(handler = (method, params) => method === "thread/read" ? { thread } : page(
  method === "thread/items/list" && params.sortDirection === "asc" ? [item()] : [])) {
  const calls = [];
  const bridge = { ensureReady: async () => {}, request(...args) { calls.push(args); return handler(...args); } };
  return { reader: new CodexHistoryReader({ bridge }), bridge, calls };
}

test("pre-aborted history reads do not initialize, use cached metadata or send RPCs", async () => {
  const { reader, bridge, calls } = readerFixture();
  let initialized = 0;
  bridge.ensureReady = async () => { initialized += 1; };
  reader.remember(thread);
  const controller = new AbortController();
  controller.abort();
  const options = { signal: controller.signal };
  for (const read of [() => reader.getThread(thread.id, options), () => reader.listTurns(thread.id, options),
    () => reader.listItems(thread.id, "turn", options), () => reader.getItem(thread.id, "turn", "target", options),
    () => reader.getImage(thread.id, "turn", "target", 0, options)]) {
    await assert.rejects(read(), aborted);
  }
  assert.equal(initialized, 0);
  assert.equal(calls.length, 0);
});

test("a reader leaves shared ready promptly while another waiter keeps initialization", async () => {
  const ready = deferred();
  const { reader, bridge, calls } = readerFixture();
  let waiters = 0;
  bridge.connecting = ready.promise;
  bridge.ensureReady = () => { waiters += 1; return bridge.connecting; };
  const controller = new AbortController();
  const cancelled = reader.getThread(thread.id, { signal: controller.signal });
  const survivor = reader.getThread(thread.id);
  cancelled.catch(() => {});
  try {
    await until(() => waiters === 1);
    controller.abort();
    await assert.rejects(bounded(cancelled), aborted);
    assert.equal(calls.length, 0);
    assert.equal(bridge.connecting, ready.promise);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    ready.resolve();
    assert.equal((await bounded(survivor)).id, thread.id);
    assert.equal(calls.length, 1);
    assert.ok(calls[0][2]?.signal instanceof AbortSignal);
    assert.notEqual(calls[0][2].signal, controller.signal);
    assert.equal(calls[0][2].signal.aborted, false);
  } finally {
    controller.abort(); ready.resolve();
    await Promise.allSettled([cancelled, survivor]);
  }
});

test("late metadata from a transport ignoring signal cannot populate cache or continue history", async () => {
  const reply = deferred();
  const { reader, calls } = readerFixture(() => reply.promise);
  const controller = new AbortController();
  const reading = reader.listTurns(thread.id, { signal: controller.signal });
  reading.catch(() => {});
  try {
    await until(() => calls.length === 1);
    assert.equal(calls[0][0], "thread/read");
    assert.deepEqual(calls[0][1], { threadId: thread.id, includeTurns: false });
    assert.ok(calls[0][2]?.signal instanceof AbortSignal);
    assert.notEqual(calls[0][2].signal, controller.signal);
    controller.abort();
    assert.equal(calls[0][2].signal.aborted, true);
    await assert.rejects(bounded(reading), aborted);
    reply.resolve({ thread });
    await tick();
    assert.equal(reader.metadata.size, 0);
    assert.equal(calls.length, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally { controller.abort(); reply.resolve({ thread }); await Promise.allSettled([reading]); }
});

test("warm history cancellation handles late rejection and skips presentation and position caches", async () => {
  const reply = deferred();
  const { reader, calls } = readerFixture(() => reply.promise);
  reader.remember(thread);
  let presentations = 0;
  reader.presentTurn = () => { presentations += 1; return {}; };
  const controller = new AbortController();
  const reading = reader.listTurns(thread.id, { signal: controller.signal });
  reading.catch(() => {});
  try {
    await until(() => calls.length === 1);
    controller.abort();
    await assert.rejects(bounded(reading), aborted);
    reply.reject(new Error("late upstream failure"));
    await tick();
    assert.equal(presentations, 0);
    assert.equal(reader.itemPositions.size, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally { controller.abort(); reply.resolve(page()); await Promise.allSettled([reading]); }
});

for (const stage of ["desc", "asc"]) {
  test(`detail cancellation at ${stage} stops later phases and preserves exclusive anchors`, async () => {
    const reply = deferred();
    const { reader, calls } = readerFixture((method, params) => params.sortDirection === stage ? reply.promise : page([item("previous")]));
    reader.remember(thread);
    let presented = 0;
    reader.subagentActivity.forItems = () => { presented += 1; return new Map(); };
    const controller = new AbortController();
    const reading = reader.getItem(thread.id, "turn", "target", { signal: controller.signal });
    reading.catch(() => {});
    try {
      await until(() => calls.some((call) => call[1].sortDirection === stage));
      assert.deepEqual(calls[0][1].cursor, { type: "item", itemId: "target" });
      if (stage === "asc") assert.deepEqual(calls[1][1].cursor, { type: "item", itemId: "previous" });
      assert.ok(calls.every((call) => call[0] === "thread/items/list" && call[1].limit === 1 && call[2]?.signal === controller.signal));
      controller.abort();
      await assert.rejects(bounded(reading), aborted);
      reply.resolve(page([item(stage === "desc" ? "previous" : "target")]));
      await tick();
      assert.equal(calls.length, stage === "desc" ? 1 : 2);
      assert.equal(presented, 0);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    } finally { controller.abort(); reply.resolve(page([item()])); await Promise.allSettled([reading]); }
  });
}

test("cancellation between detail phases prevents the target RPC", async () => {
  const { reader, calls } = readerFixture(() => page([item("previous")]));
  reader.remember(thread);
  const controller = new AbortController();
  const original = reader.officialItems.bind(reader);
  reader.officialItems = async (...args) => { const result = await original(...args); controller.abort(); return result; };
  await assert.rejects(reader.getItem(thread.id, "turn", "target", { signal: controller.signal }), aborted);
  assert.equal(calls.length, 1);
});

test("abort wins a same-reply race without caching metadata; successful reads remove listeners", async () => {
  const controller = new AbortController();
  const { reader, calls } = readerFixture(() => { controller.abort(); return { thread }; });
  await assert.rejects(reader.getThread(thread.id, { signal: controller.signal }), aborted);
  assert.equal(reader.metadata.size, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(calls.length, 1);
  const normal = readerFixture();
  const healthy = new AbortController();
  assert.equal((await normal.reader.getThread(thread.id, { signal: healthy.signal })).id, thread.id);
  assert.equal(getEventListeners(healthy.signal, "abort").length, 0);
  healthy.abort();
  assert.equal(normal.reader.metadata.size, 1);
});

test("signal-bearing successful pages, detail and inline image preserve content and local options", async () => {
  const bytes = Buffer.from("GIF89a1234567890", "ascii");
  const source = { id: "target", type: "userMessage", content: [{ type: "image", url: `data:image/gif;base64,${bytes.toString("base64")}` }] };
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const { reader, calls } = readerFixture((method, params) => method === "thread/read" ? { thread } :
    method === "thread/turns/list" ? page([{ id: "turn", status: "completed", itemsView: "summary", items: [source] }]) :
      page(params.sortDirection === "desc" ? [] : [source]));
  assert.equal((await reader.listTurns(thread.id, options)).turns[0].items[0].id, source.id);
  assert.equal((await reader.listItems(thread.id, "turn", options)).items[0].id, source.id);
  assert.equal((await reader.getItem(thread.id, "turn", source.id, options)).item.id, source.id);
  assert.deepEqual(await reader.getImage(thread.id, "turn", source.id, 0, options), { type: "image/gif", bytes });
  assert.ok(calls.every(([method, params, local]) => ["thread/read", "thread/turns/list", "thread/items/list"].includes(method) &&
    (method === "thread/read" ? local.signal instanceof AbortSignal && local.signal !== controller.signal : local.signal === controller.signal) &&
    !Object.hasOwn(params, "signal")));
  assert.equal(Object.hasOwn(reader.metadata.get(thread.id).thread, "signal"), false);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(controller.signal.aborted, false);
});

test("legacy fallback never starts after cancellation and preserves real upstream errors", async () => {
  const controller = new AbortController();
  const unsupported = Object.assign(new Error("method not found"), { code: -32601 });
  let legacyReads = 0;
  const { reader } = readerFixture(() => { controller.abort(); throw unsupported; });
  reader.remember({ ...thread, historyMode: "legacy" });
  reader.sessionManager = { historyService: { getHistoricalMessages() { legacyReads += 1; return { threadSnapshot: { turns: [] } }; } } };
  await assert.rejects(reader.listTurns(thread.id, { signal: controller.signal }), aborted);
  assert.equal(legacyReads, 0);
  const denied = Object.assign(new Error("permission denied"), { code: -32000, statusCode: 403 });
  const normal = readerFixture(() => { throw denied; });
  normal.reader.remember({ ...thread, historyMode: "legacy" });
  normal.reader.sessionManager = reader.sessionManager;
  await assert.rejects(normal.reader.listTurns(thread.id, { signal: new AbortController().signal }), (error) => error === denied);
  assert.equal(legacyReads, 0);
});

test("legacy synchronous load checks cancellation before committing metadata or presentation", async () => {
  const controller = new AbortController();
  const reader = new CodexHistoryReader({ sessionManager: { historyService: { getHistoricalMessages() {
    controller.abort(); return { threadSnapshot: { turns: [] } };
  } } } });
  await assert.rejects(reader.getThread(thread.id, { signal: controller.signal }), aborted);
  assert.equal(reader.metadata.size, 0);
  assert.equal(reader.legacyThreads.size, 0);
});

test("cached legacy fallback stops before presentation when synchronous loading observes abort", async () => {
  const controller = new AbortController();
  const reader = new CodexHistoryReader({ sessionManager: { historyService: { getHistoricalMessages() {
    controller.abort(); return { threadSnapshot: { turns: [{ id: "turn", items: [item()] }] } };
  } } } });
  reader.remember({ ...thread, historyMode: "legacy" });
  reader.legacyThreads.add(thread.id);
  let presented = 0;
  reader.presentTurn = () => { presented += 1; return {}; };
  await assert.rejects(reader.listTurns(thread.id, { signal: controller.signal }), aborted);
  assert.equal(presented, 0);
  assert.equal(reader.itemPositions.size, 0);
});

test("detail presentation and image boundaries reject abort before returning output", async () => {
  for (const mode of ["presentation", "image"]) {
    const controller = new AbortController();
    const { reader } = readerFixture();
    const raw = deferred();
    reader.rawItem = () => raw.promise;
    const reading = mode === "image" ? reader.getImage(thread.id, "turn", "target", 0, { signal: controller.signal }) :
      reader.getItem(thread.id, "turn", "target", { signal: controller.signal });
    reading.catch(() => {});
    try {
      controller.abort();
      raw.resolve({ item: item(), thread });
      await assert.rejects(bounded(reading), aborted);
    } finally { raw.resolve({ item: item(), thread }); await Promise.allSettled([reading]); }
  }
  const controller = new AbortController();
  const { reader } = readerFixture();
  reader.remember(thread);
  reader.subagentActivity.forItems = () => { controller.abort(); return new Map(); };
  await assert.rejects(reader.listItems(thread.id, "turn", { signal: controller.signal }), aborted);
});

test("thread service forwards read options without binding created state to HTTP ownership", async () => {
  const thread = { id: "synthetic", cwd: "", historyMode: "paginated", status: { type: "idle" }, turns: [],
    capabilities: { desktopQuestionAnswers: false, desktopInterrupt: false, desktopQueuedSteer: false } };
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const calls = [];
  const discoveryCalls = [];
  const service = Object.create(CodexThreadService.prototype);
  service.createdThreads = new Map([[thread.id, { local: true }]]);
  service.reader = { getThread: async (...args) => { calls.push(args); return thread; } };
  service.desktopClient = { discover: async (...args) => { discoveryCalls.push(args); return null; } };
  assert.deepEqual(await service.getThread(thread.id, options), { local: true, ...thread });
  assert.equal(calls[0][1], options);
  assert.deepEqual(discoveryCalls, [[thread.id, options]]);
  assert.deepEqual(service.createdThreads.get(thread.id), { local: true });
});

function routeFixture(path = "/turns", method = "GET") {
  const req = new EventEmitter();
  const res = Object.assign(new EventEmitter(), { destroyed: false, writableFinished: false });
  const ctx = { url: `/api/v2/codex/threads/${thread.id}${path}`, method, req, res, set() {} };
  const calls = [];
  const reply = deferred();
  const reader = {
    listTurns: (...args) => { calls.push(args); return reply.promise; },
    listItems: (...args) => { calls.push(args); return reply.promise; },
    getItem: (...args) => { calls.push(args); return reply.promise; },
    getImage: (...args) => { calls.push(args); return reply.promise; }
  };
  const runtime = { requireAuthorized: () => true, forbidCrossOrigin: () => false,
    json: (_ctx, ...args) => calls.push(["json", ...args]),
    codexThreads: { reader, getThread: (...args) => { calls.push(args); return reply.promise; },
      reconcileRequests: () => calls.push(["reconcile"]), reconcileItems: () => calls.push(["reconcile"]) } };
  return { ctx, runtime, calls, reply };
}

for (const [path, result, signalIndex] of [["", thread, 1], ["/turns", { turns: [] }, 1],
  ["/turns/turn/items", { items: [] }, 2], ["/turns/turn/items/target", { item: item() }, 3],
  ["/turns/turn/items/target/images/0", { bytes: Buffer.from("GIF89a"), type: "image/gif" }, 4]]) {
  test(`route ${path || "metadata"} owns one signal and suppresses late reconciliation and JSON`, async () => {
    const f = routeFixture(path);
    const running = handleCodexV2Route(f.ctx, f.runtime);
    try {
      const signal = f.calls[0][signalIndex]?.signal;
      assert.ok(signal instanceof AbortSignal);
      assert.equal(signal.aborted, false);
      f.ctx.res.destroyed = true; f.ctx.res.emit("close");
      assert.equal(signal.aborted, true);
      f.reply.resolve(result);
      assert.equal(await bounded(running), true);
      assert.equal(f.calls.some((call) => ["reconcile", "json"].includes(call[0])), false);
      assert.equal(f.ctx.body, undefined);
      assert.equal(f.ctx.res.listenerCount("close"), 0);
      assert.equal(f.ctx.res.listenerCount("finish"), 0);
    } finally { f.reply.resolve(result); await running; }
  });
}

test("normal GET request close, finished response and real RPC errors keep their original path", async () => {
  for (const mode of ["request-close", "response-finish", "error"]) {
    const f = routeFixture();
    const running = handleCodexV2Route(f.ctx, f.runtime);
    try {
      const signal = f.calls[0][1]?.signal;
      assert.ok(signal instanceof AbortSignal);
      if (mode === "request-close") f.ctx.req.emit("close");
      if (mode === "response-finish") { f.ctx.res.writableFinished = true; f.ctx.res.emit("finish"); f.ctx.res.emit("close"); }
      assert.equal(signal.aborted, false);
      if (mode === "error") f.reply.reject(Object.assign(new Error("permission denied"), { statusCode: 403, code: "denied" }));
      else f.reply.resolve({ turns: [] });
      await bounded(running);
      assert.equal(f.calls.filter((call) => call[0] === "json").length, 1);
      assert.equal(f.calls.find((call) => call[0] === "json")[1], mode === "error" ? 403 : 200);
      assert.equal(f.calls.filter((call) => call[0] === "reconcile").length, mode === "error" ? 0 : 1);
      assert.equal(f.ctx.res.listenerCount("close"), 0);
      assert.equal(f.ctx.req.listenerCount("close"), 0);
    } finally { f.reply.resolve({ turns: [] }); await running; }
  }
});

test("an upstream AbortError on an open response stays visible and cancellation during reconciliation skips JSON", async () => {
  const open = routeFixture();
  const running = handleCodexV2Route(open.ctx, open.runtime);
  open.reply.reject(new DOMException("upstream aborted independently", "AbortError"));
  await running;
  assert.equal(open.calls.find((call) => call[0] === "json")[2].error, "upstream aborted independently");
  const closed = routeFixture();
  closed.runtime.codexThreads.reconcileRequests = () => { closed.ctx.res.destroyed = true; closed.ctx.res.emit("close"); };
  const reconciling = handleCodexV2Route(closed.ctx, closed.runtime);
  closed.reply.resolve({ turns: [] });
  await reconciling;
  assert.equal(closed.calls.some((call) => call[0] === "json"), false);
  assert.equal(closed.ctx.res.listenerCount("close"), 0);
});

test("a destroyed response skips error JSON even before its close callback runs", async () => {
  const f = routeFixture();
  const running = handleCodexV2Route(f.ctx, f.runtime);
  f.ctx.res.destroyed = true;
  f.reply.reject(new Error("late RPC failure"));
  await running;
  assert.equal(f.calls.some((call) => call[0] === "json"), false);
  assert.equal(f.calls[0][1].signal.aborted, true);
  assert.equal(f.ctx.res.listenerCount("close"), 0);
});

test("already destroyed history response does not start reading; receipts and mutations stay unbound", async () => {
  const gone = routeFixture();
  gone.ctx.res.destroyed = true;
  await handleCodexV2Route(gone.ctx, gone.runtime);
  assert.equal(gone.calls.length, 0);
  assert.equal(gone.ctx.res.listenerCount("close"), 0);
  for (const method of ["GET", "POST"]) {
    const f = routeFixture("/requests", method);
    f.runtime.codexThreads.requests = { list: () => [] };
    f.runtime.readBody = async () => { f.ctx.res.destroyed = true; f.ctx.res.emit("close"); return "{}"; };
    f.runtime.parseJson = JSON.parse;
    f.runtime.codexThreads.submit = (...args) => { f.calls.push(["submit", ...args]); return { id: "receipt" }; };
    await handleCodexV2Route(f.ctx, f.runtime);
    assert.equal(f.ctx.res.listenerCount("close"), 0);
    assert.equal(f.calls.filter((call) => call[0] === "json").length, 1);
    if (method === "POST") assert.equal(f.calls.filter((call) => call[0] === "submit").length, 1);
  }
});

async function httpFixture() {
  const held = [], calls = [], contexts = [], jobs = [], sockets = new Set();
  const bridge = { ensureReady: async () => {}, request(...args) { const reply = deferred(); calls.push(args); held.push({ args, reply }); return reply.promise; } };
  const reader = new CodexHistoryReader({ bridge });
  const stats = { active: 0, reconciled: 0, lateJson: 0, errors: [], cleanListeners: true };
  const runtime = { requireAuthorized: () => true, forbidCrossOrigin: () => false, codexThreads: {
    reader, getThread: (...args) => reader.getThread(...args), reconcileRequests() { stats.reconciled += 1; }, reconcileItems() { stats.reconciled += 1; }
  } };
  installResponseRuntime(runtime);
  const json = runtime.json;
  runtime.json = (ctx, ...args) => { if (ctx.res.destroyed) stats.lateJson += 1; return json(ctx, ...args); };
  const app = new Koa();
  app.on("error", (error) => stats.errors.push(error));
  app.use(async (ctx) => {
    contexts.push(ctx); stats.active += 1;
    const closeListeners = new Set(ctx.res.listeners("close")), finishListeners = new Set(ctx.res.listeners("finish"));
    try { const job = handleCodexV2Route(ctx, runtime); jobs.push(job); await job; }
    finally {
      stats.active -= 1;
      stats.cleanListeners &&= ctx.res.listeners("close").every((listener) => closeListeners.has(listener)) &&
        ctx.res.listeners("finish").every((listener) => finishListeners.has(listener));
    }
  });
  const server = http.createServer(app.callback());
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const agent = new http.Agent({ keepAlive: true, maxSockets: 6 });
  const clients = [];
  const get = (path) => {
    let req;
    const result = new Promise((resolve, reject) => {
      req = http.get(`http://127.0.0.1:${server.address().port}/api/v2/codex/threads/${thread.id}${path}`, { agent }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk)); res.on("error", reject);
        res.on("end", () => { try { resolve({ status: res.statusCode, payload: JSON.parse(Buffer.concat(chunks)) }); } catch (error) { reject(error); } });
      });
      req.on("error", reject);
    });
    result.catch(() => {}); clients.push({ req, result }); return { req, result };
  };
  const close = async () => {
    try {
      for (const { req } of clients) req.destroy();
      for (let round = 0; round < 8; round += 1) {
        for (const entry of held) entry.reply.resolve(entry.args[0] === "thread/read" ? { thread } : page());
        await tick();
      }
      await Promise.allSettled(clients.map(({ result }) => result));
      await bounded(Promise.allSettled(jobs), 1500);
    } finally {
      agent.destroy(); server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await tick();
    assert.equal(server.listening, false); assert.equal(sockets.size, 0); assert.equal(stats.active, 0);
  };
  return { reader, bridge, calls, held, contexts, jobs, stats, get, close };
}

for (const mode of ["cold-turns", "cold-detail", "warm-detail"]) {
  test(`real HTTP ${mode} cancels only its reader while client, background and fake write complete`, async () => {
    const f = await httpFixture();
    const independent = [];
    try {
      if (mode === "warm-detail") f.reader.remember(thread);
      const cancelled = f.get(mode === "cold-turns" ? "/turns" : "/turns/turn/items/target");
      await until(() => f.calls.length === 1);
      const survivor = f.get("/turns");
      const background = f.reader.listTurns(thread.id);
      const mutation = f.bridge.request("turn/start", { threadId: thread.id, input: "synthetic" });
      independent.push(background, mutation); background.catch(() => {}); mutation.catch(() => {});
      await until(() => f.contexts.length === 2 && f.calls.length === (mode === "warm-detail" ? 4 : 2));
      cancelled.req.destroy(new Error("synthetic client left"));
      await assert.rejects(cancelled.result, /synthetic client left/);
      await until(() => f.contexts[0].res.destroyed);
      await bounded(f.jobs[0]);
      assert.equal(f.stats.active, 1);
      assert.equal(f.calls[0][2]?.signal.aborted, mode === "warm-detail");
      const before = f.calls.length;
      if (mode === "warm-detail") {
        f.held[0].reply.resolve(page([item("previous")])); await tick();
        assert.equal(f.calls.length, before);
      } else {
        assert.equal(f.calls.filter((call) => call[0] === "thread/read").length, 1);
      }
      assert.equal(f.stats.reconciled, 0); assert.equal(f.stats.lateJson, 0);
      assert.equal(f.reader.metadata.has(thread.id), mode === "warm-detail");

      for (let round = 0; round < 4; round += 1) {
        for (const entry of f.held) entry.reply.resolve(entry.args[0] === "thread/read" ? { thread } :
          entry.args[0] === "turn/start" ? { turn: { id: "synthetic-write" } } : page());
        await tick();
      }
      assert.equal((await bounded(survivor.result)).status, 200);
      assert.deepEqual((await bounded(background)).turns, []);
      assert.equal((await bounded(mutation)).turn.id, "synthetic-write");
      assert.equal(f.calls.filter((call) => call[0] === "thread/items/list").length, mode === "warm-detail" ? 1 : 0);
      assert.equal(f.reader.metadata.has(thread.id), true);
      assert.ok(f.calls.filter((call) => call[0] === "turn/start").every((call) => call.length === 2));
      assert.ok(f.calls.filter((call) => !call[2]).length >= 2);
      await until(() => f.stats.active === 0);
      assert.equal(f.contexts[1].req.complete, true);
      const survivorSignal = f.calls.find((call, index) => index > 0 && call[2])?.[2].signal;
      assert.equal(survivorSignal.aborted, false);
      await tick();
      const count = f.calls.length;
      const keepalive = f.get("/turns");
      await until(() => f.calls.length === count + 1);
      f.held.at(-1).reply.resolve(page());
      assert.equal((await bounded(keepalive.result)).status, 200);
      assert.equal(keepalive.req.reusedSocket, true);
      assert.equal(survivorSignal.aborted, false);
      assert.ok(f.calls.every((call) => !call[2] || getEventListeners(call[2].signal, "abort").length === 0));
      assert.equal(f.stats.reconciled, 2); assert.equal(f.stats.lateJson, 0);
      assert.equal(f.stats.cleanListeners, true); assert.deepEqual(f.stats.errors, []);
    } finally { await f.close(); await Promise.allSettled(independent); }
  });
}
