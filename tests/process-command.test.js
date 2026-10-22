import test from "node:test";
import assert from "node:assert/strict";
import { CommandError, createCommandRunner } from "../src/runtime/processes/command.js";
import { WorkspaceCommandError, createWorkspaceCommandRunner } from "../src/workspace/command.js";

const node = process.execPath;

test("generic command errors retain causes, execution state and caller details", () => {
  const cause = new Error("original cause");
  const error = new CommandError("failed", { code: "PROCESS_COMMAND_EXIT", executionState: "unknown", cause, status: 7 });
  assert(error instanceof Error);
  assert.equal(error.name, "CommandError");
  assert.equal(error.cause, cause);
  assert.equal(error.code, "PROCESS_COMMAND_EXIT");
  assert.equal(error.executionState, "unknown");
  assert.equal(error.status, 7);
  assert.equal(new CommandError("preflight").executionState, "not-applied");
});

test("the generic runner defaults to PROCESS_COMMAND errors and preserves process results", async (t) => {
  const runner = createCommandRunner();
  t.after(() => runner.close());
  const result = await runner.run(node, ["-e", "console.log('generic')"]);
  assert.deepEqual(result, { status: 0, signal: null, stdout: "generic\n", stderr: "", executionState: "not-applied" });
  let termination;
  await assert.rejects(runner.run("/definitely-missing/process-command"), (error) => {
    assert.equal(error.constructor, CommandError);
    assert.equal(error.name, "CommandError");
    assert.equal(error.code, "PROCESS_COMMAND_SPAWN");
    assert.equal(error.spawnCode, "ENOENT");
    assert.equal(error.cause.code, "ENOENT");
    assert.equal(error.spawned, false);
    assert.equal(error.closed, true);
    assert.equal(error.executionState, "not-applied");
    assert(error.termination instanceof Promise);
    termination = error.termination;
    return true;
  });
  await termination;
  await assert.rejects(runner.run(node, ["-e", "console.error('generic failure');process.exit(7)"], { mutates: true }), (error) => {
    assert.equal(error.constructor, CommandError);
    assert.equal(error.code, "PROCESS_COMMAND_EXIT");
    assert.equal(error.status, 7);
    assert.equal(error.stderr, "generic failure\n");
    assert.equal(error.stdout, "");
    assert.equal(error.executionState, "unknown");
    assert.equal(error.closed, true);
    termination = error.termination;
    return true;
  });
  await termination;
  assert.deepEqual(runner.getStats(), { active: 0, queued: 0, closed: false });
});

test("generic preflight and closed errors use neutral codes and messages", async () => {
  const runner = createCommandRunner();
  try {
    await assert.rejects(runner.run(""), { name: "CommandError", code: "PROCESS_COMMAND_INVALID", message: "Invalid command options" });
    await assert.rejects(runner.run(node, [], { signal: AbortSignal.abort() }), { name: "CommandError", code: "PROCESS_COMMAND_ABORTED", message: "Command aborted" });
    await assert.rejects(runner.run(node, [], { deadline: Date.now() - 1 }), { code: "PROCESS_COMMAND_TIMEOUT", message: "Command deadline exceeded" });
  } finally { await runner.close(); }
  await assert.rejects(runner.run(node), { name: "CommandError", code: "PROCESS_COMMAND_CLOSED", message: "Command runner is closed" });
});

test("custom error factories stay local to each runner instance", async (t) => {
  class QueryError extends CommandError {
    constructor(message, options) { super(message, options); this.name = "QueryError"; }
  }
  const custom = createCommandRunner({ errorPrefix: "QUERY_COMMAND", ErrorClass: QueryError, commandLabel: "Query command" });
  const generic = createCommandRunner();
  const workspace = createWorkspaceCommandRunner({ errorPrefix: "IGNORED", ErrorClass: QueryError, commandLabel: "Ignored" });
  t.after(() => Promise.all([custom.close(), generic.close(), workspace.close()]));
  for (const [runner, ErrorClass, code, message] of [
    [custom, QueryError, "QUERY_COMMAND_INVALID", "Invalid query command options"],
    [generic, CommandError, "PROCESS_COMMAND_INVALID", "Invalid command options"],
    [workspace, WorkspaceCommandError, "WORKSPACE_COMMAND_INVALID", "Invalid workspace command options"]
  ]) {
    await assert.rejects(runner.run(""), (error) => {
      assert.equal(error.constructor, ErrorClass);
      assert(error instanceof CommandError);
      assert.equal(error.code, code);
      assert.equal(error.message, message);
      return true;
    });
  }
});

test("the workspace wrapper preserves class identity and factory limit validation", async (t) => {
  const runner = createWorkspaceCommandRunner();
  t.after(() => runner.close());
  await assert.rejects(runner.run("/definitely-missing/workspace-command"), (error) => {
    assert(error instanceof WorkspaceCommandError);
    assert(error instanceof CommandError);
    assert.equal(error.name, "WorkspaceCommandError");
    assert.equal(error.code, "WORKSPACE_COMMAND_SPAWN");
    assert.equal(error.cause.code, "ENOENT");
    return true;
  });
  assert.throws(() => createWorkspaceCommandRunner({ maxConcurrent: 0 }), { name: "TypeError", message: "Invalid workspace command limits" });
  assert.throws(() => createCommandRunner({ maxConcurrent: 0 }), { name: "TypeError", message: "Invalid command limits" });
  assert.throws(() => createWorkspaceCommandRunner(null), TypeError);
});

test("workspace and generic runners keep independent queues and close lifecycles", async (t) => {
  const workspace = createWorkspaceCommandRunner({ maxConcurrent: 1, maxQueued: 1 });
  const generic = createCommandRunner({ maxConcurrent: 1, maxQueued: 1 });
  t.after(() => Promise.all([workspace.close(), generic.close()]));
  const first = workspace.run(node, ["-e", "setInterval(()=>{},1000)"], { mutates: true });
  const queued = workspace.run(node, ["-e", "process.exit(99)"]);
  const settled = Promise.allSettled([first, queued]);
  await assert.rejects(workspace.run(node), { code: "WORKSPACE_COMMAND_QUEUE_FULL" });
  assert.deepEqual(workspace.getStats(), { active: 1, queued: 1, closed: false });
  assert.equal((await generic.run(node, ["-e", "console.log('independent')"])).stdout, "independent\n");
  await workspace.close();
  for (const result of await settled) {
    assert.equal(result.status, "rejected");
    assert(result.reason instanceof WorkspaceCommandError);
    assert.equal(result.reason.code, "WORKSPACE_COMMAND_ABORTED");
    await result.reason.termination;
  }
  assert.deepEqual(workspace.getStats(), { active: 0, queued: 0, closed: true });
  assert.deepEqual(generic.getStats(), { active: 0, queued: 0, closed: false });
  assert.equal((await generic.run(node, ["-e", "process.exit(0)"])).status, 0);
});
