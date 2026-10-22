import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import { createKoaApp } from "../src/koa-app.js";
import { installAssetRuntime } from "../src/runtime/assets/frontendAssets.js";
import { precompressedAssets } from "../web/vite.config.js";
import { createBaseConfig, createTempDir } from "./helpers/backendTestUtils.js";

const assetName = "entry-AbCd1234.js";
const assetUrl = `/assets/${assetName}`;
const source = Buffer.from(`export const value = 1;\n${"// repeated compressed source text\n".repeat(200)}`);

async function fixture(t) {
  const rootDir = createTempDir("frontend-assets-test-");
  const frontendDir = path.join(rootDir, "dist");
  const fallbackDir = path.join(rootDir, "public");
  fs.mkdirSync(path.join(frontendDir, "assets"), { recursive: true });
  fs.mkdirSync(fallbackDir);
  const filePath = path.join(frontendDir, "assets", assetName);
  fs.writeFileSync(filePath, source);
  fs.writeFileSync(path.join(frontendDir, "index.html"), "<!doctype html><title>Fixture</title>");
  fs.writeFileSync(path.join(frontendDir, "assets", "unversioned.js"), source);
  fs.writeFileSync(path.join(fallbackDir, "public-AbCd1234.js"), source);
  await precompressedAssets().writeBundle({ dir: frontendDir }, { entry: { fileName: `assets/${assetName}` } });

  const { app, runtime } = createKoaApp({ config: createBaseConfig(rootDir), sessionManager: { stats: () => ({}) } });
  installAssetRuntime(runtime, { frontendDir, fallbackDir });
  const server = http.createServer(app.callback());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { rootDir, frontendDir, fallbackDir, filePath, runtime, baseUrl };
}

function request(baseUrl, pathname, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(pathname, baseUrl), { headers, method, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("precompression writes smaller gzip/br sides for large JS and CSS only", async (t) => {
  const { frontendDir, filePath } = await fixture(t);
  for (const [suffix, decode] of [[".gz", gunzipSync], [".br", brotliDecompressSync]]) {
    const side = fs.readFileSync(`${filePath}${suffix}`);
    assert.deepEqual(decode(side), source);
    assert.ok(side.length < source.length);
    assert.ok(fs.statSync(`${filePath}${suffix}`).mtimeMs >= fs.statSync(filePath).mtimeMs);
  }

  const names = ["style-ZyXw1234.css", "small-AbCd1234.js", "image-AbCd1234.svg"];
  for (const name of names) fs.writeFileSync(path.join(frontendDir, "assets", name), name.startsWith("small") ? "small" : source);
  await precompressedAssets().writeBundle({ dir: frontendDir }, Object.fromEntries(names.map((name) => [name, { fileName: `assets/${name}` }])));
  assert.deepEqual(gunzipSync(fs.readFileSync(path.join(frontendDir, "assets", `${names[0]}.gz`))), source);
  for (const name of names.slice(1)) {
    assert.equal(fs.existsSync(path.join(frontendDir, "assets", `${name}.gz`)), false);
    assert.equal(fs.existsSync(path.join(frontendDir, "assets", `${name}.br`)), false);
  }
});

test("fingerprinted responses negotiate byte-exact compressed representations and long caching", async (t) => {
  const { baseUrl } = await fixture(t);
  const tags = new Set();
  for (const [encoding, decode] of [["gzip", gunzipSync], ["br", brotliDecompressSync], ["identity", (value) => value]]) {
    const response = await request(baseUrl, assetUrl, { "Accept-Encoding": encoding });
    assert.equal(response.status, 200);
    assert.deepEqual(decode(response.body), source);
    assert.equal(response.headers["content-encoding"], encoding === "identity" ? undefined : encoding);
    assert.equal(response.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(response.headers.vary, "Accept-Encoding");
    assert.match(response.headers["content-type"], /^application\/javascript/);
    assert.equal(Number(response.headers["content-length"]), response.body.length);
    assert.ok(response.headers["last-modified"]);
    assert.ok(response.headers.etag);
    tags.add(response.headers.etag);
  }
  assert.equal(tags.size, 3);
});

test("encoding negotiation respects quality, wildcard, identity and 406", async (t) => {
  const { baseUrl } = await fixture(t);
  for (const [header, encoding] of [
    [undefined, undefined],
    ["gzip;q=0, br;q=0", undefined],
    ["gzip;q=0, *;q=1", "br"],
    ["br;q=0, gzip;q=0, *;q=1", undefined],
    ["*;q=1, identity;q=0", "br"],
    ["br;q=0.2, gzip;q=0.8, identity;q=0", "gzip"],
    ["identity;q=1, br;q=0.5, gzip;q=0.5", undefined]
  ]) {
    const response = await request(baseUrl, assetUrl, header === undefined ? {} : { "Accept-Encoding": header });
    assert.equal(response.status, 200, header);
    assert.equal(response.headers["content-encoding"], encoding, header);
    assert.equal(response.headers.vary, "Accept-Encoding");
  }
  for (const header of ["*;q=0", "identity;q=0, gzip;q=0, br;q=0", "deflate, identity;q=0"]) {
    const response = await request(baseUrl, assetUrl, { "Accept-Encoding": header });
    assert.equal(response.status, 406, header);
    assert.equal(response.headers.vary, "Accept-Encoding");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["content-encoding"], undefined);
  }
});

test("304 validates only the negotiated representation and has no body", async (t) => {
  const { baseUrl } = await fixture(t);
  for (const encoding of ["gzip", "br", "identity"]) {
    const first = await request(baseUrl, assetUrl, { "Accept-Encoding": encoding });
    const cached = await request(baseUrl, assetUrl, { "Accept-Encoding": encoding, "If-None-Match": `"other", ${first.headers.etag}` });
    assert.equal(cached.status, 304);
    assert.equal(cached.body.length, 0);
    for (const name of ["etag", "vary", "cache-control", "content-encoding", "last-modified"]) {
      assert.equal(cached.headers[name], first.headers[name], name);
    }
    assert.equal(cached.headers["content-length"], undefined);
    if (encoding !== "identity") {
      const changedEncoding = await request(baseUrl, assetUrl, { "Accept-Encoding": "identity", "If-None-Match": first.headers.etag });
      assert.equal(changedEncoding.status, 200);
      assert.deepEqual(changedEncoding.body, source);
    }
  }
  const first = await request(baseUrl, assetUrl);
  const modified = await request(baseUrl, assetUrl, { "If-Modified-Since": first.headers["last-modified"] });
  assert.equal(modified.status, 304);
  assert.equal(modified.body.length, 0);
});

test("HEAD preserves GET representation headers and content length", async (t) => {
  const { baseUrl } = await fixture(t);
  for (const [pathname, encoding] of [[assetUrl, "gzip"], [assetUrl, "br"], [assetUrl, "identity"], ["/", "identity"], ["/vendor/vue.js", "identity"]]) {
    const headers = { "Accept-Encoding": encoding };
    const get = await request(baseUrl, pathname, headers);
    const head = await request(baseUrl, pathname, headers, "HEAD");
    assert.equal(head.status, get.status);
    assert.equal(head.body.length, 0);
    for (const name of ["content-type", "content-length", "content-encoding", "etag", "cache-control", "last-modified", "vary"]) {
      assert.equal(head.headers[name], get.headers[name], `${pathname}: ${name}`);
    }
  }
});

test("old builds and changed source files fall back to current identity bytes", async (t) => {
  const { baseUrl, filePath } = await fixture(t);
  const previous = await request(baseUrl, assetUrl, { "Accept-Encoding": "gzip" });
  const changed = Buffer.from("export const changed = true;\n".repeat(200));
  fs.writeFileSync(filePath, changed);
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(filePath, later, later);
  const staleSide = await request(baseUrl, assetUrl, { "Accept-Encoding": "gzip, br", "If-None-Match": previous.headers.etag });
  assert.equal(staleSide.status, 200);
  assert.equal(staleSide.headers["content-encoding"], undefined);
  assert.equal(staleSide.headers.vary, "Accept-Encoding");
  assert.notEqual(staleSide.headers.etag, previous.headers.etag);
  assert.deepEqual(staleSide.body, changed);
  for (const suffix of [".br", ".gz"]) fs.rmSync(`${filePath}${suffix}`);
  const noSides = await request(baseUrl, assetUrl, { "Accept-Encoding": "gzip, br" });
  assert.equal(noSides.status, 200);
  assert.deepEqual(noSides.body, changed);
  const unacceptable = await request(baseUrl, assetUrl, { "Accept-Encoding": "gzip, identity;q=0" });
  assert.equal(unacceptable.status, 406);
});

test("HTML, unversioned assets, public files and private images keep no-store", async (t) => {
  const { baseUrl, rootDir, runtime } = await fixture(t);
  for (const pathname of ["/", "/assets/unversioned.js", "/public-AbCd1234.js", "/vendor/vue.js"]) {
    const response = await request(baseUrl, pathname, { "Accept-Encoding": "gzip, br" });
    assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["content-encoding"], undefined);
    assert.equal(response.headers.etag, undefined);
  }
  const imagePath = path.join(rootDir, "private.png");
  fs.writeFileSync(imagePath, Buffer.from([137, 80, 78, 71]));
  const imageUrl = `/api/local-file-image?path=${encodeURIComponent(imagePath)}`;
  const unauthorized = await request(baseUrl, imageUrl, { "If-None-Match": "*" });
  assert.equal(unauthorized.status, 401);
  runtime.requireAuthorized = () => true;
  const image = await request(baseUrl, imageUrl, { "Accept-Encoding": "br, gzip" });
  assert.equal(image.status, 200);
  assert.equal(image.headers["cache-control"], "no-store");
  assert.equal(image.headers["content-type"], "image/png");
  assert.equal(image.headers["content-encoding"], undefined);
  assert.equal(image.headers.etag, undefined);
  assert.deepEqual(image.body, fs.readFileSync(imagePath));
});

test("unknown APIs/assets and direct compression sides stay 404 while client links work", async (t) => {
  const { baseUrl } = await fixture(t);
  for (const pathname of ["/api", "/api/missing", "/assets", "/assets/missing", "/assets/missing.js", "/vendor", "/vendor/missing", `${assetUrl}.gz`, `${assetUrl}.br`]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await request(baseUrl, pathname, {}, method);
      assert.equal(response.status, 404, `${method} ${pathname}`);
      assert.equal(response.headers["cache-control"], "no-store");
      if (method === "HEAD") assert.equal(response.body.length, 0);
    }
  }
  for (const pathname of ["/sessions", "/login", "/chat/thread-1"]) {
    const response = await request(baseUrl, pathname);
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"], /^text\/html/);
    assert.equal(response.headers["cache-control"], "no-store");
  }
  for (const method of ["POST", "PUT", "DELETE"]) {
    const response = await request(baseUrl, "/", {}, method);
    assert.equal(response.status, 404, method);
  }
});
