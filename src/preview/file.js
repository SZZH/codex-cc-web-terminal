import fs from "node:fs";
import path from "node:path";
import { assertReadableArtifact, previewError } from "./registry.js";
import { mediaType } from "./media.js";

const MIME = { ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript", ".mjs": "application/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".woff": "font/woff", ".woff2": "font/woff2", ".wasm": "application/wasm" };

function parseRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if (first !== null && !Number.isSafeInteger(first) || last !== null && !Number.isSafeInteger(last)) return null;
  const start = first === null ? Math.max(0, size - last) : first;
  const end = first !== null && last !== null ? Math.min(size - 1, last) : size - 1;
  return start > end || start >= size ? null : { start, end };
}

function matchesIfRange(value, headers) {
  if (!value) return true;
  if (value === headers.ETag) return true;
  // Weak entity tags and non-HTTP dates must never validate a partial response.
  const date = Date.parse(value);
  return Number.isFinite(date) && new Date(date).toUTCString() === value && date === Date.parse(headers["Last-Modified"]);
}

/** Shared by the isolated preview gateway and the authenticated same-origin media route. */
export function servePreviewFile(req, res, entry, relativePath, config, { mediaOnly = false } = {}) {
  let requested;
  try { requested = decodeURIComponent(relativePath); } catch { throw previewError("文件地址无效。"); }
  const target = requested === `${entry.id}--${entry.title}` ? entry.path : path.resolve(entry.root, requested);
  const relation = path.relative(entry.root, target);
  if (relation.startsWith("..") || path.isAbsolute(relation)) throw previewError("关联资源超出预览目录。", 403);
  const artifact = assertReadableArtifact(target);
  const dataRoot = fs.realpathSync(config.dataDir);
  if (artifact.path === dataRoot || artifact.path.startsWith(`${dataRoot}${path.sep}`)) throw previewError("服务内部数据不可预览。", 403);
  const canonicalRelation = path.relative(entry.root, artifact.path);
  if (canonicalRelation.startsWith("..") || path.isAbsolute(canonicalRelation)) throw previewError("关联资源超出预览目录。", 403);
  if (artifact.path !== entry.path && !/\.(?:html?|css|m?js|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp4|webm|mp3|wav|wasm)$/i.test(artifact.path)) {
    throw previewError("此文件不是当前预览的关联资源。", 403);
  }
  const media = mediaType(artifact.path);
  if (mediaOnly && (artifact.path !== entry.path || !media)) throw previewError("此预览不是可播放的音视频文件。", 403);
  const size = artifact.stat.size;
  const headers = { "Content-Type": media?.contentType || MIME[path.extname(target).toLowerCase()] || "application/octet-stream", "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=0, must-revalidate", "Last-Modified": artifact.stat.mtime.toUTCString(), ETag: `"${size}-${artifact.stat.mtimeMs}"` };
  if (req.headers["if-none-match"] === headers.ETag) { res.writeHead(304, headers); res.end(); return; }
  let start = 0, end = size - 1, status = 200;
  if (req.headers.range && matchesIfRange(req.headers["if-range"], headers)) {
    const range = parseRange(req.headers.range, size);
    if (!range) { res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}`, "Content-Length": 0 }); res.end(); return; }
    ({ start, end } = range);
    status = 206; headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  }
  headers["Content-Length"] = Math.max(0, end - start + 1);
  res.writeHead(status, headers);
  if (req.method === "HEAD" || !size) { res.end(); return; }
  const stream = fs.createReadStream(artifact.path, { start, end });
  stream.on("error", () => res.destroy()); res.on("close", () => stream.destroy()); stream.pipe(res);
}
