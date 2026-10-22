import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { createManifest, sha256, validateManifest, verifyArtifact } from "../scripts/frontend-release/manifest.mjs";
import { activateRelease, currentRelease, listReleases, publishRelease, stageRelease } from "../scripts/frontend-release/release.mjs";
import { transformCaddyConfig } from "../scripts/frontend-release/caddy.mjs";
import { installResponseRuntime } from "../src/runtime/http/response.js";

async function fixture(t, name = "entry-AbCd1234.js", content = "export const value = 1;\n".repeat(100)) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "frontend-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "dist");
  const root = path.join(directory, "published");
  await mkdir(path.join(source, "assets"), { recursive: true });
  await mkdir(path.join(source, "licenses"));
  await writeFile(path.join(source, "index.html"), `<html><script type="module" src="/assets/${name}"></script></html>`);
  await writeFile(path.join(source, "licenses", "library.txt"), "Library license");
  await writeFile(path.join(source, "favicon.svg"), "<svg/>");
  await writeFile(path.join(source, "assets", name), content);
  await writeFile(path.join(source, "assets", `${name}.br`), brotliCompressSync(content));
  await writeFile(path.join(source, "assets", `${name}.gz`), gzipSync(content));
  return { directory, source, root, name, content };
}

function configFixture() {
  const proxy = { handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:19000" }], flush_interval: -1, headers: { request: { delete: ["Authorization"] } } };
  const auth = { handler: "authentication", providers: { http_basic: { accounts: [{ username: "fixture", password: "fixture-hash" }] } } };
  const headers = { handler: "headers", response: { set: { "X-Frame-Options": ["DENY"] } } };
  const encode = { handler: "encode", encodings: { gzip: {}, zstd: {} }, prefer: ["zstd", "gzip"] };
  return { admin: { disabled: true }, apps: { http: { servers: {
    project: { listen: [":8443"], routes: [{ handle: [{ handler: "subroute", routes: [{ handle: [auth, headers, encode, proxy] }] }], terminal: true }] },
    preview: { listen: [":8444"], routes: [{ handle: [{ ...proxy, upstreams: [{ dial: "127.0.0.1:19001" }] }] }] }
  } }, tls: { automation: { policies: [{ subjects: ["example.test"] }] } } } };
}

const handles = (config) => config.apps.http.servers.project.routes[0].handle[0].routes[0].handle;
const options = (manifest, retainedManifests = []) => ({ serverName: "project", upstreamDial: "127.0.0.1:19000", root: "/srv/project/frontend", manifest, retainedManifests });

test("manifest verifies byte checksums, MIME and compressed originals without build dependencies", async (t) => {
  const { source, name } = await fixture(t);
  const manifest = await createManifest(source, "v1");
  assert.equal(manifest.files.length, 6);
  assert.equal((await verifyArtifact(source, manifest)).artifactSha256, manifest.artifactSha256);
  const file = manifest.files.find((entry) => entry.path === `assets/${name}`);
  assert.equal(file.immutable, true);
  assert.equal(file.contentType, "application/javascript; charset=utf-8");
  assert.equal(manifest.files.find((entry) => entry.path === "index.html").immutable, false);
  await writeFile(path.join(source, "assets", `${name}.br`), brotliCompressSync("wrong"));
  await assert.rejects(createManifest(source, "broken"), /Compressed content mismatch/);
});

test("stage, activation, a second release and rollback retain both immutable generations", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t, "entry-WxYz5678.js", "export const value = 2;\n".repeat(100));
  const one = await createManifest(first.source, "one");
  const two = await createManifest(second.source, "two");
  await stageRelease({ root: first.root, source: first.source, manifest: one });
  assert.equal(await currentRelease(first.root), null);
  assert.equal((await activateRelease({ root: first.root, release: "one" })).previousRelease, null);
  assert.equal((await publishRelease({ root: first.root, source: second.source, manifest: two })).previousRelease, "one");
  assert.equal(await readlink(path.join(first.root, "current")), "releases/two");
  assert.equal((await activateRelease({ root: first.root, release: "one" })).previousRelease, "two");
  for (const artifact of [first, second]) {
    assert.equal(await readFile(path.join(first.root, "shared/files/assets", artifact.name), "utf8"), artifact.content);
  }
  assert.deepEqual((await listReleases(first.root)).map((entry) => entry.release), ["one", "two"]);
  assert.equal((await stageRelease({ root: first.root, source: first.source, manifest: one })).reused, true);
  assert.equal((await stat(path.join(first.root, "shared/files/assets", first.name))).mode & 0o777, 0o644);
});

test("truncated upload and missing lazy chunk cannot replace the active release", async (t) => {
  const value = await fixture(t);
  const manifest = await createManifest(value.source, "good");
  await publishRelease({ ...value, manifest });
  await writeFile(path.join(value.source, "assets", value.name), "truncated");
  await assert.rejects(publishRelease({ ...value, manifest: { ...manifest, release: "truncated" } }), /checksum mismatch/);
  assert.equal(await currentRelease(value.root), "good");
  await rm(path.join(value.source, "assets", `${value.name}.br`));
  await rm(path.join(value.source, "assets", `${value.name}.gz`));
  await writeFile(path.join(value.source, "assets", value.name), 'import("./missing-XyZa1234.js");');
  await assert.rejects(createManifest(value.source, "missing"), /Missing build dependency/);
});

test("path traversal, private roots, unknown MIME, duplicate paths and symlinks fail closed", async (t) => {
  const value = await fixture(t);
  const manifest = await createManifest(value.source, "good");
  for (const unsafe of ["../secret.txt", "/secret.txt", "assets/../../secret.txt", "assets\\secret.js", "assets/%2e%2e.txt", "assets/unsafe.js\n", "api/data.json", ".env", "source.map"]) {
    const bad = structuredClone(manifest);
    bad.files[0].path = unsafe;
    assert.throws(() => validateManifest(bad));
  }
  const duplicate = structuredClone(manifest);
  duplicate.files.push(duplicate.files[0]);
  assert.throws(() => validateManifest(duplicate), /Duplicate/);
  await symlink(path.join(value.source, "index.html"), path.join(value.source, "leak.html"));
  await assert.rejects(createManifest(value.source, "linked"), /Symbolic links/);
  await rm(path.join(value.source, "leak.html"));
  await mkdir(value.root);
  await symlink(value.source, path.join(value.root, "shared"));
  await assert.rejects(stageRelease({ ...value, manifest }), /Unsafe directory/);
});

test("same immutable URL with different bytes fails before pointer switch", async (t) => {
  const first = await fixture(t);
  const changed = await fixture(t, first.name, "export const changed = true;\n".repeat(100));
  await publishRelease({ ...first, manifest: await createManifest(first.source, "first") });
  const conflicting = await createManifest(changed.source, "second");
  await assert.rejects(publishRelease({ root: first.root, source: changed.source, manifest: conflicting }), /Immutable asset conflict/);
  assert.equal(await currentRelease(first.root), "first");
  assert.equal(await readFile(path.join(first.root, "shared/files/assets", first.name), "utf8"), first.content);
  assert.deepEqual(await readdir(path.join(first.root, "staging")), []);
});

test("damaged retained release or shared data cannot be activated and a lock is not stolen", async (t) => {
  const value = await fixture(t);
  const manifest = await createManifest(value.source, "first");
  await publishRelease({ ...value, manifest });
  await rm(path.join(value.root, "releases/first/files/favicon.svg"));
  await assert.rejects(activateRelease({ root: value.root, release: "first" }), /file list/);
  await writeFile(path.join(value.root, "releases/first/files/favicon.svg"), "<svg/>");
  await writeFile(path.join(value.root, "shared/files/assets", value.name), "tampered");
  await assert.rejects(activateRelease({ root: value.root, release: "first" }), /Shared immutable checksum/);
  await mkdir(path.join(value.root, ".publish-lock"));
  await assert.rejects(activateRelease({ root: value.root, release: "first" }), /already locked/);
  assert.equal(await currentRelease(value.root), "first");
});

test("Caddy transform changes only the selected proxy and preserves auth, headers, encode and other servers", async (t) => {
  const value = await fixture(t);
  const manifest = await createManifest(value.source, "first");
  const original = configFixture();
  const before = structuredClone(original);
  const changed = transformCaddyConfig(original, options(manifest));
  assert.deepEqual(original, before);
  assert.deepEqual(handles(changed).slice(0, 3), handles(original).slice(0, 3));
  const replacement = handles(changed)[3];
  assert.equal(replacement.handler, "subroute");
  assert.deepEqual(replacement.routes.at(-1).handle[0], handles(original)[3]);
  const restored = structuredClone(changed);
  handles(restored)[3] = replacement.routes.at(-1).handle[0];
  assert.deepEqual(restored, original);
  const index = replacement.routes[0];
  assert.deepEqual(index.match, [{ method: ["GET", "HEAD"], path: ["/", "/index.html"] }]);
  assert.equal(index.handle[0].response.set["Cache-Control"][0], "no-store");
  const assets = replacement.routes.find((route) => route.match?.[0].path.includes(`/assets/${value.name}`));
  assert.equal(assets.handle[0].response.set["Cache-Control"][0], "public, max-age=31536000, immutable");
  assert.equal(assets.handle.at(-1).root, "/srv/project/frontend/shared/files");
  assert.deepEqual(assets.handle.at(-1).precompressed_order, ["br", "gzip"]);
  assert.deepEqual(assets.handle.at(-1).precompressed, { br: {}, gzip: {} });
  assert.equal(replacement.routes.at(-2).handle[0].status_code, 404);
  const paths = replacement.routes.flatMap((route) => route.match?.[0].path ?? []);
  assert.ok(paths.includes("/assets/*") && paths.includes("/licenses/*"));
  assert.ok(!paths.some((entry) => /^\/(?:api|ws|image|preview)/.test(entry) || /\.(?:br|gz)$/.test(entry) || entry === "/manifest.json"));
});

test("Caddy keeps old immutable paths while root is a remote path and rejects ambiguous targets", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t, "entry-WxYz5678.js");
  await writeFile(path.join(first.source, "earlier-icon.svg"), "<svg/>");
  const one = await createManifest(first.source, "one");
  const two = await createManifest(second.source, "two");
  const original = configFixture();
  const changed = transformCaddyConfig(original, options(two, [one]));
  const paths = handles(changed)[3].routes.flatMap((route) => route.match?.[0].path ?? []);
  assert.ok(paths.includes(`/assets/${first.name}`));
  assert.ok(paths.includes(`/assets/${second.name}`));
  assert.ok(paths.includes("/earlier-icon.svg"));
  for (const override of [{ serverName: "missing" }, { upstreamDial: "wrong" }, { root: "/srv/{placeholder}" }, { root: "relative" }]) {
    assert.throws(() => transformCaddyConfig(original, { ...options(one), ...override }));
  }
  const duplicate = structuredClone(original);
  handles(duplicate).push(structuredClone(handles(duplicate)[3]));
  assert.throws(() => transformCaddyConfig(duplicate, options(one)), /found 2/);
  const mixed = structuredClone(original);
  handles(mixed)[3].upstreams.push({ dial: "other:80" });
  assert.throws(() => transformCaddyConfig(mixed, options(one)), /exactly/);
  assert.throws(() => transformCaddyConfig(changed, options(two)), /saved original/);
});

test("all Caddy static responses retain Node security headers without an outer headers handler", async (t) => {
  const value = await fixture(t);
  const manifest = await createManifest(value.source, "security-headers");
  const original = configFixture();
  handles(original).splice(1, 1);
  const changed = transformCaddyConfig(original, options(manifest));
  const runtime = {};
  installResponseRuntime(runtime);
  const expected = Object.entries(runtime.responseHeaders()).filter(([name]) => name !== "Cache-Control");
  const replacement = handles(changed).at(-1);
  for (const route of replacement.routes.slice(0, -1)) {
    const handler = route.handle[0];
    const headers = handler.handler === "headers" ? handler.response.set : handler.headers;
    for (const [name, value] of expected) assert.deepEqual(headers[name], [value], `${route.match[0].path}: ${name}`);
  }
  assert.equal(replacement.routes.at(-2).handle[0].status_code, 404);
  assert.equal(replacement.routes.at(-2).handle[0].headers["Cache-Control"][0], "no-store");
  assert.deepEqual(handles(changed).slice(0, -1), handles(original).slice(0, -1));
  const restored = structuredClone(changed);
  handles(restored)[handles(restored).length - 1] = replacement.routes.at(-1).handle[0];
  assert.deepEqual(restored, original);
});

test("CLI creates the upload manifest, publishes, verifies and generates remote Caddy JSON locally", async (t) => {
  const value = await fixture(t);
  const manifestFile = path.join(value.directory, "release.json");
  const configFile = path.join(value.directory, "original.json");
  const outputFile = path.join(value.directory, "caddy.json");
  const cli = path.resolve("scripts/frontend-release/cli.mjs");
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" }));
  assert.equal(run("manifest", "--source", value.source, "--release", "cli-one", "--output", manifestFile).ok, true);
  assert.equal(run("verify", "--source", value.source, "--manifest", manifestFile).ok, true);
  assert.equal(run("publish", "--source", value.source, "--manifest", manifestFile, "--root", value.root).release, "cli-one");
  await writeFile(configFile, JSON.stringify(configFixture()));
  assert.equal(run("caddy", "--config", configFile, "--server", "project", "--upstream", "127.0.0.1:19000", "--root", "/srv/project/frontend", "--manifest", manifestFile, "--output", outputFile).ok, true);
  assert.equal(run("status", "--root", value.root).current, "cli-one");
  assert.ok((await readFile(outputFile, "utf8")).includes("/srv/project/frontend/shared/files"));
});

function python(args, success = true) {
  const result = spawnSync("python3", [path.resolve("scripts/frontend-release/remote.py"), ...args], { encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, success ? 0 : 1, result.stderr || result.stdout);
  const output = JSON.parse(success ? result.stdout : result.stderr);
  assert.equal(output.ok, success);
  return output;
}

async function uploadBundle(value, release) {
  const manifest = await createManifest(value.source, release);
  const root = path.join(value.directory, "upload-stage");
  await stageRelease({ root, source: value.source, manifest });
  return { bundle: path.join(root, "releases", release), manifest };
}

test("Python installer accepts Node bundles, stages, installs and rolls back without deleting generations", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t, "entry-PqRs3456.js", "export const second = true;\n".repeat(100));
  const one = await uploadBundle(first, "python-one");
  const two = await uploadBundle(second, "python-two");
  assert.equal(python(["verify", "--bundle", one.bundle]).artifactSha256, one.manifest.artifactSha256);
  python(["stage", "--bundle", one.bundle, "--root", first.root]);
  assert.equal(await currentRelease(first.root), null);
  assert.equal(python(["install", "--bundle", one.bundle, "--root", first.root]).previousRelease, null);
  assert.equal(python(["install", "--bundle", two.bundle, "--root", first.root]).previousRelease, "python-one");
  assert.equal(python(["rollback", "--root", first.root, "--release", "python-one"]).previousRelease, "python-two");
  assert.equal(await currentRelease(first.root), "python-one");
  for (const value of [first, second]) {
    assert.equal(await readFile(path.join(first.root, "shared/files/assets", value.name), "utf8"), value.content);
  }
  // The Node verifier/activator can consume Python-installed directories as well.
  assert.equal((await activateRelease({ root: first.root, release: "python-two" })).previousRelease, "python-one");
  assert.equal((await stat(path.join(first.root, "releases/python-one/files/index.html"))).mode & 0o777, 0o644);
  assert.deepEqual((await listReleases(first.root)).map((entry) => entry.release), ["python-one", "python-two"]);
  const oldIcon = path.join(first.root, "releases/python-one/files/favicon.svg");
  await rm(oldIcon);
  assert.match(python(["rollback", "--root", first.root, "--release", "python-one"], false).error, /file list differs/);
  await writeFile(oldIcon, "<svg/>");
  await writeFile(path.join(first.root, "shared/files/assets", first.name), "tampered shared bytes");
  assert.match(python(["rollback", "--root", first.root, "--release", "python-one"], false).error, /checksum mismatch/);
  assert.equal(await currentRelease(first.root), "python-two");
});

test("Python rejects tampered uploads, manifest escapes, checksum changes and symlinks while preserving current", async (t) => {
  const good = await fixture(t);
  const next = await fixture(t, "entry-TuVw7890.js");
  const first = await uploadBundle(good, "good");
  const upload = await uploadBundle(next, "candidate");
  python(["install", "--bundle", first.bundle, "--root", good.root]);
  const manifestPath = path.join(upload.bundle, "manifest.json");
  const assetPath = path.join(upload.bundle, "files/assets", next.name);
  const reject = (pattern) => assert.match(python(["install", "--bundle", upload.bundle, "--root", good.root], false).error, pattern);
  await writeFile(assetPath, "tampered");
  reject(/checksum mismatch/);
  await writeFile(assetPath, next.content);
  for (const unsafe of ["../escape.js", "/absolute.js", "assets/../../escape.js", "assets\\escape.js", "assets/escape.js\n", "api/private.json"]) {
    const bad = structuredClone(upload.manifest);
    bad.files[0].path = unsafe;
    bad.artifactSha256 = sha256(JSON.stringify(bad.files));
    await writeFile(manifestPath, JSON.stringify(bad));
    reject(/Unsafe artifact path|Not a public build artifact/);
  }
  await writeFile(manifestPath, JSON.stringify({ ...upload.manifest, artifactSha256: "0".repeat(64) }));
  reject(/Manifest checksum mismatch/);
  await writeFile(manifestPath, JSON.stringify(upload.manifest));
  await writeFile(path.join(upload.bundle, "files/extra.txt"), "unlisted");
  reject(/file list differs/);
  await rm(path.join(upload.bundle, "files/extra.txt"));
  await rm(assetPath);
  await symlink(path.join(next.source, "assets", next.name), assetPath);
  reject(/Symbolic links/);
  assert.equal(await currentRelease(good.root), "good");
  assert.deepEqual((await listReleases(good.root)).map((entry) => entry.release), ["good"]);
});

test("Python rejects immutable collisions and invalid rollback targets without changing the pointer", async (t) => {
  const good = await fixture(t);
  const changed = await fixture(t, good.name, "export const collision = true;\n".repeat(100));
  const first = await uploadBundle(good, "good");
  const conflicting = await uploadBundle(changed, "conflict");
  python(["install", "--bundle", first.bundle, "--root", good.root]);
  assert.match(python(["install", "--bundle", conflicting.bundle, "--root", good.root], false).error, /Immutable asset conflict/);
  assert.equal(await readFile(path.join(good.root, "shared/files/assets", good.name), "utf8"), good.content);
  assert.match(python(["rollback", "--root", good.root, "--release", "../escape"], false).error, /Invalid release ID/);
  await rm(path.join(good.root, "releases/good/files/favicon.svg"));
  assert.match(python(["rollback", "--root", good.root, "--release", "good"], false).error, /file list differs/);
  assert.equal(await currentRelease(good.root), "good");
  assert.deepEqual(await readdir(path.join(good.root, "staging")), []);
});
