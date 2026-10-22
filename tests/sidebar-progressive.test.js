import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { PassThrough, Transform } from "node:stream";
import { brotliDecompressSync, constants, createBrotliCompress, createBrotliDecompress, createGunzip, createGzip, gunzipSync } from "node:zlib";
import Koa from "koa";

import { buildCompactSidebarPayload, sendSidebarResponse } from "../src/routes/sidebarResponse.js";
import { buildActivitySessions, sessionGroupKey, sessionIdentity } from "../web/src/lib/session-list.js";
import { restoreSessionSidebarPayload } from "../web/src/lib/session-sidebar-payload.js";
import { login, startTestServer, waitForCondition } from "./helpers/backendTestUtils.js";

function fixture({ count = 90, previewSize = 180 } = {}) {
  const sessions = Array.from({ length: count }, (_, index) => ({
    id: `session-${index}`, provider: index % 3 === 0 ? "cc" : "codex", resumeSessionId: `thread-${index}`,
    kind: "history", name: `会话 ${index}`, cwd: "/fixture/shared", projectId: index % 2 ? "a" : "b",
    updatedAt: new Date(1700000000000 + index * 1000).toISOString(), activityState: index % 7 ? "idle" : "running",
    inputPreview: createHash("sha256").update(`preview-${index}`).digest("base64").repeat(Math.ceil(previewSize / 44))
  }));
  return { sessions, projectGroups: [
    { id: "project:a", projectId: "a", groupKind: "project", name: "同名", cwd: "/fixture/shared", order: 0,
      sessions: sessions.filter((_, index) => index % 2) },
    { id: "project:b", projectId: "b", groupKind: "project", name: "同名", cwd: "/fixture/shared", pinned: true,
      sessions: sessions.filter((_, index) => !(index % 2)) },
    { id: "pinned", groupKind: "pinned", sessions: [sessions[1], sessions[50]].filter(Boolean) },
    { id: "empty", groupKind: "project", name: "空目录", sessions: [] }
  ], sidebarPreferences: { grouping: "project" }, extension: { preserve: [1, 2, 3] } };
}

function decode(response) {
  const encoding = response.headers["content-encoding"];
  return (encoding === "br" ? brotliDecompressSync(response.body)
    : encoding === "gzip" ? gunzipSync(response.body) : response.body).toString("utf8");
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.once("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.once("error", reject);
    });
    req.once("error", reject);
  });
}

async function routeServer(t, payload = fixture()) {
  let reads = 0;
  const server = await startTestServer({ sessionManager: {
    listSidebarSnapshot: () => { reads += 1; return payload; }, get: () => null
  } });
  t.after(async () => {
    server.server.closeAllConnections();
    try { await server.close(); } finally { fs.rmSync(server.rootDir, { recursive: true, force: true }); }
  });
  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  return { ...server, cookies, reads: () => reads };
}

test("progressive route is exact opt-in, preserves JSON, ETag, authorization and security headers", { timeout: 5000 }, async (t) => {
  const server = await routeServer(t);
  const url = `${server.baseUrl}/api/sessions`;
  const headers = { cookie: server.cookies, "Accept-Encoding": "identity" };
  const compact = await get(`${url}?compact=1`, headers);
  const response = await get(`${url}?compact=1&progressive=1`, headers);
  assert.match(response.headers["content-type"], /application\/x-ndjson/);
  const lines = decode(response).trimEnd().split("\n").map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, "bootstrap");
  assert.equal(lines[0].complete, false);
  assert.equal(lines[1].type, "complete");
  assert.equal(lines[1].complete, true);
  assert.equal(lines[0].protocol, "session-sidebar-progressive-v1");
  assert.equal(lines[0].snapshotId, lines[1].snapshotId);
  assert.equal(lines[0].snapshotId, compact.headers.etag.slice(3, -1));
  assert.equal(lines[0].snapshotId.length, 43);
  assert.deepEqual(lines[1].payload, JSON.parse(decode(compact)));
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers["content-length"], undefined);
  assert.equal(response.headers.vary, "Accept-Encoding");
  for (const encoding of ["br", "gzip"]) {
    const compressed = await get(`${url}?compact=1&progressive=1`, { ...headers, "Accept-Encoding": encoding });
    assert.equal(compressed.headers["content-encoding"], encoding);
    assert.deepEqual(decode(compressed).trimEnd().split("\n").map(JSON.parse), lines);
    assert.equal(compressed.headers.etag, compact.headers.etag);
    assert.equal(compressed.headers["content-length"], undefined);
  }
  for (const name of ["x-content-type-options", "x-frame-options", "referrer-policy"]) {
    assert.equal(response.headers[name], compact.headers[name]);
    assert.ok(response.headers[name]);
  }
  for (const query of ["", "progressive=1", "compact=1&progressive=true", "compact=1&progressive=0",
    "compact=1&progressive=1&progressive=1", "compact=1&compact=1&progressive=1"]) {
    const ordinary = await get(`${url}?${query}`, headers);
    assert.match(ordinary.headers["content-type"], /application\/json/);
  }
  const before = server.reads();
  assert.equal((await get(`${url}?compact=1&progressive=1`)).status, 401);
  assert.equal(server.reads(), before);
  assert.equal((await get(`${url}?compact=1&progressive=1`, { ...headers, "Accept-Encoding": "br;q=0,gzip;q=0,identity;q=0,*;q=0" })).status, 406);
  const unchanged = await get(`${url}?compact=1&progressive=1`, { ...headers,
    "Accept-Encoding": "br", "If-None-Match": compact.headers.etag });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.body.length, 0);
  assert.equal(unchanged.headers["content-encoding"], undefined);
});

test("pure progressive frames retain canonical membership, aliases, exact activity ordering and an immutable snapshot", async () => {
  const { buildSidebarProgressiveFrames } = await import("../src/routes/sidebarProgressiveFrames.js");
  const payload = fixture();
  const alias = { ...payload.sessions[88], id: "alias-88", activityState: "running", updatedAt: 1700000088 };
  payload.sessions.push(alias);
  payload.projectGroups[2].sessions.push(alias);
  const compact = buildCompactSidebarPayload(payload);
  const before = structuredClone(compact);
  const result = buildSidebarProgressiveFrames(compact);
  assert.ok(result);
  const first = JSON.parse(result.bootstrapLine);
  const final = JSON.parse(result.completeLine);
  assert.deepEqual(final.payload, before);
  const activities = buildActivitySessions(payload.projectGroups);
  const selected = new Set(payload.projectGroups.flatMap((group) => group.sessions.slice(0, 5).map((session) => session.id)));
  const identities = new Set(activities.slice(0, 20).map(sessionIdentity));
  for (const session of payload.sessions) if (identities.has(sessionIdentity(session))) selected.add(session.id);
  assert.deepEqual(first.payload.sessions.map((session) => session.id), payload.sessions.filter((session) => selected.has(session.id)).map((session) => session.id));
  assert.deepEqual(first.counts, { sessionsTotal: payload.sessions.length, activitiesTotal: activities.length,
    runningTotal: activities.filter((session) => session.activityState === "running").length,
    groups: payload.projectGroups.map((group) => ({ key: sessionGroupKey(group), total: group.sessions.length,
      running: group.sessions.filter((session) => session.activityState === "running").length })) });
  assert.deepEqual(first.payload.projectGroups, before.projectGroups.map((group) => ({ ...group,
    sessionIds: group.sessionIds.filter((id) => selected.has(id)) })));
  assert.deepEqual(restoreSessionSidebarPayload(first.payload).extension, payload.extension);
  compact.sessions[0].inputPreview = "mutated after construction";
  compact.projectGroups[0].sessionIds.length = 0;
  assert.deepEqual(JSON.parse(result.completeLine).payload, before);
  assert.equal(result.snapshotId, createHash("sha256").update(`${JSON.stringify(before)}\n`).digest("base64url"));
});

test("small, degraded, ambiguous and noncanonical snapshots fall back without data loss", async (t) => {
  const { buildSidebarProgressiveFrames } = await import("../src/routes/sidebarProgressiveFrames.js");
  const small = fixture({ count: 4 });
  const source = fixture();
  const cases = [small, { ...source, sidebarStatus: { degraded: true } }, { ...source, projectGroups: [] },
    { ...source, projectGroups: source.projectGroups.map((group) => ({ ...group, id: "duplicate" })) },
    { ...source, projectGroups: source.projectGroups.slice(0, 1) }];
  for (const payload of cases) assert.equal(buildSidebarProgressiveFrames(buildCompactSidebarPayload(payload)), null);
  const compact = buildCompactSidebarPayload(source);
  for (const payload of [null, undefined, { ...compact, sessions: [null] },
    { ...compact, sessions: [...compact.sessions, compact.sessions[0]] },
    { ...compact, projectGroups: [{ sessionIds: compact.sessions.map((session) => session.id) }] },
    { ...compact, projectGroups: compact.projectGroups.map((group, index) => index ? group : { ...group, sessionIds: ["missing"] }) }]) {
    assert.equal(buildSidebarProgressiveFrames(payload), null);
  }
  const legacy = fixture();
  legacy.projectGroups[0].sessions[0] = { ...legacy.projectGroups[0].sessions[0], name: "conflicting title" };
  for (const payload of [small, legacy]) {
    const server = await routeServer(t, payload);
    const headers = { cookie: server.cookies, "Accept-Encoding": "gzip" };
    const ordinary = await get(`${server.baseUrl}/api/sessions?compact=1`, headers);
    const progressive = await get(`${server.baseUrl}/api/sessions?compact=1&progressive=1`, headers);
    assert.match(progressive.headers["content-type"], /application\/json/);
    assert.deepEqual(JSON.parse(decode(progressive)), JSON.parse(decode(ordinary)));
  }
});

test("real HTTP br, gzip and identity independently decode bootstrap before the tail is written", { timeout: 5000 }, async (t) => {
  const { trySendSidebarProgressiveResponse } = await import("../src/routes/sidebarProgressiveTransfer.js");
  const { buildSidebarProgressiveFrames } = await import("../src/routes/sidebarProgressiveFrames.js");
  for (const encoding of ["br", "gzip", "identity"]) {
    let releaseTail;
    let tailWritten = false;
    const gate = new Promise((resolve) => { releaseTail = resolve; });
    const source = buildCompactSidebarPayload(fixture());
    const frames = buildSidebarProgressiveFrames(source);
    const server = await customServer(t, (ctx, runtime) => {
      assert.equal(trySendSidebarProgressiveResponse(ctx, runtime, frames, encoding, {
        createEncoder: () => {
          const encoder = encoding === "br" ? createBrotliCompress({ params: {
            [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT, [constants.BROTLI_PARAM_QUALITY]: 5
          } }) : encoding === "gzip" ? createGzip() : new PassThrough();
          const flush = encoder.flush?.bind(encoder);
          encoder.flush = (kind, callback) => {
            const flushed = (error) => error ? callback(error) : gate.then(() => { tailWritten = true; callback(); });
            flush ? flush(kind, flushed) : flushed();
          };
          return encoder;
        }
      }), true);
    });
    await new Promise((resolve, reject) => {
      const req = http.get(server.url, { agent: false }, (res) => {
        const decoder = encoding === "br" ? createBrotliDecompress() : encoding === "gzip" ? createGunzip() : new PassThrough();
        const decoded = [];
        let firstSeen = false;
        res.pipe(decoder);
        decoder.on("data", (chunk) => {
          decoded.push(chunk);
          const text = Buffer.concat(decoded).toString("utf8");
          if (!firstSeen && text.includes("\n")) {
            firstSeen = true;
            assert.equal(tailWritten, false);
            assert.equal(JSON.parse(text.split("\n")[0]).type, "bootstrap");
            releaseTail();
          }
        });
        decoder.once("error", reject);
        decoder.once("end", () => {
          try {
            assert.ok(firstSeen);
            const lines = Buffer.concat(decoded).toString("utf8").trimEnd().split("\n").map(JSON.parse);
            assert.equal(lines.length, 2);
            assert.deepEqual(lines[1].payload, source);
            resolve();
          } catch (error) { reject(error); }
        });
        res.once("error", reject);
      });
      req.once("error", reject);
      t.after(() => { releaseTail(); req.destroy(); });
    });
  }
});

async function customServer(t, handler) {
  const app = new Koa();
  const errors = [];
  const runtime = { responseHeaders: (headers = {}) => ({ "X-Content-Type-Options": "nosniff", ...headers }),
    json: (ctx, status, body) => { ctx.status = status; ctx.body = body; } };
  app.use((ctx) => handler(ctx, runtime));
  app.on("error", (error) => errors.push(error));
  const server = http.createServer(app.callback());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}/`, runtime, errors };
}

test("progressive transfer cancels owned streams, limits two slots and serves full JSON overflow", { timeout: 5000 }, async (t) => {
  const { trySendSidebarProgressiveResponse } = await import("../src/routes/sidebarProgressiveTransfer.js");
  const { buildSidebarProgressiveFrames } = await import("../src/routes/sidebarProgressiveFrames.js");
  const payload = fixture({ count: 300, previewSize: 2000 });
  const frames = buildSidebarProgressiveFrames(buildCompactSidebarPayload(payload));
  const encoders = [];
  let completed = 0;
  const server = await customServer(t, async (ctx, runtime) => {
    const streamed = trySendSidebarProgressiveResponse(ctx, runtime, frames, "identity", {
      createEncoder: () => {
        const encoder = new PassThrough({ highWaterMark: 64 });
        encoder.flush = (_, callback) => ctx.res.once("close", () => { completed += 1; callback(); });
        encoders.push(encoder);
        return encoder;
      }
    });
    if (!streamed) await sendSidebarResponse(ctx, runtime, payload, { compact: true });
  });
  const held = [];
  for (let index = 0; index < 2; index += 1) {
    held.push(await new Promise((resolve, reject) => {
      const req = http.get(server.url, { agent: false }, (res) => { res.pause(); resolve({ req, res }); });
      req.once("error", reject);
    }));
  }
  assert.equal(encoders.length, 2);
  const overflow = await get(server.url, { "Accept-Encoding": "identity" });
  assert.match(overflow.headers["content-type"], /application\/json/);
  assert.deepEqual(JSON.parse(decode(overflow)), buildCompactSidebarPayload(payload));
  assert.equal(encoders.length, 2, "overflow does not queue or create an encoder");
  for (const { req, res } of held) { res.destroy(); req.destroy(); }
  await waitForCondition(() => completed === 2 && encoders.every((encoder) => encoder.destroyed));
  const replacements = [];
  for (let index = 0; index < 2; index += 1) replacements.push(await new Promise((resolve, reject) => {
    const req = http.get(server.url, { agent: false }, (res) => {
      assert.match(res.headers["content-type"], /application\/x-ndjson/);
      res.pause(); resolve({ req, res });
    });
    req.once("error", reject);
  }));
  assert.equal(encoders.length, 4, "both cancelled slots are reusable");
  for (const replacement of replacements) { replacement.res.destroy(); replacement.req.destroy(); }
  await waitForCondition(() => completed === 4 && encoders.every((encoder) => encoder.destroyed));
  for (const encoder of encoders) assert.equal(encoder.listenerCount("drain"), 0);
});

test("an actual paused HTTP consumer backpressures the full tail and cancellation releases all owned resources", { timeout: 5000 }, async (t) => {
  const { trySendSidebarProgressiveResponse } = await import("../src/routes/sidebarProgressiveTransfer.js");
  const { buildSidebarProgressiveFrames } = await import("../src/routes/sidebarProgressiveFrames.js");
  const payload = fixture();
  payload.sessions[20].inputPreview = "large retained preview ".repeat(500000);
  const frames = buildSidebarProgressiveFrames(buildCompactSidebarPayload(payload));
  const owned = [];
  const server = await customServer(t, (ctx, runtime) => {
    let encoder;
    assert.equal(trySendSidebarProgressiveResponse(ctx, runtime, frames, "identity", {
      createEncoder: () => { encoder = new PassThrough({ highWaterMark: 1024 }); return encoder; }
    }), true);
    owned.push({ ctx, encoder, output: ctx.body });
  });
  const held = await new Promise((resolve, reject) => {
    const req = http.get(server.url, { agent: false }, (res) => { res.pause(); resolve({ req, res }); });
    req.once("error", reject);
  });
  await waitForCondition(() => owned[0].encoder.writableLength > 1024 && !owned[0].encoder.writableFinished);
  held.res.destroy(); held.req.destroy();
  await waitForCondition(() => owned[0].encoder.destroyed && owned[0].output.destroyed);
  const { ctx, encoder, output } = owned[0];
  for (const [stream, event] of [[ctx.req, "aborted"], [ctx.res, "close"], [ctx.res, "finish"], [output, "error"]]) {
    assert.equal(stream.listeners(event).some((listener) => listener.name === "cancelled"), false);
  }
  assert.equal(encoder.listenerCount("error"), 0);
  assert.equal(encoder.listenerCount("close"), 0);
});

test("compressor failures before and after headers are observable and release their capacity", { timeout: 5000 }, async (t) => {
  const { trySendSidebarProgressiveResponse } = await import("../src/routes/sidebarProgressiveTransfer.js");
  const { buildSidebarProgressiveFrames } = await import("../src/routes/sidebarProgressiveFrames.js");
  const frames = buildSidebarProgressiveFrames(buildCompactSidebarPayload(fixture()));
  let mode = "before";
  const owned = [];
  const server = await customServer(t, (ctx, runtime) => {
    const current = mode;
    assert.equal(trySendSidebarProgressiveResponse(ctx, runtime, frames, "gzip", {
      createEncoder: () => {
        const encoder = new Transform({ transform(chunk, _, callback) {
          callback(current === "before" ? new Error("before compression failure") : null, chunk);
        } });
        encoder.flush = (_, callback) => setImmediate(() => callback(current === "after" ? new Error("after compression failure") : null));
        owned.push(encoder);
        return encoder;
      }
    }), true);
  });
  const early = await get(server.url);
  assert.equal(early.status, 500);
  assert.equal(early.headers["cache-control"], "no-store");
  assert.equal(early.headers["x-content-type-options"], "nosniff");
  assert.ok(server.errors.some((error) => /before compression failure/.test(error.message)));
  mode = "after";
  await new Promise((resolve, reject) => {
    const req = http.get(server.url, { agent: false }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.once("aborted", () => { assert.match(data, /bootstrap/); resolve(); });
      res.once("end", () => reject(new Error("failed stream must not complete successfully")));
      res.once("error", () => {});
    });
    req.once("error", reject);
  });
  await waitForCondition(() => owned.every((encoder) => encoder.destroyed));
  assert.ok(server.errors.some((error) => /after compression failure/.test(error.message)));
  mode = "before";
  assert.equal((await get(server.url)).status, 500, "failures must release capacity for a replacement request");
  assert.equal(owned.length, 3);
});
