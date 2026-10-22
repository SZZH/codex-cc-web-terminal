import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { PassThrough, Transform } from "node:stream";
import { createGzip, gunzipSync } from "node:zlib";
import Koa from "koa";
import { readJsonTransfer } from "../src/runtime/http/readJsonTransfer.js";
import { installResponseRuntime } from "../src/runtime/http/response.js";
import { waitForCondition } from "./helpers/backendTestUtils.js";

const serialized = (payload) => Buffer.from(`${JSON.stringify(payload)}\n`);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sized = (bytes) => ({ text: "x".repeat(bytes - 12) });
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function setup(t, { payload = sized(32000), createGzipStream, beforeTransfer } = {}) {
  const runtime = {};
  installResponseRuntime(runtime);
  const app = new Koa();
  const errors = [], contexts = [];
  app.on("error", (error) => errors.push(error));
  app.use(async (ctx) => {
    ctx.vary("Origin");
    runtime.json(ctx, 200, typeof payload === "function" ? payload(ctx) : payload);
    if (beforeTransfer) await beforeTransfer(ctx);
    contexts.push(ctx);
    readJsonTransfer(ctx, runtime, createGzipStream ? { createGzipStream } : undefined);
  });
  const server = http.createServer(app.callback());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    assert.equal(server.listening, false);
    assert.equal(await new Promise((resolve) => server.getConnections((_, count) => resolve(count))), 0);
  });
  return { runtime, server, errors, contexts, url: `http://127.0.0.1:${server.address().port}` };
}

function wire(s, encoding = "gzip") {
  return new Promise((resolve, reject) => {
    const headers = encoding == null ? {} : { "accept-encoding": encoding };
    http.get(s.url, { headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("aborted", () => reject(new Error("Response aborted")));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

test("read JSON transfer follows Koa encoding negotiation and merges Vary", async (t) => {
  const payload = sized(32000);
  const s = await setup(t, { payload });
  for (const [encoding, expected] of [
    ["gzip", "gzip"], ["*", "gzip"], ["gzip;q=0, *;q=1", undefined],
    ["gzip;q=0", undefined], ["br", undefined], ["identity", undefined],
    ["gzip;q=0.5, identity;q=1", undefined], ["gzip, identity;q=0", "gzip"], [null, undefined]
  ]) {
    const response = await wire(s, encoding);
    assert.equal(response.status, 200, encoding);
    assert.equal(response.headers["content-encoding"], expected, encoding);
    assert.deepEqual(expected ? gunzipSync(response.body) : response.body, serialized(payload));
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["x-frame-options"], "DENY");
    assert.equal(response.headers.etag, undefined);
    assert.deepEqual(response.headers.vary.toLowerCase().split(/,\s*/).sort(), ["accept-encoding", "origin"]);
  }
  for (const encoding of ["gzip;q=0, identity;q=0", "br, identity;q=0", "*;q=0"]) {
    const response = await wire(s, encoding);
    assert.equal(response.status, 406, encoding);
    assert.equal(response.headers["content-encoding"], undefined);
    assert.equal(JSON.parse(response.body).code, "encoding_not_acceptable");
  }
  assert.equal(s.errors.length, 0);
});

test("8 KiB threshold counts UTF-8 bytes and strict gzip also encodes small bodies", async (t) => {
  for (const [payload, compressed] of [
    [sized(8191), false], [sized(8192), true],
    [{ text: "汉".repeat(2800) }, true], [{ text: "🧪".repeat(2050) }, true]
  ]) {
    const s = await setup(t, { payload });
    const response = await wire(s);
    assert.equal(response.headers["content-encoding"], compressed ? "gzip" : undefined);
    assert.deepEqual(compressed ? gunzipSync(response.body) : response.body, serialized(payload));
  }
  const s = await setup(t, { payload: { text: "small" } });
  const response = await wire(s, "gzip, identity;q=0");
  assert.equal(response.headers["content-encoding"], "gzip");
  assert.deepEqual(gunzipSync(response.body), serialized({ text: "small" }));
});

test("streamed JSON preserves emoji across chunk boundaries and complete bodies above 4 MiB", async (t) => {
  const prefix = "a".repeat(16 * 1024 - 10);
  const payload = { text: `${prefix}🧪${"汉".repeat(17000)}${"😀boundary".repeat(500000)}` };
  const expected = serialized(payload);
  assert.ok(expected.length > 4 * 1024 * 1024);
  const s = await setup(t, { payload, beforeTransfer: (ctx) => ctx.set("Content-Length", expected.length) });
  const response = await wire(s);
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-encoding"], "gzip");
  assert.equal(response.headers["content-length"], undefined);
  const decoded = gunzipSync(response.body);
  assert.equal(decoded.length, expected.length);
  assert.equal(hash(decoded), hash(expected));
  assert.deepEqual(decoded, expected);
  assert.equal(s.errors.length, 0);
});

test("history JSON is serialized once and a nonstring simulated body is skipped", async (t) => {
  let calls = 0;
  const s = await setup(t, { payload: { toJSON() { calls += 1; return sized(32000); } } });
  const response = await wire(s);
  assert.equal(calls, 1);
  assert.deepEqual(gunzipSync(response.body), serialized(sized(32000)));
  const body = { simulated: true };
  const ctx = { body };
  readJsonTransfer(ctx, {});
  assert.equal(ctx.body, body);
});

test("two active compressions have no waiting body queue and busy responses respect identity q=0", async (t) => {
  const compressors = [];
  const payload = sized(100000);
  const s = await setup(t, { payload, createGzipStream(options) {
    assert.equal(options.level, 1);
    const stream = createGzip(options);
    if (compressors.length < 2) stream.cork();
    compressors.push(stream);
    return stream;
  } });
  const pending = [wire(s), wire(s)];
  await waitForCondition(() => compressors.length === 2);
  const fallback = await wire(s);
  assert.equal(fallback.status, 200);
  assert.equal(fallback.headers["content-encoding"], undefined);
  assert.deepEqual(fallback.body, serialized(payload));
  const busy = await wire(s, "gzip, identity;q=0");
  assert.equal(busy.status, 503);
  assert.equal(busy.headers["retry-after"], "1");
  assert.equal(busy.headers["content-encoding"], undefined);
  assert.equal(JSON.parse(busy.body).retryable, true);
  assert.equal(compressors.length, 2);
  for (const stream of compressors) stream.uncork();
  for (const response of await Promise.all(pending)) assert.deepEqual(gunzipSync(response.body), serialized(payload));
  const recovered = await wire(s);
  assert.equal(recovered.headers["content-encoding"], "gzip");
  assert.deepEqual(gunzipSync(recovered.body), serialized(payload));
  await tick();
  assert.ok(compressors.every((stream) => stream.destroyed));
  assert.equal(s.errors.length, 0);
});

test("compression capacity belongs to each runtime", async (t) => {
  const compressors = [];
  const first = await setup(t, { createGzipStream(options) {
    const stream = createGzip(options); stream.cork(); compressors.push(stream); return stream;
  } });
  const pending = [wire(first), wire(first)];
  await waitForCondition(() => compressors.length === 2);
  const other = await setup(t);
  assert.equal((await wire(other)).headers["content-encoding"], "gzip");
  for (const stream of compressors) stream.uncork();
  await Promise.all(pending);
});

test("client cancellation destroys the pipeline quietly and releases exactly one capacity slot", async (t) => {
  const compressors = [];
  let gated = true;
  const payload = sized(100000);
  const s = await setup(t, { payload, createGzipStream(options) {
    const stream = createGzip(options);
    if (gated) stream.cork();
    compressors.push(stream); return stream;
  } });
  const cancelled = http.get(s.url, { headers: { "accept-encoding": "gzip" } });
  cancelled.on("error", () => {});
  const second = wire(s);
  await waitForCondition(() => compressors.length === 2);
  cancelled.destroy();
  await waitForCondition(() => compressors[0].destroyed);
  await tick();
  const replacement = wire(s);
  await waitForCondition(() => compressors.length === 3);
  const fallback = await wire(s);
  assert.equal(fallback.headers["content-encoding"], undefined);
  assert.deepEqual(fallback.body, serialized(payload));
  assert.equal((await wire(s, "gzip, identity;q=0")).status, 503);
  assert.equal(compressors.length, 3);
  gated = false;
  for (const stream of compressors) if (!stream.destroyed) stream.uncork();
  for (const response of await Promise.all([second, replacement])) assert.deepEqual(gunzipSync(response.body), serialized(payload));
  assert.equal((await wire(s)).headers["content-encoding"], "gzip");
  await tick();
  assert.ok(compressors.every((stream) => stream.destroyed));
  assert.ok(s.contexts.filter((ctx) => ctx.body instanceof PassThrough).every((ctx) => ctx.body.destroyed));
  assert.equal(s.errors.length, 0);
});

test("an already cancelled response starts no compression when its history read finishes", async (t) => {
  let release, waitingContext, calls = 0;
  const waiting = new Promise((resolve) => { release = resolve; });
  const s = await setup(t, { beforeTransfer(ctx) {
    if (!waitingContext) { waitingContext = ctx; return waiting; }
  }, createGzipStream(options) { calls += 1; return createGzip(options); } });
  const cancelled = http.get(s.url, { headers: { "accept-encoding": "gzip" } });
  cancelled.on("error", () => {});
  await waitForCondition(() => waitingContext);
  cancelled.destroy();
  await waitForCondition(() => waitingContext.res.destroyed);
  release();
  await tick(); await tick();
  assert.equal(calls, 0);
  assert.equal(waitingContext.response.get("Content-Encoding"), "");
  assert.equal((await wire(s)).headers["content-encoding"], "gzip");
  assert.equal(s.errors.length, 0);
});

test("client cancellation after gzip headers quietly destroys the active compressor", async (t) => {
  const payload = { text: randomBytes(4 * 1024 * 1024).toString("base64") };
  const compressors = [];
  const s = await setup(t, { payload, createGzipStream(options) {
    const stream = createGzip(options); compressors.push(stream); return stream;
  } });
  await new Promise((resolve, reject) => {
    const request = http.get(s.url, { headers: { "accept-encoding": "gzip" } }, (response) => {
      assert.equal(response.headers["content-encoding"], "gzip");
      response.on("error", () => {});
      response.once("data", () => { request.destroy(); resolve(); });
    });
    request.on("error", (error) => { if (error.code !== "ECONNRESET") reject(error); });
  });
  await waitForCondition(() => compressors[0]?.destroyed);
  await tick();
  const recovered = await wire(s);
  assert.equal(hash(gunzipSync(recovered.body)), hash(serialized(payload)));
  assert.equal(s.errors.length, 0);
});

test("a compressor failure before headers sends an error and frees capacity", async (t) => {
  let first = true;
  const s = await setup(t, { createGzipStream(options) {
    if (!first) return createGzip(options);
    first = false;
    return new Transform({ transform(_chunk, _encoding, callback) {
      queueMicrotask(() => callback(new Error("synthetic compression failure")));
    } });
  } });
  const failure = await wire(s);
  assert.equal(failure.status, 500);
  assert.equal(failure.headers["content-encoding"], undefined);
  assert.equal(failure.headers["cache-control"], "no-store");
  assert.equal((await wire(s)).headers["content-encoding"], "gzip");
  assert.equal(s.errors.length, 1);
});

test("a compressor failure after headers aborts the response and frees capacity once", async (t) => {
  const payload = { text: randomBytes(2 * 1024 * 1024).toString("base64") };
  const compressors = [];
  let gated = true;
  const s = await setup(t, { payload, createGzipStream(options) {
    const stream = createGzip(options);
    if (!compressors.length) stream.once("data", () => stream.destroy(new Error("synthetic midstream failure")));
    else if (gated) stream.cork();
    compressors.push(stream); return stream;
  } });
  await assert.rejects(wire(s), /aborted|socket hang up/i);
  await tick();
  const pending = [wire(s), wire(s)];
  await waitForCondition(() => compressors.length === 3);
  const fallback = await wire(s);
  assert.equal(fallback.headers["content-encoding"], undefined);
  assert.equal(hash(fallback.body), hash(serialized(payload)));
  assert.equal((await wire(s, "gzip, identity;q=0")).status, 503);
  assert.equal(compressors.length, 3);
  gated = false;
  for (const stream of compressors) if (!stream.destroyed) stream.uncork();
  for (const response of await Promise.all(pending)) assert.equal(hash(gunzipSync(response.body)), hash(serialized(payload)));
  assert.equal((await wire(s)).headers["content-encoding"], "gzip");
  await tick();
  assert.ok(compressors.every((stream) => stream.destroyed));
  assert.equal(s.errors.length, 1);
});

test("synchronous compressor creation failure leaves no gzip header or reserved slot", async (t) => {
  let first = true;
  const s = await setup(t, { createGzipStream(options) {
    if (first) { first = false; throw new Error("synthetic creation failure"); }
    return createGzip(options);
  } });
  const failure = await wire(s);
  assert.equal(failure.status, 500);
  assert.equal(failure.headers["content-encoding"], undefined);
  assert.equal((await wire(s)).headers["content-encoding"], "gzip");
  assert.equal(s.errors.length, 1);
});
