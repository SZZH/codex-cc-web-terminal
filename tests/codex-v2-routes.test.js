import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { WebSocket } from "ws";
import { installWebSocketServer } from "../src/routes/ws.js";
import { presentCodexItem } from "../src/sessions/codex/itemPresentation.js";
import { CodexHistoryReader } from "../src/sessions/codex/historyReader.js";
import { login, startTestServer } from "./helpers/backendTestUtils.js";

async function setup(t) {
  const calls = [];
  const sessionManager = { stats: () => ({}), get: () => null, attachClient() { throw new Error("V2 must not attach a legacy session"); } };
  const server = await startTestServer({ sessionManager });
  server.runtime.codexThreads = {
    getThread: async (id) => ({ id, name: "Test" }),
    createThread: async (body) => ({ id: "thread-new", cwd: body.cwd }),
    reader: {
      listTurns: async (threadId, options) => { calls.push({ kind: "turns", options }); return { threadId, turns: [], olderCursor: "older", hasMore: true }; },
      listItems: async (threadId, turnId) => ({ threadId, turnId, items: [], nextCursor: null, hasMore: false }),
      getItem: async () => ({ item: { id: "item-123", type: "fileChange" } }),
      getImage: async () => ({ bytes: Buffer.from("GIF89a"), type: "image/gif" })
    },
    reconcileRequests: () => {},
    submit: (threadId, body) => { calls.push({ kind: "submit", threadId, body }); return { id: body.clientRequestId, threadId, state: "received" }; },
    promoteQueuedRequest: (threadId, requestId, body) => {
      calls.push({ kind: "promote", threadId, requestId, body });
      return { id: requestId, threadId, state: "received", mode: "steer", expectedTurnId: body.expectedTurnId };
    },
    cancelQueuedRequest: async (threadId, requestId) => {
      calls.push({ kind: "cancel", threadId, requestId });
      return { id: requestId, threadId, state: "cancelled" };
    },
    requests: { list: () => [], get: (threadId, id) => id === "request-123" ? { id, threadId, state: "unknown" } : null },
    interrupt: async (threadId, body) => { calls.push({ kind: "interrupt", threadId, body }); return { ok: true }; },
    subscribe: (threadId, send, cursor) => {
      calls.push({ kind: "subscribe", threadId, cursor });
      send({ schemaVersion: 2, threadId, epoch: "server-epoch", seq: 0, type: "sync.required", payload: {} });
      return () => calls.push({ kind: "unsubscribe" });
    }
  };
  const wsRuntime = installWebSocketServer(server.server, server.runtime);
  t.after(async () => {
    wsRuntime.closeClients(); wsRuntime.stop(); await server.runtime.closeWorkspace(); await server.close();
    rmSync(server.rootDir, { recursive: true, force: true });
  });
  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  return { ...server, calls, headers: { cookie: cookies, origin: server.baseUrl, "content-type": "application/json" } };
}

test("stop forwards the displayed turn ID and retains authentication and origin checks", async (t) => {
  const s = await setup(t);
  const url = `${s.baseUrl}/api/v2/codex/threads/thread-123/interrupt`;
  const body = JSON.stringify({ expectedTurnId: "visible-turn" });
  assert.equal((await fetch(url, { method: "POST", body })).status, 401);
  assert.equal((await fetch(url, { method: "POST", body, headers: { ...s.headers, origin: "https://other.invalid" } })).status, 403);
  assert.equal(s.calls.length, 0);
  assert.equal((await fetch(url, { method: "POST", body, headers: s.headers })).status, 200);
  assert.deepEqual(s.calls, [{ kind: "interrupt", threadId: "thread-123", body: { expectedTurnId: "visible-turn" } }]);
});

test("v2 history requires authentication, returns one page and has no duplicate legacy payload", async (t) => {
  const s = await setup(t);
  const url = `${s.baseUrl}/api/v2/codex/threads/thread-123/turns?limit=2&cursor=previous`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: s.headers });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(Object.keys(payload).sort(), ["hasMore", "olderCursor", "threadId", "turns"]);
  const { signal, ...pageOptions } = s.calls[0].options;
  assert.deepEqual(pageOptions, { limit: 2, cursor: "previous" });
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
});

test("desktop question response route requires authentication and same origin and forwards only its addressed question", async (t) => {
  const s = await setup(t);
  const calls = [];
  s.runtime.codexThreads.desktopQuestions = { respond: async (...args) => { calls.push(args); return { id: "answer-id", state: "dispatching" }; } };
  const url = `${s.baseUrl}/api/v2/codex/threads/thread-123/questions/call_question/respond`;
  const body = { clientRequestId: "answer-id", expectedTurnId: "turn-id", index: 0, answer: "茶" };
  assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status, 401);
  assert.equal((await fetch(url, { method: "POST", headers: { ...s.headers, origin: "https://foreign.test" }, body: JSON.stringify(body) })).status, 403);
  assert.equal(calls.length, 0);
  const response = await fetch(url, { method: "POST", headers: s.headers, body: JSON.stringify(body) });
  assert.equal(response.status, 202);
  assert.deepEqual(calls, [["thread-123", "call_question", body]]);
  assert.equal((await response.json()).request.state, "dispatching");
});

test("item history forwards an explicit direction only to the item page reader", async (t) => {
  const s = await setup(t);
  const reads = [];
  s.runtime.codexThreads.reader.listItems = async (threadId, turnId, options) => {
    reads.push(options);
    return { threadId, turnId, items: [], nextCursor: null, hasMore: false };
  };
  const base = `${s.baseUrl}/api/v2/codex/threads/thread-123`;
  for (const direction of [undefined, "asc", "desc"]) {
    const query = `limit=30&cursor=page-token${direction ? `&sortDirection=${direction}` : ""}`;
    const response = await fetch(`${base}/turns/turn-123/items?${query}`, { headers: s.headers });
    assert.equal(response.status, 200);
    const { signal, ...options } = reads.at(-1);
    assert.deepEqual(options, { limit: 30, cursor: "page-token", ...(direction ? { sortDirection: direction } : {}) });
    assert.ok(signal instanceof AbortSignal);
  }
  assert.equal((await fetch(`${base}/turns?sortDirection=desc`, { headers: s.headers })).status, 200);
  assert.equal(Object.hasOwn(s.calls.at(-1).options, "sortDirection"), false);
});

test("item history rejects invalid or repeated sort directions before invoking the reader", async (t) => {
  const s = await setup(t);
  let reads = 0;
  s.runtime.codexThreads.reader.listItems = async () => { reads += 1; throw new Error("Must not read invalid input"); };
  const base = `${s.baseUrl}/api/v2/codex/threads/thread-123/turns/turn-123/items`;
  for (const query of ["sortDirection=", "sortDirection=newest", "sortDirection=ASC", "sortDirection=desc&sortDirection=asc", "sortDirection=desc&sortDirection=desc"]) {
    const response = await fetch(`${base}?${query}`, { headers: { ...s.headers, "accept-encoding": "gzip" } });
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get("content-encoding"), null);
    assert.deepEqual(await response.json(), { error: "Invalid item sort direction", code: "request_failed" });
  }
  assert.equal(reads, 0);
  assert.equal((await fetch(`${base}?sortDirection=newest`)).status, 401);
  assert.equal(reads, 0);
});

test("item history reads the latest 30 chronologically and retains ascending page compatibility", async (t) => {
  const s = await setup(t);
  const source = Array.from({ length: 70 }, (_, position) => ({ id: `item-${position}`, type: "agentMessage", text: `answer ${position}` }));
  const calls = [];
  s.runtime.codexThreads.reader = new CodexHistoryReader({ bridge: { request: async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { id: "thread-123", historyMode: "paginated", turns: [] } };
    assert.equal(method, "thread/items/list");
    const descending = params.sortDirection === "desc";
    const offset = params.cursor ? Number(params.cursor.split(":")[1]) : descending ? source.length : 0;
    const start = descending ? Math.max(0, offset - params.limit) : offset;
    const end = descending ? offset : Math.min(source.length, start + params.limit);
    const selected = source.slice(start, end);
    const nextCursor = descending ? start > 0 ? `desc:${start}` : null : end < source.length ? `asc:${end}` : null;
    return { data: (descending ? selected.reverse() : selected).map((item) => ({ turnId: "turn-123", item })), nextCursor };
  } } });
  const base = `${s.baseUrl}/api/v2/codex/threads/thread-123/turns/turn-123/items`;
  const headers = { ...s.headers, "accept-encoding": "identity" };
  assert.equal((await fetch(`${base}?limit=30&sortDirection=desc`)).status, 401);
  assert.equal(calls.length, 0);
  const latestResponse = await fetch(`${base}?limit=30&sortDirection=desc`, { headers });
  assert.equal(latestResponse.status, 200);
  assert.equal(latestResponse.headers.get("content-encoding"), null);
  const latest = await latestResponse.json();
  assert.deepEqual(latest.items.map((item) => item.id), source.slice(40).map((item) => item.id));
  assert.equal(latest.latestItemId, "item-69");
  assert.equal(latest.hasMore, true);
  assert.equal(latest.nextCursor, "desc:40");
  const older = await (await fetch(`${base}?limit=30&sortDirection=desc&cursor=${latest.nextCursor}`, { headers })).json();
  assert.deepEqual(older.items.map((item) => item.id), source.slice(10, 40).map((item) => item.id));
  for (const query of ["limit=30", "limit=30&sortDirection=asc"]) {
    const response = await fetch(`${base}?${query}`, { headers });
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.deepEqual(page.items.map((item) => item.id), source.slice(0, 30).map((item) => item.id));
    assert.equal(page.nextCursor, "asc:30");
  }
  assert.deepEqual(calls.filter((call) => call.method === "thread/items/list").map((call) => call.params.sortDirection), ["desc", "desc", "asc", "asc"]);
});

function readWire(url, headers) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

test("only successful authenticated v2 history GETs negotiate compressed JSON", async (t) => {
  const s = await setup(t);
  const text = "history response ".repeat(1500);
  const item = { id: "item-123", type: "agentMessage", text, presentation: { text }, status: "completed" };
  const pages = [
    ["/turns", { threadId: "thread-123", turns: [{ id: "turn-123", items: [item] }], hasMore: false }],
    ["/turns/turn-123/items", { threadId: "thread-123", turnId: "turn-123", items: [item], hasMore: false }],
    ["/turns/turn-123/items/item-123", { item }],
    ["/turns/turn-123/items?sortDirection=desc", { threadId: "thread-123", turnId: "turn-123", items: [item], hasMore: false }]
  ];
  s.runtime.codexThreads.reader.listTurns = async () => pages[0][1];
  s.runtime.codexThreads.reader.listItems = async () => pages[1][1];
  s.runtime.codexThreads.reader.getItem = async () => pages[2][1];
  const base = `${s.baseUrl}/api/v2/codex/threads/thread-123`;
  const headers = { ...s.headers, "accept-encoding": "gzip" };
  for (const [path, payload] of pages) {
    const denied = await readWire(`${base}${path}`, { "accept-encoding": "gzip" });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers["content-encoding"], undefined);
    const response = await readWire(`${base}${path}`, headers);
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-encoding"], "gzip");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["x-frame-options"], "DENY");
    assert.match(response.headers.vary, /Accept-Encoding/i);
    assert.equal(response.headers.etag, undefined);
    assert.equal(response.headers["content-length"], undefined);
    assert.deepEqual(gunzipSync(response.body), Buffer.from(`${JSON.stringify(payload)}\n`));
  }
  s.runtime.codexThreads.getThread = async () => ({ id: "thread-123", name: text });
  s.runtime.codexThreads.requests.list = () => [{ id: "request-123", text }];
  for (const path of ["", "/requests", "/turns/turn-123/items/item-123/images/0", "/missing"]) {
    const response = await readWire(`${base}${path}`, headers);
    assert.equal(response.headers["content-encoding"], undefined);
  }
  s.runtime.codexThreads.reader.listTurns = async () => { throw Object.assign(new Error(text), { status: 502 }); };
  const error = await readWire(`${base}/turns`, headers);
  assert.equal(error.status, 502);
  assert.equal(error.headers["content-encoding"], undefined);
  s.runtime.codexThreads.createThread = async () => ({ id: "thread-new", text });
  const mutation = await fetch(`${s.baseUrl}/api/v2/codex/threads`, { method: "POST", body: "{}", headers });
  assert.equal(mutation.status, 201);
  assert.equal(mutation.headers.get("content-encoding"), null);
});

test("v2 history streams a complete legal summary above 4 MiB", async (t) => {
  const s = await setup(t);
  const turns = Array.from({ length: 10 }, (_, turn) => ({ id: `turn-${turn}`, status: "completed", itemsView: "summary",
    items: Array.from({ length: 5 }, (_, item) => presentCodexItem({ id: `answer-${turn}-${item}`, type: "agentMessage",
      status: "completed", phase: "commentary", text: "历史读取需要保留消息内容以及完整身份，边界变化时继续核对结果。".repeat(700).slice(0, 16000)
    }, { threadId: "thread-123", turnId: `turn-${turn}` }))
  }));
  const payload = { threadId: "thread-123", turns, hasMore: false, olderCursor: null };
  const expected = Buffer.from(`${JSON.stringify(payload)}\n`);
  assert.ok(expected.length > 4 * 1024 * 1024);
  s.runtime.codexThreads.reader.listTurns = async () => payload;
  const response = await readWire(`${s.baseUrl}/api/v2/codex/threads/thread-123/turns`, { ...s.headers, "accept-encoding": "gzip" });
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-encoding"], "gzip");
  assert.deepEqual(gunzipSync(response.body), expected);
});

test("v2 submission returns a receipt and rejects cross-origin mutations", async (t) => {
  const s = await setup(t);
  const url = `${s.baseUrl}/api/v2/codex/threads/thread-123/requests`;
  const body = JSON.stringify({ clientRequestId: "request-123", input: { text: "hello", attachments: [] } });
  assert.equal((await fetch(url, { method: "POST", body, headers: { ...s.headers, origin: "https://untrusted.invalid" } })).status, 403);
  assert.equal(s.calls.length, 0);
  const response = await fetch(url, { method: "POST", body, headers: s.headers });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).request.state, "received");
  const receipt = await fetch(`${url}/request-123`, { headers: s.headers });
  assert.equal((await receipt.json()).request.state, "unknown");
  assert.equal((await fetch(`${url}/request-missing`, { headers: s.headers })).status, 404);
});

test("v2 queue promotion requires authentication and trusted origin and returns the existing receipt", async (t) => {
  const s = await setup(t);
  const url = `${s.baseUrl}/api/v2/codex/threads/thread-123/requests/request-queued/steer`;
  const body = JSON.stringify({ expectedTurnId: "active-turn" });
  assert.equal((await fetch(url, { method: "POST", body, headers: { "content-type": "application/json" } })).status, 401);
  assert.equal((await fetch(url, { method: "POST", body, headers: { ...s.headers, origin: "https://untrusted.invalid" } })).status, 403);
  assert.equal(s.calls.length, 0);
  const response = await fetch(url, { method: "POST", body, headers: s.headers });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { request: { id: "request-queued", threadId: "thread-123", state: "received",
    mode: "steer", expectedTurnId: "active-turn" } });
  assert.deepEqual(s.calls, [{ kind: "promote", threadId: "thread-123", requestId: "request-queued", body: { expectedTurnId: "active-turn" } }]);
});

test("v2 queue promotion preserves conflict status and does not fall back to submission", async (t) => {
  const s = await setup(t);
  s.runtime.codexThreads.promoteQueuedRequest = () => {
    throw Object.assign(new Error("目标回复已结束，消息仍保留在队列中。"), { status: 409, code: "turn_not_active" });
  };
  const response = await fetch(`${s.baseUrl}/api/v2/codex/threads/thread-123/requests/request-queued/steer`, {
    method: "POST", body: JSON.stringify({ expectedTurnId: "old-turn" }), headers: s.headers
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "目标回复已结束，消息仍保留在队列中。", code: "turn_not_active" });
  assert.equal(s.calls.some((call) => call.kind === "submit"), false);
});

test("desktop queue withdrawal requires authentication and trusted origin", async (t) => {
  const s = await setup(t);
  const url = `${s.baseUrl}/api/v2/codex/threads/thread-123/requests/request-queued/cancel`;
  assert.equal((await fetch(url, { method: "POST" })).status, 401);
  assert.equal((await fetch(url, { method: "POST", headers: { ...s.headers, origin: "https://untrusted.invalid" } })).status, 403);
  const response = await fetch(url, { method: "POST", headers: s.headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { request: { id: "request-queued", threadId: "thread-123", state: "cancelled" } });
  assert.deepEqual(s.calls, [{ kind: "cancel", threadId: "thread-123", requestId: "request-queued" }]);
});

test("inline history media uses the same authentication and sandbox headers", async (t) => {
  const s = await setup(t);
  const url = `${s.baseUrl}/api/v2/codex/threads/thread-123/turns/turn-123/items/item-123/images/0`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: s.headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/gif");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy"), /sandbox/);
  assert.equal(await response.text(), "GIF89a");
});

test("v2 websocket subscribes by official thread ID without a legacy live session", async (t) => {
  const s = await setup(t);
  const socket = new WebSocket(`${s.baseUrl.replace(/^http/, "ws")}/ws/codex?threadId=thread-123&epoch=old&after=4`, { headers: s.headers });
  t.after(() => socket.terminate());
  const event = await new Promise((resolve, reject) => { socket.once("message", (raw) => resolve(JSON.parse(String(raw)))); socket.once("error", reject); });
  assert.equal(event.type, "sync.required");
  assert.equal(event.threadId, "thread-123");
  assert.deepEqual(s.calls.find((call) => call.kind === "subscribe").cursor, { threadId: "thread-123", epoch: "old", after: 4 });
  socket.close();
});

test("v2 websocket refuses unauthenticated observers", async (t) => {
  const s = await setup(t);
  const socket = new WebSocket(`${s.baseUrl.replace(/^http/, "ws")}/ws/codex?threadId=thread-123`, { headers: { origin: s.baseUrl } });
  const status = await new Promise((resolve) => { socket.on("unexpected-response", (_, response) => { resolve(response.statusCode); response.resume(); socket.terminate(); }); socket.on("error", () => {}); });
  assert.equal(status, 401);
  assert.equal(s.calls.some((call) => call.kind === "subscribe"), false);
});
