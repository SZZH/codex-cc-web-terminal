import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspaceCommandRunner } from "../src/workspace/command.js";

const node = process.execPath;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(t, options) {
  const runner = createWorkspaceCommandRunner(options);
  t.after(() => runner.close());
  return runner;
}
async function waitFor(check, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  assert.fail("Fixture did not reach expected state");
}

test("workspace commands preserve argv, stdin, C locale and explicit accepted exit codes", async (t) => {
  const runner = fixture(t);
  const result = await runner.run(node, ["-e", "let input='';process.stdin.on('data',c=>input+=c).on('end',()=>{console.log(JSON.stringify({arg:process.argv[1],input,locale:process.env.LC_ALL,lang:process.env.LANG}));process.exit(1)})", "$(not-a-shell); value"], {
    input: "patch\n", acceptedExitCodes: [0, 1], env: { LC_ALL: "ignored", LANG: "ignored" }
  });
  assert.deepEqual(JSON.parse(result.stdout), { arg: "$(not-a-shell); value", input: "patch\n", locale: "C", lang: "C" });
  assert.equal(result.status, 1);
  assert.equal(result.executionState, "not-applied");
  assert.deepEqual(runner.getStats(), { active: 0, queued: 0, closed: false });
});

test("slow asynchronous commands leave the independent event-loop timer running", async (t) => {
  const runner = fixture(t);
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 10);
  try { await runner.run(node, ["-e", "setTimeout(()=>console.log('done'),180)"]); }
  finally { clearInterval(timer); }
  assert(ticks >= 10, `Only ${ticks} timer ticks occurred`);
});

test("command spawn, exit and signal failures cannot become successful results", async (t) => {
  const runner = fixture(t);
  await assert.rejects(runner.run("/definitely-missing/workspace-command", [], { mutates: true }), (error) => {
    assert.equal(error.code, "WORKSPACE_COMMAND_SPAWN");
    assert.equal(error.spawnCode, "ENOENT");
    assert.equal(error.executionState, "not-applied");
    assert.equal(error.closed, true);
    return true;
  });
  await assert.rejects(runner.run(node, ["-e", "console.error('bad config');process.exit(128)"], { mutates: true }), (error) => {
    assert.equal(error.code, "WORKSPACE_COMMAND_EXIT");
    assert.equal(error.status, 128);
    assert.equal(error.executionState, "unknown");
    assert.match(error.message, /bad config/);
    return true;
  });
  await assert.rejects(runner.run(node, ["-e", "process.kill(process.pid,'SIGTERM')"]), (error) => error.code === "WORKSPACE_COMMAND_SIGNAL" && error.signal === "SIGTERM");
  assert.equal(runner.getStats().active, 0);
});

test("successful mutations are applied and overflow stays bounded on both output streams", async (t) => {
  const runner = fixture(t);
  assert.equal((await runner.run(node, ["-e", "process.stdout.write('ok')"], { mutates: true })).executionState, "applied");
  for (const stream of ["stdout", "stderr"]) {
    await assert.rejects(runner.run(node, ["-e", `process.${stream}.write('x'.repeat(5000));setInterval(()=>{},1000)`], { maxBuffer: 64, mutates: true }), (error) => {
      assert.equal(error.code, "WORKSPACE_COMMAND_OUTPUT_LIMIT");
      assert(Buffer.byteLength(error[stream]) <= 64);
      assert.equal(error.executionState, "unknown");
      assert.equal(error.closed, true);
      return true;
    });
  }
  assert.equal(runner.getStats().active, 0);
});

test("command capacity and queue wait are bounded by the original absolute deadline", async (t) => {
  const runner = fixture(t, { maxConcurrent: 1, maxQueued: 1 });
  const first = runner.run(node, ["-e", "setTimeout(()=>{},220)"], { timeoutMs: 2000 });
  const queued = runner.run(node, ["-e", "process.exit(99)"], { deadline: Date.now() + 40, mutates: true });
  await assert.rejects(runner.run(node, ["-e", "0"]), { code: "WORKSPACE_COMMAND_QUEUE_FULL", executionState: "not-applied" });
  await assert.rejects(queued, (error) => error.code === "WORKSPACE_COMMAND_TIMEOUT" && !error.spawned && error.closed && error.executionState === "not-applied");
  await first;
  assert.deepEqual(runner.getStats(), { active: 0, queued: 0, closed: false });
});

test("timeout escalates past ignored TERM and confirms close before releasing its slot", async (t) => {
  const runner = fixture(t, { maxConcurrent: 1, killGraceMs: 30 });
  const start = Date.now();
  const timed = runner.run(node, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { timeoutMs: 300, mutates: true });
  const next = runner.run(node, ["-e", "console.log('next')"], { timeoutMs: 2000 });
  await assert.rejects(timed, (error) => error.code === "WORKSPACE_COMMAND_TIMEOUT" && error.closed && error.spawned && error.executionState === "unknown");
  assert(Date.now() - start >= 290);
  assert.equal((await next).stdout.trim(), "next");
  assert.equal(runner.getStats().active, 0);
});

test("pre-abort never spawns and running abort waits for child close", async (t) => {
  const runner = fixture(t);
  const pre = AbortSignal.abort();
  await assert.rejects(runner.run(node, ["-e", "0"], { signal: pre, mutates: true }), { code: "WORKSPACE_COMMAND_ABORTED", executionState: "not-applied" });
  const controller = new AbortController();
  const running = runner.run(node, ["-e", "setInterval(()=>{},1000)"], { signal: controller.signal, mutates: true });
  setTimeout(() => controller.abort(), 80);
  await assert.rejects(running, (error) => error.code === "WORKSPACE_COMMAND_ABORTED" && error.closed && error.executionState === "unknown");
  assert.equal(runner.getStats().active, 0);
});

test("POSIX cancellation also kills descendants that ignore TERM and detach their stdio", { skip: process.platform === "win32" }, async (t) => {
  const runner = fixture(t, { killGraceMs: 30 });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-tree-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "child.pid");
  const descendant = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`;
  const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const controller = new AbortController();
  const running = runner.run(node, ["-e", script], { signal: controller.signal, timeoutMs: 5000, mutates: true });
  await waitFor(async () => fs.access(marker).then(() => true, () => false));
  const pid = Number(await fs.readFile(marker, "utf8"));
  controller.abort();
  await assert.rejects(running, { code: "WORKSPACE_COMMAND_ABORTED", closed: true });
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; } });
  assert.equal(runner.getStats().active, 0);
});

test("runner shutdown drains children and queued waits and rejects future commands", async (t) => {
  const runner = fixture(t, { maxConcurrent: 1 });
  const first = runner.run(node, ["-e", "setInterval(()=>{},1000)"], { mutates: true });
  const second = runner.run(node, ["-e", "0"]);
  const results = Promise.allSettled([first, second]);
  await runner.close();
  assert((await results).every((result) => result.status === "rejected" && result.reason.code === "WORKSPACE_COMMAND_ABORTED"));
  assert.deepEqual(runner.getStats(), { active: 0, queued: 0, closed: true });
  await assert.rejects(runner.run(node, ["-e", "0"]), { code: "WORKSPACE_COMMAND_CLOSED" });
});

test("natural nonzero and signal exits clean and confirm the descendant process group", { skip: process.platform === "win32" }, async (t) => {
  const runner = fixture(t, { killGraceMs: 20 });
  for (const [finish, code] of [["process.exit(1)", "WORKSPACE_COMMAND_EXIT"], ["process.kill(process.pid,'SIGTERM')", "WORKSPACE_COMMAND_SIGNAL"]]) {
    let descendantPid;
    try {
      const descendant = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
      const script = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});console.log(child.pid);setTimeout(()=>{${finish}},30)`;
      await assert.rejects(runner.run(node, ["-e", script], { mutates: true }), (error) => {
        descendantPid = Number(error.stdout.trim());
        assert(descendantPid > 0);
        assert.equal(error.code, code);
        assert.equal(error.executionState, "unknown");
        assert.equal(error.closed, true);
        assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
        assert.equal(runner.getStats().active, 0);
        return true;
      });
    } finally {
      if (descendantPid) { try { process.kill(descendantPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
    }
  }
});
