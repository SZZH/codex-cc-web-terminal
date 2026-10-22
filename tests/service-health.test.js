import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { once } from "node:events";
import { createRuntimeShutdown } from "../src/runtime/createRuntime.js";
import { matchesManagedHealth, parseArgs, resolveHealthPort, waitForHealth } from "../scripts/service.mjs";

test("service health port follows PORT with an explicit override", () => {
  assert.equal(resolveHealthPort({ filePort: "4310" }), 4310);
  assert.equal(resolveHealthPort({ envPort: "5320", filePort: "4310" }), 5320);
  assert.equal(parseArgs(["status"], { envPort: "", filePort: "4310" }).healthPort, 4310);
  assert.equal(parseArgs(["status", "--health-port", "6330"], { envPort: "5320", filePort: "4310" }).healthPort, 6330);
  assert.equal(parseArgs(["status", "--health-port", "6330"], { envPort: "invalid", filePort: "4310" }).healthPort, 6330);
  assert.throws(() => parseArgs(["status", "--health-port"], { envPort: "5320", filePort: "4310" }), /Missing value/);
  assert.equal(parseArgs(["list"], { envPort: "invalid", filePort: "invalid" }).action, "list");
  assert.throws(() => resolveHealthPort({ envPort: "70000" }), /Invalid health port/);
});

test("health response must belong to the managed online process", () => {
  const payload = { ok: true, service: "codex-cc-web-terminal", pid: 42, shuttingDown: false };
  const app = { pid: 42, pm2_env: { status: "online" } };
  assert.equal(matchesManagedHealth(payload, app), true);
  assert.equal(matchesManagedHealth({ ...payload, pid: 43 }, app), false);
  assert.equal(matchesManagedHealth({ ...payload, service: "other" }, app), false);
  assert.equal(matchesManagedHealth({ ...payload, shuttingDown: true }, app), false);
  assert.equal(matchesManagedHealth(payload, { ...app, pm2_env: { status: "stopped" } }), false);
});

test("configured health port waits for the expected process identity", async (t) => {
  let requests = 0;
  const server = http.createServer((_req, response) => {
    requests += 1;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: true, service: "codex-cc-web-terminal", pid: requests === 1 ? 100 : 200, shuttingDown: false }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const result = await waitForHealth(port, 2, () => ({ pid: 200, pm2_env: { status: "online" } }));
  assert.equal(JSON.parse(result).pid, 200);
  assert.equal(requests, 2);
});

test("shutdown terminates stalled WebSockets and waits for workspace cleanup despite another closer failing", async (t) => {
  const server = http.createServer((_req, response) => response.end("ok"));
  const wss = new WebSocketServer({ server });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new WebSocket("ws://127.0.0.1:" + server.address().port);
  await once(client, "open");
  client._socket.pause();
  t.after(() => { client.terminate(); for (const socket of wss.clients) socket.terminate(); wss.close(); server.closeAllConnections(); server.close(); });
  let workspaceClosed = false;
  let sidebarClosed = false;
  let sessionsClosed = false;
  let stopped = false;
  const failures = [];
  const runtime = { shuttingDown: false, previewGatewayReady: true,
    closeWorkspace: async () => { await new Promise((resolve) => setTimeout(resolve, 70)); workspaceClosed = true; },
    closeSidebar: async () => { await new Promise((resolve) => setTimeout(resolve, 90)); sidebarClosed = true; } };
  const shutdown = createRuntimeShutdown({ runtime, server, forceConnectionsMs: 25,
    wsRuntime: { wss, closeClients: () => { for (const socket of wss.clients) socket.close(1012); }, stop: () => { stopped = true; } },
    previewGateway: { close: () => { throw new Error("preview close fixture"); } },
    sessionManager: { shutdown: () => { sessionsClosed = true; } }, onError: (error) => failures.push(error.message) });
  const pending = shutdown("SIGTERM");
  assert.equal(shutdown("SIGINT"), pending);
  assert.equal(runtime.shuttingDown, true);
  assert.equal(runtime.previewGatewayReady, false);
  await pending;
  assert.equal(workspaceClosed, true);
  assert.equal(sidebarClosed, true);
  assert.equal(sessionsClosed, true);
  assert.equal(stopped, true);
  assert.deepEqual(failures, ["preview close fixture"]);
  assert.equal(server.listening, false);
  assert.equal(wss.clients.size, 0);
});
