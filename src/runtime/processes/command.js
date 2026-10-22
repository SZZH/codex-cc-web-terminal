import { spawn } from "node:child_process";

export class CommandError extends Error {
  constructor(message, { code, executionState = "not-applied", cause, ...details } = {}) {
    super(message, { cause });
    this.name = "CommandError";
    Object.assign(this, { code, executionState, ...details });
  }
}

function terminateTree(child, force) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // taskkill /T includes Git filters/hooks; Windows has no POSIX process groups.
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill("SIGKILL"));
    killer.on("exit", (code) => { if (code !== 0) child.kill("SIGKILL"); });
    return;
  }
  try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); }
  catch (error) { if (error.code !== "ESRCH") child.kill(force ? "SIGKILL" : "SIGTERM"); }
}

function processGroupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

export function createCommandRunner({ maxConcurrent = 4, maxQueued = 64, killGraceMs = 100, closeTimeoutMs = 1500,
  errorPrefix = "PROCESS_COMMAND", ErrorClass = CommandError, commandLabel = "Command" } = {}) {
  if (![maxConcurrent, maxQueued].every((value) => Number.isInteger(value) && value > 0)
    || ![killGraceMs, closeTimeoutMs].every((value) => Number.isFinite(value) && value >= 0)) throw new TypeError(`Invalid ${commandLabel.toLowerCase()} limits`);
  const failure = (code, message, details = {}) => new ErrorClass(message, { code: `${errorPrefix}_${code}`, ...details });
  const queue = [];
  const active = new Set();
  let closed = false;

  function state(item, success = false) {
    return !item.options.mutates || !item.spawned ? "not-applied" : success || item.confirmedSuccess ? "applied" : "unknown";
  }

  function clearWaits(item) {
    clearTimeout(item.timer);
    item.options.signal?.removeEventListener("abort", item.abort);
  }

  function settle(item, error, result) {
    if (item.settled) return;
    item.settled = true;
    clearWaits(item);
    if (error) {
      Object.assign(error, { executionState: state(item), spawned: item.spawned, closed: item.closed, termination: item.termination });
      item.reject(error);
    } else item.resolve(result);
  }

  function stop(item, error) {
    if (item.closed || item.error) return;
    item.error = error;
    if (!item.child) {
      const index = queue.indexOf(item);
      if (index >= 0) queue.splice(index, 1);
      item.closed = true;
      item.confirmClosed();
      settle(item, error);
      drain();
      return;
    }
    terminateTree(item.child, false);
    item.killTimer = setTimeout(() => terminateTree(item.child, true), killGraceMs);
    item.closeTimer = setTimeout(() => {
      // Keep the slot and termination promise until close is actually observed.
      settle(item, error);
    }, killGraceMs + closeTimeoutMs);
  }

  function complete(item, error, result) {
    item.closed = true;
    clearTimeout(item.killTimer);
    clearTimeout(item.closeTimer);
    clearTimeout(item.treeTimer);
    item.confirmClosed();
    active.delete(item);
    settle(item, error, result);
    drain();
  }

  function finish(item, error, result) {
    if (!error || !item.spawned || process.platform === "win32") return complete(item, error, result);
    item.error ||= error;
    terminateTree(item.child, true);
    // Parent close does not confirm that filters/hooks sharing its group stopped.
    const confirmTree = () => {
      if (!processGroupExists(item.child.pid)) complete(item, error, result);
      else item.treeTimer = setTimeout(confirmTree, 10);
    };
    item.closeTimer ||= setTimeout(() => settle(item, error), closeTimeoutMs);
    confirmTree();
  }

  function start(item) {
    active.add(item);
    const options = item.options;
    try {
      item.child = spawn(item.file, item.args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env, LC_ALL: "C", LANG: "C" },
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
      });
      item.spawned = Boolean(item.child.pid);
    } catch (cause) {
      item.closed = true;
      item.confirmClosed();
      active.delete(item);
      settle(item, failure("SPAWN", cause.message, { cause, spawnCode: cause.code }));
      drain();
      return;
    }
    const stdout = [];
    const stderr = [];
    const sizes = { stdout: 0, stderr: 0 };
    const output = (name, chunks, chunk) => {
      const remaining = options.maxBuffer - sizes[name];
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      sizes[name] += chunk.length;
      if (sizes[name] > options.maxBuffer) stop(item, failure("OUTPUT_LIMIT", `${commandLabel} ${name} exceeds ${options.maxBuffer} bytes`));
    };
    item.child.stdout.on("data", (chunk) => output("stdout", stdout, chunk));
    item.child.stderr.on("data", (chunk) => output("stderr", stderr, chunk));
    item.child.on("error", (cause) => {
      item.error ||= failure("SPAWN", cause.message, { cause, spawnCode: cause.code });
    });
    item.child.on("close", (status, signal) => {
      item.confirmedSuccess = !item.error && !signal && options.acceptedExitCodes.includes(status);
      const result = { status, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), executionState: state(item, true) };
      let error = item.error || (signal
        ? failure("SIGNAL", `${commandLabel} exited on ${signal}`)
        : !options.acceptedExitCodes.includes(status)
          ? failure("EXIT", result.stderr.trim() || result.stdout.trim() || `${commandLabel} exited with status ${status}`)
          : null);
      if (!error && Date.now() >= item.deadline) error = failure("TIMEOUT", `${commandLabel} deadline exceeded`);
      if (error) Object.assign(error, result, { executionState: state(item) });
      finish(item, error, result);
    });
    if (item.child.stdin) {
      item.child.stdin.on("error", (cause) => stop(item, failure("INPUT", cause.message, { cause })));
      item.child.stdin.end(options.input);
    }
  }

  function drain() {
    while (!closed && active.size < maxConcurrent && queue.length) {
      const item = queue.shift();
      if (Date.now() >= item.deadline) stop(item, failure("TIMEOUT", `${commandLabel} deadline exceeded`));
      else start(item);
    }
  }

  function run(file, args = [], options = {}) {
    const acceptedExitCodes = options.acceptedExitCodes ?? [0];
    const maxBuffer = options.maxBuffer ?? 500_000;
    const timeoutMs = options.timeoutMs ?? 5000;
    const deadline = Math.min(options.deadline ?? Infinity, Date.now() + timeoutMs);
    if (typeof file !== "string" || !file || !Array.isArray(args) || !args.every((arg) => typeof arg === "string")
      || !Array.isArray(acceptedExitCodes) || !acceptedExitCodes.length || !acceptedExitCodes.every(Number.isInteger)
      || !Number.isInteger(maxBuffer) || maxBuffer < 1 || !Number.isFinite(deadline) || !Number.isFinite(timeoutMs) || timeoutMs <= 0
      || options.input !== undefined && typeof options.input !== "string" && !(options.input instanceof Uint8Array)) {
      return Promise.reject(failure("INVALID", `Invalid ${commandLabel.toLowerCase()} options`));
    }
    if (closed) return Promise.reject(failure("CLOSED", `${commandLabel} runner is closed`));
    if (options.signal?.aborted) return Promise.reject(failure("ABORTED", `${commandLabel} aborted`));
    if (deadline <= Date.now()) return Promise.reject(failure("TIMEOUT", `${commandLabel} deadline exceeded`));
    if (queue.length >= maxQueued) return Promise.reject(failure("QUEUE_FULL", `${commandLabel} queue is full`));
    return new Promise((resolve, reject) => {
      const item = { file, args: [...args], options: { ...options, maxBuffer, acceptedExitCodes: [...acceptedExitCodes] }, deadline, resolve, reject, spawned: false, closed: false, settled: false };
      item.termination = new Promise((confirm) => { item.confirmClosed = confirm; });
      item.abort = () => stop(item, failure("ABORTED", `${commandLabel} aborted`));
      item.timer = setTimeout(() => stop(item, failure("TIMEOUT", `${commandLabel} deadline exceeded`)), Math.max(1, deadline - Date.now()));
      options.signal?.addEventListener("abort", item.abort, { once: true });
      queue.push(item);
      drain();
    });
  }

  async function close() {
    closed = true;
    const items = [...queue, ...active];
    for (const item of items) stop(item, failure("ABORTED", `${commandLabel} runner closed`));
    await Promise.all(items.map((item) => item.termination));
  }

  return { run, close, getStats: () => ({ active: active.size, queued: queue.length, closed }) };
}
