import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceCommandError } from "./command.js";

const failure = (code, message) => new WorkspaceCommandError(message, { code });
const keyFor = (cwd, operation, args, generation) => JSON.stringify([cwd, operation, args, generation]);

export function createWorkspaceJobs({ runner, resolveWorkspace, maxConcurrent = 4, maxResolving = 4, maxQueued = 64, maxWaiters = 128 } = {}) {
  if (typeof runner?.run !== "function" || typeof resolveWorkspace !== "function"
    || ![maxConcurrent, maxResolving, maxQueued, maxWaiters].every((value) => Number.isInteger(value) && value > 0)) throw new TypeError("Invalid workspace job configuration");
  const entries = new Set();
  const admissions = [];
  const roots = new Map();
  const reads = new Map();
  const workers = new Set();
  let generation = 0;
  let sequence = 0;
  let resolving = 0;
  let active = 0;
  let waiters = 0;
  let closed = false;
  const queuedCount = () => [...entries].filter((entry) => entry.state !== "active").length;

  function forget(entry) {
    clearTimeout(entry.timer);
    for (const key of entry.keys) if (reads.get(key) === entry) reads.delete(key);
    entry.keys.clear();
    const admission = admissions.indexOf(entry);
    if (admission >= 0) admissions.splice(admission, 1);
    if (entry.root) {
      const queued = entry.root.queue.indexOf(entry);
      if (queued >= 0) entry.root.queue.splice(queued, 1);
      if (!entry.root.active && !entry.root.queue.length && roots.get(entry.workspace.repoRoot) === entry.root) roots.delete(entry.workspace.repoRoot);
    }
    entry.fn = null;
    entry.args = null;
    entries.delete(entry);
  }

  function settleSubscriber(subscriber, error, value) {
    if (subscriber.settled) return;
    if (!error && Date.now() >= subscriber.deadline) error = new WorkspaceCommandError("Workspace job deadline exceeded", {
      code: "WORKSPACE_JOB_TIMEOUT", executionState: subscriber.entry.context?.executionState || "not-applied"
    });
    subscriber.settled = true;
    clearTimeout(subscriber.timer);
    subscriber.signal?.removeEventListener("abort", subscriber.abort);
    subscriber.entry.subscribers.delete(subscriber);
    waiters -= 1;
    if (error) subscriber.reject(error);
    else subscriber.resolve(value);
  }

  function settle(entry, error, value) {
    if (entry.settled) return;
    if (!error && Date.now() >= entry.deadline) error = failure("WORKSPACE_JOB_TIMEOUT", "Workspace job deadline exceeded");
    entry.settled = true;
    if (error) error = Object.assign(new WorkspaceCommandError(error.message, { cause: error }), error, {
      code: error.code || "WORKSPACE_JOB_FAILED", executionState: entry.context?.executionState || "not-applied"
    });
    for (const subscriber of [...entry.subscribers]) settleSubscriber(subscriber, error, value);
    forget(entry);
  }

  function abortEntry(entry, error) {
    if (entry.settled || entry.controller.signal.aborted) return;
    entry.error = error;
    entry.controller.abort(error);
    if (entry.state !== "active") {
      settle(entry, error);
      flushAdmissions();
      drain();
    }
  }

  function checkRunning(entry) {
    if (Date.now() >= entry.deadline && !entry.controller.signal.aborted) abortEntry(entry, failure("WORKSPACE_JOB_TIMEOUT", "Workspace job deadline exceeded"));
    if (entry.controller.signal.aborted) throw entry.error || failure("WORKSPACE_JOB_ABORTED", "Workspace job aborted");
    if (entry.settled) throw failure("WORKSPACE_JOB_CLOSED", "Workspace job already settled");
  }

  function subscribe(entry, { signal, deadline }) {
    return new Promise((resolve, reject) => {
      const subscriber = { entry, signal, deadline, resolve, reject, settled: false };
      const detach = (error) => {
        if (entry.mode === "write") abortEntry(subscriber.entry, error);
        else {
          settleSubscriber(subscriber, error);
          if (!subscriber.entry.subscribers.size) abortEntry(subscriber.entry, error);
        }
      };
      subscriber.abort = () => detach(failure("WORKSPACE_JOB_ABORTED", "Workspace job aborted"));
      subscriber.timer = setTimeout(() => detach(failure("WORKSPACE_JOB_TIMEOUT", "Workspace job deadline exceeded")), Math.max(1, deadline - Date.now()));
      signal?.addEventListener("abort", subscriber.abort, { once: true });
      entry.subscribers.add(subscriber);
      waiters += 1;
    });
  }

  function createContext(entry, workspace, allowMutation) {
    const outcomes = [];
    const pending = new Set();
    const commands = new Set();
    const terminations = [];
    const track = (promise, command = false) => {
      const tracked = promise.then(() => {}, () => {}).finally(() => { pending.delete(tracked); commands.delete(tracked); });
      pending.add(tracked);
      if (command) commands.add(tracked);
      return promise;
    };
    const context = {
      ...workspace, deadline: entry.deadline, signal: entry.controller.signal,
      get executionState() {
        if (outcomes.some((outcome) => outcome.state === "unknown")) return "unknown";
        return outcomes.some((outcome) => outcome.state === "applied") ? "applied" : "not-applied";
      },
      runCommand(file, argv, options = {}) {
        try { checkRunning(entry); } catch (error) { return Promise.reject(error); }
        if (options.mutates && !allowMutation) return Promise.reject(failure("WORKSPACE_JOB_READ_ONLY", "Read jobs and workspace resolution cannot mutate files"));
        if (options.mutates && context.executionState === "unknown") return Promise.reject(failure("WORKSPACE_JOB_UNCERTAIN", "Workspace write state is unknown; inspect it before another write"));
        const outcome = { state: "not-applied" };
        outcomes.push(outcome);
        const promise = runner.run(file, argv, { ...options, cwd: options.cwd || workspace.cwd,
          deadline: Math.min(options.deadline ?? Infinity, entry.deadline), signal: entry.controller.signal })
          .then((result) => { outcome.state = result.executionState; return result; }, (error) => {
            outcome.state = error.executionState || "not-applied";
            outcome.error = error;
            if (error.termination) terminations.push(error.termination);
            throw error;
          });
        return track(promise, true);
      },
      mutate(fn) {
        if (!allowMutation) return Promise.reject(failure("WORKSPACE_JOB_READ_ONLY", "Read jobs and workspace resolution cannot mutate files"));
        if (context.executionState === "unknown") return Promise.reject(failure("WORKSPACE_JOB_UNCERTAIN", "Workspace write state is unknown; inspect it before another write"));
        if (typeof fn !== "function") return Promise.reject(failure("WORKSPACE_JOB_INVALID", "Workspace mutation requires a function"));
        const outcome = { state: "not-applied" };
        outcomes.push(outcome);
        return track(Promise.resolve().then(() => {
          checkRunning(entry);
          outcome.state = "unknown";
          return fn({ signal: entry.controller.signal, deadline: entry.deadline });
        }).then((result) => { outcome.state = "applied"; checkRunning(entry); return result; }, (error) => { outcome.error = error; throw error; }));
      }
    };
    return { context, terminations, uncertainError: () => outcomes.find((outcome) => outcome.state === "unknown")?.error,
      async finishOperations() { while (pending.size) await Promise.all([...pending]); },
      async finishCommands() { while (commands.size) await Promise.all([...commands]); } };
  }

  async function execute(entry) {
    active += 1;
    entry.state = "active";
    const root = entry.root;
    root.active = true;
    root.activeEntry = entry;
    const lifecycle = createContext(entry, entry.workspace, entry.mode === "write");
    entry.context = lifecycle.context;
    const aborted = new Promise((_, reject) => { entry.onAbort = () => reject(entry.error || failure("WORKSPACE_JOB_ABORTED", "Workspace job aborted")); });
    entry.controller.signal.addEventListener("abort", entry.onAbort, { once: true });
    let value;
    let error;
    try { value = await Promise.race([Promise.resolve().then(() => { checkRunning(entry); return entry.fn(lifecycle.context); }), aborted]); }
    catch (cause) { error = cause instanceof Error ? cause : new Error(String(cause)); }
    const finished = lifecycle.finishOperations();
    try { await Promise.race([finished, aborted]); }
    catch (cause) { error ||= cause; }
    if (entry.controller.signal.aborted) await lifecycle.finishCommands();
    try { checkRunning(entry); } catch (cause) { error ||= cause; }
    if (!error && lifecycle.context.executionState === "unknown") error = lifecycle.uncertainError() || failure("WORKSPACE_JOB_UNCERTAIN", "Workspace write state is unknown");
    entry.controller.signal.removeEventListener("abort", entry.onAbort);
    settle(entry, error, value);
    // A timed-out write may report uncertainty, but keeps its lock until close.
    await finished;
    await Promise.allSettled(lifecycle.terminations);
    active -= 1;
    root.active = false;
    root.activeEntry = null;
    if (!root.queue.length) roots.delete(entry.workspace.repoRoot);
    drain();
  }

  function drain() {
    if (closed) return;
    for (const [repoRoot, root] of roots) {
      while (root.queue[0]?.settled) root.queue.shift();
      if (!root.active && root.queue.length && active < maxConcurrent) {
        const candidate = root.queue[0];
        const overlaps = [...roots].some(([otherPath, other]) => other.active && other.activeEntry
          && (candidate.mode === "write" || other.activeEntry.mode === "write")
          && (repoRoot === otherPath || repoRoot.startsWith(otherPath.endsWith(path.sep) ? otherPath : otherPath + path.sep)
            || otherPath.startsWith(repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep)));
        if (overlaps) continue;
        const entry = root.queue.shift();
        if (entry.controller.signal.aborted || Date.now() >= entry.deadline) abortEntry(entry, failure("WORKSPACE_JOB_TIMEOUT", "Workspace job deadline exceeded"));
        else trackWorker(execute(entry));
      }
      if (!root.active && !root.queue.length) roots.delete(repoRoot);
    }
  }

  function flushAdmissions() {
    // Resolve concurrently, then admit in submission order so aliases stay FIFO.
    while (admissions.length && (admissions[0].settled || admissions[0].state === "resolved")) {
      const entry = admissions.shift();
      if (entry.settled) continue;
      try { checkRunning(entry); } catch { continue; }
      const key = entry.mode === "read" ? keyFor(entry.workspace.cwd, entry.operation, entry.args, entry.generation) : "";
      const shared = key && reads.get(key);
      if (shared && shared !== entry && !shared.settled) {
        const owner = shared.sequence < entry.sequence ? shared : entry;
        const merged = owner === shared ? entry : shared;
        for (const subscriber of merged.subscribers) { subscriber.entry = owner; owner.subscribers.add(subscriber); }
        merged.subscribers.clear();
        reads.set(key, owner);
        owner.keys.add(key);
        merged.error = failure("WORKSPACE_JOB_ABORTED", "Workspace read merged into its earliest submission");
        merged.controller.abort(merged.error);
        merged.settled = true;
        forget(merged);
        if (owner !== entry) continue;
      }
      if (key) { reads.set(key, entry); entry.keys.add(key); }
      let root = roots.get(entry.workspace.repoRoot);
      if (!root) { root = { queue: [], active: false }; roots.set(entry.workspace.repoRoot, root); }
      entry.root = root;
      entry.state = "queued";
      root.queue.push(entry);
    }
    drain();
  }

  async function resolveEntry(entry) {
    resolving += 1;
    entry.state = "resolving";
    const lifecycle = createContext(entry, { cwd: entry.cwd }, false);
    try {
      const cwd = await fs.realpath(entry.cwd);
      if (!(await fs.stat(cwd)).isDirectory()) throw failure("WORKSPACE_JOB_INVALID", "Invalid workspace directory");
      checkRunning(entry);
      const workspace = await resolveWorkspace(cwd, lifecycle.context);
      await lifecycle.finishOperations();
      checkRunning(entry);
      const repoRoot = await fs.realpath(workspace.repoRoot || cwd);
      checkRunning(entry);
      if (typeof workspace.isGitRepo !== "boolean") throw failure("WORKSPACE_JOB_INVALID", "Workspace resolver must provide isGitRepo");
      entry.workspace = { ...workspace, cwd, repoRoot };
      entry.state = "resolved";
    } catch (error) {
      await lifecycle.finishOperations();
      settle(entry, error instanceof Error ? error : new Error(String(error)));
      await Promise.allSettled(lifecycle.terminations);
    } finally {
      resolving -= 1;
      flushAdmissions();
      startResolvers();
    }
  }

  function startResolvers() {
    if (closed) return;
    for (const entry of admissions) {
      if (resolving >= maxResolving) break;
      if (!entry.settled && entry.state === "new") trackWorker(resolveEntry(entry));
    }
  }

  function trackWorker(promise) {
    workers.add(promise);
    promise.then(() => workers.delete(promise), () => workers.delete(promise));
  }

  function run(options, fn) {
    const { cwd, operation, args = [], mode = "read", signal } = options || {};
    const timeoutMs = options?.timeoutMs ?? (mode === "write" ? 15000 : 5000);
    const deadline = Math.min(options?.deadline ?? Infinity, Date.now() + timeoutMs);
    let key;
    let savedArgs;
    try { savedArgs = JSON.parse(JSON.stringify(args)); key = keyFor(path.resolve(cwd), operation, savedArgs, generation); }
    catch { return Promise.reject(failure("WORKSPACE_JOB_INVALID", "Invalid workspace job arguments")); }
    if (!["read", "write"].includes(mode) || typeof operation !== "string" || !operation || typeof fn !== "function"
      || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(deadline)) return Promise.reject(failure("WORKSPACE_JOB_INVALID", "Invalid workspace job options"));
    if (closed) return Promise.reject(failure("WORKSPACE_JOB_CLOSED", "Workspace jobs are closed"));
    if (signal?.aborted) return Promise.reject(failure("WORKSPACE_JOB_ABORTED", "Workspace job aborted"));
    if (deadline <= Date.now()) return Promise.reject(failure("WORKSPACE_JOB_TIMEOUT", "Workspace job deadline exceeded"));
    if (waiters >= maxWaiters) return Promise.reject(failure("WORKSPACE_JOB_QUEUE_FULL", "Workspace job waiters are full"));
    const shared = mode === "read" && reads.get(key);
    if (shared && !shared.settled) return subscribe(shared, { signal, deadline });
    if (queuedCount() + active >= maxQueued + maxConcurrent) return Promise.reject(failure("WORKSPACE_JOB_QUEUE_FULL", "Workspace job queue is full"));
    if (mode === "write") generation += 1;
    const entry = { cwd: path.resolve(cwd), operation, args: savedArgs, mode, fn, deadline, generation, sequence: ++sequence, state: "new", keys: new Set(), subscribers: new Set(), controller: new AbortController(), settled: false };
    entries.add(entry);
    admissions.push(entry);
    if (mode === "read") { reads.set(key, entry); entry.keys.add(key); }
    entry.timer = setTimeout(() => abortEntry(entry, failure("WORKSPACE_JOB_TIMEOUT", "Workspace job deadline exceeded")), Math.max(1, deadline - Date.now()));
    const promise = subscribe(entry, { signal, deadline });
    startResolvers();
    return promise;
  }

  async function close() {
    closed = true;
    for (const entry of [...entries]) abortEntry(entry, failure("WORKSPACE_JOB_ABORTED", "Workspace jobs closed"));
    await runner.close?.();
    await Promise.allSettled([...workers]);
    roots.clear();
  }

  return { run, close, getStats: () => ({ active, resolving, queued: queuedCount(), waiters, reads: reads.size, roots: roots.size, closed }) };
}
