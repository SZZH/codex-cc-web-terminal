import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { login, startTestServer } from "./helpers/backendTestUtils.js";
import { AppServerBridge } from "../src/appServerBridge.js";
import { CodexInteractionService } from "../src/sessions/codex/interactions/service.js";
import { installWebSocketServer } from "../src/routes/ws.js";
import { WebSocket } from "ws";
import { waitForCondition } from "./helpers/backendTestUtils.js";

test("interaction HTTP snapshots and responses retain authentication, origin and one-response authority", async (t) => {
  const server = await startTestServer({ sessionManager: { stats: () => ({}), get: () => null } });
  const bridge = new AppServerBridge({});
  const messages = [];
  bridge.bindSocket({ readyState: 1, on() {}, send(payload, callback) { messages.push(JSON.parse(payload)); callback?.(); } });
  bridge.ensureReady = async () => { throw new Error("interaction GET must not resume"); };
  const interactions = new CodexInteractionService({ bridge, ownsThread: () => true });
  server.runtime.codexThreads = { interactions };
  t.after(async () => {
    interactions.shutdown(); bridge.resetConnectionState();
    await server.runtime.closeWorkspace(); await server.close();
    fs.rmSync(server.rootDir, { recursive: true, force: true });
  });
  bridge.handleMessage(JSON.stringify({ id: 42, method: "item/fileChange/requestApproval", params: { threadId: "thread-123", turnId: "turn-123", itemId: "item-123", startedAtMs: 100 } }));
  const base = `${server.baseUrl}/api/v2/codex/threads/thread-123/interactions`;
  assert.equal((await fetch(base)).status, 401);
  const auth = await login(server.baseUrl, server.config.accessToken);
  const headers = { cookie: auth.cookies, origin: server.baseUrl, "content-type": "application/json" };
  const snapshot = await (await fetch(base, { headers })).json();
  assert.equal(snapshot.interactions.length, 1);
  const id = snapshot.interactions[0].id;
  const body = JSON.stringify({ responseId: randomUUID(), response: { decision: "accept" } });
  assert.equal((await fetch(`${base}/${id}/respond`, { method: "POST", headers: { "content-type": "application/json" }, body })).status, 401);
  assert.equal((await fetch(`${base}/${id}/respond`, { method: "POST", headers: { ...headers, origin: "https://untrusted.invalid" }, body })).status, 403);
  assert.equal((await fetch(`${base}/${id}/respond`, { method: "POST", headers, body: JSON.stringify({ rpcId: 42, response: { decision: "accept" } }) })).status, 400);
  const response = await fetch(`${base}/${id}/respond`, { method: "POST", headers, body });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).interaction.status, "submitted");
  assert.equal((await fetch(`${base}/${id}/respond`, { method: "POST", headers, body })).status, 200);
  assert.equal(messages.length, 1);
  assert.equal((await fetch(`${server.baseUrl}/api/v2/codex/threads/wrong-thread/interactions/${id}`, { headers })).status, 404);
});

test("real HTTP respondents share one claim while websocket observers receive versioned states", async (t) => {
  const server = await startTestServer({ sessionManager: { stats: () => ({}), get: () => null } });
  const bridge = new AppServerBridge({});
  const messages = [], callbacks = [], observers = new Set(), events = [];
  let sequence = 0;
  bridge.bindSocket({ readyState: 1, on() {}, send(payload, callback) { messages.push(JSON.parse(payload)); callbacks.push(callback); } });
  const interactions = new CodexInteractionService({ bridge, ownsThread: () => true, publish(threadId, type, payload) {
    for (const send of observers) send({ schemaVersion: 2, threadId, epoch: "stream-epoch", seq: ++sequence, type, payload });
  } });
  server.runtime.codexThreads = { interactions, subscribe(threadId, send) {
    observers.add(send);
    send({ schemaVersion: 2, threadId, epoch: "stream-epoch", seq: sequence, type: "sync.required", payload: {} });
    return () => observers.delete(send);
  } };
  const wsRuntime = installWebSocketServer(server.server, server.runtime);
  let socket;
  t.after(async () => {
    socket?.terminate(); wsRuntime.closeClients(); wsRuntime.stop();
    interactions.shutdown(); bridge.resetConnectionState();
    await server.runtime.closeWorkspace(); await server.close();
    fs.rmSync(server.rootDir, { recursive: true, force: true });
  });
  const auth = await login(server.baseUrl, server.config.accessToken);
  const headers = { cookie: auth.cookies, origin: server.baseUrl, "content-type": "application/json" };
  socket = new WebSocket(`${server.baseUrl.replace(/^http/, "ws")}/ws/codex?threadId=thread-123`, { headers });
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  bridge.handleMessage(JSON.stringify({ id: "native-rpc", method: "item/tool/requestUserInput", params: {
    threadId: "thread-123", turnId: "turn-123", itemId: "item-123", isBlocking: true,
    questions: [{ id: "value", header: "Value", question: "Enter", isSecret: true }]
  } }));
  await waitForCondition(() => events.some((event) => event.type === "interaction.updated"));
  const pending = interactions.list("thread-123");
  const entry = pending.interactions[0];
  const url = `${server.baseUrl}/api/v2/codex/threads/thread-123/interactions/${entry.id}/respond`;
  const answer = { responseId: randomUUID(), response: { answers: { value: { answers: ["secret-over-http"] } } } };
  const first = fetch(url, { method: "POST", headers, body: JSON.stringify(answer) });
  await waitForCondition(() => messages.length === 1);
  const duplicate = fetch(url, { method: "POST", headers, body: JSON.stringify(answer) });
  const competing = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...answer, responseId: randomUUID() }) });
  assert.equal(competing.status, 409);
  callbacks[0]();
  for (const response of await Promise.all([first, duplicate])) {
    assert.equal(response.status, 200);
    assert.equal((await response.json()).interaction.status, "submitted");
  }
  bridge.handleMessage(JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "thread-123", requestId: "native-rpc" } }));
  await waitForCondition(() => events.some((event) => event.payload.interaction?.status === "resolved"));
  const changes = events.filter((event) => event.type === "interaction.updated");
  assert.deepEqual(changes.map((event) => event.payload.interaction.status), ["pending", "submitting", "submitted", "resolved"]);
  assert.ok(changes.every((event) => event.epoch === "stream-epoch" && event.payload.epoch === interactions.epoch));
  assert.deepEqual(changes.map((event) => event.payload.interaction.version), [1, 2, 3, 4]);
  assert.equal(JSON.stringify(events).includes("secret-over-http"), false);
  assert.equal(JSON.stringify(events).includes("native-rpc"), false);
  assert.equal(messages.length, 1);
});
