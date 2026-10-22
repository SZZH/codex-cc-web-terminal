import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { permissionModeFromPolicy, permissionPolicyIsUnsupported } from "../src/sessions/shared/permissionPolicy.js";
import { parseHistoricalThreadComposerContext } from "../src/sessions/shared/historicalComposerState.js";
import { CodexThreadStateStore } from "../src/sessions/state/CodexThreadStateStore.js";

const special = (kind, access) => ({ path: { type: "special", value: { kind } }, access });
const absolute = (target, access) => ({ path: { type: "path", path: target }, access });
const managed = (entries, network = "restricted") => ({ type: "managed", file_system: { type: "restricted", entries }, network });
const readonly = managed([special("root", "read")], "enabled");
const workspace = managed([special("root", "read"), absolute("/workspace", "write"), special("slash_tmp", "write"), special("tmpdir", "write")]);
const full = { type: "managed", file_system: { type: "unrestricted" }, network: "enabled" };

test("desktop disabled sandbox storage preserves full access without accepting unknown restrictions", () => {
  assert.equal(permissionModeFromPolicy({ type: "disabled" }), "full-access");
  assert.equal(permissionPolicyIsUnsupported({ type: "disabled" }), false);
  assert.equal(permissionModeFromPolicy({ type: "disabled", network: "restricted" }), "default");
  assert.equal(permissionPolicyIsUnsupported({ type: "disabled", network: "restricted" }), true);
});

test("managed policy maps raw objects and JSON strings to three permission modes", () => {
  for (const [policy, mode] of [[readonly, "default"], [workspace, "auto-review"], [full, "full-access"]]) {
    assert.equal(permissionModeFromPolicy(policy, "/workspace"), mode);
    assert.equal(permissionModeFromPolicy(JSON.stringify(policy), "/workspace"), mode);
  }
});

test("legacy serialized and app-server policy names remain compatible", () => {
  for (const type of ["danger-full-access", "dangerFullAccess"]) assert.equal(permissionModeFromPolicy({ type }), "full-access");
  for (const type of ["workspace-write", "workspaceWrite"]) assert.equal(permissionModeFromPolicy({ type }), "auto-review");
  for (const type of ["read-only", "readOnly", "externalSandbox"]) assert.equal(permissionModeFromPolicy({ type }), "default");
});

test("restricted write grants never imply full access and denied scopes do not restore write access", () => {
  assert.equal(permissionModeFromPolicy(managed([special("root", "write")]), "/workspace"), "default");
  assert.equal(permissionModeFromPolicy(managed([absolute("/workspace", "write"), absolute("/workspace", "none")]), "/workspace"), "default");
  assert.equal(permissionModeFromPolicy(managed([absolute("/workspace/app", "write"), absolute("/workspace", "deny")]), "/workspace"), "default");
  assert.equal(permissionModeFromPolicy(managed([absolute("/workspace", "write"), special("root", "none")]), "/workspace"), "default");
  assert.equal(permissionModeFromPolicy(managed([absolute("/workspace", "write"), absolute("/private", "none")]), "/workspace"), "auto-review");
  assert.equal(permissionModeFromPolicy({ ...full, file_system: { type: "unrestricted", entries: [absolute("/private", "none")] } }), "default");
  assert.equal(permissionModeFromPolicy({ ...full, deny: ["/private"] }), "default");
  assert.equal(permissionModeFromPolicy({ ...full, deny: { "/private": "none" } }), "default");
  assert.equal(permissionModeFromPolicy({ type: "danger-full-access", file_system: { type: "restricted", entries: [absolute("/private", "none")] } }), "default");
  assert.equal(permissionModeFromPolicy({ ...full, file_system: { type: "unrestricted", future_limit: true } }), "default");
  assert.equal(permissionModeFromPolicy({ ...full, network: "restricted" }), "default");
});

test("managed workspace restoration requires full cwd coverage rather than a narrow file or subdirectory grant", () => {
  for (const scope of ["/workspace/allowed.txt", "/workspace/subdir", "/workspace-sibling"]) {
    assert.equal(permissionModeFromPolicy(managed([special("root", "read"), absolute(scope, "write")]), "/workspace"), "default", scope);
  }
  assert.equal(permissionModeFromPolicy(workspace), "default");
  assert.equal(permissionModeFromPolicy(workspace, "relative/workspace"), "default");
  assert.equal(permissionModeFromPolicy(workspace, "/workspace"), "auto-review");
  assert.equal(permissionModeFromPolicy(managed([absolute("/", "write")]), "/workspace"), "auto-review");
  for (const scope of ["cwd", "project_roots"]) {
    assert.equal(permissionModeFromPolicy(managed([special(scope, "write")]), "/workspace"), "auto-review");
  }
  for (const scope of ["slash_tmp", "tmpdir"]) {
    assert.equal(permissionModeFromPolicy(managed([special(scope, "write")]), "/workspace"), "default");
  }
});

test("intersecting child denies and unknown constraints cannot become whole-workspace write permission", () => {
  for (const deniedPath of ["/workspace", "/workspace/private.txt", "/workspace/subdir"]) {
    assert.equal(permissionModeFromPolicy(managed([absolute("/workspace", "write"), absolute(deniedPath, "none")]), "/workspace"), "default", deniedPath);
  }
  for (const policy of [
    { ...workspace, future_constraint: true },
    { ...workspace, file_system: { ...workspace.file_system, future_constraint: true } },
    managed([{ ...absolute("/workspace", "write"), future_constraint: true }]),
    managed([{ ...absolute("/workspace", "write"), missing_path_behavior: "deny" }]),
    managed([{ path: { type: "path", path: "/workspace", future_constraint: true }, access: "write" }])
  ]) assert.equal(permissionModeFromPolicy(policy, "/workspace"), "default");
});

test("known workspace network modes only narrow to disabled while unknown constraints remain default", () => {
  for (const network of ["enabled", "disabled", "restricted"]) {
    assert.equal(permissionModeFromPolicy(managed([absolute("/workspace", "write")], network), "/workspace"), "auto-review");
  }
  for (const network of [null, "future", { access: "restricted" }]) {
    assert.equal(permissionModeFromPolicy(managed([absolute("/workspace", "write")], network), "/workspace"), "default");
  }
});

test("unknown policy shapes, broken JSON and invalid write paths remain default", () => {
  for (const value of [null, [], "{", "null", "[]", { type: "unknown" }, { type: "managed" },
    { type: "managed", file_system: { type: "future" } }, managed([{ access: "write" }]),
    managed([absolute("relative/path", "write")]), managed([special("unknown", "write")]),
    managed([absolute("/workspace", "invented")]), { type: "managed", file_system: { type: "restricted", entries: {} } }]) {
    assert.equal(permissionModeFromPolicy(value), "default");
  }
});

test("unsupported policy classification blocks scope and network expansion while retaining normal modes", () => {
  const options = { cwd: "/workspace" };
  for (const policy of [readonly, workspace, full, { type: "read-only" }, { type: "read-only", network_access: true },
    { type: "workspace-write" }, { type: "danger-full-access" }]) {
    assert.equal(permissionPolicyIsUnsupported(policy, options), false);
    assert.equal(permissionPolicyIsUnsupported(JSON.stringify(policy), options), false);
  }
  for (const policy of [
    managed([special("root", "read"), absolute("/workspace/allowed.txt", "write")]),
    managed([special("root", "read"), absolute("/workspace/subdir", "write")]),
    managed([special("root", "read"), special("tmpdir", "write")]),
    managed([special("root", "read"), absolute("/workspace", "write"), absolute("/workspace/denied", "none")]),
    managed([special("root", "read"), absolute("/workspace", "write"), absolute("/private", "none")]),
    managed([absolute("/workspace", "write")]),
    managed([special("root", "read"), absolute("/workspace", "write"), absolute("/workspace/private", "read")]),
    { ...readonly, network: "restricted" }, { ...readonly, network: "disabled" },
    { ...full, network: undefined }, { ...full, fileSystem: { type: "restricted", entries: [] } },
    { type: "read-only", network_access: false }, { type: "readOnly", networkAccess: false },
    { type: "managed", future_constraint: true },
    { type: "managed", file_system: { type: "future", entries: [special("root", "read")] }, network: "enabled" }, "{"
  ]) assert.equal(permissionPolicyIsUnsupported(policy, options), true, JSON.stringify(policy));
  assert.equal(permissionPolicyIsUnsupported(managed([
    special("root", "read"), absolute("/workspace", "write"), absolute("/workspace/.git", "read")
  ]), options), false);
  for (const network of ["enabled", "restricted", "disabled"]) {
    assert.equal(permissionPolicyIsUnsupported({ ...workspace, network }, options), false);
  }
});

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-managed-permissions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "state.sqlite");
  execFileSync("sqlite3", [dbPath, "create table threads (id text primary key, cwd text, model text, reasoning_effort text, sandbox_policy text, approval_mode text, git_branch text, updated_at_ms integer, updated_at integer)"]);
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  return { root, dbPath, store: new CodexThreadStateStore({ codexStateDbPath: dbPath }), insert(id, policy, approval = "never") {
    const serialized = typeof policy === "string" ? policy : JSON.stringify(policy);
    execFileSync("sqlite3", [dbPath, `insert into threads values (${quote(id)},'/workspace','model','ultra',${quote(serialized)},${quote(approval)},'main',1700000000000,1700000000)`]);
  } };
}

test("SQLite managed permission readback survives service reconstruction without relying on approval never", (t) => {
  const { dbPath, store, insert } = createFixture(t);
  insert("full", full);
  insert("workspace", workspace, "on-request");
  insert("workspace-never", workspace);
  insert("readonly", readonly);
  insert("readonly-approval", readonly, "on-request");
  insert("broken", "{", "on-request");
  insert("unknown", { type: "future" }, "untrusted");
  insert("narrow-file", managed([absolute("/workspace/allowed.txt", "write")]));
  insert("narrow-subdir", managed([absolute("/workspace/subdir", "write")]));
  insert("denied-child", managed([absolute("/workspace", "write"), absolute("/workspace/denied", "none")]));
  insert("tmp-only", managed([special("tmpdir", "write")]));
  const expected = { full: "full-access", workspace: "auto-review", "workspace-never": "auto-review", readonly: "default", "readonly-approval": "manual-review", broken: "default", unknown: "default", "narrow-file": "default", "narrow-subdir": "default", "denied-child": "default", "tmp-only": "default" };
  for (const reader of [store, new CodexThreadStateStore({ codexStateDbPath: dbPath })]) {
    for (const [id, mode] of Object.entries(expected)) {
      const state = reader.getThreadComposerState(id);
      assert.equal(state?.permissionMode, mode, id);
      assert.equal(state?.reasoningEffort, "ultra");
      const unsupported = ["broken", "unknown", "narrow-file", "narrow-subdir", "denied-child", "tmp-only"].includes(id);
      assert.equal(Boolean(state?.permissionPolicyUnsupported), unsupported, id);
    }
  }
});

test("historical turn context shares managed and legacy parsing and updates incrementally", (t) => {
  const { root } = createFixture(t);
  const transcript = path.join(root, "history.jsonl");
  const context = (policy, approval = "never") => JSON.stringify({ type: "turn_context", payload: { cwd: "/workspace", model: "model", effort: "ultra", sandbox_policy: policy, approval_policy: approval } });
  fs.writeFileSync(transcript, `${context(full)}\n`);
  assert.equal(parseHistoricalThreadComposerContext(transcript)?.permissionMode, "full-access");
  fs.appendFileSync(transcript, `${context(JSON.stringify(workspace), "on-request")}\n`);
  assert.equal(parseHistoricalThreadComposerContext(transcript)?.permissionMode, "auto-review");
  fs.appendFileSync(transcript, `${context(readonly)}\n`);
  assert.equal(parseHistoricalThreadComposerContext(transcript)?.permissionMode, "default");
  fs.appendFileSync(transcript, `${context({ type: "danger-full-access" })}\n`);
  assert.equal(parseHistoricalThreadComposerContext(transcript)?.permissionMode, "full-access");
  fs.appendFileSync(transcript, `${context("{", "on-request")}\n`);
  assert.equal(parseHistoricalThreadComposerContext(transcript)?.permissionMode, "default");
  fs.appendFileSync(transcript, `${context(managed([absolute("/workspace/allowed.txt", "write")]))}\n`);
  assert.equal(parseHistoricalThreadComposerContext(transcript)?.permissionMode, "default");
  assert.equal(parseHistoricalThreadComposerContext(transcript)?.permissionPolicyUnsupported, true);
});

test("official workspace policy with generated credential-directory protection remains usable", () => {
  const policy = managed([
    special("root", "read"), absolute("/workspace", "write"), special("tmpdir", "write"),
    ...[".git", ".agents", ".codex", ".aws"].map((name) => ({ ...absolute(`/workspace/${name}`, "read"), missing_path_behavior: "skip" }))
  ], "restricted");
  assert.equal(permissionModeFromPolicy(policy, "/workspace"), "auto-review");
  assert.equal(permissionPolicyIsUnsupported(policy, { cwd: "/workspace" }), false);
  policy.file_system.entries.push(absolute("/workspace/private", "read"));
  assert.equal(permissionPolicyIsUnsupported(policy, { cwd: "/workspace" }), true);
});
