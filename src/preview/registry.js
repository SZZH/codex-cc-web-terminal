import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export const previewError = (message, status = 400) => Object.assign(new Error(message), { status });
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);
const TOKEN = /^[a-zA-Z0-9_-]{32}$/;
const CANCELLATION_TTL_MS = 5 * 60 * 1000;
const MAX_CANCELLATIONS = 200;
const forbiddenName = (name) => /^(?:\.env(?:\..*)?|auth(?:-sessions)?\.json|preview-grants\.json|access\.json|frp\.token|id_(?:rsa|ed25519|dsa)(?:\.pub)?|.*\.(?:key|pem|p12|pfx))$/i.test(name);

export function assertReadableArtifact(filePath) {
  if (filePath.includes("\0") || /(?:^|[\\/])\.(?:ssh|aws|codex|claude|config|git)(?:[\\/]|$)/.test(filePath) || forbiddenName(path.basename(filePath))) {
    throw previewError("此文件不属于可预览的文档或项目产物。", 403);
  }
  let canonical, stat;
  try { canonical = fs.realpathSync(filePath); stat = fs.statSync(canonical); }
  catch (error) {
    throw previewError(error.code === "EACCES" ? "没有读取此文件的权限。" : "文件已移动、删除或尚未生成。", error.code === "EACCES" ? 403 : 404);
  }
  if (!stat.isFile() || /^(?:\/dev|\/proc|\/sys)(?:\/|$)/.test(canonical)) throw previewError("只能预览普通文件。", 400);
  if (canonical !== filePath && (/[/\\]\.(?:ssh|aws|codex|claude|config|git)(?:[/\\]|$)/.test(canonical) || forbiddenName(path.basename(canonical)))) throw previewError("无法预览受保护文件。", 403);
  return { path: canonical, stat };
}

export class PreviewRegistry {
  constructor(config, { now = Date.now } = {}) {
    this.config = config; this.now = now; this.entries = new Map(); this.cancelledRequests = new Map();
    this.removalListeners = new Set();
    this.file = path.join(config.dataDir, "preview-grants.json");
    this.servicePorts = config.previewServicePorts || [3212, 3213, 3214, 3215];
    try {
      const values = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const entry of values) {
        if (!TOKEN.test(entry.id) || entry.expiresAt <= now()) continue;
        if (entry.kind === "cancelled") this.cancelledRequests.set(entry.id, entry.expiresAt);
        else if (entry.kind === "file" || entry.kind === "service" && this.servicePorts.includes(entry.port)) this.entries.set(entry.id, entry);
      }
      this.pruneCancellations();
    } catch { /* Grants can be recreated by reopening their original chat links. */ }
  }

  pruneCancellations() {
    for (const [id, expiresAt] of this.cancelledRequests) if (expiresAt <= this.now()) this.cancelledRequests.delete(id);
    while (this.cancelledRequests.size > MAX_CANCELLATIONS) this.cancelledRequests.delete(this.cancelledRequests.keys().next().value);
  }

  persist() {
    for (const [id, entry] of this.entries) if (entry.expiresAt <= this.now()) this.entries.delete(id);
    while (this.entries.size > 200) this.entries.delete(this.entries.keys().next().value);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    this.pruneCancellations();
    // Keep cancellations in the existing private store so a restart cannot revive a late POST.
    const cancellations = [...this.cancelledRequests].map(([id, expiresAt]) => ({ kind: "cancelled", id, expiresAt }));
    fs.writeFileSync(temporary, JSON.stringify([...this.entries.values(), ...cancellations]), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  get(id, port) {
    if (!TOKEN.test(String(id || ""))) throw previewError("预览地址无效。", 404);
    const entry = this.entries.get(id);
    if (!entry || entry.expiresAt <= this.now()) throw previewError("预览已过期，请返回会话重新打开。", 410);
    if (port && entry.port !== port) throw previewError("预览地址不匹配。", 403);
    return entry;
  }

  register({ target, cwd = "", requestId } = {}) {
    let value = String(target || "").trim();
    if (!value || value.length > 8192 || value.includes("\0")) throw previewError("文件或网页地址无效。");
    let entry;
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
      const blocked = new Set([this.config.port, this.config.previewPort, ...this.servicePorts, 5260, 7000, 7400, 7500, 8012, 8777]);
      if (!LOCAL_HOSTS.has(url.hostname) || port < 1024 || blocked.has(port) || url.username || url.password) {
        throw previewError("只能预览明确启动的本地项目服务。", 403);
      }
      if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
      const origin = url.origin;
      this.pruneCancellations();
      if (requestId !== undefined) {
        if (typeof requestId !== "string" || !TOKEN.test(requestId)) throw previewError("预览请求标识无效。");
        if (this.cancelledRequests.has(requestId)) throw previewError("此预览请求已取消，请重新打开。", 409);
        const existing = this.entries.get(requestId);
        if (existing && existing.expiresAt > this.now()) {
          if (existing.kind !== "service" || existing.target !== url.href) throw previewError("预览请求标识已用于其他地址。", 409);
          return existing;
        }
      }
      const occupied = new Set([...this.entries.values()].filter((item) => item.kind === "service" && item.expiresAt > this.now()).map((item) => item.port));
      const slotPort = this.servicePorts.find((candidate) => !occupied.has(candidate));
      if (!slotPort) throw previewError("网页预览已满，请关闭一个预览后重试。", 409);
      entry = { kind: "service", origin, target: url.href, port: slotPort, title: `网页预览 · ${port}`, id: requestId };
    } else {
      if (requestId !== undefined) throw previewError("文件预览不接受客户端授权标识。");
      if (/^file:\/\//i.test(value)) {
        let url;
        try { url = new URL(value); value = fileURLToPath(url); } catch { throw previewError("文件地址无效。"); }
      } else {
        if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) throw previewError("不支持此预览地址。");
        value = value.replace(/#(?:L?\d+(?:[-:]L?\d+)?)$/, "").replace(/:\d+(?::\d+)?$/, "");
      }
      const filePath = path.isAbsolute(value) ? value : cwd && path.isAbsolute(cwd) ? path.resolve(cwd, value) : "";
      if (!filePath) throw previewError("相对文件链接缺少工作目录。");
      const artifact = assertReadableArtifact(path.resolve(filePath));
      const dataRoot = fs.realpathSync(this.config.dataDir);
      if (artifact.path === dataRoot || artifact.path.startsWith(`${dataRoot}${path.sep}`)) throw previewError("服务内部数据不能作为文件预览。", 403);
      const version = `${artifact.stat.mtimeMs}:${artifact.stat.size}`;
      const existing = [...this.entries.values()].find((item) => item.kind === "file" && item.path === artifact.path && item.version === version && item.expiresAt > this.now());
      entry = { kind: "file", path: artifact.path, root: path.dirname(artifact.path), version,
        port: this.config.previewPort || 3211, title: path.basename(artifact.path), id: existing?.id };
    }
    entry.id ||= randomBytes(24).toString("base64url");
    entry.expiresAt = this.now() + 12 * 60 * 60 * 1000;
    this.entries.set(entry.id, entry); this.persist();
    return entry;
  }

  remove(id) {
    if (typeof id !== "string" || !TOKEN.test(id)) throw previewError("预览请求标识无效。");
    this.entries.delete(id);
    this.cancelledRequests.delete(id);
    this.cancelledRequests.set(id, this.now() + CANCELLATION_TTL_MS);
    for (const listener of this.removalListeners) listener(id);
    this.persist();
  }
}
