import fs from "node:fs/promises";
import { CommandError, createCommandRunner } from "../../runtime/processes/command.js";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export function createSidebarReadRuntime({ globalStatePath, stateDbPath, columns, publish,
  runner = createCommandRunner({ maxConcurrent: 2, maxQueued: 32 }), fileSystem = fs, timeoutMs = 5000 } = {}) {
  const sources = { global: { generation: 0, signature: null, pending: null }, threads: { generation: 0, signature: null, pending: null } };
  const pending = new Set();
  const controller = new AbortController();
  const counts = { queries: 0, globalReads: 0, cacheHits: 0 };
  let closed = false;
  let closing = null;

  async function fileVersion(file) {
    try {
      const stat = await fileSystem.stat(file, { bigint: true });
      if (!stat.isFile()) throw new Error("Sidebar source is not a file");
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
    } catch (error) {
      if (error.code === "ENOENT") return "missing";
      throw error;
    }
  }

  async function signature(kind) {
    if (kind === "global") return fileVersion(globalStatePath);
    const versions = await Promise.allSettled([fileVersion(stateDbPath), fileVersion(stateDbPath + "-wal")]);
    const failed = versions.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    return JSON.stringify(versions.map((result) => result.value));
  }

  function checkDeadline(deadline) {
    if (controller.signal.aborted) throw new CommandError("Sidebar reader closed", { code: "PROCESS_COMMAND_ABORTED" });
    if (Date.now() >= deadline) throw new CommandError("Sidebar read deadline exceeded", { code: "PROCESS_COMMAND_TIMEOUT" });
  }

  async function query(sql, deadline) {
    checkDeadline(deadline);
    counts.queries += 1;
    const result = await runner.run("sqlite3", ["-readonly", "-cmd", ".timeout 2000", "-json", stateDbPath, sql], {
      maxBuffer: MAX_OUTPUT_BYTES, timeoutMs, deadline, signal: controller.signal
    });
    const rows = JSON.parse(result.stdout.trim() || "[]");
    if (!Array.isArray(rows)) throw new Error("Invalid SQLite response");
    return rows;
  }

  async function load(kind, deadline) {
    if (kind === "global") {
      counts.globalReads += 1;
      const value = JSON.parse(await fileSystem.readFile(globalStatePath, { encoding: "utf8", signal: controller.signal }));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid global state");
      return value;
    }
    const available = new Set((await query("pragma table_info(threads)", deadline)).map((column) => column.name));
    if (!available.has("id")) throw new Error("Codex threads table is unavailable");
    const fields = columns.map((column) => available.has(column) ? `"${column}"` : `null as "${column}"`);
    return query(`select ${fields.join(", ")} from threads`, deadline);
  }

  function invalidate(kind) {
    // A synchronous compatibility read owns publication from this point onward.
    sources[kind].generation += 1;
    sources[kind].signature = null;
  }

  function read(kind) {
    if (closed) return Promise.reject(new CommandError("Sidebar reader is closed", { code: "SIDEBAR_READ_CLOSED" }));
    const source = sources[kind];
    if (source.pending?.generation === source.generation) return source.pending.promise;
    if (pending.size >= 32) {
      source.signature = null;
      publish(kind, { error: new CommandError("Sidebar read queue is full", { code: "SIDEBAR_READ_QUEUE_FULL" }) });
      return Promise.resolve();
    }
    const generation = source.generation;
    const deadline = Date.now() + timeoutMs;
    const task = { generation, promise: null };
    source.pending = task;
    task.promise = (async () => {
      try {
        const before = await signature(kind);
        checkDeadline(deadline);
        if (source.signature === before) { counts.cacheHits += 1; return; }
        if (kind === "threads" && JSON.parse(before)[0] === "missing") {
          throw Object.assign(new Error("Codex state database is unavailable"), { code: "ENOENT" });
        }
        const value = await load(kind, deadline);
        const after = await signature(kind);
        checkDeadline(deadline);
        if (!closed && source.generation === generation) {
          source.signature = before === after ? before : null;
          publish(kind, { value });
        }
      } catch (error) {
        if (closed) throw new CommandError("Sidebar reader closed", { code: "PROCESS_COMMAND_ABORTED", cause: error });
        if (!closed && source.generation === generation) {
          source.signature = null;
          publish(kind, { error });
        }
      } finally {
        if (source.pending === task) source.pending = null;
        pending.delete(task.promise);
      }
    })();
    pending.add(task.promise);
    return task.promise;
  }

  function close() {
    if (closing) return closing;
    closed = true;
    invalidate("global"); invalidate("threads");
    controller.abort();
    closing = Promise.allSettled([runner.close(), ...pending]).then(() => {});
    return closing;
  }

  return { readGlobal: () => read("global"), readThreads: () => read("threads"), invalidate, close,
    getStats: () => ({ ...counts, ...runner.getStats(), pending: pending.size, closed }) };
}
