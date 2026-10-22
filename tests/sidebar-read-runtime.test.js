import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { CodexSidebarService } from "../src/sessions/history/CodexSidebarService.js";
import { SessionManager } from "../src/sessionManager.js";
import { CommandError, createCommandRunner } from "../src/runtime/processes/command.js";
import { createKoaApp } from "../src/koa-app.js";
import { restoreSessionSidebarPayload } from "../web/src/lib/session-sidebar-payload.js";
import { createBaseConfig } from "./helpers/backendTestUtils.js";

const execute = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const state = () => ({ "local-projects": {
  a: { id: "a", name: "Alpha", rootPaths: ["/workspace/a"] },
  b: { id: "b", name: "Bravo", rootPaths: ["/workspace/b"] }
}, "project-order": ["a", "b"] });
const schema = "create table threads (id text primary key, cwd text, title text, updated_at integer, archived integer); insert into threads values ('simple','/workspace/a','Before',1700000000,0);";
async function until(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (check()) return; await delay(5); }
  assert.fail("Sidebar fixture did not reach the expected state");
}
async function fixture(t, readerOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sidebar-read-"));
  const config = createBaseConfig(root, { codexGlobalStatePath: path.join(root, "desktop.json") });
  await fs.writeFile(config.codexGlobalStatePath, JSON.stringify(state()));
  const sql = (text, db = config.codexStateDbPath) => execute("sqlite3", [db, text]);
  await sql(schema);
  const service = new CodexSidebarService(config, { readerOptions });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, config, service, sql, stats: () => service.readRuntime.getStats() };
}
async function sqliteConnection(t, db) {
  const child = spawn("sqlite3", [db], { stdio: ["pipe", "pipe", "pipe"] });
  let serial = 0;
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.stdin.end(".quit\n");
    const timer = setTimeout(() => child.kill("SIGKILL"), 200);
    try { await exited; } finally { clearTimeout(timer); }
  });
  const sql = (text) => new Promise((resolve, reject) => {
    const marker = "SIDEBAR_READY_" + ++serial;
    let output = "";
    const timer = setTimeout(() => finish(new Error("SQLite fixture readiness timed out")), 5000);
    function finish(error) { clearTimeout(timer); child.stdout.off("data", data); child.off("error", finish); error ? reject(error) : resolve(); }
    function data(chunk) { output += chunk; if (output.includes(marker)) finish(); }
    child.stdout.on("data", data); child.once("error", finish);
    child.stdin.write(text + ";\nselect '" + marker + "';\n");
  });
  return { child, sql };
}
function hookedRunner(hook) {
  const runner = createCommandRunner({ maxConcurrent: 2, maxQueued: 32 });
  return { ...runner, run: async (...args) => {
    const result = await runner.run(...args);
    await hook(args[1].at(-1), result, args[2]);
    return result;
  } };
}

test("concurrent sidebar reads coalesce and unchanged sources avoid JSON and SQLite reads", async (t) => {
  const f = await fixture(t);
  const snapshots = await Promise.all(Array.from({ length: 12 }, () => f.service.getDesktopSnapshotAsync()));
  assert(snapshots.every((snapshot) => snapshot.sessions[0].name === "Before"));
  assert.equal(f.stats().queries, 2);
  assert.equal(f.stats().globalReads, 1);
  await f.service.getDesktopSnapshotAsync();
  assert.equal(f.stats().queries, 2);
  assert.equal(f.stats().globalReads, 1);
  assert.equal(f.stats().pending, 0);
  assert.equal(f.stats().active, 0);
});

test("global same-size changes, ordering and pins refresh without rereading unchanged SQLite", async (t) => {
  const f = await fixture(t);
  await f.service.getDesktopSnapshotAsync();
  const before = await fs.stat(f.config.codexGlobalStatePath, { bigint: true });
  const updated = state(); updated["local-projects"].a.name = "Omega";
  await fs.writeFile(f.config.codexGlobalStatePath, JSON.stringify(updated));
  assert.equal((await fs.stat(f.config.codexGlobalStatePath, { bigint: true })).size, before.size);
  let snapshot = await f.service.getDesktopSnapshotAsync();
  assert.equal(snapshot.projectGroups.find((group) => group.projectId === "a").name, "Omega");
  assert.equal(f.stats().queries, 2);
  updated["project-order"] = ["b", "a"]; updated["pinned-thread-ids"] = ["simple"];
  await fs.writeFile(f.config.codexGlobalStatePath, JSON.stringify(updated));
  snapshot = await f.service.getDesktopSnapshotAsync();
  assert.deepEqual(snapshot.projectGroups.map((group) => group.id), ["pinned:codex", "project:b", "project:a"]);
  assert.equal(snapshot.projectGroups[0].sessions[0].resumeSessionId, "simple");
  assert.equal(f.stats().queries, 2);
  assert.equal(f.stats().globalReads, 3);
});

test("SQLite same-size writes, schema changes, file replacement and initial absence invalidate their own source", async (t) => {
  const f = await fixture(t);
  await f.service.getDesktopSnapshotAsync();
  const before = await fs.stat(f.config.codexStateDbPath, { bigint: true });
  await f.sql("update threads set title='Newest'");
  assert.equal((await fs.stat(f.config.codexStateDbPath, { bigint: true })).size, before.size);
  assert.equal((await f.service.getDesktopSnapshotAsync()).sessions[0].name, "Newest");
  await f.sql("alter table threads add column name text; update threads set name='Canonical'");
  assert.equal((await f.service.getDesktopSnapshotAsync()).sessions[0].name, "Canonical");
  const replacement = path.join(f.root, "replacement.sqlite");
  await f.sql("create table threads (id text, cwd text, title text); insert into threads values ('replacement','/workspace/b','Replaced')", replacement);
  await fs.rename(replacement, f.config.codexStateDbPath);
  assert.equal((await f.service.getDesktopSnapshotAsync()).sessions[0].name, "Replaced");
  assert.equal(f.stats().globalReads, 1);
  assert.equal(f.stats().queries, 8);
  await fs.unlink(f.config.codexStateDbPath);
  const missing = await f.service.getDesktopSnapshotAsync();
  assert.equal(missing.sessions[0].name, "Replaced");
  assert.equal(missing.sidebarStatus.degraded, true);
  await f.sql(schema);
  assert.equal((await f.service.getDesktopSnapshotAsync()).sidebarStatus.degraded, false);
  const cold = new CodexSidebarService({ ...f.config, codexStateDbPath: path.join(f.root, "initially-missing.sqlite") });
  t.after(() => cold.close());
  assert.equal((await cold.getDesktopSnapshotAsync()).sidebarStatus.degraded, true);
  await f.sql(schema, cold.stateDbPath);
  assert.equal((await cold.getDesktopSnapshotAsync()).sessions[0].name, "Before");
});

test("WAL-only commits, checkpoint truncation and disappearance invalidate cached rows", async (t) => {
  const f = await fixture(t);
  const writer = await sqliteConnection(t, f.config.codexStateDbPath);
  await writer.sql("pragma journal_mode=WAL; pragma wal_autocheckpoint=0");
  await f.service.getDesktopSnapshotAsync();
  const mainBefore = await fs.stat(f.config.codexStateDbPath, { bigint: true });
  await writer.sql("update threads set title='Newest'");
  const mainAfter = await fs.stat(f.config.codexStateDbPath, { bigint: true });
  assert.deepEqual([mainAfter.size, mainAfter.mtimeNs, mainAfter.ctimeNs], [mainBefore.size, mainBefore.mtimeNs, mainBefore.ctimeNs]);
  assert.equal((await f.service.getDesktopSnapshotAsync()).sessions[0].name, "Newest");
  assert.equal(f.stats().queries, 4);
  await writer.sql("pragma wal_checkpoint(TRUNCATE)");
  assert.equal((await fs.stat(f.config.codexStateDbPath + "-wal")).size, 0);
  await f.service.getDesktopSnapshotAsync();
  assert.equal(f.stats().queries, 6);
  const exited = once(writer.child, "exit"); writer.child.stdin.end(".quit\n"); await exited;
  await assert.rejects(fs.stat(f.config.codexStateDbPath + "-wal"), { code: "ENOENT" });
  assert.equal((await f.service.getDesktopSnapshotAsync()).sessions[0].name, "Newest");
  assert.equal(f.stats().queries, 8);
  assert.equal(f.stats().globalReads, 1);
});

test("JSON, stat and SQLite failures preserve identities and remain retryable", async (t) => {
  let failStat = false;
  const fileSystem = { ...fs, stat: async (...args) => {
    if (failStat) throw Object.assign(new Error("stat fixture"), { code: "EACCES" });
    return fs.stat(...args);
  } };
  const f = await fixture(t, { fileSystem });
  await f.service.getDesktopSnapshotAsync();
  await fs.writeFile(f.config.codexGlobalStatePath, "{");
  let snapshot = await f.service.getDesktopSnapshotAsync();
  assert.equal(snapshot.projectGroups[0].id, "project:a");
  assert.equal(snapshot.sessions[0].name, "Before");
  assert.equal(snapshot.sidebarStatus.degraded, true);
  await fs.writeFile(f.config.codexGlobalStatePath, JSON.stringify(state()));
  assert.equal((await f.service.getDesktopSnapshotAsync()).sidebarStatus.degraded, false);
  failStat = true;
  snapshot = await f.service.getDesktopSnapshotAsync();
  assert.equal(snapshot.sessions[0].name, "Before");
  assert.equal(snapshot.sidebarStatus.warnings.length, 2);
  failStat = false;
  assert.equal((await f.service.getDesktopSnapshotAsync()).sidebarStatus.degraded, false);
  const saved = await fs.readFile(f.config.codexStateDbPath);
  await fs.writeFile(f.config.codexStateDbPath, "invalid database");
  snapshot = await f.service.getDesktopSnapshotAsync();
  assert.equal(snapshot.sessions[0].name, "Before");
  assert.equal(snapshot.sidebarStatus.degraded, true);
  const failedQueries = f.stats().queries;
  await f.service.getDesktopSnapshotAsync();
  assert.equal(f.stats().queries, failedQueries + 1);
  await fs.writeFile(f.config.codexStateDbPath, saved);
  assert.equal((await f.service.getDesktopSnapshotAsync()).sidebarStatus.degraded, false);
});

test("initially absent project metadata can recover without caching a failed source", async (t) => {
  const f = await fixture(t);
  await fs.unlink(f.config.codexGlobalStatePath);
  assert.equal(await f.service.getDesktopSnapshotAsync(), null);
  assert.match(f.service.lastGlobalReadError, /could not be read/);
  await fs.writeFile(f.config.codexGlobalStatePath, JSON.stringify(state()));
  assert.equal((await f.service.getDesktopSnapshotAsync()).projectGroups[0].id, "project:a");
  assert.equal(f.service.lastGlobalReadError, "");
});

test("spawn, output limit and invalid SQLite JSON failures never poison a previous successful snapshot", async (t) => {
  let failure = "";
  const core = createCommandRunner();
  const runner = { ...core, run: async (...args) => {
    if (failure === "SPAWN" || failure === "OUTPUT_LIMIT") throw new CommandError("query fixture", { code: "PROCESS_COMMAND_" + failure });
    const result = await core.run(...args);
    return failure === "JSON" ? { ...result, stdout: "{" } : result;
  } };
  const f = await fixture(t, { runner });
  await f.service.getDesktopSnapshotAsync();
  for (const mode of ["SPAWN", "OUTPUT_LIMIT", "JSON"]) {
    await f.sql("update threads set title='Newest'");
    failure = mode;
    const snapshot = await f.service.getDesktopSnapshotAsync();
    assert.equal(snapshot.sessions[0].name, "Before");
    assert.equal(snapshot.sidebarStatus.degraded, true);
    failure = "";
    await f.sql("update threads set title='Before'");
    assert.equal((await f.service.getDesktopSnapshotAsync()).sidebarStatus.degraded, false);
  }
});

test("an unstable JSON read is not cached as the newer file version", async (t) => {
  let f, changed = false;
  const fileSystem = { ...fs, readFile: async (...args) => {
    const value = await fs.readFile(...args);
    if (!changed) { changed = true; const next = state(); next["local-projects"].a.name = "Omega"; await fs.writeFile(f.config.codexGlobalStatePath, JSON.stringify(next)); }
    return value;
  } };
  f = await fixture(t, { fileSystem });
  assert.equal((await f.service.getDesktopSnapshotAsync()).projectGroups[0].name, "Alpha");
  assert.equal((await f.service.getDesktopSnapshotAsync()).projectGroups[0].name, "Omega");
  assert.equal(f.stats().globalReads, 2);
  assert.equal(f.stats().queries, 2);
});

test("rows changed after SELECT are not cached under the newer database signature", async (t) => {
  let f, changed = false;
  const runner = hookedRunner(async (sql) => {
    if (sql.startsWith("select") && !changed) { changed = true; await f.sql("update threads set title='Newest'"); }
  });
  f = await fixture(t, { runner });
  assert.equal((await f.service.getDesktopSnapshotAsync()).sessions[0].name, "Before");
  assert.equal((await f.service.getDesktopSnapshotAsync()).sessions[0].name, "Newest");
  assert.equal(f.stats().queries, 4);
});

for (const kind of ["global", "threads"]) {
  for (const asyncFails of [false, true]) {
    for (const syncFails of [false, true]) {
      test(`old ${kind} async ${asyncFails ? "failure" : "success"} cannot replace a newer sync ${syncFails ? "failure" : "success"}`, async (t) => {
        const entered = deferred(), release = deferred();
        let held = false;
        const hold = async () => { if (!held) { held = true; entered.resolve(); await release.promise; if (asyncFails) throw new Error("old read fixture"); } };
        const fileSystem = { ...fs, readFile: async (...args) => { const value = await fs.readFile(...args); if (kind === "global") await hold(); return value; } };
        const runner = hookedRunner(async (sql) => { if (kind === "threads" && sql.startsWith("select")) await hold(); });
        const f = await fixture(t, { fileSystem, runner });
        const loadSync = () => kind === "global" ? f.service.loadGlobalState() : f.service.loadThreads();
        const current = () => kind === "global" ? [f.service.lastGlobalState, f.service.lastGlobalReadError] : [f.service.lastThreads, f.service.lastReadError];
        loadSync();
        const pending = kind === "global" ? f.service.readRuntime.readGlobal() : f.service.readRuntime.readThreads();
        try {
          await entered.promise;
          if (kind === "global") { const next = state(); next["local-projects"].a.name = "Omega"; await fs.writeFile(f.config.codexGlobalStatePath, syncFails ? "{" : JSON.stringify(next)); }
          else if (syncFails) await fs.writeFile(f.config.codexStateDbPath, "invalid database");
          else await f.sql("update threads set title='Newest'");
          loadSync();
          const expected = current();
          assert.equal(Boolean(expected[1]), syncFails);
          release.resolve(); await pending;
          assert.deepEqual(current(), expected);
          if (!syncFails) assert.equal(kind === "global" ? current()[0]["local-projects"].a.name : current()[0][0].title, kind === "global" ? "Omega" : "Newest");
        } finally { release.resolve(); await pending; }
      });
    }
  }
}

test("the shared SQLite deadline spans both commands and rejects a late schema result before SELECT", async (t) => {
  const deadlines = [];
  const core = createCommandRunner();
  const runner = { ...core, run: async (_file, _args, options) => {
    deadlines.push(options.deadline);
    await delay(100);
    return { stdout: '[{"name":"id"}]' };
  } };
  const f = await fixture(t, { runner, timeoutMs: 80 });
  const snapshot = await f.service.getDesktopSnapshotAsync();
  assert.equal(snapshot.sidebarStatus.degraded, true);
  assert.match(f.service.lastReadError, /timed out/);
  assert.equal(deadlines.length, 1);
  assert.equal(f.stats().queries, 1);
});

for (const kind of ["global", "threads"]) {
  test(`an obsolete ${kind} read cannot replace a newer async publication or evict its cache`, async (t) => {
    const entered = deferred(), release = deferred();
    let held = false;
    const hold = async () => { if (!held) { held = true; entered.resolve(); await release.promise; } };
    const fileSystem = { ...fs, readFile: async (...args) => { const value = await fs.readFile(...args); if (kind === "global") await hold(); return value; } };
    const runner = hookedRunner(async (sql) => { if (kind === "threads" && sql.startsWith("select")) await hold(); });
    const f = await fixture(t, { fileSystem, runner });
    const read = () => kind === "global" ? f.service.readRuntime.readGlobal() : f.service.readRuntime.readThreads();
    const old = read();
    try {
      await entered.promise;
      if (kind === "global") {
        const next = state(); next["local-projects"].a.name = "Omega";
        await fs.writeFile(f.config.codexGlobalStatePath, JSON.stringify(next));
        f.service.loadGlobalState();
      } else {
        await f.sql("update threads set title='Newest'");
        f.service.loadThreads();
      }
      await read();
      const expectedCounts = f.stats();
      release.resolve(); await old;
      await read();
      assert.equal(kind === "global" ? f.service.lastGlobalState["local-projects"].a.name : f.service.lastThreads[0].title, kind === "global" ? "Omega" : "Newest");
      assert.equal(f.stats().queries, expectedCounts.queries);
      assert.equal(f.stats().globalReads, expectedCounts.globalReads);
      assert.equal(f.stats().pending, 0);
    } finally { release.resolve(); await old; }
  });
}

test("superseded source tasks have an admission bound and close awaits their actual cleanup", async (t) => {
  const release = deferred();
  const fileSystem = { ...fs, stat: async (...args) => { await release.promise; return fs.stat(...args); } };
  const f = await fixture(t, { fileSystem });
  const reads = [];
  try {
    for (let index = 0; index < 32; index += 1) {
      f.service.readRuntime.invalidate("global");
      reads.push(f.service.readRuntime.readGlobal());
    }
    f.service.readRuntime.invalidate("global");
    await f.service.readRuntime.readGlobal();
    assert.equal(f.stats().pending, 32);
    assert.match(f.service.lastGlobalReadError, /could not be read/);
    let closed = false;
    const closing = f.service.close().then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false);
    release.resolve();
    await closing;
    const results = await Promise.allSettled(reads);
    assert(results.every((result) => result.status === "rejected" && result.reason.code === "PROCESS_COMMAND_ABORTED"));
    assert.equal(f.stats().pending, 0);
    assert.equal(f.stats().active, 0);
  } finally { release.resolve(); await Promise.allSettled(reads); }
});

test("a failed WAL stat cannot let close outrun the still-pending main database stat", async (t) => {
  const entered = deferred(), release = deferred();
  const fileSystem = { ...fs, stat: async (file, ...args) => {
    if (file.endsWith("-wal")) throw Object.assign(new Error("WAL stat fixture"), { code: "EACCES" });
    entered.resolve(); await release.promise;
    return fs.stat(file, ...args);
  } };
  const f = await fixture(t, { fileSystem });
  const reading = f.service.readRuntime.readThreads();
  try {
    await entered.promise;
    let closed = false;
    const closing = f.service.close().then(() => { closed = true; });
    await delay(10);
    assert.equal(closed, false);
    release.resolve();
    await closing;
    await assert.rejects(reading, { code: "PROCESS_COMMAND_ABORTED" });
    assert.equal(f.stats().pending, 0);
  } finally { release.resolve(); await Promise.allSettled([reading]); }
});

test("cold manager assembly uses the latest live sessions and never falls back to synchronous SQLite", async (t) => {
  const entered = deferred(), release = deferred();
  const runner = hookedRunner(async (sql) => { if (sql.startsWith("select")) { entered.resolve(); await release.promise; } });
  const f = await fixture(t, { runner });
  const manager = new SessionManager(f.config); manager.codexSidebarService = f.service;
  let live = [];
  manager.listLiveSessions = () => live;
  manager.listAll = () => assert.fail("Modern list must not scan history");
  f.service.loadThreads = () => assert.fail("Async list must not use sync SQLite");
  const pending = manager.listSidebarSnapshotAsync();
  try {
    await entered.promise;
    live = [{ id: "live-new", provider: "codex", projectId: "b", name: "Live", cwd: "/workspace/b", updatedAt: "2026-10-18T00:00:00.000Z" }];
    release.resolve();
    assert((await pending).sessions.some((session) => session.id === "live-new"));
    live = [];
    assert(!(await manager.listSidebarSnapshotAsync()).sessions.some((session) => session.id === "live-new"));
    assert.equal(f.stats().queries, 2);
  } finally { release.resolve(); await pending; }
});

test("legacy manager fallback uses async project reads while retaining grouped history", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.config.codexGlobalStatePath, JSON.stringify({ "project-order": ["/workspace/a"] }));
  const manager = new SessionManager(f.config); manager.codexSidebarService = f.service;
  manager.listAll = () => [{ id: "history:cc:old", provider: "cc", resumeSessionId: "old", cwd: "/workspace/a", updatedAt: "2020-01-01T00:00:00.000Z" }];
  manager.listProjectGroups = () => assert.fail("Async fallback must not use sync groups");
  f.service.loadThreads = () => assert.fail("Async fallback must not use sync SQLite");
  const snapshot = await manager.listSidebarSnapshotAsync();
  assert(snapshot.sessions.some((session) => session.id === "history:cc:old"));
  assert.equal(snapshot.projectGroups[0].projectRoot, "/workspace/a");
});

test("HTTP 200/304 and compact lists reuse sources while preserving latest activity decoration", async (t) => {
  const f = await fixture(t);
  const manager = new SessionManager(f.config); manager.codexSidebarService = f.service;
  let activityState = "idle";
  const { app, runtime } = createKoaApp({ config: f.config, sessionManager: manager,
    codexThreads: { getThreadActivity: () => ({ activityState }) } });
  runtime.requireAuthorized = () => true;
  const server = http.createServer(app.callback());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await runtime.closeWorkspace(); });
  const url = "http://127.0.0.1:" + server.address().port + "/api/sessions";
  const first = await fetch(url), expected = await first.json();
  const etag = first.headers.get("etag");
  assert.equal((await fetch(url, { headers: { "If-None-Match": etag } })).status, 304);
  const compact = await (await fetch(url + "?compact=1")).json();
  assert.deepEqual(restoreSessionSidebarPayload(compact), expected);
  assert.equal(f.stats().queries, 2);
  assert.equal(f.stats().globalReads, 1);
  activityState = "running";
  const changed = await fetch(url, { headers: { "If-None-Match": etag } });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).sessions[0].activityState, "running");
  assert.equal(f.stats().queries, 2);
});

test("a changed rollback-locked SQLite source leaves same-process HTTP and WS responsive and recovers", async (t) => {
  const f = await fixture(t);
  await f.service.getDesktopSnapshotAsync();
  await f.sql("update threads set title='Newest'");
  const locker = await sqliteConnection(t, f.config.codexStateDbPath);
  await locker.sql("begin exclusive");
  const manager = new SessionManager(f.config); manager.codexSidebarService = f.service;
  const { app, runtime } = createKoaApp({ config: f.config, sessionManager: manager });
  runtime.requireAuthorized = () => true;
  const server = http.createServer(app.callback());
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => socket.on("message", (message) => socket.send(message)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const socket = new WebSocket(origin.replace("http:", "ws:"));
  await once(socket, "open");
  t.after(async () => { socket.terminate(); for (const peer of wss.clients) peer.terminate(); wss.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await runtime.closeWorkspace(); });
  let completed = false;
  const reading = fetch(origin + "/api/sessions").then(async (response) => { const value = await response.json(); completed = true; return value; });
  await until(() => f.stats().active === 1);
  const started = performance.now();
  const health = await fetch(origin + "/api/health"); await health.json();
  const httpMs = performance.now() - started;
  const reply = once(socket, "message"), wsStart = performance.now(); socket.send("ping");
  assert.equal(String((await reply)[0]), "ping");
  const wsMs = performance.now() - wsStart;
  assert.equal(completed, false);
  assert(httpMs < 250, `HTTP waited ${httpMs}ms`);
  assert(wsMs < 250, `WS waited ${wsMs}ms`);
  const degraded = await reading;
  assert.equal(degraded.sessions[0].name, "Before");
  assert.equal(degraded.sidebarStatus.degraded, true);
  await locker.sql("rollback");
  assert.equal((await (await fetch(origin + "/api/sessions")).json()).sessions[0].name, "Newest");
  t.diagnostic(JSON.stringify({ httpMs, wsMs }));
});

test("close cancels locked SQLite processes, waits for source cleanup and rejects future reads", async (t) => {
  const f = await fixture(t);
  const locker = await sqliteConnection(t, f.config.codexStateDbPath);
  await locker.sql("begin exclusive");
  const reading = assert.rejects(f.service.getDesktopSnapshotAsync(), { code: "PROCESS_COMMAND_ABORTED" });
  await until(() => f.stats().active === 1);
  const closing = f.service.close();
  assert.equal(f.service.close(), closing);
  await closing; await reading;
  assert.equal(f.stats().active, 0);
  assert.equal(f.stats().queued, 0);
  assert.equal(f.stats().pending, 0);
  assert.equal(f.stats().closed, true);
  await assert.rejects(f.service.getDesktopSnapshotAsync(), { code: "SIDEBAR_READ_CLOSED" });
  await locker.sql("rollback");
});
