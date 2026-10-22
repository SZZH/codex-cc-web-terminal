import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWorkspaceCommandRunner, WorkspaceCommandError } from "../src/workspace/command.js";
import { createWorkspaceJobs } from "../src/workspace/jobs.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const blockUntil = (deadline) => { while (Date.now() <= deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, deadline - Date.now())); };
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function until(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (check()) return; await delay(5); }
  assert.fail("Job fixture did not settle");
}
async function fixture(t, options = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-jobs-"));
  const one = path.join(temp, "one");
  const two = path.join(temp, "two");
  await fs.mkdir(path.join(one, "sub"), { recursive: true });
  await fs.mkdir(two);
  const canonicalOne = await fs.realpath(one);
  const canonicalTwo = await fs.realpath(two);
  const runner = createWorkspaceCommandRunner({ maxConcurrent: options.commandConcurrency || 4, killGraceMs: 30 });
  const jobs = createWorkspaceJobs({ runner, ...options,
    resolveWorkspace: async (cwd, context) => {
      await options.resolveWorkspace?.(cwd, context);
      return { repoRoot: cwd.startsWith(canonicalOne) ? canonicalOne : canonicalTwo, isGitRepo: true };
    }
  });
  t.after(async () => { await jobs.close(); await fs.rm(temp, { recursive: true, force: true }); });
  return { jobs, runner, temp, one, two };
}

test("repository jobs serialize the whole check/write/refresh workflow across subdirectories and aliases", async (t) => {
  const { jobs, temp, one } = await fixture(t);
  const alias = path.join(temp, "alias");
  await fs.symlink(one, alias, process.platform === "win32" ? "junction" : "dir");
  const events = [];
  const run = (cwd, number) => jobs.run({ cwd, operation: "checkout", mode: "write" }, async () => {
    events.push(`${number}:check`); await delay(10);
    events.push(`${number}:write`); await delay(10);
    events.push(`${number}:refresh`);
  });
  await Promise.all([run(path.join(one, "sub"), 1), run(alias, 2), run(one, 3)]);
  assert.deepEqual(events, ["1:check", "1:write", "1:refresh", "2:check", "2:write", "2:refresh", "3:check", "3:write", "3:refresh"]);
  await until(() => jobs.getStats().active === 0);
  assert.equal(jobs.getStats().roots, 0);
});

test("reverse completion of asynchronous repository resolution preserves submission FIFO", async (t) => {
  let resolvingCalls = 0;
  const resolved = [];
  const { jobs, one } = await fixture(t, { resolveWorkspace: async () => {
    const call = ++resolvingCalls;
    await delay(call === 1 ? 70 : 1);
    resolved.push(call);
  } });
  const order = [];
  await Promise.all([jobs.run({ cwd: path.join(one, "sub"), operation: "first", mode: "write" }, () => order.push(1)),
    jobs.run({ cwd: one, operation: "second", mode: "write" }, () => order.push(2))]);
  assert.deepEqual(resolved, [2, 1]);
  assert.deepEqual(order, [1, 2]);
});

test("identical read jobs deduplicate across canonical aliases and are removed after completion", async (t) => {
  const { jobs, temp, one } = await fixture(t);
  const alias = path.join(temp, "alias");
  await fs.symlink(one, alias, process.platform === "win32" ? "junction" : "dir");
  let reads = 0;
  const read = async () => { reads += 1; await delay(30); return { reads }; };
  const options = { cwd: one, operation: "branches", args: ["heads"] };
  const values = await Promise.all([jobs.run(options, read), jobs.run(options, read), jobs.run({ ...options, cwd: alias }, read)]);
  assert.equal(reads, 1);
  assert.deepEqual(values, [{ reads: 1 }, { reads: 1 }, { reads: 1 }]);
  await jobs.run(options, read);
  assert.equal(reads, 2);
  await until(() => jobs.getStats().active === 0);
  assert.equal(jobs.getStats().reads, 0);
  assert.equal(jobs.getStats().waiters, 0);
});

test("a submitted write advances the read generation before resolution or execution", async (t) => {
  const { jobs, one } = await fixture(t);
  const gate = deferred();
  const started = deferred();
  const events = [];
  let value = 0;
  const options = { cwd: one, operation: "branches" };
  const before = jobs.run(options, async () => { events.push("old-read"); started.resolve(); await gate.promise; return value; });
  await started.promise;
  const write = jobs.run({ cwd: path.join(one, "sub"), operation: "switch", mode: "write" }, () => { events.push("write"); value += 1; });
  const after = jobs.run(options, () => { events.push("new-read"); return value; });
  gate.resolve();
  assert.equal(await before, 0);
  await write;
  assert.equal(await after, 1);
  assert.deepEqual(events, ["old-read", "write", "new-read"]);
});

test("distinct cwd and args do not accidentally share a repository read snapshot", async (t) => {
  const { jobs, one } = await fixture(t);
  let count = 0;
  const read = () => ++count;
  await Promise.all([jobs.run({ cwd: one, operation: "changes", args: [1] }, read),
    jobs.run({ cwd: path.join(one, "sub"), operation: "changes", args: [1] }, read),
    jobs.run({ cwd: one, operation: "changes", args: [2] }, read)]);
  assert.equal(count, 3);
});

test("aborting one shared read subscriber does not cancel the other subscriber", async (t) => {
  const { jobs, one } = await fixture(t);
  const gate = deferred();
  const controller = new AbortController();
  let calls = 0;
  const options = { cwd: one, operation: "branches" };
  const first = jobs.run({ ...options, signal: controller.signal }, async () => { calls += 1; await gate.promise; return 7; });
  const second = jobs.run(options, () => assert.fail("Duplicate read executed"));
  controller.abort();
  await assert.rejects(first, { code: "WORKSPACE_JOB_ABORTED" });
  gate.resolve();
  assert.equal(await second, 7);
  assert.equal(calls, 1);
  assert.equal(jobs.getStats().waiters, 0);
});

test("queue and resolver waits consume the original job deadline without starting expired writes", async (t) => {
  const gate = deferred();
  const started = deferred();
  const { jobs, one } = await fixture(t);
  const first = jobs.run({ cwd: one, operation: "holding", mode: "write" }, async () => { started.resolve(); await gate.promise; });
  await started.promise;
  let called = false;
  await assert.rejects(jobs.run({ cwd: one, operation: "expired", mode: "write", timeoutMs: 30 }, () => { called = true; }), {
    code: "WORKSPACE_JOB_TIMEOUT", executionState: "not-applied"
  });
  assert.equal(called, false);
  gate.resolve();
  await first;
});

test("slow root resolution and its admission queue are bounded and clean after timeout", async (t) => {
  const gate = deferred();
  let calls = 0;
  const { jobs, one, two } = await fixture(t, { maxResolving: 1, maxConcurrent: 1, maxQueued: 1, resolveWorkspace: async () => { calls += 1; await gate.promise; } });
  const first = jobs.run({ cwd: one, operation: "one", timeoutMs: 40 }, () => assert.fail("Expired root executed"));
  const second = jobs.run({ cwd: two, operation: "two", timeoutMs: 40 }, () => assert.fail("Expired queued root executed"));
  const settled = Promise.allSettled([first, second]);
  await assert.rejects(jobs.run({ cwd: one, operation: "overflow" }, () => 0), { code: "WORKSPACE_JOB_QUEUE_FULL" });
  assert((await settled).every((result) => result.status === "rejected" && result.reason.code === "WORKSPACE_JOB_TIMEOUT"));
  assert.equal(calls, 1);
  assert.equal(jobs.getStats().resolving, 1);
  gate.resolve();
  await until(() => jobs.getStats().resolving === 0);
  assert.equal(jobs.getStats().queued, 0);
  assert.equal(jobs.getStats().reads, 0);
  assert.equal(jobs.getStats().waiters, 0);
});

test("cross-repository job execution and command execution have independent global bounds", async (t) => {
  const { jobs, runner, one, two } = await fixture(t, { maxConcurrent: 2, commandConcurrency: 1 });
  let running = 0;
  let peak = 0;
  let commandPeak = 0;
  const observer = setInterval(() => { commandPeak = Math.max(commandPeak, runner.getStats().active); }, 5);
  const job = async (context) => {
    running += 1; peak = Math.max(peak, running);
    await context.runCommand(process.execPath, ["-e", "setTimeout(()=>{},90)"]);
    running -= 1;
  };
  try { await Promise.all([jobs.run({ cwd: one, operation: "one" }, job), jobs.run({ cwd: two, operation: "two" }, job)]); }
  finally { clearInterval(observer); }
  assert.equal(peak, 2);
  assert.equal(commandPeak, 1);
  assert.deepEqual(runner.getStats(), { active: 0, queued: 0, closed: false });
});

test("the absolute budget spans root probing, all commands and refresh", async (t) => {
  const { jobs, one } = await fixture(t, { resolveWorkspace: async (cwd, context) => {
    await context.runCommand(process.execPath, ["-e", "setTimeout(()=>{},55)"], { cwd });
  } });
  const start = Date.now();
  await assert.rejects(jobs.run({ cwd: one, operation: "workflow", mode: "write", timeoutMs: 210 }, async (context) => {
    await context.runCommand(process.execPath, ["-e", "setTimeout(()=>{},40)"], { mutates: true, timeoutMs: 1000 });
    await context.runCommand(process.execPath, ["-e", "setTimeout(()=>{},200)"], { timeoutMs: 1000 });
  }), (error) => {
    assert(["WORKSPACE_JOB_TIMEOUT", "WORKSPACE_COMMAND_TIMEOUT", "WORKSPACE_COMMAND_ABORTED"].includes(error.code));
    assert.equal(error.executionState, "applied");
    return true;
  });
  assert(Date.now() - start < 500);
  await until(() => jobs.getStats().active === 0);
});

test("write success followed by refresh failure stays applied and never automatically retries", async (t) => {
  const { jobs, one } = await fixture(t);
  let writes = 0;
  await assert.rejects(jobs.run({ cwd: one, operation: "patch", mode: "write" }, async (context) => {
    writes += 1;
    await context.runCommand(process.execPath, ["-e", "0"], { mutates: true });
    await context.runCommand(process.execPath, ["-e", "console.error('refresh failed');process.exit(128)"]);
  }), { code: "WORKSPACE_COMMAND_EXIT", executionState: "applied" });
  assert.equal(writes, 1);
});

test("timed-out mutations stay unknown and hold their repository until command close", async (t) => {
  const { jobs, runner, one } = await fixture(t);
  const first = jobs.run({ cwd: one, operation: "write", mode: "write", timeoutMs: 160 }, async (context) => {
    await context.runCommand(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { mutates: true });
  });
  const firstChecked = assert.rejects(first, (error) => {
    assert.equal(error.executionState, "unknown");
    assert.equal(runner.getStats().active, 0);
    return true;
  });
  const second = jobs.run({ cwd: one, operation: "next", mode: "write" }, () => {
    assert.equal(runner.getStats().active, 0);
    return "next";
  });
  await firstChecked;
  assert.equal(await second, "next");
});

test("read-only jobs and root resolution reject accidental mutation commands", async (t) => {
  const { jobs, one } = await fixture(t);
  await assert.rejects(jobs.run({ cwd: one, operation: "read" }, (context) => context.runCommand(process.execPath, ["-e", "0"], { mutates: true })), {
    code: "WORKSPACE_JOB_READ_ONLY", executionState: "not-applied"
  });
});

test("job shutdown rejects queued and running work and clears repository bookkeeping", async (t) => {
  const { jobs, runner, one } = await fixture(t);
  const first = jobs.run({ cwd: one, operation: "first", mode: "write" }, (context) => context.runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { mutates: true }));
  const second = jobs.run({ cwd: one, operation: "second", mode: "write" }, () => assert.fail("Closed queue executed"));
  const results = Promise.allSettled([first, second]);
  await until(() => jobs.getStats().active === 1);
  await jobs.close();
  assert((await results).every((result) => result.status === "rejected"));
  await until(() => jobs.getStats().active === 0 && jobs.getStats().resolving === 0);
  assert.deepEqual(jobs.getStats(), { active: 0, resolving: 0, queued: 0, waiters: 0, reads: 0, roots: 0, closed: true });
  assert.equal(runner.getStats().active, 0);
  await assert.rejects(jobs.run({ cwd: one, operation: "closed" }, () => 0), { code: "WORKSPACE_JOB_CLOSED" });
});

test("filesystem mutations participate in applied, unknown and not-applied outcomes", async (t) => {
  const { jobs, one } = await fixture(t);
  const file = path.join(one, "sample.txt");
  await assert.rejects(jobs.run({ cwd: one, operation: "file-write", mode: "write" }, async (context) => {
    await context.mutate(() => fs.writeFile(file, "after"));
    throw new Error("refresh failed");
  }), { executionState: "applied" });
  assert.equal(await fs.readFile(file, "utf8"), "after");
  await assert.rejects(jobs.run({ cwd: one, operation: "partial-file-write", mode: "write" }, (context) => context.mutate(async () => {
    await fs.writeFile(file, "partially changed");
    throw new Error("second file failed");
  })), { executionState: "unknown" });
  await assert.rejects(jobs.run({ cwd: one, operation: "precheck", mode: "write" }, () => { throw new Error("check failed"); }), { executionState: "not-applied" });
  await assert.rejects(jobs.run({ cwd: one, operation: "read-only" }, (context) => context.mutate(() => fs.unlink(file))), { code: "WORKSPACE_JOB_READ_ONLY" });
  assert.equal(await fs.readFile(file, "utf8"), "partially changed");
});

test("a failure before confirmed child close keeps the repository lock after reporting unknown", async (t) => {
  const { one } = await fixture(t);
  const termination = deferred();
  const jobs = createWorkspaceJobs({
    runner: { run: async () => { throw new WorkspaceCommandError("close unconfirmed", {
      code: "WORKSPACE_COMMAND_TIMEOUT", executionState: "unknown", spawned: true, closed: false, termination: termination.promise
    }); } },
    resolveWorkspace: async (cwd) => ({ repoRoot: cwd, isGitRepo: true })
  });
  t.after(() => jobs.close());
  try {
    await assert.rejects(jobs.run({ cwd: one, operation: "uncertain-write", mode: "write" }, (context) => context.runCommand("fixture", [], { mutates: true })), {
      executionState: "unknown", closed: false
    });
    let nextStarted = false;
    const next = jobs.run({ cwd: one, operation: "next-write", mode: "write" }, () => { nextStarted = true; });
    await delay(25);
    assert.equal(nextStarted, false);
    assert.equal(jobs.getStats().active, 1);
    termination.resolve();
    await next;
    assert.equal(nextStarted, true);
  } finally { termination.resolve(); }
});

test("subscriber limits and failed read eviction prevent unbounded or poisoned read sharing", async (t) => {
  const { jobs, one } = await fixture(t, { maxWaiters: 2 });
  const gate = deferred();
  let calls = 0;
  const options = { cwd: one, operation: "failure" };
  const read = async () => { calls += 1; await gate.promise; throw new Error("read failed"); };
  const first = jobs.run(options, read);
  const second = jobs.run(options, read);
  const checked = Promise.allSettled([first, second]);
  await assert.rejects(jobs.run(options, read), { code: "WORKSPACE_JOB_QUEUE_FULL" });
  gate.resolve();
  assert((await checked).every((result) => result.status === "rejected" && result.reason.message === "read failed"));
  assert.equal(calls, 1);
  assert.equal(await jobs.run(options, () => "recovered"), "recovered");
  await until(() => jobs.getStats().active === 0);
  assert.equal(jobs.getStats().waiters, 0);
  assert.equal(jobs.getStats().reads, 0);
});

test("cross-repository job capacity still serializes when configured to one", async (t) => {
  const { jobs, one, two } = await fixture(t, { maxConcurrent: 1 });
  let running = 0;
  let peak = 0;
  const job = async () => { running += 1; peak = Math.max(peak, running); await delay(20); running -= 1; };
  await Promise.all([jobs.run({ cwd: one, operation: "one" }, job), jobs.run({ cwd: two, operation: "two" }, job)]);
  assert.equal(peak, 1);
});

test("an explicitly handled prewrite tool failure can use a safe filesystem fallback", async (t) => {
  const { jobs, one } = await fixture(t);
  const file = path.join(one, "fallback.txt");
  const result = await jobs.run({ cwd: one, operation: "fallback", mode: "write" }, async (context) => {
    try { await context.runCommand("/missing/workspace-patch", []); }
    catch (error) {
      assert.equal(error.executionState, "not-applied");
      await context.mutate(() => fs.writeFile(file, "fallback"));
    }
    return "done";
  });
  assert.equal(result, "done");
  assert.equal(await fs.readFile(file, "utf8"), "fallback");
});

test("unknown writes cannot start a fallback mutation or become a successful job", async (t) => {
  const { jobs, one } = await fixture(t);
  let fallbackCalled = false;
  await assert.rejects(jobs.run({ cwd: one, operation: "uncertain-fallback", mode: "write" }, async (context) => {
    try { await context.runCommand(process.execPath, ["-e", "process.exit(1)"], { mutates: true }); }
    catch {
      await assert.rejects(context.mutate(() => { fallbackCalled = true; }), { code: "WORKSPACE_JOB_UNCERTAIN" });
      await assert.rejects(context.runCommand(process.execPath, ["-e", "0"], { mutates: true }), { code: "WORKSPACE_JOB_UNCERTAIN" });
    }
    return "should not succeed";
  }), { code: "WORKSPACE_COMMAND_EXIT", executionState: "unknown" });
  assert.equal(fallbackCalled, false);
});

test("a filesystem write deadline reports unknown promptly while retaining its lock until completion", async (t) => {
  const { jobs, one } = await fixture(t);
  const gate = deferred();
  const started = deferred();
  let nextStarted = false;
  try {
    const first = jobs.run({ cwd: one, operation: "slow-file-write", mode: "write", timeoutMs: 50 }, (context) => context.mutate(async () => {
      started.resolve();
      await gate.promise;
      await fs.writeFile(path.join(one, "slow.txt"), "completed");
    }));
    const checked = assert.rejects(first, { code: "WORKSPACE_JOB_TIMEOUT", executionState: "unknown" });
    await started.promise;
    const second = jobs.run({ cwd: one, operation: "after-file-write", mode: "write" }, () => { nextStarted = true; });
    await checked;
    assert.equal(nextStarted, false);
    assert.equal(jobs.getStats().active, 1);
    gate.resolve();
    await second;
    assert.equal(await fs.readFile(path.join(one, "slow.txt"), "utf8"), "completed");
    assert.equal(nextStarted, true);
  } finally { gate.resolve(); }
});

test("actual wall-clock expiry prevents a new mutation even when the timeout timer is delayed", async (t) => {
  const { jobs, one } = await fixture(t);
  let mutations = 0;
  await assert.rejects(jobs.run({ cwd: one, operation: "blocked-before-write", mode: "write", timeoutMs: 30 }, async (context) => {
    blockUntil(context.deadline + 40);
    await context.mutate(() => { mutations += 1; });
    return "expired success";
  }), { code: "WORKSPACE_JOB_TIMEOUT", executionState: "not-applied" });
  assert.equal(mutations, 0);
});

test("final wall-clock checks reject late read success and preserve already-applied writes", async (t) => {
  const { jobs, one } = await fixture(t);
  await assert.rejects(jobs.run({ cwd: one, operation: "blocked-read", timeoutMs: 30 }, (context) => {
    blockUntil(context.deadline + 20);
    return "late";
  }), { code: "WORKSPACE_JOB_TIMEOUT", executionState: "not-applied" });
  let writes = 0;
  await assert.rejects(jobs.run({ cwd: one, operation: "blocked-after-write", mode: "write", timeoutMs: 30 }, async (context) => {
    await context.mutate(() => { writes += 1; });
    blockUntil(context.deadline + 20);
    return "late";
  }), { code: "WORKSPACE_JOB_TIMEOUT", executionState: "applied" });
  await assert.rejects(jobs.run({ cwd: one, operation: "blocked-in-write", mode: "write", timeoutMs: 30 }, (context) => context.mutate(() => {
    writes += 1;
    blockUntil(context.deadline + 20);
  })), { code: "WORKSPACE_JOB_TIMEOUT", executionState: "applied" });
  assert.equal(writes, 2);
});

test("an expired subscriber cannot consume a shared result before its delayed timer runs", async (t) => {
  const { jobs, one } = await fixture(t);
  const gate = deferred();
  const started = deferred();
  const options = { cwd: one, operation: "subscriber-deadline" };
  const first = jobs.run({ ...options, timeoutMs: 1000 }, async () => {
    started.resolve(); await gate.promise; blockUntil(Date.now() + 70); return "first";
  });
  await started.promise;
  const second = jobs.run({ ...options, timeoutMs: 30 }, () => assert.fail("Shared callback replaced"));
  const secondChecked = assert.rejects(second, { code: "WORKSPACE_JOB_TIMEOUT" });
  gate.resolve();
  assert.equal(await first, "first");
  await secondChecked;
});

test("canonical merging keeps the earliest alias callback and its original shared budget", async (t) => {
  const { jobs, temp, one } = await fixture(t);
  const alias = path.join(temp, "earlier-alias");
  await fs.symlink(one, alias, process.platform === "win32" ? "junction" : "dir");
  let firstFn = 0;
  let secondFn = 0;
  const first = jobs.run({ cwd: alias, operation: "canonical-owner", timeoutMs: 70 }, async () => { firstFn += 1; await delay(120); return "first"; });
  const second = jobs.run({ cwd: one, operation: "canonical-owner", timeoutMs: 400 }, async () => { secondFn += 1; await delay(120); return "second"; });
  const results = await Promise.allSettled([first, second]);
  assert.equal(firstFn, 1);
  assert.equal(secondFn, 0);
  assert(results.every((result) => result.status === "rejected" && result.reason.code === "WORKSPACE_JOB_TIMEOUT"));
  await delay(125);
});

test("cancelled jobs release captured callbacks behind live root and admission queue heads", async () => {
  const jobsUrl = new URL("../src/workspace/jobs.js", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import os from 'node:os';
    import { createWorkspaceJobs } from ${JSON.stringify(jobsUrl)};
    const cwd = await fs.realpath(os.tmpdir());
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
    const until = async check => { for(let i=0;i<500;i++){ if(check()) return; await tick(); } throw new Error('fixture did not reach queue'); };
    async function phase(admission) {
      const hold = gate();
      const jobs = createWorkspaceJobs({ runner:{run:async()=>{}}, maxConcurrent:1, maxQueued:3, maxResolving:1,
        resolveWorkspace:async()=>{if(admission) await hold.promise; return {repoRoot:cwd,isGitRepo:true};} });
      const first = jobs.run({cwd,operation:'active',mode:'write'},async()=>{if(!admission) await hold.promise;});
      if(admission) await until(()=>jobs.getStats().resolving===1); else await until(()=>jobs.getStats().active===1);
      const head = jobs.run({cwd,operation:'live-head',mode:'write'},()=>{});
      if(!admission) await until(()=>jobs.getStats().resolving===0 && jobs.getStats().queued===1);
      const refs = [];
      async function cancelOne(index) {
        const captured = {index}; refs.push(new WeakRef(captured));
        const controller = new AbortController();
        const pending = jobs.run({cwd,operation:'cancel-'+index,mode:'write',signal:controller.signal},()=>captured.index);
        const checked = pending.catch(error=>assert.equal(error.code,'WORKSPACE_JOB_ABORTED'));
        if(!admission) await until(()=>jobs.getStats().resolving===0 && jobs.getStats().queued===2);
        controller.abort(); await checked;
      }
      try {
        for(let index=0;index<20;index++) await cancelOne(index);
        for(let cycle=0;cycle<8;cycle++){ await tick(); global.gc(); await tick(); }
        return refs.filter(ref=>ref.deref()).length;
      } finally { hold.resolve(); await Promise.all([first,head]); await jobs.close(); }
    }
    console.log(JSON.stringify({rootQueue:await phase(false),admissions:await phase(true)}));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], { timeout: 10000, maxBuffer: 10000 });
  assert.deepEqual(JSON.parse(stdout), { rootQueue: 0, admissions: 0 });
});
