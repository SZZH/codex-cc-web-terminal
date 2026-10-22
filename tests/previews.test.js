import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { PreviewRegistry } from "../src/preview/registry.js";
import { PreviewGateway, previewOrigin } from "../src/preview/gateway.js";
import { login, startTestServer } from "./helpers/backendTestUtils.js";

async function listen(server) { await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); return server.address().port; }
async function availablePort() { const server = http.createServer(); const port = await listen(server); await new Promise((resolve) => server.close(resolve)); return port; }
function registryFixture(t, { now, ...overrides } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preview-registry-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const config = { dataDir: root, port: 3210, previewPort: 3211, previewServicePorts: [3212, 3213], ...overrides };
  return { config, registry: new PreviewRegistry(config, { now }) };
}
async function fixture(t, { serviceCount = 1, ...overrides } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preview-test-"));
  fs.mkdirSync(path.join(root, "state"));
  const ports = new Set();
  while (ports.size < serviceCount + 1) ports.add(await availablePort());
  const [previewPort, ...previewServicePorts] = ports;
  const config = { dataDir: path.join(root, "state"), port: 3210, previewPort, previewServicePorts, authSessionCookieName: "chat_session", ...overrides };
  const registry = new PreviewRegistry(config), gateway = new PreviewGateway({ config, registry });
  await gateway.start();
  t.after(async () => { await gateway.close(); fs.rmSync(root, { force: true, recursive: true }); });
  return { root, config, registry, gateway, origin: `http://127.0.0.1:${config.previewPort}` };
}

async function bounded(promise, message, timeout = 2000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); })]); }
  finally { clearTimeout(timer); }
}

async function mockViewer(t) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const value = { path: req.url, cookie: req.headers.cookie || "", baseUrl: req.headers["x-base-url"] || "" };
    requests.push(value); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value));
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { origin: `http://127.0.0.1:${port}`, requests };
}

async function fileOpening(f, grant) {
  const response = await fetch(`${f.origin}/_open/${grant.id}`, { redirect: "manual" });
  assert.equal(response.status, 302);
  const location = response.headers.get("location");
  const source = new URL(Buffer.from(new URL(location, f.origin).searchParams.get("url"), "base64").toString("utf8"));
  return { location, source, cookie: response.headers.get("set-cookie").split(";")[0] };
}

async function echoServer(t) {
  const server = http.createServer((_req, res) => res.end("ready"));
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => socket.on("message", (raw) => socket.send(raw)));
  const port = await listen(server);
  t.after(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  });
  return port;
}

async function openSocket(grant) {
  const origin = `http://127.0.0.1:${grant.port}`;
  const socket = new WebSocket(`${origin.replace("http", "ws")}/hmr`, {
    headers: { Origin: origin, Cookie: `__codex_preview_${grant.port}=${grant.id}` }
  });
  socket.on("error", () => {});
  const closed = new Promise((resolve) => socket.once("close", resolve));
  try { await bounded(new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); }), "preview websocket did not open"); }
  catch (error) { socket.terminate(); throw error; }
  return { socket, closed };
}

async function echo(socket, value) {
  const response = new Promise((resolve) => socket.once("message", (raw) => resolve(String(raw))));
  socket.send(value); assert.equal(await bounded(response, "preview websocket stopped forwarding"), value);
}

test("file grants resolve Chinese paths, persist, expire, and reject credentials and directories", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preview-grants-")); t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const file = path.join(root, "中文 报告.md"); fs.writeFileSync(file, "# report");
  fs.mkdirSync(path.join(root,"state"));
  let now = 100000; const config = { dataDir: path.join(root, "state"), previewPort: 3211 };
  const registry = new PreviewRegistry(config, { now: () => now });
  const grant = registry.register({ target: "中文 报告.md", cwd: root });
  assert.equal(grant.title, "中文 报告.md");
  assert.equal(registry.register({ target: new URL(`file://${file}`).href }).id, grant.id);
  assert.throws(() => registry.register({ target: file, requestId: "f".repeat(32) }), (error) => error.status === 400);
  assert.equal(registry.register({ target: file }).id, grant.id);
  assert.equal(new PreviewRegistry(config, { now: () => now }).get(grant.id).path, fs.realpathSync(file));
  assert.throws(() => registry.register({ target: path.join(root, ".env") }), /可预览/);
  assert.throws(() => registry.register({ target: root }), /普通文件/);
  assert.throws(() => registry.register({ target: path.join(root, "missing.md") }), /移动/);
  now = grant.expiresAt + 1; assert.throws(() => registry.get(grant.id), /过期/);
});

test("authenticated preview creation rejects cross-origin mutation and generates device-accessible origins", async (t) => {
  const server = await startTestServer({ sessionManager: { stats: () => ({}) } }); t.after(() => server.close());
  server.runtime.previewGatewayReady = true;
  const file = path.join(server.rootDir, "report.md"); fs.writeFileSync(file, "hello");
  const endpoint = `${server.baseUrl}/api/previews`, body = JSON.stringify({ target: file });
  assert.equal((await fetch(endpoint, { method: "POST", body })).status, 401);
  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  assert.equal((await fetch(endpoint, { method: "POST", body, headers: { cookie: cookies, origin: "https://wrong.example" } })).status, 403);
  const response = await fetch(endpoint, { method: "POST", body, headers: { cookie: cookies, origin: server.baseUrl } });
  assert.equal(response.status, 201); const value = await response.json();
  assert.equal(value.kind, "file"); assert.match(value.url, /^http:\/\/127\.0\.0\.1:3211\/_open\//);
  assert.equal(previewOrigin({ previewPublicOrigin: "https://203.0.113.10:8444", previewPort: 3211 }, "https://203.0.113.10:8443", 3213), "https://203.0.113.10:8446");
  assert.equal(previewOrigin({}, "http://192.168.1.10:3210", 3211), "http://192.168.1.10:3211");
});

test("unavailable preview gateway exposes readiness and does not issue a grant", async (t) => {
  const server = await startTestServer({ sessionManager: { stats: () => ({}) } });
  t.after(() => server.close());
  const target = path.join(server.rootDir, "report.md"); fs.writeFileSync(target, "hello");
  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const headers = { cookie: cookies, origin: server.baseUrl };
  const endpoint = `${server.baseUrl}/api/previews`;
  const unavailable = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ target }) });
  assert.equal(unavailable.status, 503);
  assert.equal(server.runtime.previewRegistry.entries.size, 0);
  const fallback = await fetch(`${endpoint}/open?${new URLSearchParams({ target })}`, { headers, redirect: "manual" });
  assert.equal(fallback.status, 503);
  assert.equal(fallback.headers.get("location"), null);
  assert.equal((await fetch(`${endpoint}/${"a".repeat(32)}`, { method: "DELETE", headers })).status, 200);
  const health = await (await fetch(`${server.baseUrl}/api/health`)).json();
  assert.deepEqual(health.preview, { enabled: true, ready: false });
  assert.equal(health.service, "codex-cc-web-terminal");
  assert.equal(health.pid, process.pid);

  server.runtime.previewGatewayReady = true;
  assert.equal((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ target }) })).status, 201);
  assert.deepEqual((await (await fetch(`${server.baseUrl}/api/health`)).json()).preview, { enabled: true, ready: true });
});

test("service windows have independent slots while the same request is idempotent", (t) => {
  const { registry } = registryFixture(t);
  const target = "http://localhost:5173/app";
  const first = registry.register({ target, requestId: "a".repeat(32) });
  const second = registry.register({ target, requestId: "b".repeat(32) });
  assert.notEqual(first.id, second.id); assert.notEqual(first.port, second.port);
  assert.equal(registry.register({ target, requestId: first.id }), first);
  assert.throws(() => registry.register({ target: "http://127.0.0.1:5173/app", requestId: first.id }), (error) => error.status === 409);
  assert.equal(registry.entries.size, 2);
  assert.throws(() => registry.register({ target, requestId: "c".repeat(32) }), (error) => error.status === 409);
  assert.throws(() => registry.register({ target: "http://localhost:5173/other", requestId: second.id }), (error) => error.status === 409);
  registry.remove(first.id);
  assert.equal(registry.get(second.id), second);
  const replacement = registry.register({ target, requestId: "c".repeat(32) });
  assert.equal(replacement.port, first.port);
  assert.throws(() => registry.register({ target, requestId: first.id }), (error) => error.status === 409);
  assert.equal(registry.entries.size, 2);
  for (const requestId of ["", "short", "a".repeat(33), null, 123]) {
    assert.throws(() => registry.register({ target, requestId }), (error) => error.status === 400);
  }
});

test("service grants preserve loopback address families and only normalize the IPv4 wildcard", (t) => {
  const { registry } = registryFixture(t, { previewServicePorts: [3212, 3213, 3214] });
  for (const [hostname, expected] of [["localhost", "localhost"], ["[::1]", "[::1]"], ["0.0.0.0", "127.0.0.1"]]) {
    const grant = registry.register({ target: `http://${hostname}:5173/app?view=mobile#section` });
    assert.equal(grant.origin, `http://${expected}:5173`);
    assert.equal(grant.target, `http://${expected}:5173/app?view=mobile#section`);
  }
});

test("cancel before create survives restart and prevents a late POST from occupying any slot", (t) => {
  let now = 100000;
  const { config, registry } = registryFixture(t, { now: () => now });
  const requestId = "cancel".padEnd(32, "a"), target = "http://localhost:5173/";
  registry.remove(requestId);
  const restored = new PreviewRegistry(config, { now: () => now });
  for (const current of [registry, restored]) {
    assert.throws(() => current.register({ target, requestId }), (error) => error.status === 409);
    assert.equal(current.entries.size, 0);
  }
  now += 5 * 60 * 1000 - 1;
  assert.throws(() => restored.register({ target, requestId }), (error) => error.status === 409);
  now += 1;
  const grant = restored.register({ target, requestId });
  assert.equal(grant.id, requestId);
  restored.remove(requestId);
  assert.throws(() => restored.register({ target, requestId }), (error) => error.status === 409);
  assert.equal(restored.entries.size, 0);
});

test("cancellation tombstones are bounded and expire without permanent slot loss", (t) => {
  let now = 100000;
  const { config, registry } = registryFixture(t, { now: () => now });
  for (let index = 0; index < 205; index += 1) registry.remove(index.toString(16).padStart(32, "0"));
  assert.equal(registry.cancelledRequests.size, 200);
  assert.equal(new PreviewRegistry(config, { now: () => now }).cancelledRequests.size, 200);
  assert.throws(() => registry.remove("invalid"), (error) => error.status === 400);
  assert.equal(registry.cancelledRequests.size, 200);
  now += 5 * 60 * 1000;
  registry.register({ target: "http://localhost:5173/", requestId: "d".repeat(32) });
  assert.equal(registry.cancelledRequests.size, 0);
  assert.equal(new PreviewRegistry(config, { now: () => now }).cancelledRequests.size, 0);
});

test("preview API cancels pending service IDs and creates separate fallback windows", async (t) => {
  const server = await startTestServer({ sessionManager: { stats: () => ({}) }, configOverrides: { previewServicePorts: [3212, 3213] } });
  server.runtime.previewGatewayReady = true;
  t.after(async () => { await server.close(); fs.rmSync(server.rootDir, { recursive: true, force: true }); });
  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  const endpoint = `${server.baseUrl}/api/previews`, headers = { cookie: cookies, origin: server.baseUrl };
  const requestId = "e".repeat(32), target = "http://localhost:5173/app";
  assert.equal((await fetch(`${endpoint}/${requestId}`, { method: "DELETE", headers })).status, 200);
  const cancelled = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ target, requestId }) });
  assert.equal(cancelled.status, 409); assert.equal(server.runtime.previewRegistry.entries.size, 0);
  const activeId = "f".repeat(32);
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ target, requestId: activeId }) });
  assert.equal(response.status, 201); assert.equal((await response.json()).id, activeId);
  const fallback = await fetch(`${endpoint}/open?${new URLSearchParams({ target, requestId: activeId })}`, { headers, redirect: "manual" });
  assert.equal(fallback.status, 302); assert.ok(!fallback.headers.get("location").endsWith(activeId));
  assert.equal(server.runtime.previewRegistry.entries.size, 2);
  assert.equal((await fetch(`${endpoint}/${activeId}`, { method: "DELETE", headers })).status, 200);
  assert.equal(server.runtime.previewRegistry.entries.size, 1);
});

test("file gateway supports ranges, unchanged caching, related assets and scope boundaries", async (t) => {
  const f = await fixture(t); const file = path.join(f.root, "报告.pdf"); fs.writeFileSync(file, "%PDF-1.4 abcdef");
  fs.writeFileSync(path.join(f.root, "image.png"), "image"); fs.writeFileSync(path.join(f.root, "other.docx"), "other");
  const grant = f.registry.register({ target: file });
  const raw = `${f.origin}/__file/${grant.id}/${encodeURIComponent(grant.title)}`;
  assert.equal((await fetch(`${f.origin}/__file/invalid/a.pdf`)).status, 404);
  const response = await fetch(raw, { headers: { Range: "bytes=0-3" } });
  assert.equal(response.status, 206); assert.equal(await response.text(), "%PDF");
  assert.match(response.headers.get("content-range"), /^bytes 0-3\//);
  assert.equal((await fetch(raw, { headers: { "If-None-Match": response.headers.get("etag") } })).status, 304);
  assert.equal((await fetch(`${f.origin}/__file/${grant.id}/image.png`)).status, 200);
  assert.equal((await fetch(`${f.origin}/__file/${grant.id}/other.docx`)).status, 403);
  const outside = path.join(f.root, "..", `outside-${grant.id}.png`); fs.writeFileSync(outside, "outside"); t.after(() => fs.rmSync(outside, { force: true }));
  fs.symlinkSync(outside, path.join(f.root, "escape.png"));
  assert.equal((await fetch(`${f.origin}/__file/${grant.id}/escape.png`)).status, 403);
  const open = await fetch(`${f.origin}/_open/${grant.id}`, { redirect: "manual" });
  assert.equal(open.status, 302); assert.match(open.headers.get("location"), /^\/viewer\/onlinePreview\?url=/);
  const cookie = open.headers.get("set-cookie").split(";")[0];
  const forged = encodeURIComponent(Buffer.from("http://127.0.0.1:5260/api/status").toString("base64"));
  assert.equal((await fetch(`${f.origin}/viewer/onlinePreview?url=${forged}`,{headers:{Cookie:cookie}})).status,403);
  fs.writeFileSync(path.join(f.config.dataDir,"auth-sessions.json"),"private");
  assert.equal((await fetch(`${f.origin}/__file/${grant.id}/state/auth-sessions.json`)).status,403);
});

test("service preview proxies paths, JSON APIs, redirects and websocket without chat credentials", async (t) => {
  let seen;
  const upstream = http.createServer((req, res) => {
    seen = req.headers;
    if (req.url === "/redirect") { res.writeHead(302, { Location: `http://${req.headers.host}/app` }); res.end(); return; }
    res.setHeader("Set-Cookie", ["session=project-session; Path=/", "theme=dark; Path=/; Domain=127.0.0.1",
      "chat_session=must-not-overwrite; Path=/", "__codex_preview_fake=must-not-overwrite; Path=/"]);
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ path: req.url, method: req.method }));
  });
  const wsServer = new WebSocketServer({ server: upstream }); wsServer.on("connection", (socket) => socket.on("message", (raw) => socket.send(raw.toString())));
  const port = await listen(upstream);
  t.after(async () => { wsServer.close(); await new Promise((resolve) => upstream.close(resolve)); });
  const f = await fixture(t), grant = f.registry.register({ target: `http://localhost:${port}/app?foo=bar` });
  const origin = `http://127.0.0.1:${grant.port}`;
  assert.equal((await fetch(origin)).status, 404);
  const open = await fetch(`${origin}/_open/${grant.id}`, { redirect: "manual" });
  assert.equal(open.headers.get("location"), "/app?foo=bar");
  const cookie = `${open.headers.get("set-cookie").split(";")[0]}; chat_session=SECRET; otherapp=SECRET; __previewapp_${grant.id}_app=legitimate; __previewapp_OTHER_app=OTHERSECRET`;
  const response = await fetch(`${origin}/api/test`, { method: "POST", body: "{}", headers: { Cookie: cookie, Authorization: "Basic SECRET", Origin: origin } });
  assert.deepEqual(await response.json(), { path: "/api/test", method: "POST" });
  assert.equal(seen.authorization, undefined); assert.equal(seen.cookie, "app=legitimate"); assert.equal(seen.origin, `http://localhost:${port}`);
  assert.match(response.headers.get("set-cookie"), new RegExp(`^__previewapp_${grant.id}_session=project-session`));
  const setCookies = response.headers.getSetCookie();
  assert.equal(setCookies.length, 2);
  for (const value of setCookies) {
    assert.ok(value.startsWith(`__previewapp_${grant.id}_`));
    assert.match(value, /;\s*HttpOnly(?:;|$)/i);
    assert.doesNotMatch(value, /;\s*Domain=/i);
    assert.doesNotMatch(value, /must-not-overwrite/);
  }
  assert.equal((await fetch(`${origin}/api/test`, {method:"POST",headers:{Cookie:cookie,Origin:"http://127.0.0.1:3210"}})).status,403);
  const redirect = await fetch(`${origin}/redirect`, { headers: { Cookie: cookie }, redirect: "manual" }); assert.equal(redirect.headers.get("location"), "/app");
  const socket = new WebSocket(`${origin.replace("http", "ws")}/hmr`, { headers: { Cookie: cookie, Origin: origin } });
  t.after(() => socket.terminate());
  const received = new Promise((resolve, reject) => { socket.once("open", () => socket.send("update")); socket.once("message", (raw) => resolve(String(raw))); socket.once("error", reject); });
  assert.equal(await received, "update"); socket.close();
  const attack = new WebSocket(`${origin.replace("http", "ws")}/hmr`, { headers: { Cookie: cookie, Origin: "http://127.0.0.1:9999" } });
  const denied = await new Promise((resolve) => { attack.on("error", () => {}); attack.once("unexpected-response", (_, response) => { resolve(response.statusCode); response.resume(); attack.terminate(); }); });
  assert.equal(denied, 403);
  assert.throws(() => f.registry.register({ target: "http://127.0.0.1:5260/" }), /只能预览/);
  assert.throws(() => f.registry.register({ target: "http://example.com/" }), /只能预览/);
});

test("IPv6-only upstream is reachable through explicit ::1 and localhost service grants", async (t) => {
  const upstream = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ path: req.url, address: req.socket.localAddress, host: req.headers.host }));
  });
  try {
    await new Promise((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen({ host: "::1", port: 0, ipv6Only: true }, resolve);
    });
  } catch (error) {
    if (error.code === "EADDRNOTAVAIL") { t.skip("IPv6 loopback is unavailable (EADDRNOTAVAIL)"); return; }
    throw error;
  }
  t.after(() => new Promise((resolve) => { upstream.close(resolve); upstream.closeAllConnections(); }));
  assert.equal(upstream.address().address, "::1");
  const port = upstream.address().port;
  const f = await fixture(t, { serviceCount: 2 });
  for (const hostname of ["[::1]", "localhost"]) {
    const grant = f.registry.register({ target: `http://${hostname}:${port}/app` });
    const origin = `http://127.0.0.1:${grant.port}`;
    const opening = await fetch(`${origin}/_open/${grant.id}`, { redirect: "manual" });
    assert.equal(opening.status, 302);
    const response = await fetch(`${origin}/api/ipv6?value=1`, { headers: { Cookie: opening.headers.get("set-cookie").split(";")[0] } });
    assert.equal(response.status, 200, `${hostname} did not reach the IPv6-only upstream`);
    assert.deepEqual(await response.json(), { path: "/api/ipv6?value=1", address: "::1", host: `${hostname}:${port}` });
  }
});

test("KK canonical guards reject encoded sensitive endpoints while allowing Chinese converted assets", async (t) => {
  const viewer = await mockViewer(t);
  const f = await fixture(t, { kkFileViewUrl: viewer.origin });
  const file = path.join(f.root, "中文 报告.pdf"); fs.writeFileSync(file, "%PDF fixture");
  const grant = f.registry.register({ target: file });
  const opening = await fileOpening(f, grant);
  const forbidden = encodeURIComponent(Buffer.from("http://127.0.0.1:5260/private").toString("base64"));
  for (const route of [
    `/viewer/%6fnlinePreview?url=${forbidden}`,
    `/viewer/onlinePreview;ignored=1?url=${forbidden}`,
    `/viewer/%67etCorsFile?urlPath=${forbidden}`,
    "/viewer/%64eleteFile?fileName=private.pdf",
    "/viewer/%75pload",
    `/viewer/%256fnlinePreview?url=${forbidden}`
  ]) {
    const response = await fetch(f.origin + route, { headers: { Cookie: opening.cookie } });
    assert.equal(response.status, 403, route);
  }
  assert.equal(viewer.requests.length, 0);
  const resource = `/viewer/converted/${encodeURIComponent(`${grant.id}--中文 报告.pdf`)}`;
  const response = await fetch(f.origin + resource, { headers: { Cookie: opening.cookie } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).path, resource);
  assert.equal(viewer.requests.length, 1);
  const script = await fetch(`${f.origin}/viewer/js/viewer.js`, { headers: { Cookie: opening.cookie } });
  assert.equal(script.headers.get("cache-control"), "private, max-age=86400");
  const document = await fetch(f.origin + opening.location, { headers: { Cookie: opening.cookie } });
  assert.notEqual(document.headers.get("cache-control"), "private, max-age=86400");
});

test("KK cache filenames separate equal basenames across grants and change after a file update", async (t) => {
  const f = await fixture(t);
  const paths = ["first", "second"].map((name) => {
    const directory = path.join(f.root, name); fs.mkdirSync(directory);
    const file = path.join(directory, "周报.md"); fs.writeFileSync(file, name); return file;
  });
  const grants = paths.map((target) => f.registry.register({ target }));
  const openings = await Promise.all(grants.map((grant) => fileOpening(f, grant)));
  const names = openings.map(({ source }) => decodeURIComponent(source.pathname.split("/").at(-1)));
  assert.deepEqual(names, grants.map((grant) => `${grant.id}--周报.md`));
  assert.notEqual(names[0], names[1]);
  for (let index = 0; index < openings.length; index += 1) {
    assert.equal(await (await fetch(openings[index].source)).text(), index === 0 ? "first" : "second");
  }
  assert.equal(f.registry.register({ target: paths[0] }).id, grants[0].id);
  fs.writeFileSync(paths[0], "updated first document");
  const updated = f.registry.register({ target: paths[0] });
  const updatedOpening = await fileOpening(f, updated);
  assert.notEqual(updated.id, grants[0].id);
  assert.notEqual(updated.version, grants[0].version);
  assert.notEqual(updatedOpening.source.pathname, openings[0].source.pathname);
  assert.notEqual(updatedOpening.source.searchParams.get("v"), openings[0].source.searchParams.get("v"));
  assert.equal(await (await fetch(updatedOpening.source)).text(), "updated first document");
  const wrongGrantAlias = `${f.origin}/__file/${grants[1].id}/${encodeURIComponent(`${updated.id}--${updated.title}`)}`;
  assert.equal((await fetch(wrongGrantAlias)).status, 404);
});

test("KK viewer sources cannot override their grant cache name or version through query parameters", async (t) => {
  const viewer = await mockViewer(t);
  const f = await fixture(t, { kkFileViewUrl: viewer.origin });
  const file = path.join(f.root, "报告.docx"); fs.writeFileSync(file, "document fixture");
  const grant = f.registry.register({ target: file });
  const opening = await fileOpening(f, grant);
  const changed = (mutate) => { const source = new URL(opening.source); mutate(source); return source.href; };
  const sources = [
    changed((url) => url.searchParams.set("fullfilename", "shared.docx")),
    changed((url) => url.searchParams.set("kkCompressfileKey", "shared")),
    changed((url) => url.searchParams.set("kkCompressfilepath", "shared.docx")),
    changed((url) => url.searchParams.append("v", grant.version)),
    changed((url) => url.searchParams.set("v", "old-version")),
    changed((url) => { url.search = ""; }),
    changed((url) => { url.hash = "unexpected"; }),
    changed((url) => { url.username = "unexpected"; }),
    changed((url) => { url.pathname = `/__file/${grant.id}/${encodeURIComponent(grant.title)}`; })
  ];
  for (const source of sources) {
    const endpoint = `${f.origin}/viewer/onlinePreview?url=${encodeURIComponent(Buffer.from(source).toString("base64"))}`;
    assert.equal((await fetch(endpoint, { headers: { Cookie: opening.cookie } })).status, 403, source);
  }
  assert.equal(viewer.requests.length, 0);
  assert.equal((await fetch(f.origin + opening.location, { headers: { Cookie: opening.cookie } })).status, 200);
  assert.equal(viewer.requests.length, 1);
});

test("concurrent file viewers identify the source grant instead of the last shared file cookie", async (t) => {
  const viewer = await mockViewer(t);
  const f = await fixture(t, { kkFileViewUrl: viewer.origin });
  const grants = ["a.md", "b.md"].map((name) => {
    const target = path.join(f.root, name); fs.writeFileSync(target, name); return f.registry.register({ target });
  });
  const [first, second] = await Promise.all(grants.map((grant) => fileOpening(f, grant)));
  const cookie = `${second.cookie}; __previewapp_${grants[0].id}_session=first; __previewapp_${grants[1].id}_session=second`;
  const response = await fetch(f.origin + first.location, {
    headers: { Cookie: cookie, "X-Base-Url": "http://untrusted.invalid/", "X-Forwarded-Proto": "https" }
  });
  assert.equal(response.status, 200);
  const received = await response.json();
  assert.equal(received.cookie, "session=first");
  assert.equal(received.baseUrl, `https://127.0.0.1:${f.config.previewPort}/viewer/`);
  assert.equal((await fetch(f.origin + second.location)).status, 200);
  const cors = `${f.origin}/viewer/getCorsFile?urlPath=${encodeURIComponent(first.source.href)}`;
  assert.equal((await fetch(cors, { headers: { Cookie: second.cookie } })).status, 200);
  grants[0].expiresAt = Date.now() - 1;
  assert.equal((await fetch(f.origin + first.location, { headers: { Cookie: second.cookie } })).status, 410);
  assert.equal((await fetch(f.origin + second.location, { headers: { Cookie: second.cookie } })).status, 200);
});

test("revoking one window immediately closes its websocket without disrupting another window of the same service", async (t) => {
  const port = await echoServer(t);
  const f = await fixture(t, { serviceCount: 2 });
  const grants = [0, 1].map(() => f.registry.register({ target: `http://127.0.0.1:${port}/` }));
  assert.notEqual(grants[0].id, grants[1].id); assert.notEqual(grants[0].port, grants[1].port);
  const first = await openSocket(grants[0]), second = await openSocket(grants[1]);
  try {
    await echo(first.socket, "first-live"); await echo(second.socket, "second-live");
    f.registry.remove(grants[0].id);
    await bounded(first.closed, "revoked websocket remained connected");
    await echo(second.socket, "second-still-live");
    assert.equal((await fetch(`http://127.0.0.1:${grants[0].port}/`, {
      headers: { Cookie: `__codex_preview_${grants[0].port}=${grants[0].id}` }
    })).status, 410);
  } finally { first.socket.terminate(); second.socket.terminate(); }
});

test("a websocket already open at grant expiry is disconnected", async (t) => {
  const port = await echoServer(t);
  const f = await fixture(t);
  const grant = f.registry.register({ target: `http://127.0.0.1:${port}/` });
  grant.expiresAt = Date.now() + 800;
  const connection = await openSocket(grant);
  try {
    await echo(connection.socket, "before-expiry");
    await bounded(connection.closed, "expired websocket remained connected");
    assert.throws(() => f.registry.get(grant.id), (error) => error.status === 410);
  } finally { connection.socket.terminate(); }
});

test("gateway shutdown closes active upgraded sockets and completes without waiting for clients", async (t) => {
  const port = await echoServer(t);
  const f = await fixture(t);
  const grant = f.registry.register({ target: `http://127.0.0.1:${port}/` });
  const connection = await openSocket(grant);
  try {
    await echo(connection.socket, "still-connected");
    assert.equal(f.gateway.upgradedSockets.size, 1);
    await bounded(f.gateway.close(), "gateway shutdown waited indefinitely for an upgraded socket");
    await bounded(connection.closed, "shutdown did not disconnect websocket");
    assert.equal(f.gateway.upgradedSockets.size, 0);
    assert.equal(f.registry.removalListeners.size, 0);
  } finally { connection.socket.terminate(); }
});
