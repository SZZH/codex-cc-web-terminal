import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCodexFollowUpQueueMode } from "../src/sessions/shared/codexFollowUpMode.js";
import { buildThreadComposerState } from "../src/routes/threadComposerState.js";
import { handleConfigRoute } from "../src/routes/config.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(t, source = "", initial = undefined) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-follow-up-mode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { codexAppServerEnabled: true, codexConfigPath: path.join(root, "config.toml"),
    codexGlobalStatePath: path.join(root, "global.json"), defaultCwd: root };
  fs.writeFileSync(config.codexConfigPath, source);
  fs.writeFileSync(config.codexGlobalStatePath, JSON.stringify({ "electron-initial-follow-up-queue-mode": initial }));
  return config;
}
function connected(request) {
  return { connected: true, initialized: true, connectionGeneration: 1, ws: { readyState: 1 }, request,
    ensureReady() { assert.fail("Reading a follow-up preference must not start an app-server"); } };
}

test("local follow-up preference reads only the desktop scalar and normalizes legacy values", async (t) => {
  const cases = [
    ['[desktop]\nfollowUpQueueMode = "queue"', "queue"],
    ['[desktop]\nfollowUpQueueMode = "steer"', "steer"],
    ["[desktop]\nfollowUpQueueMode = 'interrupt'", "steer"],
    ['desktop.followUpQueueMode = "queue" # active setting', "queue"],
    ['"desktop" . "followUpQueueMode" = "queue"', "queue"],
    ["[ 'desktop' ] # section\n'followUpQueueMode' = 'queue'", "queue"],
    ['followUpQueueMode = "queue"', "steer"],
    ['[profiles.work.desktop]\nfollowUpQueueMode = "queue"', "steer"],
    ['[other]\ndesktop.followUpQueueMode = "queue"', "steer"],
    ['[[desktop]]\nfollowUpQueueMode = "queue"', "steer"],
    ['# [desktop]\n# followUpQueueMode = "queue"', "steer"],
    ['[desktop]\nfollowUpQueueMode = "invalid"', "steer"],
    ['[desktop]\nfollowUpQueueMode = false', "steer"],
    ['[desktop]\nother = "followUpQueueMode = \\"queue\\""', "steer"],
    ['instructions = """\n[desktop]\nfollowUpQueueMode = "queue"\n"""', "steer"],
    ["instructions = '''\n[desktop]\nfollowUpQueueMode = 'queue'\n'''", "steer"],
    ['[desktop]\nfollowUpQueueMode = "steer"\n[other]\nfollowUpQueueMode = "queue"', "steer"]
  ];
  for (const [source, expected] of cases) {
    await t.test(source.split("\n").join(" / "), async (t) => {
      assert.equal(await readCodexFollowUpQueueMode({ config: fixture(t, source) }), expected);
    });
  }
});

test("local preference outranks the initialization cache and unreadable files use the official default", async (t) => {
  const config = fixture(t, '[desktop]\nfollowUpQueueMode = "steer"', "queue");
  assert.equal(await readCodexFollowUpQueueMode({ config }), "steer");
  fs.writeFileSync(config.codexConfigPath, '[other]\nfollowUpQueueMode = "steer"');
  assert.equal(await readCodexFollowUpQueueMode({ config }), "queue");
  fs.rmSync(config.codexConfigPath);
  assert.equal(await readCodexFollowUpQueueMode({ config }), "queue");
  fs.writeFileSync(config.codexGlobalStatePath, "invalid JSON");
  assert.equal(await readCodexFollowUpQueueMode({ config }), "steer");
  assert.equal(await readCodexFollowUpQueueMode(), "steer");
});

test("effective config overrides the local base per cwd and returns only the normalized preference", async (t) => {
  const config = fixture(t, '[desktop]\nfollowUpQueueMode = "queue"');
  const calls = [];
  const bridge = connected(async (method, params, options) => {
    calls.push({ method, params, options });
    return { config: { desktop: { followUpQueueMode: params.cwd === "/profile" ? "interrupt" : "queue" },
      get api_key() { assert.fail("Other configuration must not be read"); } }, layers: [{ sensitive: "never return" }] };
  });
  assert.equal(await readCodexFollowUpQueueMode({ config, bridge, cwd: "/profile" }), "steer");
  assert.equal(await readCodexFollowUpQueueMode({ config, bridge, cwd: "/other" }), "queue");
  assert.deepEqual(calls.map(({ method, params }) => ({ method, params })), [
    { method: "config/read", params: { includeLayers: false, cwd: "/profile" } },
    { method: "config/read", params: { includeLayers: false, cwd: "/other" } }
  ]);
  assert.equal(calls.every(({ options }) => options.signal instanceof AbortSignal), true);
});

test("disconnected, uninitialized, closed, and disabled bridges only read local settings", async (t) => {
  const config = fixture(t, '[desktop]\nfollowUpQueueMode = "queue"');
  for (const patch of [{ connected: false }, { initialized: false }, { ws: { readyState: 3 } }]) {
    const bridge = Object.assign(connected(() => assert.fail("Unavailable bridge must not receive reads")), patch);
    assert.equal(await readCodexFollowUpQueueMode({ config, bridge }), "queue");
  }
  const bridge = connected(() => assert.fail("Disabled app-server must not receive reads"));
  assert.equal(await readCodexFollowUpQueueMode({ config: { ...config, codexAppServerEnabled: false }, bridge }), "queue");
});

test("concurrent reads share one RPC, expire after five seconds, and invalidate on reconnect", async (t) => {
  const config = fixture(t);
  let now = 100;
  t.mock.method(Date, "now", () => now);
  const gate = deferred();
  let count = 0;
  const bridge = connected(async () => { count += 1; return count === 1 ? gate.promise : { config: { desktop: { followUpQueueMode: "steer" } } }; });
  const reads = [readCodexFollowUpQueueMode({ config, bridge }), readCodexFollowUpQueueMode({ config, bridge })];
  await tick();
  assert.equal(count, 1);
  gate.resolve({ config: { desktop: { followUpQueueMode: "queue" } } });
  assert.deepEqual(await Promise.all(reads), ["queue", "queue"]);
  now += 4_999;
  assert.equal(await readCodexFollowUpQueueMode({ config, bridge }), "queue");
  assert.equal(count, 1);
  now += 1;
  assert.equal(await readCodexFollowUpQueueMode({ config, bridge }), "steer");
  assert.equal(count, 2);
  bridge.connectionGeneration += 1;
  bridge.ws = { readyState: 1 };
  assert.equal(await readCodexFollowUpQueueMode({ config, bridge }), "steer");
  assert.equal(count, 3);
});

test("unavailable or invalid effective values fall back without retaining secrets or repeated failures", async (t) => {
  const config = fixture(t, '[desktop]\nfollowUpQueueMode = "queue"');
  for (const value of [undefined, "unknown", {}, 1]) {
    const bridge = connected(async () => ({ config: { desktop: { followUpQueueMode: value } } }));
    assert.equal(await readCodexFollowUpQueueMode({ config, bridge }), "queue");
  }
  let count = 0;
  const bridge = connected(() => { count += 1; throw new Error("sensitive configuration error"); });
  assert.equal(await readCodexFollowUpQueueMode({ config, bridge }), "queue");
  fs.writeFileSync(config.codexConfigPath, '[desktop]\nfollowUpQueueMode = "steer"');
  assert.equal(await readCodexFollowUpQueueMode({ config, bridge }), "steer");
  assert.equal(count, 1);
});

test("stalled configuration reads abort after three seconds and cannot overwrite a later refresh", async (t) => {
  const config = fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100 });
  const gate = deferred();
  let signal;
  let count = 0;
  const bridge = connected((method, params, options) => {
    signal = options.signal;
    count += 1;
    return count === 1 ? gate.promise : { config: { desktop: { followUpQueueMode: "steer" } } };
  });
  const pending = readCodexFollowUpQueueMode({ config, bridge });
  await tick();
  t.mock.timers.tick(3_000);
  assert.equal(await pending, "steer");
  assert.equal(signal.aborted, true);
  gate.resolve({ config: { desktop: { followUpQueueMode: "queue" } } });
  await tick();
  assert.equal(await readCodexFollowUpQueueMode({ config, bridge }), "steer");
  assert.equal(count, 1);
  t.mock.timers.tick(5_000);
  assert.equal(await readCodexFollowUpQueueMode({ config, bridge }), "steer");
  assert.equal(count, 2);
});

test("a read from a disconnected generation cannot publish its preference", async (t) => {
  const config = fixture(t);
  const gate = deferred();
  const bridge = connected(() => gate.promise);
  const pending = readCodexFollowUpQueueMode({ config, bridge });
  await tick();
  bridge.connectionGeneration += 1;
  gate.resolve({ config: { desktop: { followUpQueueMode: "queue" } } });
  assert.equal(await pending, "steer");
});

test("Codex composer settings expose the effective preference using the thread cwd without model or Git reads", async (t) => {
  const config = fixture(t, '[desktop]\nfollowUpQueueMode = "queue"');
  const calls = [];
  const runtime = { config, sessionManager: {
    providerCatalog: () => [],
    findLiveSessionByThreadId: () => ({ cwd: "/thread-cwd", model: "model" }),
    appServerBridge: connected(async (method, params) => {
      calls.push({ method, params });
      return { config: { desktop: { followUpQueueMode: "steer" }, secret: "not exposed" } };
    })
  } };
  const state = await buildThreadComposerState(runtime, { listGitBranches() { assert.fail("git=0 must not query Git"); } }, "codex", "thread", { includeGit: false });
  assert.equal(state.followUpQueueMode, "steer");
  assert.equal(state.cwd, "/thread-cwd");
  assert.equal(Object.hasOwn(state, "git"), false);
  assert.equal(JSON.stringify(state).includes("not exposed"), false);
  assert.deepEqual(calls, [{ method: "config/read", params: { includeLayers: false, cwd: "/thread-cwd" } }]);
});

test("config route reads the preference alongside the model catalog and exposes only its scalar", async (t) => {
  const config = fixture(t, '[desktop]\nfollowUpQueueMode = "queue"');
  const gate = deferred();
  const calls = [];
  const bridge = connected(async (method) => {
    calls.push(method);
    return method === "model/list" ? gate.promise : { config: { desktop: { followUpQueueMode: "steer" }, secret: "not exposed" } };
  });
  // The pre-existing catalog reader owns connection initialization, independent of preference reads.
  bridge.ensureReady = async () => {};
  let response;
  const runtime = { config, requireAuthorized: () => true, json(ctx, status, body) { response = { status, body }; },
    sessionManager: { appServerBridge: bridge, providerCatalog: () => [{ id: "codex", models: [] }] } };
  const pending = handleConfigRoute({ path: "/api/config" }, runtime);
  await tick();
  assert.deepEqual(calls.sort(), ["config/read", "model/list"]);
  gate.resolve({ data: [], nextCursor: null });
  assert.equal(await pending, true);
  assert.equal(response.body.codexFollowUpQueueMode, "steer");
  assert.equal(response.status, 200);
  assert.equal(Object.hasOwn(response.body.codexDefaults, "followUpQueueMode"), false);
  assert.equal(JSON.stringify(response.body).includes("not exposed"), false);
});
