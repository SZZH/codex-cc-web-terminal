import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { createWorkspaceService } from "../src/workspace/service.js";
import { handleWorkspaceChangesRoute } from "../src/routes/workspaceChanges.js";
import { readWorkspaceChanges } from "../src/workspace/changes.js";

const exec = promisify(execFile);
const git = (cwd, ...args) => exec("git", args, { cwd, env: { ...process.env, LC_ALL: "C", LANG: "C" } });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t, { repository = true, commit = true, shim = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-async-"));
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  const services = [];
  const requests = [];
  const configWrites = [];
  let readinessMs = null;
  const timeline = path.join(root, "timeline.jsonl");
  t.after(async () => {
    const closed = await Promise.allSettled(services.map((service) => service.close()));
    if (shim) {
      const frames = (await fs.readFile(timeline, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      const first = frames.find((frame) => frame.phase === "entered");
      t.diagnostic(JSON.stringify({ fixture: "git-shim",
        readinessMs,
        firstEntryAfterRequestMs: first && requests.length ? first.at - requests[0].at : null,
        maxConfigWriteMs: Math.max(0, ...configWrites),
        entered: frames.filter((frame) => frame.phase === "entered").length,
        gitStarted: frames.filter((frame) => frame.phase === "git-start").length,
        gitFinished: frames.filter((frame) => frame.phase === "git-end").length,
        injectedFailures: frames.filter((frame) => frame.phase === "injected-failure").length,
        maxGitMs: Math.max(0, ...frames.filter((frame) => frame.phase === "git-end").map((frame) => frame.duration)) }));
    }
    await fs.rm(root, { recursive: true, force: true });
    const failure = closed.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  });
  if (repository) {
    await git(cwd, "init");
    await git(cwd, "config", "user.name", "Workspace Fixture");
    await git(cwd, "config", "user.email", "fixture@example.test");
    if (commit) {
      await fs.writeFile(path.join(cwd, "sample.txt"), "before\n");
      await git(cwd, "add", ".");
      await git(cwd, "commit", "-m", "fixture");
    }
  }
  const control = path.join(root, "control.json");
  const log = path.join(root, "commands.jsonl");
  const marker = path.join(root, "written");
  let gitBin = "git";
  if (shim) {
    gitBin = path.join(root, "git-shim");
    const script = [
      "#!/usr/bin/env node",
      "if(process.argv[2]==='--fixture-ready'){process.stdout.write('fixture-ready\\n');process.exit(0);}",
      "const fs=require('node:fs'),{spawnSync}=require('node:child_process');",
      "const args=process.argv.slice(2);",
      "const record=(phase,extra={})=>fs.appendFileSync(" + JSON.stringify(timeline) + ",JSON.stringify({phase,at:Date.now(),pid:process.pid,command:args[0],...extra})+'\\n');record('entered');",
      "const config=JSON.parse(fs.readFileSync(" + JSON.stringify(control) + ",'utf8'));",
      "const marker=" + JSON.stringify(marker) + ";",
      "fs.appendFileSync(" + JSON.stringify(log) + ",JSON.stringify(args)+'\\n');",
      "const written=fs.existsSync(marker);",
      "if(config.delayMs&&(!config.only||config.only===args[0]))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,config.delayMs);",
      "if(config.fail===args[0]&&(!config.afterWrite||written)){record('injected-failure');console.error('fatal: fixture read configuration failure');process.exit(128);}",
      "const input=fs.readFileSync(0);record('git-start');const started=Date.now();const result=spawnSync('git',args,{cwd:process.cwd(),input,encoding:'utf8'});record('git-end',{duration:Date.now()-started});",
      "const write=['switch','restore'].includes(args[0])||args[0]==='apply'&&!args.includes('--check')||args[0]==='branch'&&args[1]&&!args[1].startsWith('-');",
      "if(write&&result.status===0){record('write-confirmed');fs.writeFileSync(marker,'yes');if(config.holdAfterWrite)while(true)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);}",
      "process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status??1);"
    ].join("\n");
    await fs.writeFile(gitBin, script, { mode: 0o755 });
    await fs.writeFile(control, "{}");
    // Prepare the generated executable before measuring an injected Git fault.
    const preparing = performance.now();
    const ready = await exec(gitBin, ["--fixture-ready"], { cwd, timeout: 30000 });
    assert.equal(ready.stdout, "fixture-ready\n");
    readinessMs = Math.round(performance.now() - preparing);
  }
  const create = (options = {}) => {
    const service = createWorkspaceService({ gitBin, ...options });
    for (const name of ["listWorkspaceChanges", "listGitBranches", "revertWorkspaceChanges", "applyPatchWorkspaceChanges", "reversePatchWorkspaceChanges", "checkoutGitBranch", "createGitBranch"]) {
      const run = service[name];
      service[name] = (...args) => { requests.push({ method: name, at: Date.now() }); return run(...args); };
    }
    services.push(service);
    return service;
  };
  return { root, cwd, create, service: create(), control, marker,
    configure: async (options) => { const start = Date.now(); await fs.writeFile(control, JSON.stringify(options)); configWrites.push(Date.now() - start); },
    commands: async () => (await fs.readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse) };
}

const changedFile = (filePath = "sample.txt") => ({ path: filePath, status: "M", diff: "@@ -1 +1 @@\n-before\n+after" });

test("Git subdirectory reads and selected reverts use one repository-root path base", async (t) => {
  const { cwd, service } = await fixture(t);
  await fs.mkdir(path.join(cwd, "sub"));
  await fs.writeFile(path.join(cwd, "sub", "nested.txt"), "nested before\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "nested fixture");
  await fs.writeFile(path.join(cwd, "sample.txt"), "after\n");
  await fs.writeFile(path.join(cwd, "sub", "nested.txt"), "nested after\n");
  const result = await service.listWorkspaceChanges(path.join(cwd, "sub"));
  assert.equal(result.cwd, await fs.realpath(cwd));
  assert.deepEqual(result.files.map((file) => file.path).sort(), ["sample.txt", "sub/nested.txt"]);
  assert.match(result.files.find((file) => file.path === "sample.txt").diff, /\+after/);
  assert.match(result.files.find((file) => file.path === "sub/nested.txt").diff, /\+nested after/);
  const reverted = await service.revertWorkspaceChanges(path.join(cwd, "sub"), ["sub/nested.txt"]);
  assert.equal(reverted.cwd, result.cwd);
  assert.equal(await fs.readFile(path.join(cwd, "sub", "nested.txt"), "utf8"), "nested before\n");
  assert.equal(await fs.readFile(path.join(cwd, "sample.txt"), "utf8"), "after\n");
});

test("historical patches stay caller-relative while their live Git refresh is root-relative", async (t) => {
  const { cwd, service } = await fixture(t);
  await fs.mkdir(path.join(cwd, "sub"));
  await fs.writeFile(path.join(cwd, "sub", "nested.txt"), "before\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "nested fixture");
  await fs.writeFile(path.join(cwd, "sub", "nested.txt"), "after\n");
  const result = await service.reversePatchWorkspaceChanges(path.join(cwd, "sub"), [changedFile("nested.txt")]);
  assert.equal(await fs.readFile(path.join(cwd, "sub", "nested.txt"), "utf8"), "before\n");
  assert.equal(result.cwd, await fs.realpath(cwd));
  assert.equal(result.total, 0);
});

test("unborn HEAD and detached HEAD remain valid Git read states", async (t) => {
  const { cwd, service } = await fixture(t, { commit: false });
  await fs.writeFile(path.join(cwd, "new.txt"), "unborn\n");
  await git(cwd, "add", "new.txt");
  const changes = await service.listWorkspaceChanges(cwd);
  assert.match(changes.files[0].diff, /\+unborn/);
  assert.equal(changes.additions, 1);
  assert.equal((await service.listGitBranches(cwd)).dirty, true);
  await fs.writeFile(path.join(cwd, "new.txt"), "unborn\nworking tree\n");
  const working = await service.listWorkspaceChanges(cwd);
  assert.match(working.files[0].diff, /\+working tree/);
  assert.equal(working.additions, 2);
  await assert.rejects(service.revertWorkspaceChanges(cwd, ["new.txt"]), { executionState: "not-applied" });
  await git(cwd, "add", "new.txt");
  await git(cwd, "commit", "-m", "first");
  await git(cwd, "checkout", "--detach");
  const detached = await service.listGitBranches(cwd);
  assert.equal(detached.currentBranch, "");
  assert.equal(detached.dirty, false);
});

test("ordinary parent and child patches sharing a target cannot interleave", async (t) => {
  const { cwd, service } = await fixture(t, { repository: false });
  const child = path.join(cwd, "child");
  await fs.mkdir(child);
  await fs.writeFile(path.join(child, "sample.txt"), "after\n");
  await Promise.all([
    service.reversePatchWorkspaceChanges(cwd, [changedFile("child/sample.txt")]),
    service.applyPatchWorkspaceChanges(child, [changedFile()], "forward")
  ]);
  assert.equal(await fs.readFile(path.join(child, "sample.txt"), "utf8"), "after\n");
  assert.equal(service.stats().jobs.active, 0);
});

test("missing ordinary-directory patch tool retains the safe JavaScript fallback", async (t) => {
  const { cwd, create } = await fixture(t, { repository: false });
  const service = create({ patchBin: path.join(cwd, "missing-patch-tool") });
  await fs.writeFile(path.join(cwd, "sample.txt"), "after\n");
  await service.reversePatchWorkspaceChanges(cwd, [changedFile()]);
  assert.equal(await fs.readFile(path.join(cwd, "sample.txt"), "utf8"), "before\n");
});

test("ordinary JavaScript fallback preserves complete added/deleted files and final newlines", async (t) => {
  const { cwd, create } = await fixture(t, { repository: false });
  const service = create({ patchBin: path.join(cwd, "missing-patch-tool") });
  const file = { path: "created.txt", status: "A", diff: "--- /dev/null\n+++ b/created.txt\n@@ -0,0 +1 @@\n+created\n" };
  await service.applyPatchWorkspaceChanges(cwd, [file], "forward");
  assert.equal(await fs.readFile(path.join(cwd, "created.txt"), "utf8"), "created\n");
  await service.reversePatchWorkspaceChanges(cwd, [file]);
  await assert.rejects(fs.access(path.join(cwd, "created.txt")), { code: "ENOENT" });
  const noNewline = { path: "plain.txt", status: "A", diff: "@@ -0,0 +1 @@\n+plain\n\\ No newline at end of file\n" };
  await service.applyPatchWorkspaceChanges(cwd, [noNewline], "forward");
  assert.equal(await fs.readFile(path.join(cwd, "plain.txt"), "utf8"), "plain");
});

test("failed dirty inspection rejects branch writes before any mutation", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t, { shim: true });
  await f.configure({ fail: "status" });
  await assert.rejects(f.service.checkoutGitBranch(f.cwd, "feature"), { executionState: "not-applied" });
  assert(!(await f.commands()).some((args) => args[0] === "switch"));
  await assert.rejects(f.service.listGitBranches(f.cwd), { code: "WORKSPACE_COMMAND_EXIT" });
});

test("a confirmed branch write followed by refresh failure stays applied without retry", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t, { shim: true });
  await f.configure({ fail: "branch", afterWrite: true });
  await assert.rejects(f.service.createGitBranch(f.cwd, "feature/applied", { checkout: false }), {
    code: "WORKSPACE_COMMAND_EXIT", executionState: "applied"
  });
  const writes = (await f.commands()).filter((args) => args[0] === "branch" && args[1] === "feature/applied");
  assert.equal(writes.length, 1);
  await f.configure({});
  assert((await f.service.listGitBranches(f.cwd)).branches.some((branch) => branch.name === "feature/applied"));
});

test("an interrupted write after its actual write marker remains unknown without a second patch or fallback", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t, { shim: true });
  await fs.writeFile(path.join(f.cwd, "sample.txt"), "after\n");
  await f.configure({ holdAfterWrite: true });
  const controller = new AbortController();
  let settled;
  const pending = f.service.reversePatchWorkspaceChanges(f.cwd, [changedFile()], { signal: controller.signal })
    .then((value) => { settled = { value }; }, (error) => { settled = { error }; });
  const waitingUntil = Date.now() + 15000;
  while (!settled && !await fs.access(f.marker).then(() => true, () => false)) {
    assert(Date.now() < waitingUntil, "fixture must reach its actual write marker within the unchanged job budget");
    await delay(5);
  }
  assert.equal(settled, undefined, "the fixture must still be waiting after the actual write");
  controller.abort();
  await pending;
  assert.equal(settled.error.executionState, "unknown");
  assert.match(settled.error.code, /ABORTED/);
  assert.equal(await fs.readFile(path.join(f.cwd, "sample.txt"), "utf8"), "before\n");
  assert.equal((await f.commands()).filter((args) => args[0] === "apply" && !args.includes("--check")).length, 1);
  assert.equal(f.service.stats().commands.active, 0);
});

test("slow Git in the real route leaves same-process HTTP and WebSocket responsive", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t, { shim: true });
  await f.configure({ delayMs: 250, only: "status" });
  const runtime = { workspace: f.service, forbidCrossOrigin: () => false, requireAuthorized: () => true,
    json: (ctx, status, value) => { ctx.res.writeHead(status, { "Content-Type": "application/json" }); ctx.res.end(JSON.stringify(value)); } };
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health") return res.end("ok");
    await handleWorkspaceChangesRoute({ req, res, url: req.url, method: req.method, path: new URL(req.url, "http://local").pathname }, runtime);
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => socket.on("message", (message) => socket.send(message)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const socket = new WebSocket(base.replace("http", "ws"));
  t.after(async () => { socket.terminate(); for (const client of wss.clients) client.terminate(); wss.close(); await new Promise((resolve) => server.close(resolve)); });
  await once(socket, "open");
  let finished = false;
  const requestedAt = performance.now();
  const work = fetch(base + "/api/workspace-git?" + new URLSearchParams({ cwd: f.cwd })).then(async (response) => { assert.equal(response.status, 200); finished = true; return response.json(); });
  await delay(50);
  assert(performance.now() - requestedAt < 150, "the probe timer must advance while Git is pending");
  const start = performance.now();
  let httpMs;
  let wsMs;
  const health = fetch(base + "/health").then(async (response) => { const value = await response.text(); httpMs = performance.now() - start; return value; });
  const echo = once(socket, "message").then((value) => { wsMs = performance.now() - start; return value; });
  socket.send("probe");
  assert.equal(await health, "ok");
  assert.equal(String((await echo)[0]), "probe");
  assert(performance.now() - start < 150);
  assert.equal(finished, false);
  assert.equal((await work).isGitRepo, true);
  t.diagnostic(JSON.stringify({ slowGitMs: 250, httpMs: Number(httpMs.toFixed(1)), wsMs: Number(wsMs.toFixed(1)), gitCalls: (await f.commands()).length }));
});

test("closing a workspace service waits for command cleanup and exposes closed health stats", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t, { shim: true });
  await f.configure({ delayMs: 1000 });
  const pending = f.service.listGitBranches(f.cwd);
  const checked = assert.rejects(pending, { code: "WORKSPACE_JOB_ABORTED", executionState: "not-applied" });
  await delay(50);
  const start = performance.now();
  await f.service.close();
  await checked;
  assert(performance.now() - start < 2000);
  assert.equal(f.service.stats().jobs.active, 0);
  assert.equal(f.service.stats().commands.active, 0);
  assert.equal(f.service.stats().jobs.closed, true);
});

test("concurrent writes to one repository return snapshots in submission order", async (t) => {
  const { cwd, service } = await fixture(t);
  const [first, second] = await Promise.all([
    service.createGitBranch(cwd, "feature/first", { checkout: false }),
    service.createGitBranch(cwd, "feature/second", { checkout: false })
  ]);
  assert(first.branches.some((branch) => branch.name === "feature/first"));
  assert(!first.branches.some((branch) => branch.name === "feature/second"));
  assert(second.branches.some((branch) => branch.name === "feature/first"));
  assert(second.branches.some((branch) => branch.name === "feature/second"));
});

test("a timed-out workspace read returns an explicit HTTP error instead of empty or non-Git success", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t, { shim: true });
  await f.configure({ delayMs: 500 });
  const ctx = { method: "GET", path: "/api/workspace-changes", url: "/api/workspace-changes?" + new URLSearchParams({ cwd: f.cwd }) };
  await handleWorkspaceChangesRoute(ctx, { forbidCrossOrigin: () => false, requireAuthorized: () => true,
    workspace: { listWorkspaceChanges: (cwd) => f.service.listWorkspaceChanges(cwd, { timeoutMs: 80 }) },
    json: (context, status, value) => Object.assign(context, { status, value }) });
  assert.equal(ctx.status, 504);
  assert.match(ctx.value.code, /TIMEOUT|ABORTED/);
  assert.equal(ctx.value.executionState, "not-applied");
  assert.equal(Object.hasOwn(ctx.value, "files"), false);
  assert.equal(Object.hasOwn(ctx.value, "isGitRepo"), false);
});

test("renamed Git entries keep destination and previous path aligned during selected revert", async (t) => {
  const { cwd, service } = await fixture(t);
  await git(cwd, "mv", "sample.txt", "renamed.txt");
  const changes = await service.listWorkspaceChanges(cwd);
  assert.equal(changes.files[0].path, "renamed.txt");
  assert.equal(changes.files[0].previousPath, "sample.txt");
  await service.revertWorkspaceChanges(cwd, ["renamed.txt"]);
  assert.equal(await fs.readFile(path.join(cwd, "sample.txt"), "utf8"), "before\n");
  await assert.rejects(fs.access(path.join(cwd, "renamed.txt")), { code: "ENOENT" });
});

test("change reads preserve status order while limiting concurrent file diffs to two", async () => {
  const names = Array.from({ length: 7 }, (_, index) => "file-" + index + ".txt");
  let activeDiffs = 0, peakDiffs = 0, activeCommands = 0, peakCommands = 0;
  const command = async (_context, args) => {
    activeCommands += 1; peakCommands = Math.max(peakCommands, activeCommands);
    try {
      if (args[0] === "status") { await delay(5); return { stdout: names.map((name) => " M " + name + "\0").join("") }; }
      if (args[0] === "rev-parse") { await delay(5); return { status: 0, stdout: "head" }; }
      if (args.includes("--numstat")) { await delay(15); return { stdout: names.map((name) => "1\t1\t" + name).join("\n") }; }
      activeDiffs += 1; peakDiffs = Math.max(peakDiffs, activeDiffs);
      try { await delay(names.indexOf(args.at(-1)) % 2 ? 1 : 12); return { stdout: "@@ -1 +1 @@\n-before\n+after\n" }; }
      finally { activeDiffs -= 1; }
    } finally { activeCommands -= 1; }
  };
  const result = await readWorkspaceChanges({ cwd: "/workspace", isGitRepo: true }, command);
  assert.deepEqual(result.files.map((file) => file.path), names);
  assert.equal(peakDiffs, 2);
  assert.equal(peakCommands, 3);
  assert.equal(activeCommands, 0);
  assert.equal(result.additions, 7);
});

test("selected reverts treat wildcard-like filenames literally and preserve other changed files", async (t) => {
  const { cwd, service } = await fixture(t);
  for (const name of ["literal*.txt", "literal-other.txt"]) await fs.writeFile(path.join(cwd, name), "before\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "literal filenames");
  for (const name of ["literal*.txt", "literal-other.txt"]) await fs.writeFile(path.join(cwd, name), "after\n");
  await service.revertWorkspaceChanges(cwd, ["literal*.txt"]);
  assert.equal(await fs.readFile(path.join(cwd, "literal*.txt"), "utf8"), "before\n");
  assert.equal(await fs.readFile(path.join(cwd, "literal-other.txt"), "utf8"), "after\n");
});

test("literal pathspec magic filenames cannot include or revert unselected files", { skip: process.platform === "win32" }, async (t) => {
  const { cwd, service } = await fixture(t);
  const names = [":(exclude)keep.txt", "keep.txt", "other.txt"];
  for (const name of names) await fs.writeFile(path.join(cwd, name), "before\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "literal magic fixture");
  for (const name of names) await fs.writeFile(path.join(cwd, name), "after\n");
  const changes = await service.listWorkspaceChanges(cwd);
  const selected = changes.files.find((file) => file.path === names[0]);
  assert(!selected.diff.includes("other.txt"));
  await service.revertWorkspaceChanges(cwd, [names[0]]);
  assert.equal(await fs.readFile(path.join(cwd, names[0]), "utf8"), "before\n");
  assert.equal(await fs.readFile(path.join(cwd, "other.txt"), "utf8"), "after\n");
  assert.equal(await fs.readFile(path.join(cwd, "keep.txt"), "utf8"), "after\n");
});

test("Git revert preserves leading and trailing spaces in file identities", { skip: process.platform === "win32" }, async (t) => {
  const { cwd, service } = await fixture(t);
  const names = ["sample.txt", "sample.txt ", " sample.txt"];
  for (const name of names) await fs.writeFile(path.join(cwd, name), "before\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "spaced filenames");
  for (const name of names) await fs.writeFile(path.join(cwd, name), "after\n");
  const reverted = await service.revertWorkspaceChanges(cwd, [names[1], names[2]]);
  assert.deepEqual(new Set(reverted.reverted), new Set(names.slice(1)));
  assert.equal(await fs.readFile(path.join(cwd, names[0]), "utf8"), "after\n");
  for (const name of names.slice(1)) assert.equal(await fs.readFile(path.join(cwd, name), "utf8"), "before\n");
  await assert.rejects(service.revertWorkspaceChanges(cwd, [""]), { executionState: "not-applied" });
  assert.equal(await fs.readFile(path.join(cwd, names[0]), "utf8"), "after\n");
});

test("ordinary patch preserves leading and trailing spaces in file identities", { skip: process.platform === "win32" }, async (t) => {
  const { cwd, create } = await fixture(t, { repository: false });
  const service = create({ patchBin: path.join(cwd, "missing-patch-tool") });
  const names = ["sample.txt", "sample.txt ", " sample.txt"];
  for (const name of names) await fs.writeFile(path.join(cwd, name), "after\n");
  await service.reversePatchWorkspaceChanges(cwd, names.slice(1).map(changedFile));
  assert.equal(await fs.readFile(path.join(cwd, names[0]), "utf8"), "after\n");
  for (const name of names.slice(1)) assert.equal(await fs.readFile(path.join(cwd, name), "utf8"), "before\n");
});

for (const [label, diff, expected, initial = "first\nlast\n"] of [
  ["first", "@@ -0,0 +1 @@\n+start\n", "start\nfirst\nlast\n"],
  ["middle", "@@ -1,0 +2 @@\n+middle\n", "first\nmiddle\nlast\n"],
  ["last", "@@ -2,0 +3 @@\n+end\n", "first\nlast\nend\n"],
  ["multiple", "@@ -0,0 +1 @@\n+start\n@@ -1,0 +3 @@\n+middle\n@@ -2,0 +5 @@\n+end\n", "start\nfirst\nmiddle\nlast\nend\n"],
  ["duplicate text", "@@ -2,0 +3 @@\n+middle\n", "middle\nfirst\nmiddle\nlast\n", "middle\nfirst\nlast\n"]
]) {
  test(`zero-context ${label} insertions follow hunk positions and reverse exactly`, async (t) => {
    const { cwd, create } = await fixture(t, { repository: false });
    const service = create({ patchBin: path.join(cwd, "missing-patch-tool") });
    await fs.writeFile(path.join(cwd, "sample.txt"), initial);
    const file = { path: "sample.txt", status: "M", diff };
    await service.applyPatchWorkspaceChanges(cwd, [file], "forward");
    assert.equal(await fs.readFile(path.join(cwd, "sample.txt"), "utf8"), expected);
    await service.reversePatchWorkspaceChanges(cwd, [file]);
    assert.equal(await fs.readFile(path.join(cwd, "sample.txt"), "utf8"), initial);
  });
}

for (const repository of [true, false]) {
  test(`patch final-line spaces remain unchanged in ${repository ? "Git" : "JavaScript fallback"}`, async (t) => {
    const { cwd, create } = await fixture(t, { repository, commit: false });
    const service = create({ patchBin: path.join(cwd, "missing-patch-tool") });
    await fs.writeFile(path.join(cwd, "sample.txt"), "before\n");
    const file = { path: "sample.txt", status: "M", diff: "@@ -1 +1 @@\n-before\n+after \n" };
    await service.applyPatchWorkspaceChanges(cwd, [file], "forward");
    assert.equal(await fs.readFile(path.join(cwd, "sample.txt"), "utf8"), "after \n");
    await service.reversePatchWorkspaceChanges(cwd, [file]);
    assert.equal(await fs.readFile(path.join(cwd, "sample.txt"), "utf8"), "before\n");
  });
}

for (const repository of [true, false]) {
  test(`default ${repository ? "Git" : "ordinary"} patch applies only the raw spaced filename`, { skip: process.platform === "win32" }, async (t) => {
    const { cwd, service } = await fixture(t, { repository });
    for (const name of ["sample.txt", "sample.txt "]) await fs.writeFile(path.join(cwd, name), "after\n");
    await service.reversePatchWorkspaceChanges(cwd, [changedFile("sample.txt ")]);
    assert.equal(await fs.readFile(path.join(cwd, "sample.txt "), "utf8"), "before\n");
    assert.equal(await fs.readFile(path.join(cwd, "sample.txt"), "utf8"), "after\n");
  });
}

test("live canonical changes patch the root file without touching its same-named child file", async (t) => {
  const { cwd, service } = await fixture(t);
  const sub = path.join(cwd, "sub");
  await fs.mkdir(sub);
  await fs.writeFile(path.join(sub, "sample.txt"), "after\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "independent child");
  await fs.writeFile(path.join(cwd, "sample.txt"), "after\n");
  const live = await service.listWorkspaceChanges(sub);
  assert.equal(live.cwd, await fs.realpath(cwd));
  assert.deepEqual(live.files.map((file) => file.path), ["sample.txt"]);
  await service.reversePatchWorkspaceChanges(live.cwd, live.files);
  assert.equal(await fs.readFile(path.join(cwd, "sample.txt"), "utf8"), "before\n");
  assert.equal(await fs.readFile(path.join(sub, "sample.txt"), "utf8"), "after\n");
});
