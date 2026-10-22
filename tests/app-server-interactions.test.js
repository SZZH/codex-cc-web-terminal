import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AppServerBridge } from "../src/appServerBridge.js";

function socket() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.messages = [];
  ws.send = (encoded, callback) => { ws.messages.push(JSON.parse(encoded)); callback?.(); };
  return ws;
}

test("inbound callbacks preserve typed RPC IDs and claim their original socket once", async () => {
  const bridge = new AppServerBridge({});
  const first = socket();
  bridge.bindSocket(first);
  const requests = [];
  bridge.inbound.setHandler((request) => { requests.push(request); return true; });
  for (const id of [1, "1"]) first.emit("message", JSON.stringify({ id, method: "item/tool/requestUserInput", params: { threadId: "thread-123" } }));
  assert.equal(requests.length, 2);
  await requests[0].respond({ answers: {} });
  await assert.rejects(requests[0].respond({ answers: {} }), /already/);
  assert.equal(first.messages[0].id, 1);
  const replacement = socket();
  bridge.bindSocket(replacement);
  first.emit("close");
  first.emit("message", JSON.stringify({ id: "old", method: "item/tool/requestUserInput", params: {} }));
  assert.equal(bridge.ws, replacement);
  assert.equal(requests.length, 2);
  await assert.rejects(requests[1].respond({ answers: {} }), /connection|available/);
  assert.deepEqual(replacement.messages, []);
  bridge.resetConnectionState();
});

test("resolved requests lose response authority before any observer or callback", async () => {
  const bridge = new AppServerBridge({});
  const ws = socket();
  bridge.bindSocket(ws);
  let request;
  bridge.inbound.setHandler((entry) => { request = entry; return true; });
  ws.emit("message", JSON.stringify({ id: "rpc", method: "mcpServer/elicitation/request", params: { threadId: "thread-123" } }));
  ws.emit("message", JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "thread-123", requestId: "rpc" } }));
  await assert.rejects(request.respond({ action: "decline" }), /resolved|available/);
  assert.deepEqual(ws.messages, []);
  bridge.resetConnectionState();
});

test("stale socket replies cannot settle outbound RPCs on a replacement connection", async () => {
  const bridge = new AppServerBridge({ codexAppServerRequestTimeoutMs: 1000 });
  const old = socket();
  bridge.bindSocket(old);
  const current = socket();
  bridge.bindSocket(current);
  const pending = bridge.request("thread/read", { threadId: "thread-123" });
  const id = current.messages[0].id;
  old.emit("message", JSON.stringify({ id, result: { stale: true } }));
  assert.equal(bridge.pending.size, 1);
  current.emit("message", JSON.stringify({ id, result: { current: true } }));
  assert.deepEqual(await pending, { current: true });
  bridge.resetConnectionState();
});

test("unregistered host callbacks have explicit errors and current time is host owned", async () => {
  const bridge = new AppServerBridge({});
  const ws = socket();
  bridge.bindSocket(ws);
  for (const [index, method] of ["item/tool/call", "account/chatgptAuthTokens/refresh", "attestation/generate", "applyPatchApproval", "execCommandApproval", "currentTime/read"].entries()) {
    ws.emit("message", JSON.stringify({ id: index, method, params: {} }));
  }
  assert.equal(ws.messages[0].error.code, -32001);
  for (const response of ws.messages.slice(1, 5)) assert.equal(response.error.code, -32601);
  assert.ok(Math.abs(ws.messages[5].result.currentTimeAt - Math.floor(Date.now() / 1000)) <= 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bridge.inbound.requests.size, 0);
  bridge.resetConnectionState();
});
