import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import zlib, { brotliDecompressSync, gzipSync, gunzipSync } from "node:zlib";
import Koa from "koa";

import { buildCompactSidebarPayload } from "../src/routes/sidebarResponse.js";
import { restoreSessionSidebarPayload } from "../web/src/lib/session-sidebar-payload.js";
import { login, startTestServer } from "./helpers/backendTestUtils.js";

function sidebarFixture() {
  const codex = { id: "history:codex:shared", provider: "codex", resumeSessionId: "shared", kind: "history",
    name: "Canonical title", inputPreview: "Full preview", cwd: "/workspace/shared", projectId: "a",
    updatedAt: "2026-10-16T08:00:00.001Z", extra: { one: 1, two: 2 } };
  const cc = { ...codex, id: "history:cc:shared", provider: "cc", name: "Other provider" };
  const live = { ...codex, id: "live-session", resumeSessionId: "live-thread", kind: "live", status: "running" };
  return {
    sessions: [cc, live, codex],
    projectGroups: [
      { id: "project:b", projectId: "b", groupKind: "project", name: "Same name", cwd: codex.cwd,
        rootPaths: [codex.cwd, "/workspace/second"], collapsed: true, order: 0, sessions: [live, codex] },
      { id: "project:a", projectId: "a", groupKind: "project", name: "Same name", cwd: codex.cwd,
        order: 1, pinned: true, sessions: [codex, cc] },
      { id: "empty", name: "Empty project", sessions: [] },
      { id: "pinned:codex", groupKind: "pinned", sessions: [codex] }
    ],
    sidebarPreferences: { grouping: "project", projects: "manual" },
    sidebarStatus: { source: "fixture", degraded: true, warnings: ["Retained warning"] },
    extension: { supported: true }
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

test("compact sidebar round trips complete records, group metadata, order and multiple memberships", () => {
  const payload = deepFreeze(sidebarFixture());
  const compact = buildCompactSidebarPayload(payload);
  assert.equal(compact.sidebarFormat, "compact-v1");
  assert.strictEqual(compact.sessions, payload.sessions);
  assert.deepEqual(compact.projectGroups.map((group) => group.sessionIds), [
    ["live-session", "history:codex:shared"], ["history:codex:shared", "history:cc:shared"], [], ["history:codex:shared"]
  ]);
  assert.ok(compact.projectGroups.every((group) => !Object.hasOwn(group, "sessions")));
  const transported = deepFreeze(JSON.parse(JSON.stringify(compact)));
  const restored = restoreSessionSidebarPayload(transported);
  assert.deepEqual(restored, payload);
  assert.strictEqual(restored.projectGroups[0].sessions[1], restored.sessions[2]);
  assert.strictEqual(restored.projectGroups[1].sessions[0], restored.sessions[2]);
  assert.equal(transported.sidebarFormat, "compact-v1");
  assert.equal(payload.sidebarFormat, undefined);
});

test("compact sidebar compares record contents independently of property insertion order", () => {
  const payload = sidebarFixture();
  payload.projectGroups = payload.projectGroups.map((group) => ({ ...group,
    sessions: group.sessions.map((session) => Object.fromEntries(Object.entries(session).reverse())) }));
  const compact = buildCompactSidebarPayload(deepFreeze(payload));
  assert.equal(compact.sidebarFormat, "compact-v1");
  assert.deepEqual(restoreSessionSidebarPayload(compact), payload);
});

test("compact sidebar falls back without losing ambiguous or noncanonical legacy data", () => {
  const first = { id: "one", name: "Canonical" };
  const payloads = [
    null, [], {},
    { sessions: [], projectGroups: null },
    { sessions: [null], projectGroups: [] },
    { sessions: [{ name: "Missing ID" }], projectGroups: [] },
    { sessions: [{ id: " " }], projectGroups: [] },
    { sessions: [first, { ...first, name: "Conflicting" }], projectGroups: [] },
    { sessions: [first, { ...first }], projectGroups: [] },
    { sessions: [first], projectGroups: [{ sessions: [{ id: "missing" }] }] },
    { sessions: [first], projectGroups: [{ sessions: [{ ...first, name: "Older group title" }] }] },
    { sessions: [first], projectGroups: [{ sessions: [first], sessionIds: ["existing extension"] }] },
    { sessions: [first], projectGroups: [{}] },
    { sessions: [first], projectGroups: [null] },
    { sessions: [first], projectGroups: [], sidebarFormat: "existing extension" }
  ];
  for (const payload of payloads) assert.strictEqual(buildCompactSidebarPayload(deepFreeze(payload)), payload);
});

test("sidebar decoder preserves legacy identity and handles empty or absent groups", () => {
  const legacy = deepFreeze(sidebarFixture());
  assert.strictEqual(restoreSessionSidebarPayload(legacy), legacy);
  assert.deepEqual(restoreSessionSidebarPayload({ sidebarFormat: "compact-v1", sessions: [] }), { sessions: [] });
  for (const payload of [
    { sessions: [], projectGroups: [] },
    { sessions: [], projectGroups: [{ id: "empty", collapsed: true, sessions: [] }] },
    { sessions: [{ id: "ungrouped" }], projectGroups: [] }
  ]) assert.deepEqual(restoreSessionSidebarPayload(buildCompactSidebarPayload(deepFreeze(payload))), payload);
});

test("sidebar decoder rejects unknown formats, malformed structures and dangling references", () => {
  const compact = { sidebarFormat: "compact-v1", sessions: [{ id: "one" }], projectGroups: [] };
  const payloads = [
    null, [], "invalid", { ...compact, sidebarFormat: "compact-v2" }, { ...compact, sidebarFormat: null },
    { sidebarFormat: "compact-v1" }, { ...compact, sessions: {} }, { ...compact, sessions: [null] },
    { ...compact, sessions: [{ id: 1 }] }, { ...compact, sessions: [{ id: "" }] },
    { ...compact, sessions: [{ id: "one", name: "A" }, { id: "one", name: "B" }] },
    { ...compact, sessions: [{ id: "one" }, { id: "one" }] },
    { ...compact, projectGroups: null }, { ...compact, projectGroups: [null] },
    { ...compact, projectGroups: [{ sessionIds: "one" }] },
    { ...compact, projectGroups: [{ sessionIds: ["one"], sessions: [] }] },
    { ...compact, projectGroups: [{ sessionIds: ["one", "missing"] }] },
    { ...compact, projectGroups: [{ sessionIds: [1] }] }
  ];
  for (const payload of payloads) assert.throws(() => restoreSessionSidebarPayload(deepFreeze(payload)), /sidebar/i);
});

test("compact sidebar reduces JSON and gzip transfer without truncating content", () => {
  const sessions = Array.from({ length: 240 }, (_, index) => ({
    id: `history:codex:thread-${index}`, provider: "codex", resumeSessionId: `thread-${index}`, name: `Complete title ${index}`,
    inputPreview: Array.from({ length: 12 }, (_, part) => createHash("sha256").update(`preview:${index}:${part}`).digest("base64")).join(" ")
  }));
  const payload = { sessions, projectGroups: [
    { id: "project:one", sessions: sessions.slice(0, 120) }, { id: "project:two", sessions: sessions.slice(120) }
  ] };
  const compact = buildCompactSidebarPayload(payload);
  const originalJson = Buffer.from(JSON.stringify(payload));
  const compactJson = Buffer.from(JSON.stringify(compact));
  assert.ok(compactJson.length < originalJson.length);
  assert.ok(gzipSync(compactJson).length < gzipSync(originalJson).length);
  assert.deepEqual(restoreSessionSidebarPayload(JSON.parse(compactJson)), payload);
});

function rawGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.on("error", reject);
  });
}

function responsePayload(response) {
  const encoding = response.headers["content-encoding"];
  return JSON.parse(encoding === "br" ? brotliDecompressSync(response.body)
    : encoding === "gzip" ? gunzipSync(response.body) : response.body);
}

async function sidebarServer(t, payload) {
  let reads = 0;
  const server = await startTestServer({ sessionManager: {
    listSidebarSnapshot: () => { reads += 1; return payload; },
    get: () => null
  } });
  t.after(async () => {
    try { await server.close(); } finally { fs.rmSync(server.rootDir, { recursive: true, force: true }); }
  });
  const { cookies } = await login(server.baseUrl, server.config.accessToken);
  return { ...server, cookies, readCount: () => reads };
}

test("sessions compact opt-in keeps default JSON, compression and ETag representations isolated", async (t) => {
  const source = sidebarFixture();
  const before = structuredClone(source);
  const server = await sidebarServer(t, source);
  const url = `${server.baseUrl}/api/sessions`;
  const headers = { cookie: server.cookies };
  const legacy = await rawGet(url, headers);
  const compact = await rawGet(`${url}?compact=1`, headers);
  assert.equal(legacy.status, 200);
  assert.equal(compact.status, 200);
  assert.equal(responsePayload(legacy).sidebarFormat, undefined);
  assert.equal(responsePayload(compact).sidebarFormat, "compact-v1");
  assert.deepEqual(restoreSessionSidebarPayload(responsePayload(compact)), responsePayload(legacy));
  assert.notEqual(legacy.headers.etag, compact.headers.etag);

  for (const [target, identity] of [[url, legacy], [`${url}?compact=1`, compact]]) {
    for (const encoding of ["br", "gzip"]) {
      const zipped = await rawGet(target, { ...headers, "Accept-Encoding": encoding });
      assert.equal(zipped.headers["content-encoding"], encoding);
      assert.equal(zipped.headers.etag, identity.headers.etag);
      assert.equal(zipped.headers["cache-control"], "private, no-cache");
      assert.equal(zipped.headers.vary, "Accept-Encoding");
      assert.deepEqual(responsePayload(zipped), responsePayload(identity));
      const cached = await rawGet(target, { ...headers, "Accept-Encoding": encoding, "If-None-Match": identity.headers.etag });
      assert.equal(cached.status, 304);
      assert.equal(cached.body.length, 0);
      assert.equal(cached.headers["content-encoding"], undefined);
    }
  }

  const compactWithLegacyTag = await rawGet(`${url}?compact=1`, { ...headers, "If-None-Match": legacy.headers.etag });
  const legacyWithCompactTag = await rawGet(url, { ...headers, "If-None-Match": compact.headers.etag });
  assert.equal(compactWithLegacyTag.status, 200);
  assert.equal(legacyWithCompactTag.status, 200);
  for (const query of ["compact=0", "compact=true", "compact=1&compact=0"]) {
    const response = await rawGet(`${url}?${query}`, headers);
    assert.deepEqual(responsePayload(response), responsePayload(legacy));
  }
  const noGzip = await rawGet(`${url}?compact=1`, { ...headers, "Accept-Encoding": "gzip;q=0, *;q=1" });
  assert.equal(noGzip.headers["content-encoding"], "br");
  assert.equal(noGzip.headers.etag, compact.headers.etag);
  assert.deepEqual(responsePayload(noGzip), responsePayload(compact));

  const reads = server.readCount();
  const unauthorized = await rawGet(`${url}?compact=1`, { "If-None-Match": compact.headers.etag, "Accept-Encoding": "br" });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.etag, undefined);
  assert.equal(unauthorized.headers["content-encoding"], undefined);
  assert.equal(unauthorized.headers["cache-control"], "no-store");
  assert.equal(server.readCount(), reads);
  assert.deepEqual(source, before);

  source.sessions[2].name = "Updated canonical title";
  const changed = await rawGet(`${url}?compact=1`, { ...headers, "Accept-Encoding": "br", "If-None-Match": compact.headers.etag });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.etag, compact.headers.etag);
  assert.equal(restoreSessionSidebarPayload(responsePayload(changed)).projectGroups[1].sessions[0].name, "Updated canonical title");
});

test("compact requests retain legacy records when group fields differ from the canonical record", async (t) => {
  const source = sidebarFixture();
  source.projectGroups[0].sessions[1] = { ...source.sessions[2], name: "Older group title" };
  const server = await sidebarServer(t, source);
  const headers = { cookie: server.cookies, "Accept-Encoding": "br" };
  const legacy = await rawGet(`${server.baseUrl}/api/sessions`, headers);
  const requestedCompact = await rawGet(`${server.baseUrl}/api/sessions?compact=1`, headers);
  assert.equal(requestedCompact.status, 200);
  assert.equal(responsePayload(requestedCompact).sidebarFormat, undefined);
  assert.deepEqual(responsePayload(requestedCompact), responsePayload(legacy));
  assert.equal(requestedCompact.headers.etag, legacy.headers.etag);
  assert.equal(responsePayload(requestedCompact).projectGroups[0].sessions[1].name, "Older group title");
});

test("compact activity changes invalidate ETags without changing stored ordering metadata", async (t) => {
  const source = sidebarFixture();
  const server = await sidebarServer(t, source);
  let activityState = "running";
  server.runtime.codexThreads = { getThreadActivity: () => ({ activityState, lastActivityAt: "2026-10-16T08:00:01.000Z" }) };
  const url = `${server.baseUrl}/api/sessions?compact=1`;
  const headers = { cookie: server.cookies, "Accept-Encoding": "br" };
  const first = await rawGet(url, headers);
  const running = restoreSessionSidebarPayload(responsePayload(first));
  assert.equal(running.sessions[2].activityState, "running");
  assert.equal(running.projectGroups[0].sessions[1].activityState, "running");
  activityState = "idle";
  const next = await rawGet(url, { ...headers, "If-None-Match": first.headers.etag });
  assert.equal(next.status, 200);
  assert.notEqual(next.headers.etag, first.headers.etag);
  const idle = restoreSessionSidebarPayload(responsePayload(next));
  assert.equal(idle.projectGroups[0].sessions[1].activityState, "idle");
  assert.deepEqual(idle.projectGroups.map((group) => group.sessions.map((session) => session.id)),
    running.projectGroups.map((group) => group.sessions.map((session) => session.id)));
  assert.equal(idle.sessions[2].updatedAt, running.sessions[2].updatedAt);
  assert.equal(source.sessions[2].activityState, undefined);
});

test("sidebar compression shares in-flight work, retries failures and discards superseded representations", async (t) => {
  const calls = { br: [], gzip: [] };
  const mocks = [
    t.mock.method(zlib, "brotliCompress", (input, options, callback) => calls.br.push({ input, options, callback })),
    t.mock.method(zlib, "gzip", (input, callback) => calls.gzip.push({ input, callback }))
  ];
  syncBuiltinESMExports();
  try {
    const { sendSidebarResponse } = await import("../src/routes/sidebarResponse.js?compression-cache-test");
    const app = new Koa();
    function context(encoding, etag = "") {
      const headers = {};
      const request = Object.create(app.request);
      request.req = { headers: { "accept-encoding": encoding } };
      return {
        headers,
        request,
        get accept() { return request.accept; },
        get: (name) => name === "If-None-Match" ? etag : encoding,
        acceptsEncodings: app.context.acceptsEncodings,
        vary: (name) => { headers.Vary = name; },
        set: (name, value) => typeof name === "object" ? Object.assign(headers, name) : headers[name] = value
      };
    }
    const runtime = { responseHeaders: (headers) => headers };
    const payload = sidebarFixture();
    const identity = context("identity");
    await sendSidebarResponse(identity, runtime, payload);
    for (const encoding of ["gzip", "br"]) {
      const cached = context(encoding, identity.headers.ETag);
      await sendSidebarResponse(cached, runtime, payload);
      assert.equal(cached.status, 304);
      assert.equal(cached.body, null);
      assert.equal(cached.headers["Content-Encoding"], undefined);
      assert.equal(calls[encoding].length, 0, "304 must avoid compression entirely");

      const first = context(encoding);
      const second = context(encoding);
      const originalHeaders = first.request.req.headers;
      const originalAccept = first.accept;
      const inFlight = [sendSidebarResponse(first, runtime, payload), sendSidebarResponse(second, runtime, payload)];
      assert.strictEqual(first.request.req.headers, originalHeaders);
      assert.equal(originalHeaders["accept-encoding"], encoding);
      assert.strictEqual(first.accept, originalAccept);
      assert.equal(calls[encoding].length, 1, "concurrent identical payloads share one compression");
      const failure = new Error(`${encoding} compression failed`);
      const rejected = inFlight.map((promise) => assert.rejects(promise, (error) => error === failure));
      calls[encoding][0].callback(failure);
      await Promise.all(rejected);
      assert.equal(first.body, undefined);
      assert.equal(first.headers["Content-Encoding"], undefined);

      const retry = context(encoding);
      const retryPromise = sendSidebarResponse(retry, runtime, payload).then(() => null, (error) => error);
      assert.equal(calls[encoding].length, 2, "a rejected cache entry must be retried");
      assert.equal(calls[encoding][1].input, identity.body);
      const encoded = Buffer.from(`${encoding}:complete`);
      calls[encoding][1].callback(null, encoded);
      assert.equal(await retryPromise, null);
      assert.strictEqual(retry.body, encoded);
      assert.equal(retry.headers["Content-Encoding"], encoding);
      const repeat = context(encoding);
      await sendSidebarResponse(repeat, runtime, payload);
      assert.strictEqual(repeat.body, encoded);
      assert.equal(calls[encoding].length, 2);
    }
    assert.equal(calls.br[1].options.params[zlib.constants.BROTLI_PARAM_MODE], zlib.constants.BROTLI_MODE_TEXT);
    assert.equal(calls.br[1].options.params[zlib.constants.BROTLI_PARAM_QUALITY], 5);
    const mixedCase = context("GZip;Q=0.4, BR;Q=0.9");
    const originalHeaders = mixedCase.request.req.headers;
    const originalAccept = mixedCase.accept;
    await sendSidebarResponse(mixedCase, runtime, payload);
    assert.equal(mixedCase.headers["Content-Encoding"], "br");
    assert.equal(calls.br.length, 2);
    assert.strictEqual(mixedCase.request.req.headers, originalHeaders);
    assert.equal(originalHeaders["accept-encoding"], "GZip;Q=0.4, BR;Q=0.9");
    assert.strictEqual(mixedCase.accept, originalAccept);

    const changed = { ...payload, extension: { supported: false } };
    const previous = context("br");
    const newer = context("br");
    const previousPromise = sendSidebarResponse(previous, runtime, changed);
    const newerPromise = sendSidebarResponse(newer, runtime, payload, { compact: true });
    assert.equal(calls.br.length, 4);
    calls.br[3].callback(null, Buffer.from("compact"));
    await newerPromise;
    calls.br[2].callback(new Error("superseded payload failed"));
    await assert.rejects(previousPromise, /superseded payload failed/);
    const current = context("br");
    await sendSidebarResponse(current, runtime, payload, { compact: true });
    assert.strictEqual(current.body, newer.body);
    assert.equal(calls.br.length, 4, "an older failure cannot evict the current payload");
    assert.notEqual(previous.headers.ETag, newer.headers.ETag);

    const separateRuntime = context("br");
    const separatePromise = sendSidebarResponse(separateRuntime, { ...runtime }, payload, { compact: true });
    assert.equal(calls.br.length, 5, "different runtimes cannot share a response cache");
    calls.br[4].callback(null, Buffer.from("separate runtime"));
    await separatePromise;
    assert.notStrictEqual(separateRuntime.body, current.body);

    const legacy = context("br");
    const legacyPromise = sendSidebarResponse(legacy, runtime, payload);
    assert.equal(calls.br.length, 6, "only the latest representation is retained");
    calls.br[5].callback(null, Buffer.from("legacy"));
    await legacyPromise;
    assert.equal(legacy.headers.ETag, identity.headers.ETag);
    assert.notEqual(legacy.headers.ETag, newer.headers.ETag);
  } finally {
    for (const mock of mocks) mock.mock.restore();
    syncBuiltinESMExports();
  }
});
