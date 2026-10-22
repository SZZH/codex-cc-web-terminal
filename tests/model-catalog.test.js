import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { getAppServerModelCatalog, getCachedAppServerModels, normalizeAppServerModel } from "../src/sessions/shared/appServerModelCatalog.js";
import { handleConfigRoute } from "../src/routes/config.js";
import { SessionManager } from "../src/sessionManager.js";
import { normalizeCodexComposerPatch, normalizeReasoningEffort } from "../src/sessions/shared/composerOptions.js";
import { createBaseConfig, login, startTestServer } from "./helpers/backendTestUtils.js";

const model = (slug, extra = {}) => ({ id: `id-${slug}`, model: slug, displayName: `Display ${slug}`, ...extra });
const settleCatalog = () => new Promise((resolve) => setImmediate(resolve));

test("standard app-server model schema keeps only declared capabilities and no invented defaults", () => {
  assert.deepEqual(normalizeAppServerModel(model("current", {
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }, { reasoningEffort: "high" }],
    defaultReasoningEffort: "high", inputModalities: ["text", "image", "image"], isDefault: true
  })), {
    value: "current", label: "Display current", capabilitiesKnown: true,
    supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "high", inputModalities: ["text", "image"], isDefault: true
  });
  const unknownCapabilities = normalizeAppServerModel(model("minimal"));
  assert.equal(Object.hasOwn(unknownCapabilities, "defaultReasoningEffort"), false);
  assert.equal(Object.hasOwn(unknownCapabilities, "supportedReasoningEfforts"), false);
  assert.equal(Object.hasOwn(unknownCapabilities, "inputModalities"), false);
  assert.equal(normalizeAppServerModel(model("hidden", { hidden: true })), null);
});

test("live model catalog fetches all pages, removes duplicates and hides unavailable entries", async () => {
  const requests = [];
  const bridge = {
    async ensureReady() { requests.push("ready"); },
    async request(method, params) {
      requests.push({ method, params });
      return params.cursor === "second"
        ? { data: [model("first"), model("second")], nextCursor: null }
        : { data: [model("first"), model("hidden", { hidden: true })], nextCursor: "second" };
    }
  };
  const result = await getAppServerModelCatalog({ bridge });
  assert.deepEqual(result.models.map((item) => item.value), ["first", "second"]);
  assert.equal(result.status, "ready");
  assert.equal(result.source, "app_server");
  assert.equal(result.error, null);
  assert.deepEqual(requests, ["ready", { method: "model/list", params: { limit: 100 } }, { method: "model/list", params: { limit: 100, cursor: "second" } }]);
});

test("parallel config readers coalesce requests and expired catalogs refresh in the background", async () => {
  let calls = 0;
  let nowMs = 1000;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const bridge = { async request() { calls += 1; await gate; return { data: [model(`version-${calls}`)] }; } };
  const options = { bridge, now: () => nowMs, ttlMs: 60_000 };
  const first = getAppServerModelCatalog(options);
  const second = getAppServerModelCatalog(options);
  release();
  assert.deepEqual((await first).models, (await second).models);
  assert.equal(calls, 1);
  nowMs += 59_999;
  await getAppServerModelCatalog(options);
  assert.equal(calls, 1);
  nowMs += 1;
  const stale = await getAppServerModelCatalog(options);
  assert.equal(stale.models[0].value, "version-1");
  assert.equal(stale.status, "stale");
  assert.equal(stale.refreshing, true);
  assert.equal(calls, 2);
  await settleCatalog();
  const refreshed = await getAppServerModelCatalog(options);
  assert.equal(refreshed.models[0].value, "version-2");
  assert.equal(refreshed.status, "ready");
  assert.equal(refreshed.refreshing, false);
});

test("cold catalog readers wait for the complete real catalog and coalesce without returning fallback models", async (t) => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release({ data: [] }));
  const bridge = { request() { calls += 1; return gate; } };
  const options = { bridge, fallbackModels: [{ value: "local-fallback" }] };
  let firstSettled = false;
  let secondSettled = false;
  const first = getAppServerModelCatalog(options).then((catalog) => { firstSettled = true; return catalog; });
  const second = getAppServerModelCatalog(options).then((catalog) => { secondSettled = true; return catalog; });
  await settleCatalog();
  assert.equal(firstSettled, false);
  assert.equal(secondSettled, false);
  assert.equal(calls, 1);
  assert.equal(getCachedAppServerModels(bridge), null);
  release({ data: [model("real", { supportedReasoningEfforts: ["low", "ultra"], defaultReasoningEffort: "ultra", inputModalities: ["text", "image"], isDefault: true })] });
  const [result, duplicate] = await Promise.all([first, second]);
  assert.equal(result.status, "ready");
  assert.equal(result.refreshing, false);
  assert.deepEqual(result.models.map((item) => item.value), ["real"]);
  assert.deepEqual(result.models, duplicate.models);
  assert.notEqual(result.models, duplicate.models);
  assert.notEqual(result.models[0], duplicate.models[0]);
  assert.notEqual(result.models[0].inputModalities, duplicate.models[0].inputModalities);
});

test("expired complete catalogs return immediately during one pending refresh and publish isolated new capabilities", async (t) => {
  let nowMs = 1000;
  let calls = 0;
  let release;
  const bridge = { request() {
    calls += 1;
    if (calls === 1) return Promise.resolve({ data: [model("cached", {
      supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "high", inputModalities: ["text"], isDefault: true
    })] });
    return new Promise((resolve) => { release = resolve; });
  } };
  t.after(() => release?.({ data: [] }));
  const options = { bridge, now: () => nowMs, ttlMs: 100, fallbackModels: [{ value: "local-fallback" }] };
  const initial = await getAppServerModelCatalog(options);
  nowMs += 100;
  const catalogs = [];
  const readers = Array.from({ length: 3 }, (_, index) => getAppServerModelCatalog({ ...options, configuredModels: [`custom-${index}`] })
    .then((catalog) => { catalogs.push(catalog); return catalog; }));
  await settleCatalog();
  assert.equal(catalogs.length, 3, "a cached response must settle before the upstream refresh finishes");
  assert.equal(calls, 2);
  const [stale, duplicate] = await Promise.all(readers);
  assert.equal(stale.status, "stale");
  assert.equal(stale.refreshing, true);
  assert.equal(stale.error, null);
  assert.equal(stale.updatedAt, initial.updatedAt);
  assert.equal(stale.source, "app_server");
  assert.deepEqual(stale.models.map((item) => item.value), ["cached", "custom-0"]);
  assert.deepEqual(duplicate.models.map((item) => item.value), ["cached", "custom-1"]);
  stale.models[0].label = "Changed by caller";
  stale.models[0].supportedReasoningEfforts.push("invented");
  stale.models[0].inputModalities.push("invented");
  stale.models.push({ value: "invented" });
  const cached = getCachedAppServerModels(bridge);
  assert.equal(cached[0].label, "Display cached");
  assert.deepEqual(cached[0].supportedReasoningEfforts, ["low", "high"]);
  assert.deepEqual(cached[0].inputModalities, ["text"]);
  assert.equal(cached.length, 1);
  assert.deepEqual(duplicate.models[0], cached[0]);
  nowMs += 25;
  release({ data: [model("new", { supportedReasoningEfforts: ["minimal", "ultra"], defaultReasoningEffort: "minimal", inputModalities: ["text", "image"], isDefault: false })] });
  await settleCatalog();
  const refreshed = await getAppServerModelCatalog(options);
  assert.equal(refreshed.status, "ready");
  assert.equal(refreshed.refreshing, false);
  assert.equal(refreshed.error, null);
  assert.equal(refreshed.updatedAt, new Date(nowMs).toISOString());
  assert.deepEqual(refreshed.models, [{ value: "new", label: "Display new", capabilitiesKnown: true,
    supportedReasoningEfforts: ["minimal", "ultra"], defaultReasoningEffort: "minimal", inputModalities: ["text", "image"], isDefault: false }]);
  refreshed.models[0].supportedReasoningEfforts.push("invented");
  refreshed.models[0].inputModalities.push("invented");
  nowMs += 99;
  assert.deepEqual((await getAppServerModelCatalog(options)).models[0].inputModalities, ["text", "image"]);
  assert.equal(calls, 2);
  nowMs += 1;
  assert.equal((await getAppServerModelCatalog(options)).refreshing, true);
  assert.equal(calls, 3);
  release({ data: [model("next")] });
  await settleCatalog();
});

test("configured and current custom models remain visible without claiming server capabilities", async () => {
  const bridge = { async request() { return { data: [model("current", { supportedReasoningEfforts: ["high"] })] }; } };
  const result = await getAppServerModelCatalog({ bridge, configuredModels: ["private-custom", "private-custom", "current", "current-session"] });
  assert.deepEqual(result.models.map((item) => item.value), ["current", "private-custom", "current-session"]);
  assert.deepEqual(result.models[1], { value: "private-custom", label: "private-custom", capabilitiesKnown: false, catalogSource: "configured" });
  assert.equal(Object.hasOwn(result.models[2], "supportedReasoningEfforts"), false);
  result.models[0].supportedReasoningEfforts.push("invented");
  assert.deepEqual((await getAppServerModelCatalog({ bridge })).models[0].supportedReasoningEfforts, ["high"]);
});

test("repeated pagination cursors fail clearly without exposing a partial live catalog", async () => {
  let calls = 0;
  const bridge = { async request() { calls += 1; return { data: [model(`partial-${calls}`)], nextCursor: "repeat" }; } };
  const result = await getAppServerModelCatalog({ bridge, fallbackModels: [{ value: "old-cache", label: "Old cache" }] });
  assert.equal(calls, 2);
  assert.equal(result.status, "fallback");
  assert.equal(result.source, "local_fallback");
  assert.match(result.error, /repeated.*cursor/);
  assert.deepEqual(result.models.map((item) => item.value), ["old-cache"]);
});

test("failed refresh preserves the last complete live catalog with stale status and bounded retry", async () => {
  let nowMs = 10_000;
  let calls = 0;
  let failed = false;
  const bridge = { async request() { calls += 1; if (failed) throw new Error("Upstream model list is unavailable"); return { data: [model("supported-current")] }; } };
  const options = { bridge, now: () => nowMs, ttlMs: 100, fallbackModels: [{ value: "old-cache" }] };
  const first = await getAppServerModelCatalog(options);
  failed = true;
  nowMs += 100;
  const refreshing = await getAppServerModelCatalog(options);
  assert.equal(refreshing.status, "stale");
  assert.equal(refreshing.refreshing, true);
  assert.equal(refreshing.error, null);
  await settleCatalog();
  const stale = await getAppServerModelCatalog(options);
  assert.equal(stale.status, "stale");
  assert.equal(stale.refreshing, false);
  assert.equal(stale.source, "app_server");
  assert.match(stale.error, /unavailable/);
  assert.equal(stale.updatedAt, first.updatedAt);
  assert.deepEqual(stale.models.map((item) => item.value), ["supported-current"]);
  await getAppServerModelCatalog(options);
  assert.equal(calls, 2);
  nowMs += 5000;
  const retry = await getAppServerModelCatalog(options);
  assert.equal(retry.refreshing, true);
  assert.equal(retry.error, stale.error);
  assert.deepEqual(retry.models, stale.models);
  await settleCatalog();
  assert.equal(calls, 3);
  failed = false;
  nowMs += 5000;
  const recovering = await getAppServerModelCatalog(options);
  assert.equal(recovering.status, "stale");
  assert.equal(recovering.refreshing, true);
  assert.equal(recovering.error, stale.error);
  await settleCatalog();
  const recovered = await getAppServerModelCatalog(options);
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.refreshing, false);
  assert.equal(recovered.error, null);
  assert.equal(recovered.updatedAt, new Date(nowMs).toISOString());
  assert.equal(calls, 4);
});

test("a later pagination failure never replaces the last complete catalog with partial data", async () => {
  let nowMs = 10_000;
  let refreshing = false;
  const bridge = { async request(method, params) {
    if (!refreshing) return { data: [model("complete")] };
    if (params.cursor) throw new Error("Second page failed");
    return { data: [model("partial")], nextCursor: "later" };
  } };
  const options = { bridge, now: () => nowMs, ttlMs: 10 };
  await getAppServerModelCatalog(options);
  refreshing = true;
  nowMs += 10;
  const refreshingResult = await getAppServerModelCatalog(options);
  assert.equal(refreshingResult.status, "stale");
  assert.equal(refreshingResult.refreshing, true);
  await settleCatalog();
  const result = await getAppServerModelCatalog(options);
  assert.equal(result.status, "stale");
  assert.match(result.error, /Second page failed/);
  assert.deepEqual(result.models.map((item) => item.value), ["complete"]);
});

test("model count and pagination limits bound the cached catalog", async () => {
  const tooMany = await getAppServerModelCatalog({ bridge: { async request() {
    return { data: Array.from({ length: 513 }, (_, index) => model(`model-${index}`)) };
  } } });
  assert.equal(tooMany.status, "fallback");
  assert.match(tooMany.error, /supported size/);
  let pages = 0;
  const tooManyPages = await getAppServerModelCatalog({ bridge: { async request() {
    pages += 1;
    return { data: [], nextCursor: `page-${pages}` };
  } } });
  assert.equal(pages, 20);
  assert.match(tooManyPages.error, /pagination limit/);
});

test("invalid model/list schema and stalled requests report explicit fallback instead of fresh success", async () => {
  const invalid = await getAppServerModelCatalog({ bridge: { async request() { return { models: [model("wrong-envelope")] }; } } });
  assert.equal(invalid.status, "fallback");
  assert.match(invalid.error, /invalid model catalog/);
  const stalled = await getAppServerModelCatalog({ bridge: { request() { return new Promise(() => {}); } }, timeoutMs: 5 });
  assert.equal(stalled.status, "fallback");
  assert.match(stalled.error, /timed out/);
});

test("disabled app-server and stubs without request retain fallback without starting a service", async () => {
  const bridge = { async ensureReady() { assert.fail("Disabled bridge must not start"); }, async request() { assert.fail("Disabled bridge must not request"); } };
  const disabled = await getAppServerModelCatalog({ enabled: false, bridge, fallbackModels: [{ value: "local" }] });
  assert.equal(disabled.status, "fallback");
  assert.match(disabled.error, /disabled/);
  const stub = await getAppServerModelCatalog({ bridge: { async ensureReady() { assert.fail("Unsupported stub must not start"); } } });
  assert.equal(stub.source, "local_fallback");
});

test("config route overrides only Codex catalog and keeps configured/current models and status visible", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-catalog-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, "config.toml");
  fs.writeFileSync(configPath, 'model = "private-desktop-model"\n');
  const providers = [
    { id: "codex", defaultModel: "old-default", models: [{ value: "outdated-cache" }] },
    { id: "cc", defaultModel: "sonnet", models: [{ value: "sonnet" }] }
  ];
  let response;
  const runtime = {
    config: { codexConfigPath: configPath, codexAppServerEnabled: true },
    requireAuthorized: () => true,
    json(ctx, status, body) { response = { status, body }; },
    sessionManager: {
      providerCatalog: () => providers,
      listLiveSessions: () => [{ provider: "codex", model: "private-session-model" }, { provider: "cc", model: "unrelated" }],
      appServerBridge: { async request() { return { data: [model("live-current", { inputModalities: ["text", "image"] })] }; } }
    }
  };
  assert.equal(await handleConfigRoute({ path: "/api/config" }, runtime), true);
  assert.equal(response.status, 200);
  assert.equal(response.body.providers[0].defaultModel, "private-desktop-model");
  assert.deepEqual(response.body.providers[0].models.map((item) => item.value), ["live-current", "private-desktop-model", "old-default", "private-session-model"]);
  assert.deepEqual(response.body.providers[1], providers[1]);
  assert.deepEqual(providers[0].models, [{ value: "outdated-cache" }]);
  assert.equal(response.body.codexModelCatalog.status, "ready");
  assert.equal(Object.hasOwn(response.body.codexModelCatalog, "models"), false);
  assert.equal(Object.hasOwn(response.body.providers[0].models[1], "defaultReasoningEffort"), false);
});

test("unauthorized config requests never call app-server or expose its catalog", async () => {
  const runtime = { requireAuthorized: () => false, sessionManager: { providerCatalog() { assert.fail("Unauthorized catalog access"); } } };
  assert.equal(await handleConfigRoute({ path: "/api/config" }, runtime), true);
  assert.equal(await handleConfigRoute({ path: "/unrelated" }, runtime), false);
});

test("unknown model capabilities validate protocol efforts without silently lowering max or ultra", () => {
  for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) {
    assert.equal(normalizeReasoningEffort(effort), effort);
    assert.equal(normalizeCodexComposerPatch({ model: "custom", reasoningEffort: effort }).reasoningEffort, effort);
  }
  assert.throws(() => normalizeCodexComposerPatch({ model: "custom", reasoningEffort: "super" }), /does not support/);
  assert.deepEqual(normalizeCodexComposerPatch({ model: "custom-next" }, { model: "custom", reasoningEffort: "ultra" }), { model: "custom-next" });
  assert.throws(() => normalizeCodexComposerPatch({ model: "limited", reasoningEffort: "ultra" }, {}, [
    { value: "limited", supportedReasoningEfforts: ["low", "high"] }
  ]), /does not support/);
});

test("SessionManager creates and updates from the same live model capabilities as GET config", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-validation-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = createBaseConfig(root);
  fs.writeFileSync(config.codexModelsCachePath, JSON.stringify({ models: [
    { slug: "live-model", supported_reasoning_levels: [{ effort: "low" }], default_reasoning_level: "low" }
  ] }));
  const bridge = Object.assign(new EventEmitter(), { async request() { return { data: [
    model("live-model", { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultReasoningEffort: "medium" }),
    model("limited-model", { supportedReasoningEfforts: ["low"], defaultReasoningEffort: "low" })
  ] }; } });
  const manager = new SessionManager(config, { appServerBridge: bridge });
  assert.equal(getCachedAppServerModels(bridge), null);
  assert.deepEqual(manager.providerCatalog()[0].models[0].supportedReasoningEfforts, ["low"]);
  await getAppServerModelCatalog({ bridge });
  const cached = getCachedAppServerModels(bridge);
  assert.deepEqual(manager.providerCatalog()[0].models[0].supportedReasoningEfforts, ["low", "medium", "high", "xhigh", "max", "ultra"]);
  cached[0].supportedReasoningEfforts.push("invented");
  assert.equal(manager.providerCatalog()[0].models[0].supportedReasoningEfforts.includes("invented"), false);
  const created = manager.create({ model: "live-model", reasoningEffort: "max", cwd: root });
  assert.equal(created.reasoningEffort, "max");
  manager.updateSessionOptions(created.id, { reasoningEffort: "ultra" });
  assert.equal(manager.serialize(manager.get(created.id)).reasoningEffort, "ultra");
  assert.throws(() => manager.updateSessionOptions(created.id, { model: "limited-model", reasoningEffort: "ultra" }), /does not support/);
  assert.equal(manager.get(created.id).model, "live-model");
  assert.throws(() => manager.create({ model: "limited-model", reasoningEffort: "max", cwd: root }), /does not support/);
  const custom = manager.create({ model: "private-unknown", reasoningEffort: "ultra", cwd: root });
  manager.updateSessionOptions(custom.id, { reasoningEffort: "max" });
  assert.equal(manager.get(custom.id).reasoningEffort, "max");
  assert.throws(() => manager.updateSessionOptions(custom.id, { reasoningEffort: "invalid" }), /does not support/);
  manager.get(created.id).resumeSessionId = "live-model-thread";
  const server = await startTestServer({ sessionManager: manager, configOverrides: config });
  t.after(() => server.close());
  const { cookies } = await login(server.baseUrl, config.accessToken);
  const headers = { cookie: cookies, "content-type": "application/json" };
  const configResponse = await (await fetch(`${server.baseUrl}/api/config`, { headers })).json();
  assert.equal(configResponse.codexModelCatalog.source, "app_server");
  for (const effort of ["max", "ultra"]) {
    const url = `${server.baseUrl}/api/threads/codex/live-model-thread/composer-state`;
    const saved = await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ reasoningEffort: effort }) });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).reasoningEffort, effort);
    const reopened = await (await fetch(url, { headers })).json();
    assert.equal(reopened.reasoningEffort, effort);
  }
});
