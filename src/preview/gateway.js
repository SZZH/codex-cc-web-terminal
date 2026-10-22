import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProxyMiddleware } from "http-proxy-middleware";
import { assertReadableArtifact, previewError } from "./registry.js";

const MIME = { ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript", ".mjs": "application/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".woff": "font/woff", ".woff2": "font/woff2", ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wasm": "application/wasm" };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function cookieValue(req, name) {
  return String(req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || "";
}

function fail(res, error) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(error.status || 502, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'", "X-Content-Type-Options": "nosniff" });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>预览暂不可用</title><style>body{font:16px/1.6 system-ui;padding:24px;color:#51463e;background:#faf7f3}h1{font-size:20px}</style><h1>预览暂不可用</h1><p>${escapeHtml(error.message || "请返回会话重新打开或稍后重试。")}</p>`);
}

export function previewOrigin(config, requestOrigin, port) {
  const source = new URL(requestOrigin);
  if (config.previewPublicOrigin && !["localhost", "127.0.0.1", "[::1]"].includes(source.hostname)) {
    const base = new URL(config.previewPublicOrigin);
    base.port = String(Number(base.port || 443) + port - (config.previewPort || 3211));
    return base.origin;
  }
  source.port = String(port); return source.origin;
}

/** Isolated origins, with routing and WebSocket forwarding delegated to http-proxy-middleware. */
export class PreviewGateway {
  constructor({ config, registry }) {
    this.config = config; this.registry = registry; this.servers = []; this.proxies = new Map();
    this.upgradedSockets = new Set();
    this.onRemove = (id) => { for (const socket of this.upgradedSockets) if (socket.previewId === id) socket.destroy(); };
    registry.removalListeners.add(this.onRemove);
    this.filePort = config.previewPort || 3211;
    this.ports = [this.filePort, ...registry.servicePorts];
  }

  safeHeaders(req, entry) {
    delete req.headers.authorization; delete req.headers["proxy-authorization"];
    delete req.headers["x-base-url"];
    if (entry.kind === "file") req.previewBaseUrl = `${req.headers["x-forwarded-proto"] === "https" ? "https" : "http"}://${req.headers.host}/viewer/`;
    for (const key of Object.keys(req.headers)) if (/^x-(?:forwarded-user|auth|original-url)/i.test(key)) delete req.headers[key];
    const prefix = `__previewapp_${entry.id}_`;
    req.previewId = entry.id;
    req.headers.cookie = String(req.headers.cookie || "").split(";").map((part) => part.trim())
      .filter((part) => part.startsWith(prefix)).map((part) => part.slice(prefix.length)).join("; ");
  }

  assertOrigin(req) {
    if (!req.headers.origin) return;
    try {
      const origin = new URL(req.headers.origin);
      if (origin.host === req.headers.host && ["http:", "https:"].includes(origin.protocol)) return;
    } catch { /* Reject malformed origins too. */ }
    throw previewError("预览请求来源不匹配。", 403);
  }

  proxy(target) {
    if (this.proxies.has(target)) return this.proxies.get(target);
    const proxy = createProxyMiddleware({ target, changeOrigin: true, cookieDomainRewrite: "", proxyTimeout: 30000,
      on: {
        proxyReq: (proxyReq, req) => {
          proxyReq.removeHeader("authorization"); proxyReq.removeHeader("proxy-authorization");
          if (req.previewBaseUrl) proxyReq.setHeader("X-Base-Url", req.previewBaseUrl);
          if (req.headers.origin) proxyReq.setHeader("Origin", target);
        },
        proxyReqWs: (proxyReq, req) => { if (req.headers.origin) proxyReq.setHeader("Origin", target); },
        proxyRes: (proxyRes, req) => {
          if (req.previewBaseUrl && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300 && /^\/viewer\/(?:js|css|bootstrap|pdfjs|fonts)\//.test(req.url)) {
            proxyRes.headers["cache-control"] = "private, max-age=86400";
          }
          const location = proxyRes.headers.location;
          if (location) {
            try { const url = new URL(location, target); if (url.origin === target) proxyRes.headers.location = url.pathname + url.search + url.hash; } catch { /* Preserve external redirects. */ }
          }
          if (proxyRes.headers["set-cookie"]) proxyRes.headers["set-cookie"] = proxyRes.headers["set-cookie"]
            .filter((value) => !value.startsWith(`${this.config.authSessionCookieName || "codex_web_term_session"}=`) && !value.startsWith("__codex_preview_"))
            .map((value) => `__previewapp_${req.previewId}_${value}${/;\s*HttpOnly(?:;|$)/i.test(value) ? "" : "; HttpOnly"}`);
        },
        error: (_error, _req, res) => { if (typeof res.writeHead === "function") fail(res, previewError("预览服务未启动或连接已中断，请返回会话重试。", 503)); else res.destroy(); }
      }
    });
    this.proxies.set(target, proxy); return proxy;
  }

  file(req, res, entry, relativePath) {
    let requested;
    try { requested = decodeURIComponent(relativePath); } catch { throw previewError("文件地址无效。"); }
    const target = requested === `${entry.id}--${entry.title}` ? entry.path : path.resolve(entry.root, requested);
    const relation = path.relative(entry.root, target);
    if (relation.startsWith("..") || path.isAbsolute(relation)) throw previewError("关联资源超出预览目录。", 403);
    const artifact = assertReadableArtifact(target);
    const dataRoot = fs.realpathSync(this.config.dataDir);
    if (artifact.path === dataRoot || artifact.path.startsWith(`${dataRoot}${path.sep}`)) throw previewError("服务内部数据不可预览。", 403);
    const canonicalRelation = path.relative(entry.root, artifact.path);
    if (canonicalRelation.startsWith("..") || path.isAbsolute(canonicalRelation)) throw previewError("关联资源超出预览目录。", 403);
    if (artifact.path !== entry.path && !/\.(?:html?|css|m?js|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp4|webm|mp3|wav|wasm)$/i.test(artifact.path)) {
      throw previewError("此文件不是当前预览的关联资源。", 403);
    }
    const size = artifact.stat.size;
    const headers = { "Content-Type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream", "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=0, must-revalidate", "Last-Modified": artifact.stat.mtime.toUTCString(), ETag: `"${size}-${artifact.stat.mtimeMs}"` };
    if (req.headers["if-none-match"] === headers.ETag) { res.writeHead(304, headers); res.end(); return; }
    let start = 0, end = size - 1, status = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); res.end(); return; }
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
      if (start > end || start >= size) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); res.end(); return; }
      status = 206; headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    }
    headers["Content-Length"] = Math.max(0, end - start + 1);
    res.writeHead(status, headers);
    if (req.method === "HEAD" || !size) { res.end(); return; }
    const stream = fs.createReadStream(artifact.path, { start, end });
    stream.on("error", () => res.destroy()); res.on("close", () => stream.destroy()); stream.pipe(res);
  }

  validateViewerRequest(url, entry) {
    if (!["/viewer/onlinePreview", "/viewer/getCorsFile", "/viewer/picturesPreview"].includes(url.pathname)) return;
    const names = url.pathname.endsWith("onlinePreview") ? ["url"] : url.pathname.endsWith("getCorsFile") ? ["urlPath"] : ["urls"];
    for (const name of names) {
      let source = url.searchParams.get(name);
      if (!source) throw previewError("文件预览地址无效。");
      if (!/^https?:\/\//i.test(source)) source = Buffer.from(source, "base64").toString("utf8");
      for (const value of source.split("|")) {
        let requested;
        try { requested = new URL(value); } catch { throw previewError("文件预览地址无效。"); }
        const allowed = `/__file/${entry.id}/${encodeURIComponent(`${entry.id}--${entry.title}`)}`;
        const parameters = [...requested.searchParams];
        if (requested.origin !== `http://127.0.0.1:${this.filePort}` || requested.pathname !== allowed ||
          requested.username || requested.password || requested.hash || parameters.length !== 1 ||
          parameters[0][0] !== "v" || parameters[0][1] !== entry.version) {
          throw previewError("此预览只能读取已选择的文件。", 403);
        }
      }
    }
  }

  handle(req, res, port) {
    try {
      const url = new URL(req.url, "http://preview.local");
      if (url.pathname === "/__preview_health") { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}'); return; }
      if (url.pathname === "/__preview_assets.js") {
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
        fs.createReadStream(fileURLToPath(new URL("../../scripts/preview/markdown-assets.js", import.meta.url))).pipe(res); return;
      }
      if (url.pathname.startsWith("/_open/")) {
        const id = url.pathname.slice(7), entry = this.registry.get(id, port);
        const secure = req.headers["x-forwarded-proto"] === "https";
        const cookie = `__codex_preview_${port}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure ? "; Secure" : ""}`;
        let location;
        if (entry.kind === "service") { const original = new URL(entry.target); location = original.pathname + original.search + original.hash; }
        else {
          const resource = `/__file/${id}/${encodeURIComponent(/\.html?$/i.test(entry.title) ? entry.title : `${entry.id}--${entry.title}`)}`;
          if (/\.html?$/i.test(entry.title)) location = resource;
          else {
            const source = `http://127.0.0.1:${this.filePort}${resource}?v=${encodeURIComponent(entry.version)}`;
            location = `/viewer/onlinePreview?url=${encodeURIComponent(Buffer.from(source).toString("base64"))}`;
          }
        }
        res.writeHead(302, { Location: location, "Set-Cookie": cookie, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
          ...(entry.kind === "service" ? { "Clear-Site-Data": '"storage", "cache"' } : {}) }); res.end(); return;
      }
      if (port === this.filePort && url.pathname.startsWith("/__file/")) {
        const match = /^\/__file\/([^/]+)\/(.*)$/.exec(url.pathname);
        if (!match || !["GET", "HEAD"].includes(req.method)) throw previewError("文件地址无效。", 400);
        const entry = this.registry.get(match[1], port);
        if (entry.kind !== "file") throw previewError("文件地址无效。");
        this.file(req, res, entry, match[2]); return;
      }
      let grantId = cookieValue(req, `__codex_preview_${port}`);
      if (port === this.filePort && ["/viewer/onlinePreview", "/viewer/getCorsFile", "/viewer/picturesPreview"].includes(decodeURIComponent(url.pathname))) {
        const encoded = url.searchParams.get("url") || url.searchParams.get("urlPath") || url.searchParams.get("urls");
        if (encoded) {
          try {
            const source = new URL(/^https?:\/\//i.test(encoded) ? encoded : Buffer.from(encoded, "base64").toString("utf8"));
            const match = /^\/__file\/([^/]+)\//.exec(source.pathname);
            if (source.origin === `http://127.0.0.1:${this.filePort}` && match) grantId = match[1];
          } catch { /* The validation below reports malformed viewer sources. */ }
        }
      }
      const entry = this.registry.get(grantId, port);
      if (req.headers["service-worker"] === "script") throw previewError("预览模式不注册离线服务。", 403);
      if (entry.kind === "file" && !url.pathname.startsWith("/viewer/")) throw previewError("请从会话打开文件预览。", 404);
      if (entry.kind === "file") {
        if (!["GET", "HEAD"].includes(req.method)) throw previewError("文件预览为只读。", 403);
        let canonicalPath;
        try { canonicalPath = decodeURIComponent(url.pathname); } catch { throw previewError("预览资源地址无效。"); }
        if (/%(?:2f|5c|25)/i.test(url.pathname) || /[;\\\x00-\x1f]/.test(canonicalPath) || canonicalPath.split("/").some((part) => part === "." || part === "..")) throw previewError("预览资源地址不是标准路径。", 403);
        if (/^\/viewer\/(?:delete|upload|addTask|fileUpload|directory)/i.test(canonicalPath)) throw previewError("文件预览为只读。", 403);
        this.validateViewerRequest({ pathname: canonicalPath, searchParams: url.searchParams }, entry);
      }
      this.assertOrigin(req);
      this.safeHeaders(req, entry);
      this.proxy(entry.kind === "service" ? entry.origin : this.config.kkFileViewUrl || "http://127.0.0.1:8012")(req, res, () => fail(res, previewError("预览资源不存在。", 404)));
    } catch (error) { fail(res, error); }
  }

  async start() {
    for (const port of this.ports) {
      const server = http.createServer((req, res) => this.handle(req, res, port));
      server.on("upgrade", (req, socket, head) => {
        try {
          const entry = this.registry.get(cookieValue(req, `__codex_preview_${port}`), port);
          if (entry.kind !== "service") throw new Error("No service");
          this.assertOrigin(req);
          this.upgradedSockets.add(socket);
          socket.previewId = entry.id;
          const expiry = setTimeout(() => socket.destroy(), Math.max(1, entry.expiresAt - Date.now())); expiry.unref?.();
          socket.once("close", () => { clearTimeout(expiry); this.upgradedSockets.delete(socket); });
          this.safeHeaders(req, entry); this.proxy(entry.origin).upgrade(req, socket, head);
        } catch { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); }
      });
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, this.config.previewHost || "127.0.0.1", resolve); });
      this.servers.push(server);
    }
  }
  async close() {
    for (const socket of this.upgradedSockets) socket.destroy(); this.upgradedSockets.clear();
    this.registry.removalListeners.delete(this.onRemove);
    await Promise.all(this.servers.map((server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); })));
    this.servers = [];
  }
}
