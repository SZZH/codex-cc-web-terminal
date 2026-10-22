import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CodexSidebarService } from "../src/sessions/history/CodexSidebarService.js";
import { buildDesktopSidebarSnapshot, desktopSidebarPreferences } from "../src/sessions/history/codexDesktopSidebar.js";
import { SessionManager } from "../src/sessionManager.js";
import { createBaseConfig, createTempDir } from "./helpers/backendTestUtils.js";

const thread = (id, extra = {}) => ({ id, cwd: "/workspace/a", title: `Title ${id}`, updated_at: 1700000000, source: "vscode", ...extra });
const project = (id, rootPaths = [`/workspace/${id}`]) => ({ id, name: `Project ${id}`, rootPaths });
const metadata = (extra = {}) => ({ "local-projects": { a: project("a"), b: project("b") }, "project-order": ["b", "a"], ...extra });
const ids = (group) => group.sessions.map((session) => session.resumeSessionId || session.id);
const group = (snapshot, id) => snapshot.projectGroups.find((item) => item.id === id);

function fixture(t, state, sql = "create table threads (id text primary key, cwd text, title text, updated_at integer, source text)") {
  const home = createTempDir();
  let service;
  t.after(async () => { await service?.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const config = createBaseConfig(home);
  config.codexGlobalStatePath = path.join(home, ".codex-global-state.json");
  config.codexStateDbPath = path.join(home, "state_5.sqlite");
  fs.writeFileSync(config.codexGlobalStatePath, JSON.stringify(state));
  execFileSync("sqlite3", [config.codexStateDbPath, sql]);
  service = new CodexSidebarService(config);
  return { home, config, service };
}

test("desktop projects keep IDs, names and unified ordering without injecting saved path groups", () => {
  const projects = Object.fromEntries(Array.from({ length: 29 }, (_, index) => {
    const id = index === 0 ? "c7e6c059-c92f-4cc0-b098-cda0c7026090" : `local-${index}`;
    return [id, { id, name: `Named ${index}`, rootPaths: [`/workspace/folder-${index}`] }];
  }));
  const state = metadata({
    "local-projects": projects,
    "project-order": Object.keys(projects),
    "electron-saved-workspace-roots": ["/workspace/legacy"],
    "electron-persisted-atom-state": { "unified-sidebar-project-order-v1": ["chatgpt:project:irrelevant", "codex:project:local-28", "codex:project:local-1"] }
  });
  const snapshot = buildDesktopSidebarSnapshot({ globalState: state });
  assert.equal(snapshot.projectGroups.length, 29);
  assert.deepEqual(snapshot.projectGroups.slice(0, 2).map((item) => item.projectId), ["local-28", "local-1"]);
  assert.equal(snapshot.projectGroups[0].name, "Named 28");
  assert.equal(snapshot.projectGroups.some((item) => item.name === "legacy"), false);
  assert.equal(new Set(snapshot.projectGroups.map((item) => item.id)).size, 29);
});

test("explicit membership beats cwd and projectless hints even for projects sharing roots", () => {
  const state = metadata({
    "local-projects": { a: project("a", ["/shared", "/second"]), b: project("b", ["/shared"]) },
    "thread-project-assignments": {
      moved: { projectKind: "local", projectId: "b" },
      explicit: { projectKind: "local", projectId: "a" },
      remote: { projectKind: "remote", projectId: "remote-a", hostId: "ssh-x" }
    },
    "projectless-thread-ids": ["projectless", "explicit"]
  });
  const snapshot = buildDesktopSidebarSnapshot({ globalState: state, threads: [
    thread("moved", { cwd: "/second" }), thread("explicit", { cwd: "/unrelated" }),
    thread("second", { cwd: "/second/child" }), thread("ambiguous", { cwd: "/shared" }),
    thread("projectless", { cwd: "/second" }), thread("remote", { cwd: "/second" })
  ] });
  assert.deepEqual(ids(group(snapshot, "project:b")), ["moved"]);
  assert.deepEqual(ids(group(snapshot, "project:a")), ["explicit", "second"]);
  assert.deepEqual(new Set(ids(group(snapshot, "recent:codex"))), new Set(["ambiguous", "projectless", "remote"]));
});

test("database project IDs resolve legacy migration aliases while pending null assignments keep global membership", () => {
  const state = metadata({
    "app-server-project-id-by-legacy-project-id-by-host": { "local:/codex-home": { a: "server-a", b: "server-b" } },
    "app-server-projects-migration-by-host": { "local:/codex-home": { threadAssignmentsMigrated: false, pendingThreadAssignmentIds: ["pending"] } },
    "thread-project-assignments": { pending: { projectKind: "local", projectId: "b" }, override: { projectKind: "local", projectId: "a" } }
  });
  const snapshot = buildDesktopSidebarSnapshot({ globalState: state, codexHome: "/codex-home", threads: [
    thread("pending", { project_id: null }), thread("database", { project_id: "server-b" }),
    thread("override", { project_id: "server-b" }), thread("missing-project", { project_id: "deleted-project" })
  ] });
  assert.deepEqual(ids(group(snapshot, "project:b")), ["pending", "database"]);
  assert.deepEqual(ids(group(snapshot, "project:a")), ["override"]);
  assert.deepEqual(ids(group(snapshot, "recent:codex")), ["missing-project"]);
});

test("desktop sidebar retains old CLI, appServer and exec threads and excludes hidden child work", () => {
  const snapshot = buildDesktopSidebarSnapshot({ globalState: metadata(), threads: [
    thread("cli", { source: "cli", updated_at: 1400000000 }), thread("exec", { source: "exec" }),
    thread("web", { source: "appServer" }), thread("archived", { archived: 1 }),
    thread("spawn", { source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "cli" } } }) }),
    thread("guardian", { source: JSON.stringify({ subagent: { other: "guardian" } }) }),
    thread("compact", { source: "subAgentCompact" }), thread("ambient", { thread_source: "ambient_suggestions" }),
    thread("ephemeral", { ephemeral: true }), thread("legacy-child", { agent_path: "/root/worker" }),
    thread("legacy-parent", { parent_thread_id: "cli" }), thread("thread-subagent", { thread_source: "subagent" }),
    thread("thread-guardian", { thread_source: "guardian_review" })
  ] });
  assert.deepEqual(ids(group(snapshot, "project:a")), ["exec", "web", "cli"]);
});

test("pinned membership is distinct from stale order entries and pinned threads appear only once", () => {
  const state = metadata({
    "pinned-thread-ids": ["first", "second"],
    "pinned-project-ids": ["a"],
    "electron-persisted-atom-state": {
      "unified-sidebar-pinned-order-v1": ["codex:thread:local:second", "codex:thread:local:stale", "codex:thread:local:first", "codex:project:b"]
    }
  });
  const snapshot = buildDesktopSidebarSnapshot({ globalState: state, threads: [thread("first"), thread("second"), thread("stale"), thread("regular")] });
  assert.deepEqual(snapshot.projectGroups.map((item) => item.id), ["pinned:codex", "project:a", "project:b"]);
  assert.deepEqual(ids(group(snapshot, "pinned:codex")), ["second", "first"]);
  assert.deepEqual(ids(group(snapshot, "project:a")), ["stale", "regular"]);
  assert.equal(snapshot.sessions.length, 4);
});

test("legacy preferences migrate to recency and versioned manual thread ordering remains valid", () => {
  const state = metadata({
    "sidebar-project-thread-orders": { a: { threadIds: ["older", "newer"] } },
    "electron-persisted-atom-state": { "flat-project-sidebar-preferences-v1": { projectSortMode: "manual", chatSortMode: "priority" } }
  });
  const threads = [thread("older", { updated_at_ms: 1700000000001 }), thread("newer", { updated_at_ms: 1700000000002 })];
  assert.deepEqual(ids(group(buildDesktopSidebarSnapshot({ globalState: state, threads }), "project:a")), ["newer", "older"]);
  state["electron-persisted-atom-state"]["flat-project-sidebar-preferences-v1"].manualSortVersion = 1;
  assert.deepEqual(ids(group(buildDesktopSidebarSnapshot({ globalState: state, threads }), "project:a")), ["older", "newer"]);
  state["electron-persisted-atom-state"]["codex-sidebar-sort-mode-v1"] = "manual";
  assert.equal(desktopSidebarPreferences(state).projects, "updated_at");
});

test("millisecond recency and canonical titles determine thread order without changing project order", () => {
  const snapshot = buildDesktopSidebarSnapshot({ globalState: metadata(), threads: [
    thread("older", { title: "Canonical old", updated_at_ms: 1700000000001, recency_at: 0, recency_at_ms: 0 }),
    thread("newer", { title: "Original prompt", name: "Canonical new", preview: "Preview", updated_at_ms: 1700000000002 })
  ] });
  assert.deepEqual(snapshot.projectGroups.map((item) => item.projectId), ["b", "a"]);
  assert.deepEqual(group(snapshot, "project:a").sessions.map((session) => [session.name, session.updatedAt]), [
    ["Canonical new", "2023-11-14T22:13:20.002Z"], ["Canonical old", "2023-11-14T22:13:20.001Z"]
  ]);
  assert.equal(group(snapshot, "project:a").sessions[0].inputPreview, "Preview");
  const withRecency = buildDesktopSidebarSnapshot({ globalState: metadata(), threads: [
    thread("touched", { updated_at_ms: 1700000000001, recency_at: 1700000001 }),
    thread("updated", { updated_at_ms: 1700000000999 })
  ] });
  assert.deepEqual(ids(group(withRecency, "project:a")), ["touched", "updated"]);
});

test("database pinning supplements global pinning while default zero does not erase legacy pins", () => {
  const snapshot = buildDesktopSidebarSnapshot({ globalState: metadata({ "pinned-thread-ids": ["global-pin"] }), threads: [
    thread("global-pin", { is_pinned: 0 }), thread("database-pin", { is_pinned: 1 }), thread("regular", { is_pinned: 0 })
  ] });
  assert.deepEqual(new Set(ids(group(snapshot, "pinned:codex"))), new Set(["global-pin", "database-pin"]));
  assert.deepEqual(ids(group(snapshot, "project:a")), ["regular"]);
});

test("live continuations retain authoritative membership and canonical titles and deduplicate by thread", () => {
  const state = metadata({ "thread-project-assignments": { existing: { projectKind: "local", projectId: "b" } } });
  const snapshot = buildDesktopSidebarSnapshot({ globalState: state, threads: [thread("existing"), thread("hidden", { archived: 1 })], liveSessions: [
    { id: "live-old", provider: "codex", resumeSessionId: "existing", name: "Runtime old", cwd: "/workspace/a", updatedAt: "2026-10-15T10:00:00.000Z" },
    { id: "live-new", provider: "codex", resumeSessionId: "existing", name: "Runtime new", cwd: "/workspace/a", updatedAt: "2026-10-15T11:00:00.000Z" },
    { id: "live-hidden", provider: "codex", resumeSessionId: "hidden", cwd: "/workspace/a" },
    { id: "new-pending", provider: "codex", projectId: "b", name: "Pending", cwd: "/workspace/a", updatedAt: "2026-10-15T12:00:00.000Z" }
  ] });
  assert.deepEqual(group(snapshot, "project:b").sessions.map((session) => session.id), ["new-pending", "live-new"]);
  assert.equal(group(snapshot, "project:b").sessions[1].name, "Title existing");
  assert.equal(snapshot.sessions.length, 2);
  assert.equal(group(snapshot, "project:a").sessions.length, 0);
});

test("read-only SQLite sidebar supports missing optional columns and an empty project registry", async (t) => {
  const { config, service } = fixture(t, metadata({ "local-projects": {} }), "create table threads (id text, title text, cwd text, updated_at integer); insert into threads values ('simple','Canonical','/outside',1700000000)");
  const before = fs.statSync(config.codexStateDbPath).mtimeMs;
  const snapshot = await service.getDesktopSnapshotAsync();
  assert.deepEqual(snapshot.projectGroups.map((item) => item.id), ["recent:codex"]);
  assert.equal(snapshot.sessions[0].name, "Canonical");
  assert.equal(snapshot.sidebarStatus.degraded, false);
  assert.equal(fs.statSync(config.codexStateDbPath).mtimeMs, before);
});

test("sidebar refresh reflects desktop metadata changes and SQLite title and archive changes", async (t) => {
  const { config, service } = fixture(t, metadata(), "create table threads (id text, title text, cwd text, updated_at_ms integer, archived integer); insert into threads values ('simple','Before','/workspace/a',1700000000000,0)");
  assert.equal(group(await service.getDesktopSnapshotAsync(), "project:a").sessions[0].name, "Before");
  const state = metadata({ "thread-project-assignments": { simple: { projectKind: "local", projectId: "b" } } });
  state["local-projects"].b.name = "Renamed project";
  fs.writeFileSync(config.codexGlobalStatePath, JSON.stringify(state));
  execFileSync("sqlite3", [config.codexStateDbPath, "update threads set title='After', updated_at_ms=1700000000123"]);
  const updated = await service.getDesktopSnapshotAsync();
  assert.equal(group(updated, "project:b").name, "Renamed project");
  assert.equal(group(updated, "project:b").sessions[0].name, "After");
  assert.equal(group(updated, "project:a").sessions.length, 0);
  execFileSync("sqlite3", [config.codexStateDbPath, "update threads set archived=1"]);
  assert.equal((await service.getDesktopSnapshotAsync()).sessions.length, 0);
});

test("database failure retains the previous snapshot with an explicit degraded status", async (t) => {
  const { config, service } = fixture(t, metadata(), "create table threads (id text, title text, cwd text); insert into threads values ('simple','Saved','/workspace/a')");
  assert.equal((await service.getDesktopSnapshotAsync()).sessions.length, 1);
  fs.writeFileSync(config.codexStateDbPath, "unreadable SQLite database");
  const snapshot = await service.getDesktopSnapshotAsync();
  assert.equal(snapshot.sessions[0].name, "Saved");
  assert.equal(snapshot.sidebarStatus.degraded, true);
  assert.equal(snapshot.sidebarStatus.warnings.length, 1);
});

test("a transient global metadata read failure keeps project identities and reports degradation", async (t) => {
  const { config, service } = fixture(t, metadata());
  assert.equal((await service.getDesktopSnapshotAsync()).projectGroups.length, 2);
  fs.writeFileSync(config.codexGlobalStatePath, "{");
  const snapshot = await service.getDesktopSnapshotAsync();
  assert.deepEqual(snapshot.projectGroups.map((item) => item.projectId), ["b", "a"]);
  assert.equal(snapshot.sidebarStatus.degraded, true);
});

test("modern manager lists directly from SQLite without invoking the rollout catalog", async (t) => {
  const { config } = fixture(t, metadata(), "create table threads (id text, title text, cwd text); insert into threads values ('simple','Fast sidebar','/workspace/a')");
  const manager = new SessionManager(config);
  t.after(() => manager.codexSidebarService.close());
  manager.listAll = () => { throw new Error("Rollout scan must not run"); };
  manager.historyService.listHistoricalSessions = () => { throw new Error("Rollout scan must not run"); };
  const snapshot = await manager.listSidebarSnapshotAsync();
  assert.equal(snapshot.sessions[0].name, "Fast sidebar");
  assert.equal(snapshot.sidebarStatus.source, "codex_desktop");
});

test("new sessions resolve canonical project IDs and keep same-root projects distinct without global writes", (t) => {
  const { config, home } = fixture(t, metadata());
  const state = metadata({
    "local-projects": { a: project("a", [home]), b: project("b", [home]) },
    "app-server-project-id-by-legacy-project-id-by-host": { [`local:${home}`]: { a: "server-a", b: "server-b" } }
  });
  fs.writeFileSync(config.codexGlobalStatePath, JSON.stringify(state));
  const before = fs.readFileSync(config.codexGlobalStatePath, "utf8");
  const manager = new SessionManager(config);
  const first = manager.create({ cwd: home, projectId: "a", name: "First" });
  const second = manager.create({ cwd: home, projectId: "b", name: "Second" });
  assert.equal(first.projectId, "server-a");
  assert.equal(second.projectId, "server-b");
  assert.throws(() => manager.create({ cwd: home, projectId: "no-such-project" }), /project is no longer available/);
  const snapshot = manager.listSidebarSnapshot();
  assert.deepEqual(group(snapshot, "project:a").sessions.map((session) => session.name), ["First"]);
  assert.deepEqual(group(snapshot, "project:b").sessions.map((session) => session.name), ["Second"]);
  assert.equal(fs.readFileSync(config.codexGlobalStatePath, "utf8"), before);
});
