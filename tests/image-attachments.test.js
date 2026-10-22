import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";

import { AppServerBridge } from "../src/appServerBridge.js";
import { SessionManager } from "../src/sessionManager.js";
import { buildCodexJsonExecArgs } from "../src/sessions/runners/codexRunner.js";
import { normalizeSessionInputEvents } from "../src/transport/sse/sessionStream.js";
import {
  MAX_IMAGE_BYTES,
  normalizeImageAttachmentReferences,
  readUploadedImage,
  resolveImageAttachments,
  saveUploadedImage
} from "../src/sessions/shared/imageAttachments.js";
import { buildThreadSnapshotFromFile } from "../src/threads/history.js";
import { createLegacyThreadProjection, projectorSnapshotToLegacyThread } from "../src/projector/legacyBridge.js";
import { createBaseConfig, createTempDir, login, startTestServer, waitForMicrotasks } from "./helpers/backendTestUtils.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCe8AAAAASUVORK5CYII=", "base64");

function fixture(t, overrides = {}) {
  const root = createTempDir();
  const config = createBaseConfig(root, overrides);
  const bridge = new EventEmitter();
  bridge.turns = [];
  bridge.startTurn = async (session, text, images) => {
    bridge.turns.push({ text, images });
    return { turn: { id: `server-${bridge.turns.length}`, status: "inProgress", items: [] } };
  };
  const manager = new SessionManager(config, { appServerBridge: bridge });
  manager.scheduleConversationHistoryResync = () => {};
  t.after(() => { manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, config, bridge, manager };
}

async function upload(server, cookies, { type = "image/png", body = PNG, name = "test image.png", headers = {} } = {}) {
  return fetch(`${server.baseUrl}/api/attachments/images`, {
    method: "POST",
    headers: { cookie: cookies, "content-type": type, "x-file-name": encodeURIComponent(name), ...headers },
    body
  });
}

test("uploaded images have private persistent files and resolve from IDs after a runtime reload", (t) => {
  const { config } = fixture(t);
  const attachment = saveUploadedImage(config, PNG, { type: "image/png", name: "sample.png" });
  assert.deepEqual(Object.keys(attachment).sort(), ["id", "name", "size", "type", "url"]);
  const image = readUploadedImage({ ...config }, attachment.id);
  assert.equal(image.path, path.join(config.dataDir, "uploads", "images", `${attachment.id}.png`));
  assert.deepEqual(fs.readFileSync(image.path), PNG);
  assert.equal(fs.statSync(image.path).mode & 0o777, 0o600);
  assert.equal(resolveImageAttachments(config, [{ id: attachment.id }])[0].type, "image/png");
});

test("image validation rejects forged MIME, unsupported content, oversize and unsafe references", (t) => {
  const { config } = fixture(t);
  assert.throws(() => saveUploadedImage(config, PNG, { type: "image/jpeg" }), /must match/);
  assert.throws(() => saveUploadedImage(config, Buffer.from("<svg></svg>"), { type: "image/svg+xml" }), /must match/);
  const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  PNG.copy(oversized);
  assert.throws(() => saveUploadedImage(config, oversized, { type: "image/png" }), /20 MiB/);
  for (const attachments of [[{ id: "../../secrets" }], [{ path: "/private/file.png" }], [{ id: "00000000-0000-4000-8000-000000000000", path: "/private/file.png" }], null]) {
    assert.throws(() => normalizeImageAttachmentReferences(attachments), /uploaded image ID|at most/);
  }
  assert.throws(() => normalizeImageAttachmentReferences(Array(7).fill({ id: "00000000-0000-4000-8000-000000000000" })), /at most 6/);
  assert.throws(() => resolveImageAttachments(config, [{ id: "00000000-0000-4000-8000-000000000000" }]), /not found/);
});

test("the documented 20 MiB size boundary is accepted and input attachment count is enforced", (t) => {
  const { config, manager, bridge } = fixture(t);
  const maximum = Buffer.alloc(MAX_IMAGE_BYTES);
  PNG.copy(maximum);
  const attachment = saveUploadedImage(config, maximum, { type: "image/png" });
  assert.equal(readUploadedImage(config, attachment.id).size, MAX_IMAGE_BYTES);
  const session = manager.get(manager.create({ provider: "codex" }).id);
  assert.throws(() => manager.write(session.id, "too many", { attachments: Array(7).fill({ id: attachment.id }) }), /at most 6/);
  assert.equal(bridge.turns.length, 0);
  assert.equal(session.threadSnapshot.turns.length, 0);
});

test("supported GIF, JPEG and WebP uploads are checked against their file signatures", (t) => {
  const { config } = fixture(t);
  const fixtures = [
    ["image/gif", Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64")],
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9])],
    ["image/webp", Buffer.concat([Buffer.from("RIFF"), Buffer.from([8, 0, 0, 0]), Buffer.from("WEBPVP8 ")])]
  ];
  for (const [type, bytes] of fixtures) {
    const attachment = saveUploadedImage(config, bytes, { type });
    assert.equal(readUploadedImage(config, attachment.id).type, type);
  }
});

test("image reads reject missing, changed and symlinked files", (t) => {
  const { config, root } = fixture(t);
  const attachment = saveUploadedImage(config, PNG, { type: "image/png" });
  const image = readUploadedImage(config, attachment.id);
  fs.writeFileSync(image.path, Buffer.alloc(PNG.length));
  assert.throws(() => readUploadedImage(config, attachment.id), /no longer valid/);
  fs.unlinkSync(image.path);
  const other = path.join(root, "other.png");
  fs.writeFileSync(other, PNG);
  fs.symlinkSync(other, image.path);
  assert.throws(() => readUploadedImage(config, attachment.id), /no longer valid/);
});

test("upload and retrieval require authentication and uploads reject foreign Origin", async (t) => {
  const { config, manager } = fixture(t);
  const server = await startTestServer({ sessionManager: manager, configOverrides: config });
  t.after(() => server.close());
  assert.equal((await upload(server, "")).status, 401);
  const { cookies } = await login(server.baseUrl, config.accessToken);
  assert.equal((await upload(server, cookies, { headers: { origin: "https://foreign.example" } })).status, 403);
  const response = await upload(server, cookies, { name: "image \u4e2d\u6587.png" });
  assert.equal(response.status, 201);
  const { attachment } = await response.json();
  assert.equal(attachment.name, "image \u4e2d\u6587.png");
  assert.equal((await fetch(`${server.baseUrl}${attachment.url}`)).status, 401);
  const image = await fetch(`${server.baseUrl}${attachment.url}`, { headers: { cookie: cookies } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
  assert.equal((await upload(server, cookies, { type: "image/jpeg" })).status, 415);
});

test("chunked oversized uploads receive a recoverable 413 without saving a partial file", async (t) => {
  const { config, manager } = fixture(t);
  const server = await startTestServer({ sessionManager: manager, configOverrides: config });
  t.after(() => server.close());
  const { cookies } = await login(server.baseUrl, config.accessToken);
  const response = await new Promise((resolve, reject) => {
    const req = http.request(`${server.baseUrl}/api/attachments/images`, {
      method: "POST", headers: { cookie: cookies, "content-type": "image/png" }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.write(PNG);
    req.end(Buffer.alloc(MAX_IMAGE_BYTES));
  });
  assert.equal(response.status, 413);
  assert.match(response.body, /20 MiB/);
  assert.equal(fs.existsSync(path.join(config.dataDir, "uploads", "images")), false);
  assert.equal((await upload(server, cookies)).status, 201);
});

test("image-only and mixed input events retain upload references", () => {
  const attachments = [{ id: "00000000-0000-4000-8000-000000000000" }];
  assert.deepEqual(normalizeSessionInputEvents({ type: "input", data: "", attachments }), [{ type: "input", data: "", attachments }]);
  assert.deepEqual(normalizeSessionInputEvents({ input: "what is shown?", attachments }), [{ type: "input", data: "what is shown?", attachments }]);
  assert.throws(() => normalizeSessionInputEvents({ type: "input", data: "text", attachments: null }), /at most/);
});

test("image-only HTTP input reaches app-server and live history as one image-bearing turn", async (t) => {
  const { config, manager, bridge } = fixture(t);
  const session = manager.create({ provider: "codex" });
  const server = await startTestServer({ sessionManager: manager, configOverrides: config });
  t.after(() => server.close());
  const { cookies } = await login(server.baseUrl, config.accessToken);
  const { attachment } = await (await upload(server, cookies)).json();
  const response = await fetch(`${server.baseUrl}/api/sessions/${session.id}/input`, {
    method: "POST", headers: { cookie: cookies, "content-type": "application/json" },
    body: JSON.stringify({ type: "input", data: "", attachments: [{ id: attachment.id }] })
  });
  assert.equal(response.status, 202);
  await waitForMicrotasks();
  assert.equal(bridge.turns.length, 1);
  assert.equal(bridge.turns[0].text, "");
  assert.equal(bridge.turns[0].images[0].path, readUploadedImage(config, attachment.id).path);
  const snapshot = manager.getConversationSnapshot(session.id);
  assert.equal(snapshot.threadSnapshot.turns.length, 1);
  const user = snapshot.threadSnapshot.turns[0].items.find((item) => item.kind === "UserMessage");
  assert.equal(user.payload.content[0].type, "local_image");
  assert.equal(user.payload.content[0].path, bridge.turns[0].images[0].path);
  const projection = createLegacyThreadProjection({ threadId: snapshot.threadSnapshot.threadId, snapshot: snapshot.threadSnapshot });
  const reopened = projectorSnapshotToLegacyThread(projection.projector.getSnapshot());
  assert.deepEqual(reopened.turns[0].items.find((item) => item.kind === "UserMessage").payload, user.payload);
});

test("HTTP input rejects unknown or arbitrary image paths before submitting any model turn", async (t) => {
  const { config, manager, bridge } = fixture(t);
  const session = manager.create({ provider: "codex" });
  const server = await startTestServer({ sessionManager: manager, configOverrides: config });
  t.after(() => server.close());
  const { cookies } = await login(server.baseUrl, config.accessToken);
  for (const attachments of [[{ path: "/private/file.png" }], [{ id: "00000000-0000-4000-8000-000000000000" }]]) {
    const response = await fetch(`${server.baseUrl}/api/sessions/${session.id}/input`, {
      method: "POST", headers: { cookie: cookies, "content-type": "application/json" },
      body: JSON.stringify({ type: "input", data: "do not silently drop", attachments })
    });
    assert.equal(response.status, 400);
  }
  assert.equal(bridge.turns.length, 0);
  assert.equal(manager.get(session.id).threadSnapshot.turns.length, 0);
});

test("app-server encodes text and localImage using the official input union", async (t) => {
  const { config } = fixture(t);
  const attachment = saveUploadedImage(config, PNG, { type: "image/png" });
  const images = resolveImageAttachments(config, [{ id: attachment.id }]);
  const bridge = new AppServerBridge(config);
  const requests = [];
  bridge.ensureThread = async () => "thread-image";
  bridge.request = async (method, params) => { requests.push({ method, params }); return {}; };
  const session = { cwd: config.root, model: "model", permissionMode: "default" };
  await bridge.startTurn(session, "first\n\n  second", images);
  assert.deepEqual(requests[0].params.input, [
    { type: "text", text: "first\n\n  second", text_elements: [] },
    { type: "localImage", path: images[0].path }
  ]);
  await bridge.startTurn(session, "", images);
  assert.deepEqual(requests[1].params.input, [{ type: "localImage", path: images[0].path }]);
});

test("JSON exec image flags support both fresh and resumed prompts without merging images into text", (t) => {
  const { config, manager } = fixture(t);
  const attachment = saveUploadedImage(config, PNG, { type: "image/png" });
  const images = resolveImageAttachments(config, [{ id: attachment.id }]);
  for (const resumeSessionId of ["", "saved-thread"]) {
    const args = buildCodexJsonExecArgs(manager, { permissionMode: "default", resumeSessionId }, { text: "first\n\n  second", images });
    assert.deepEqual(args.slice(-4), ["--image", images[0].path, "--", "first\n\n  second"]);
    if (resumeSessionId) assert.ok(args.indexOf("resume") < args.indexOf("--image"));
  }
});

test("JSON fallback lacking image support fails before queueing a turn", (t) => {
  const { config, manager } = fixture(t, { codexBin: process.execPath });
  const attachment = saveUploadedImage(config, PNG, { type: "image/png" });
  const session = manager.get(manager.create({ provider: "codex" }).id);
  session.runnerMode = "json_exec";
  assert.throws(() => manager.write(session.id, "", { attachments: [{ id: attachment.id }] }), /does not support image attachments/);
  assert.deepEqual(session.queuedInputs, []);
  assert.equal(session.threadSnapshot.turns.length, 0);
});

test("JSON fallback starts fresh and resumed image turns with their persistent image paths", (t) => {
  const spawnOriginal = childProcess.spawn;
  const spawnSyncOriginal = childProcess.spawnSync;
  const executions = [];
  childProcess.spawnSync = () => ({ status: 0, stdout: "Usage: exec --image <FILE>" });
  childProcess.spawn = (binary, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    executions.push({ binary, args, child });
    return child;
  };
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.spawn = spawnOriginal;
    childProcess.spawnSync = spawnSyncOriginal;
    syncBuiltinESMExports();
  });
  const { config, manager } = fixture(t, { codexBin: "codex-image-test-stub" });
  const attachment = saveUploadedImage(config, PNG, { type: "image/png" });
  const image = readUploadedImage(config, attachment.id);
  for (const resumeSessionId of ["", "existing-image-thread"]) {
    const session = manager.get(manager.create({ provider: "codex", resumeSessionId }).id);
    session.runnerMode = "json_exec";
    manager.write(session.id, "describe\n\n  this\n", { attachments: [{ id: attachment.id }] });
    const execution = executions.at(-1);
    assert.deepEqual(execution.args.slice(-4), ["--image", image.path, "--", "describe\n\n  this"]);
    assert.equal(session.threadSnapshot.turns.length, 1);
    assert.equal(session.threadSnapshot.turns[0].items.find((item) => item.kind === "UserMessage").payload.content[1].path, image.path);
    execution.child.stdout.emit("data", JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "image received" } }) + "\n");
    execution.child.emit("close", 0);
    assert.equal(session.turnRunning, false);
  }
  assert.equal(executions.length, 2);
});

test("persisted Codex history retains multiline text and uploaded local image references", (t) => {
  const { config, root } = fixture(t);
  const attachment = saveUploadedImage(config, PNG, { type: "image/png" });
  const image = readUploadedImage(config, attachment.id);
  const file = path.join(root, "history.jsonl");
  fs.writeFileSync(file, JSON.stringify({
    type: "event_msg", timestamp: "2026-10-15T00:00:00.000Z", payload: {
      type: "user_message", turn_id: "turn-image", message: "one\n\n  two",
      local_images: [{ path: image.path, name: image.name }]
    }
  }) + "\n");
  const snapshot = buildThreadSnapshotFromFile(file, { threadId: "thread-image" });
  const user = snapshot.turns[0].items.find((item) => item.kind === "UserMessage");
  assert.equal(user.text, "one\n\n  two");
  assert.equal(user.payload.local_images[0].path, image.path);
  assert.equal(readUploadedImage({ ...config }, attachment.id).path, image.path);
});
