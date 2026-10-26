import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const REQUEST_TERMINAL_STATES = new Set(["completed", "failed", "interrupted", "rejected", "cancelled", "removed", "superseded"]);
const STATES = new Set(["received", "dispatching", "queued", "accepted", "running", "unknown", ...REQUEST_TERMINAL_STATES]);
const ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;
const MAX_RECENT_REQUESTS = 200;

function error(message, status = 400) { return Object.assign(new Error(message), { status }); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function publicRecord(record) {
  const { fingerprint, ...receipt } = record;
  return structuredClone(receipt);
}

// This journal stores submissions only. Codex remains the owner of conversation history.
export class CodexRequestStore {
  constructor({ dataDir, now = () => new Date().toISOString() }) {
    this.root = path.join(dataDir, "codex-requests");
    this.now = now;
    this.nextOrder = Date.now() * 1000;
    this.indexes = new Map();
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.recoverDispatchedRequests();
  }

  indexRecord(record) {
    let index = this.indexes.get(record.threadId);
    if (!index) {
      index = { recent: new Map(), pending: new Map() };
      this.indexes.set(record.threadId, index);
    }
    const entry = { id: record.id, order: record.order || Date.parse(record.createdAt) * 1000 };
    index.recent.set(record.id, entry);
    if (REQUEST_TERMINAL_STATES.has(record.state)) index.pending.delete(record.id);
    else index.pending.set(record.id, entry);
    if (index.recent.size > MAX_RECENT_REQUESTS) {
      const oldest = [...index.recent.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      for (const item of oldest.slice(0, oldest.length - MAX_RECENT_REQUESTS)) index.recent.delete(item.id);
    }
  }

  directory(threadId) {
    if (!String(threadId || "").trim()) throw error("Missing thread ID");
    return path.join(this.root, createHash("sha256").update(String(threadId)).digest("hex"));
  }

  filename(threadId, id) {
    if (!ID_PATTERN.test(String(id || ""))) throw error("Invalid client request ID");
    return path.join(this.directory(threadId), `${id}.json`);
  }

  read(threadId, id) {
    const filename = this.filename(threadId, id);
    if (!fs.existsSync(filename)) return null;
    const record = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (record.threadId !== threadId || record.id !== id || !STATES.has(record.state)) throw error("Invalid persisted request", 500);
    return record;
  }

  write(record) {
    const filename = this.filename(record.threadId, record.id);
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify(record));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(temporary, filename);
      if (process.platform !== "win32") {
        const directory = fs.openSync(path.dirname(filename), "r");
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
    } finally {
      if (fd != null) fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    this.indexRecord(record);
    return publicRecord(record);
  }

  receive(threadId, { clientRequestId, input, options = {}, mode = "queue", expectedTurnId = null, questionReply }) {
    this.filename(threadId, clientRequestId);
    if (!["queue", "steer"].includes(mode)) throw error("Invalid submission mode");
    const data = { input, options, mode, expectedTurnId, ...(questionReply ? { questionReply } : {}) };
    const encoded = JSON.stringify(stable(data));
    if (Buffer.byteLength(encoded) > 1024 * 1024) throw error("Message exceeds the 1 MiB limit", 413);
    const fingerprint = createHash("sha256").update(encoded).digest("hex");
    const existing = this.read(threadId, clientRequestId);
    if (existing) {
      const legacyFingerprint = existing.mode == null && mode === "queue" && !expectedTurnId
        ? createHash("sha256").update(JSON.stringify(stable({ input, options }))).digest("hex") : null;
      if (existing.fingerprint !== fingerprint && existing.fingerprint !== legacyFingerprint) throw error("这个请求编号已用于不同内容。", 409);
      return publicRecord(existing);
    }
    const time = this.now();
    return this.write({ id: clientRequestId, threadId, state: "received", ...structuredClone(data), fingerprint,
      order: ++this.nextOrder, createdAt: time, updatedAt: time, turnId: null, userItemId: null, error: null });
  }

  get(threadId, id) {
    const record = this.read(threadId, id);
    return record ? publicRecord(record) : null;
  }

  update(threadId, id, patch) {
    const record = this.read(threadId, id);
    if (!record) throw error("Request not found", 404);
    if (patch.state && !STATES.has(patch.state)) throw error("Invalid request state");
    const observedExecution = record.state === "removed" && record.executionRoute === "desktopQueue"
      && patch.turnId && patch.userItemId && ["accepted", "running"].includes(patch.state);
    if (REQUEST_TERMINAL_STATES.has(record.state) && patch.state && !REQUEST_TERMINAL_STATES.has(patch.state)
      && !observedExecution) return publicRecord(record);
    return this.write({ ...record, ...patch, id, threadId, input: record.input, options: record.options,
      fingerprint: record.fingerprint, createdAt: record.createdAt, updatedAt: this.now() });
  }

  list(threadId, { limit = 100 } = {}) {
    const index = this.indexes.get(threadId);
    if (!index) return [];
    const byOrder = (a, b) => a.order - b.order || a.id.localeCompare(b.id);
    const recent = [...index.recent.values()].sort(byOrder).slice(-Math.max(1, Math.min(MAX_RECENT_REQUESTS, limit)));
    const ids = new Set([...recent, ...index.pending.values()].map((entry) => entry.id));
    return [...ids].map((id) => this.get(threadId, id)).filter(Boolean)
      .sort((a, b) => byOrder({ id: a.id, order: a.order || Date.parse(a.createdAt) * 1000 },
        { id: b.id, order: b.order || Date.parse(b.createdAt) * 1000 }));
  }

  pendingThreadIds() {
    return [...this.indexes].filter(([, index]) => index.pending.size > 0).map(([threadId]) => threadId);
  }

  recoverDispatchedRequests() {
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      for (const name of fs.readdirSync(path.join(this.root, entry.name))) {
        if (!name.endsWith(".json")) continue;
        const record = JSON.parse(fs.readFileSync(path.join(this.root, entry.name, name), "utf8"));
        this.nextOrder = Math.max(this.nextOrder, Number(record.order) || 0);
        if (["dispatching", "unknown"].includes(record.state) && record.executionRoute === "desktopSteer" &&
          record.promotionPhase === "claimed" && !record.turnId && !record.userItemId) {
          this.write({ ...record, state: "rejected", updatedAt: this.now(),
            error: { code: "steer_rejected", message: "服务重启前已取出排队消息，但尚未发送引导。原文已保留，可恢复到输入框。" } });
        } else if (["dispatching", "accepted", "running"].includes(record.state)) {
          this.write({ ...record, state: "unknown", updatedAt: this.now(),
            error: { code: "confirmation_required", message: "服务已重启，正在核对上一条消息是否已执行。不会自动重发。" } });
        } else this.indexRecord(record);
      }
    }
  }
}
