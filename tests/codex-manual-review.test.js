import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { compileScript, parse } from "vue/compiler-sfc";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import pty from "node-pty";

import { AppServerBridge } from "../src/appServerBridge.js";
import { SessionManager } from "../src/sessionManager.js";
import { buildCodexJsonExecArgs } from "../src/sessions/runners/codexRunner.js";
import { normalizePermissionMode, buildCodexPermissionArgs } from "../src/sessions/shared/composerOptions.js";
import * as permissionPolicy from "../src/sessions/shared/permissionPolicy.js";
import { parseHistoricalThreadComposerContext } from "../src/sessions/shared/historicalComposerState.js";
import { writeCodexDesktopPermissionMode } from "../src/sessions/shared/codexDesktopConfig.js";
import { CodexThreadStateStore } from "../src/sessions/state/CodexThreadStateStore.js";
import * as composer from "../web/src/lib/composer.js";
import { createBaseConfig } from "./helpers/backendTestUtils.js";

const modes = ["default", "manual-review", "auto-review", "full-access"];
const rootRead = { path: { type: "special", value: { kind: "root" } }, access: "read" };
const managedRead = { type: "managed", network: "enabled", file_system: { type: "restricted", entries: [rootRead] } };
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

function fixture(t) {
  const root = fs.mkdtempSync("/tmp/codex-r22-manual-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = createBaseConfig(root, {
    codexGlobalStatePath: path.join(root, "desktop.json"),
    codexConfigPath: path.join(root, "config.toml")
  });
  fs.writeFileSync(config.codexGlobalStatePath, '{"electron-persisted-atom-state":{"agent-mode":"full-access"}}');
  execFileSync("sqlite3", [config.codexStateDbPath, `
    create table threads (id text primary key, cwd text, model text, reasoning_effort text,
      sandbox_policy text, approval_mode text, git_branch text, updated_at integer, updated_at_ms integer);
    insert into threads values ('a', ${quote(root)}, 'test-model', 'high', '{"type":"read-only"}', 'never', '', 1, 1);
    insert into threads values ('b', ${quote(root)}, 'test-model', 'high', '{"type":"read-only"}', 'never', '', 1, 1);
  `]);
  return { root, config, store: new CodexThreadStateStore(config) };
}

class RecordingBridge extends AppServerBridge {
  requests = [];
  async ensureReady() {}
  request(method, params) {
    this.requests.push({ method, params });
    return Promise.resolve(method === "thread/start" ? { thread: { id: "created" } } : { turn: { items: [] } });
  }
}

test("manual-review is explicit read-only/on-request/user for start, resume and every turn", async (t) => {
  const { root, config } = fixture(t);
  const bridge = new RecordingBridge(config);
  t.after(() => bridge.shutdown());
  assert.equal(normalizePermissionMode("manual-review"), "manual-review");
  assert.deepEqual(buildCodexPermissionArgs("manual-review"), ["--sandbox", "read-only", "-c", 'approval_policy="on-request"', "-c", 'approvals_reviewer="user"']);
  const session = { cwd: root, model: "test-model", permissionMode: "manual-review" };
  for (const mode of ["manual-review", "auto-review", "manual-review", "default", "full-access"]) {
    session.permissionMode = mode;
    await bridge.startTurn(session, "fixture only");
    const [thread, turn] = bridge.requests.slice(-2);
    assert.equal(thread.method, bridge.requests.length === 2 ? "thread/start" : "thread/resume");
    const sandbox = mode === "full-access" ? "danger-full-access" : mode === "auto-review" ? "workspace-write" : "read-only";
    const policy = ["manual-review", "auto-review"].includes(mode) ? "on-request" : "never";
    const reviewer = mode === "auto-review" ? "auto_review" : "user";
    assert.equal(thread.params.sandbox, sandbox);
    for (const params of [thread.params, turn.params]) {
      assert.equal(params.approvalPolicy, policy);
      assert.equal(params.approvalsReviewer, reviewer);
    }
    if (mode === "manual-review") assert.deepEqual(turn.params.sandboxPolicy, {
      type: "readOnly", access: { type: "fullAccess" }, networkAccess: true
    });
  }
});

test("all four stored modes reopen independently without changing other threads or desktop bytes", (t) => {
  const { config, store } = fixture(t);
  const desktopBefore = fs.readFileSync(config.codexGlobalStatePath);
  for (const permissionMode of modes) {
    assert.equal(store.patchThreadComposerState("a", { permissionMode }).permissionMode, permissionMode);
    assert.equal(new CodexThreadStateStore(config).getThreadComposerState("a").permissionMode, permissionMode);
    assert.equal(store.getThreadComposerState("b").permissionMode, "default");
    assert.deepEqual(fs.readFileSync(config.codexGlobalStatePath), desktopBefore);
    const [row] = JSON.parse(execFileSync("sqlite3", ["-json", config.codexStateDbPath,
      "select sandbox_policy, approval_mode from threads where id='a'"], { encoding: "utf8" }));
    assert.equal(JSON.parse(row.sandbox_policy).type,
      permissionMode === "full-access" ? "danger-full-access" : permissionMode === "auto-review" ? "workspace-write" : "read-only");
    assert.equal(row.approval_mode, ["auto-review", "manual-review"].includes(permissionMode) ? "on-request" : "never");
  }
});

test("only supported complete read-only policies plus exact on-request restore manual mode", () => {
  for (const policy of [{ type: "read-only" }, { type: "readOnly", networkAccess: true }, managedRead]) {
    assert.equal(permissionPolicy.permissionModeFromPolicy(policy, "/workspace"), "default");
    for (const value of [policy, JSON.stringify(policy)]) {
      assert.equal(permissionPolicy.permissionModeFromStoredPolicy(value, { cwd: "/workspace", approvalPolicy: "on-request" }), "manual-review");
      for (const approvalPolicy of [undefined, null, "", "never", "untrusted", "future", { granular: {} }]) {
        assert.equal(permissionPolicy.permissionModeFromStoredPolicy(value, { cwd: "/workspace", approvalPolicy }), "default");
      }
    }
  }
  for (const policy of [null, "{", { type: "future" }, { type: "read-only", future: true },
    { type: "read-only", networkAccess: false }, { type: "read-only", networkAccess: null },
    { type: "read-only", access: { type: "fullAccess", future: true } },
    { ...managedRead, deny: ["/workspace/private"] }, { ...managedRead, network: "disabled" },
    { ...managedRead, file_system: { type: "restricted", entries: [{ ...rootRead, access: "none" }] } },
    { ...managedRead, file_system: { type: "restricted", entries: [{ path: { type: "path", path: "/workspace/subdir" }, access: "read" }] } }
  ]) assert.equal(permissionPolicy.permissionModeFromStoredPolicy(policy, { cwd: "/workspace", approvalPolicy: "on-request" }), "default");
  assert.equal(permissionPolicy.permissionModeFromStoredPolicy({ type: "workspace-write" }, { approvalPolicy: "never" }), "auto-review");
});

test("SQLite and rollout share approval-aware decoding and keep unsupported state blocked", (t) => {
  const { root, config, store } = fixture(t);
  const file = path.join(root, "rollout.jsonl");
  const cases = [
    ...modes.map((mode) => [mode === "full-access" ? { type: "danger-full-access" } : mode === "auto-review"
      ? { type: "workspace-write" } : { type: "read-only", network_access: true },
    ["auto-review", "manual-review"].includes(mode) ? "on-request" : "never", mode, false]),
    [managedRead, "on-request", "manual-review", false],
    [{ type: "read-only" }, undefined, "default", false],
    [{ type: "read-only" }, "future", "default", false],
    [{ ...managedRead, network: "disabled" }, "on-request", "default", true],
    [{ ...managedRead, file_system: { type: "restricted", entries: [rootRead,
      { path: { type: "path", path: path.join(root, "only.txt") }, access: "write" }] } }, "on-request", "default", true]
  ];
  for (const [sandbox, approval, expected, unsupported] of cases) {
    execFileSync("sqlite3", [config.codexStateDbPath,
      `update threads set sandbox_policy=${quote(JSON.stringify(sandbox))}, approval_mode=${approval == null ? "null" : quote(approval)} where id='a'`]);
    fs.writeFileSync(file, `${JSON.stringify({ type: "turn_context", payload: {
      cwd: root, sandbox_policy: sandbox, ...(approval == null ? {} : { approval_policy: approval })
    } })}\n`);
    for (const state of [store.getThreadComposerState("a"), parseHistoricalThreadComposerContext(file)]) {
      assert.equal(state.permissionMode, expected);
      assert.equal(Boolean(state.permissionPolicyUnsupported), unsupported);
    }
  }
});

test("manual desktop writes do no I/O and preserve existing desktop data", (t) => {
  const { config } = fixture(t);
  const before = fs.readFileSync(config.codexGlobalStatePath);
  const statBefore = fs.statSync(config.codexGlobalStatePath, { bigint: true });
  const fail = () => { throw new Error("manual mode must not access desktop files"); };
  const mocks = ["existsSync", "readFileSync", "mkdirSync", "writeFileSync"].map((method) => t.mock.method(fs, method, fail));
  try { writeCodexDesktopPermissionMode(config, "manual-review"); }
  finally { mocks.forEach((mock) => mock.mock.restore()); }
  assert.deepEqual(fs.readFileSync(config.codexGlobalStatePath), before);
  assert.equal(fs.statSync(config.codexGlobalStatePath, { bigint: true }).mtimeNs, statBefore.mtimeNs);
});

test("CC create/update and json_exec reject manual mode before spawning or changing settings", async (t) => {
  const { config } = fixture(t);
  const bridge = new EventEmitter();
  const manager = new SessionManager(config, { appServerBridge: bridge });
  t.after(async () => { manager.shutdown(); await manager.codexSidebarService.close(); });
  let spawns = 0;
  t.mock.method(pty, "spawn", () => { spawns += 1; throw new Error("must reject before spawn"); });
  for (const provider of ["cc", "claude"]) {
    assert.throws(() => manager.create({ provider, permissionMode: "manual-review" }), /人工审批/);
    const session = { provider: "cc", permissionMode: "default", model: "sonnet" };
    assert.throws(() => manager.updateSessionOptions(session, { permissionMode: "manual-review" }), /人工审批/);
    assert.equal(session.permissionMode, "default");
  }
  assert.equal(spawns, 0);
  assert.throws(() => buildCodexJsonExecArgs(manager, { permissionMode: "manual-review" }, "fixture only"), /人工审批/);
  const session = { provider: "codex", runnerMode: "json_exec", permissionMode: "default", model: "gpt-5" };
  assert.throws(() => manager.updateSessionOptions(session, { permissionMode: "manual-review" }), /人工审批/);
  assert.equal(session.permissionMode, "default");
  manager.config.codexAppServerEnabled = false;
  assert.throws(() => manager.create({ permissionMode: "manual-review" }), /人工审批/);
  assert.equal(manager.sessions.size, 0);
});

const sourceUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const slotStub = sourceUrl('export default { inheritAttrs: false, emits: ["close"], setup(_, { slots }) { return () => slots.default?.(); } };');
const markerStub = sourceUrl(`import { h } from ${JSON.stringify(import.meta.resolve("vue"))};
  export default { props: ["permissionModeOptions"], setup(props) {
    return () => h("output", {}, JSON.stringify(props.permissionModeOptions?.map((option) => option.value) || []));
  } };`);

async function component(relativePath, stubName = "") {
  const file = new URL(`../web/src/components/${relativePath}.vue`, import.meta.url);
  const { descriptor } = parse(fs.readFileSync(file, "utf8"), { filename: file.pathname });
  const source = compileScript(descriptor, { id: file.pathname, inlineTemplate: true }).content
    .replace(/from\s+["']([^"']+)["']/g, (_, name) => `from ${JSON.stringify(!name.startsWith(".") ? import.meta.resolve(name)
      : name.endsWith(".vue") ? name.includes(stubName) && stubName ? markerStub : slotStub : new URL(name, file).href)}`);
  return (await import(sourceUrl(source))).default;
}

test("V2 four choices are opt-in and three SFC layers preserve the legacy default", async () => {
  const original = ["default", "auto-review", "full-access"];
  assert.deepEqual(composer.PERMISSION_MODE_OPTIONS.map((option) => option.value), original);
  assert.deepEqual(composer.CODEX_PERMISSION_MODE_OPTIONS?.map((option) => option.value), modes);
  const props = { composerOptions: composer.createComposerOptions({ permissionMode: "manual-review" }),
    gitState: composer.createWorkspaceGitState(), models: [], showPermissionMode: true };
  const Settings = await component("composer/ComposerSettings");
  const legacy = await renderToString(createSSRApp({ render: () => h(Settings, props) }));
  const opted = await renderToString(createSSRApp({ render: () => h(Settings, { ...props,
    permissionModeOptions: composer.CODEX_PERMISSION_MODE_OPTIONS }) }));
  assert.doesNotMatch(legacy, /人工审批/);
  assert.match(opted, /aria-pressed="true"[^>]*>人工审批/);
  const hidden = await renderToString(createSSRApp({ render: () => h(Settings, {
    ...props, showPermissionMode: false, permissionModeOptions: composer.CODEX_PERMISSION_MODE_OPTIONS }) }));
  assert.doesNotMatch(hidden, /人工审批/);
  for (const [file, child] of [["ChatView", "ChatComposer"], ["composer/ChatComposer", "ComposerSettings"]]) {
    const Component = await component(file, child);
    for (const options of [undefined, composer.CODEX_PERMISSION_MODE_OPTIONS]) {
      const rendered = await renderToString(createSSRApp({ render: () => h(Component, {
        ...props, ...(options ? { permissionModeOptions: options } : {}) }) }));
      assert.ok(rendered.includes(JSON.stringify(options ? modes : original).replaceAll('"', "&quot;")), file);
    }
  }
});
