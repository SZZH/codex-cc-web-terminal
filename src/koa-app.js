import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Koa from "koa";

import { handleAuthRoute } from "./routes/auth.js";
import { handleConfigRoute } from "./routes/config.js";
import { handleHistoryRoute } from "./routes/history.js";
import { handleSessionRoute } from "./routes/sessions.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");
const webDistDir = path.join(__dirname, "..", "web", "dist");
const directoryBrowserLimit = 400;

export function createKoaApp({ config, sessionManager }) {
  const runtime = {
    config,
    sessionManager,
    authSessions: new Map(),
    loginAttempts: new Map(),
    startedAt: Date.now(),
    shuttingDown: false,
    wss: null
  };

  runtime.nowMs = () => Date.now();
  runtime.responseHeaders = (extraHeaders = {}) => ({
    "Cache-Control": "no-store",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...extraHeaders
  });
  runtime.json = (ctx, statusCode, payload, extraHeaders = {}) => {
    ctx.status = statusCode;
    ctx.set(runtime.responseHeaders(extraHeaders));
    ctx.type = "application/json; charset=utf-8";
    ctx.body = `${JSON.stringify(payload)}\n`;
  };
  runtime.unauthorized = (ctx) => {
    runtime.json(ctx, 401, { error: "Unauthorized" });
  };
  runtime.readBody = (req) =>
    new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 2_000_000) {
          reject(new Error("Request body too large."));
        }
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  runtime.readBodyBuffer = (req, limitBytes = 2_000_000) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let settled = false;

      const cleanup = () => {
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", onError);
        req.off("aborted", onAborted);
        req.off("close", onClose);
      };

      const finishResolve = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      };

      const finishReject = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      const onData = (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > limitBytes) {
          finishReject(new Error("Request body too large."));
          try {
            req.destroy();
          } catch {
            // no-op
          }
          return;
        }
        chunks.push(buffer);
      };

      const onEnd = () => finishResolve(Buffer.concat(chunks));
      const onError = (err) => finishReject(err);
      const onAborted = () => finishReject(new Error("Request body aborted by client."));
      const onClose = () => {
        if (!settled) {
          finishReject(new Error("Request body stream closed before end."));
        }
      };

      req.on("data", onData);
      req.on("end", onEnd);
      req.on("error", onError);
      req.on("aborted", onAborted);
      req.on("close", onClose);
    });
  runtime.parseCookies = (req) => {
    const raw = String(req.headers.cookie || "");
    const cookies = {};
    for (const pair of raw.split(/;\s*/)) {
      if (!pair) {
        continue;
      }
      const index = pair.indexOf("=");
      if (index <= 0) {
        continue;
      }
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        // Ignore malformed cookie values rather than failing the whole request.
      }
    }
    return cookies;
  };
  runtime.serializeCookie = (name, value, options = {}) => {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    if (options.maxAge !== undefined) {
      parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
    }
    if (options.httpOnly !== false) {
      parts.push("HttpOnly");
    }
    if (options.sameSite) {
      parts.push(`SameSite=${options.sameSite}`);
    }
    if (options.path) {
      parts.push(`Path=${options.path}`);
    }
    if (options.secure) {
      parts.push("Secure");
    }
    return parts.join("; ");
  };
  runtime.clearAuthCookie = (ctx) => {
    ctx.set(
      "Set-Cookie",
      runtime.serializeCookie(runtime.config.authSessionCookieName, "", {
        maxAge: 0,
        path: "/",
        sameSite: "Lax",
        secure: runtime.config.secureCookies
      })
    );
  };
  runtime.createAuthSession = (req) => {
    const id = crypto.randomUUID();
    const expiresAt = runtime.nowMs() + runtime.config.authSessionTtlMs;
    runtime.authSessions.set(id, {
      id,
      expiresAt,
      ip: req.socket.remoteAddress || "",
      userAgent: String(req.headers["user-agent"] || "")
    });
    return { id, expiresAt };
  };
  runtime.pruneExpiredAuthSessions = () => {
    const current = runtime.nowMs();
    for (const [id, session] of runtime.authSessions) {
      if (session.expiresAt <= current) {
        runtime.authSessions.delete(id);
      }
    }
  };
  runtime.getClientAddress = (req) => String(req.socket.remoteAddress || "");
  runtime.normalizeIp = (address) => {
    const value = String(address || "").trim();
    if (!value) {
      return "";
    }
    if (value === "::1") {
      return "127.0.0.1";
    }
    if (value.startsWith("::ffff:")) {
      return value.slice(7);
    }
    return value;
  };
  runtime.ipv4ToInt = (address) => {
    const parts = runtime
      .normalizeIp(address)
      .split(".")
      .map((part) => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return null;
    }
    return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
  };
  runtime.isTailscaleIpv6 = (address) => runtime.normalizeIp(address).toLowerCase().startsWith("fd7a:115c:a1e0:");
  runtime.cidrContains = (cidr, address) => {
    const [baseAddress, prefixText] = String(cidr || "").split("/");
    const prefix = Number.parseInt(prefixText, 10);
    const baseInt = runtime.ipv4ToInt(baseAddress);
    const targetInt = runtime.ipv4ToInt(address);
    if (baseInt === null || targetInt === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
      return false;
    }
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (baseInt & mask) === (targetInt & mask);
  };
  runtime.getAllowedCidrs = () => {
    const cidrs = [...runtime.config.trustedCidrs];
    if (runtime.config.tailscaleOnly) {
      cidrs.push("100.64.0.0/10", "127.0.0.0/8");
    }
    return cidrs;
  };
  runtime.isAllowedClient = (req) => {
    const cidrs = runtime.getAllowedCidrs();
    if (cidrs.length === 0) {
      return true;
    }
    const clientIp = runtime.getClientAddress(req);
    if (runtime.config.tailscaleOnly && runtime.isTailscaleIpv6(clientIp)) {
      return true;
    }
    return cidrs.some((cidr) => runtime.cidrContains(cidr, clientIp));
  };
  runtime.isTrustedOrigin = (req) => {
    const origin = String(req.headers.origin || "").trim();
    if (!origin) {
      return true;
    }
    try {
      const originUrl = new URL(origin);
      const hostHeader = String(req.headers.host || "").trim();
      if (originUrl.host === hostHeader) {
        return true;
      }

      const hostName = hostHeader.split(":")[0].toLowerCase();
      const originHostName = originUrl.hostname.toLowerCase();
      const loopbacks = new Set(["127.0.0.1", "localhost", "::1"]);
      if (loopbacks.has(hostName) && loopbacks.has(originHostName)) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  };
  runtime.forbidCrossOrigin = (ctx) => {
    if (runtime.isTrustedOrigin(ctx.req)) {
      return false;
    }
    runtime.json(ctx, 403, { error: "Cross-origin request rejected" });
    return true;
  };
  runtime.pruneLoginAttempts = () => {
    const current = runtime.nowMs();
    for (const [key, state] of runtime.loginAttempts) {
      const windowExpired = state.windowStartedAt + runtime.config.authRateLimitWindowMs <= current;
      const blockExpired = state.blockUntil <= current;
      if (windowExpired && blockExpired) {
        runtime.loginAttempts.delete(key);
      }
    }
  };
  runtime.getLoginAttemptState = (req) => {
    runtime.pruneLoginAttempts();
    const key = runtime.getClientAddress(req);
    const current = runtime.nowMs();
    const existing = runtime.loginAttempts.get(key);
    if (!existing) {
      return {
        key,
        state: {
          windowStartedAt: current,
          failedAttempts: 0,
          blockUntil: 0
        }
      };
    }

    if (existing.windowStartedAt + runtime.config.authRateLimitWindowMs <= current) {
      existing.windowStartedAt = current;
      existing.failedAttempts = 0;
      existing.blockUntil = 0;
    }

    return { key, state: existing };
  };
  runtime.isLoginBlocked = (req) => runtime.getLoginAttemptState(req).state.blockUntil > runtime.nowMs();
  runtime.recordFailedLogin = (req) => {
    const { key, state } = runtime.getLoginAttemptState(req);
    state.failedAttempts += 1;
    if (state.failedAttempts >= runtime.config.authRateLimitMaxAttempts) {
      state.blockUntil = runtime.nowMs() + runtime.config.authRateLimitBlockMs;
    }
    runtime.loginAttempts.set(key, state);
  };
  runtime.clearFailedLogins = (req) => {
    runtime.loginAttempts.delete(runtime.getClientAddress(req));
  };
  runtime.constantTimeEquals = (a, b) => {
    const left = Buffer.from(String(a || ""), "utf8");
    const right = Buffer.from(String(b || ""), "utf8");
    if (left.length !== right.length) {
      return false;
    }
    return crypto.timingSafeEqual(left, right);
  };
  runtime.getAuthSession = (req) => {
    runtime.pruneExpiredAuthSessions();
    const cookies = runtime.parseCookies(req);
    const id = cookies[runtime.config.authSessionCookieName];
    if (!id) {
      return null;
    }
    const session = runtime.authSessions.get(id) || null;
    if (!session) {
      return null;
    }
    if (session.expiresAt <= runtime.nowMs()) {
      runtime.authSessions.delete(id);
      return null;
    }
    session.expiresAt = runtime.nowMs() + runtime.config.authSessionTtlMs;
    return session;
  };
  runtime.isAuthorized = (req) => Boolean(runtime.getAuthSession(req));
  runtime.requireAuthorized = (ctx) => {
    if (!runtime.isAuthorized(ctx.req)) {
      runtime.clearAuthCookie(ctx);
      runtime.unauthorized(ctx);
      return false;
    }
    return true;
  };
  runtime.healthPayload = () => ({
    ok: true,
    shuttingDown: runtime.shuttingDown,
    uptimeSeconds: Math.floor((runtime.nowMs() - runtime.startedAt) / 1000),
    authSessions: runtime.authSessions.size,
    rateLimitedClients: [...runtime.loginAttempts.values()].filter((state) => state.blockUntil > runtime.nowMs()).length,
    wsClients: runtime.wss?.clients.size || 0,
    ...runtime.sessionManager.stats()
  });
  runtime.serveFile = (ctx, filePath, contentType) => {
    ctx.status = 200;
    ctx.set(runtime.responseHeaders());
    ctx.type = contentType;
    ctx.body = fs.createReadStream(filePath);
  };
  runtime.frontendRootDir = () => webDistDir;
  runtime.resolveAsset = (rootDir, pathname) => {
    const normalizedPath = pathname === "/" ? "/index.html" : pathname;
    const safePath = path.normalize(normalizedPath).replace(/^(\.\.[/\\])+/, "");
    const resolvedPath = path.join(rootDir, safePath);
    if (!resolvedPath.startsWith(rootDir)) {
      return null;
    }
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
      return null;
    }
    return resolvedPath;
  };
  runtime.contentTypeForFile = (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case ".html":
        return "text/html; charset=utf-8";
      case ".js":
        return "application/javascript; charset=utf-8";
      case ".css":
        return "text/css; charset=utf-8";
      case ".json":
        return "application/json; charset=utf-8";
      case ".svg":
        return "image/svg+xml";
      case ".png":
        return "image/png";
      case ".jpg":
      case ".jpeg":
        return "image/jpeg";
      case ".webp":
        return "image/webp";
      case ".woff":
        return "font/woff";
      case ".woff2":
        return "font/woff2";
      default:
        return "application/octet-stream";
    }
  };
  runtime.tryServeFrontendAsset = (ctx, pathname) => {
    for (const rootDir of [webDistDir, publicDir]) {
      const filePath = runtime.resolveAsset(rootDir, pathname);
      if (!filePath) {
        continue;
      }
      runtime.serveFile(ctx, filePath, runtime.contentTypeForFile(filePath));
      return true;
    }
    return false;
  };
  runtime.serveFrontendIndex = (ctx) => {
    const filePath = path.join(runtime.frontendRootDir(), "index.html");
    if (!fs.existsSync(filePath)) {
      runtime.json(ctx, 503, { error: "Frontend assets are missing. Run `npm run web:build` first." });
      return;
    }
    runtime.serveFile(ctx, filePath, "text/html; charset=utf-8");
  };
  runtime.parseJson = (body) => {
    if (!body) {
      return {};
    }
    return JSON.parse(body);
  };
  runtime.resolveBrowserPath = (rawPath) => {
    const requested = String(rawPath || "").trim();
    const resolved = path.resolve(requested || runtime.config.defaultCwd);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Path does not exist: ${resolved}`);
    }
    return resolved;
  };
  runtime.listDirectoryPayload = (rawPath) => {
    const resolved = runtime.resolveBrowserPath(rawPath);
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolved}`);
    }

    const entries = [];
    for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
      const fullPath = path.join(resolved, entry.name);
      try {
        const entryStat = fs.statSync(fullPath);
        let type = "other";
        if (entryStat.isDirectory()) {
          type = "directory";
        } else if (entryStat.isFile()) {
          type = "file";
        }

        entries.push({
          name: entry.name,
          path: fullPath,
          type,
          size: entryStat.isFile() ? entryStat.size : null
        });
      } catch {
        // Ignore entries that cannot be read.
      }
    }

    entries.sort((left, right) => {
      if (left.type !== right.type) {
        if (left.type === "directory") {
          return -1;
        }
        if (right.type === "directory") {
          return 1;
        }
      }
      return left.name.localeCompare(right.name, undefined, {
        numeric: true,
        sensitivity: "base"
      });
    });

    const rootPath = path.parse(resolved).root;
    return {
      path: resolved,
      parentPath: resolved === rootPath ? null : path.dirname(resolved),
      rootPath,
      entries: entries.slice(0, directoryBrowserLimit),
      totalEntries: entries.length,
      truncated: entries.length > directoryBrowserLimit
    };
  };
  runtime.routeVendor = (ctx, pathname) => {
    const vendorMap = {
      "/vendor/xterm.css": path.join(process.cwd(), "node_modules", "xterm", "css", "xterm.css"),
      "/vendor/xterm.js": path.join(process.cwd(), "node_modules", "xterm", "lib", "xterm.js"),
      "/vendor/xterm-addon-fit.js": path.join(
        process.cwd(),
        "node_modules",
        "@xterm",
        "addon-fit",
        "lib",
        "addon-fit.js"
      ),
      "/vendor/vue.js": path.join(process.cwd(), "node_modules", "vue", "dist", "vue.global.prod.js")
    };

    const filePath = vendorMap[pathname];
    if (!filePath) {
      return false;
    }

    const contentType = pathname.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8";
    runtime.serveFile(ctx, filePath, contentType);
    return true;
  };

  const app = new Koa();
  app.use(async (ctx, next) => {
    ctx.set(runtime.responseHeaders());
    ctx.state.auth = {
      isAuthorized: () => runtime.isAuthorized(ctx.req),
      getAuthSession: () => runtime.getAuthSession(ctx.req)
    };
    try {
      await next();
    } catch (err) {
      ctx.app.emit("error", err, ctx);
      if (ctx.headerSent) {
        throw err;
      }
      runtime.json(ctx, 500, { error: err?.message || String(err) });
    }
  });

  app.use(async (ctx, next) => {
    if (runtime.shuttingDown && ctx.path !== "/api/health") {
      runtime.json(ctx, 503, { error: "Server is restarting", retryable: true });
      return;
    }

    if (!runtime.isAllowedClient(ctx.req)) {
      const clientIp = runtime.normalizeIp(runtime.getClientAddress(ctx.req));
      console.warn(`[access] denied client=${clientIp || "unknown"} url=${ctx.url || ""}`);
      runtime.json(ctx, 403, { error: "Client address is not allowed", clientIp });
      return;
    }

    if (ctx.method === "GET" && !ctx.path.startsWith("/api/")) {
      if (runtime.routeVendor(ctx, ctx.path)) {
        return;
      }
      if (runtime.tryServeFrontendAsset(ctx, ctx.path)) {
        return;
      }
      if (!path.extname(ctx.path)) {
        runtime.serveFrontendIndex(ctx);
        return;
      }
    }

    if (ctx.path === "/") {
      runtime.serveFrontendIndex(ctx);
      return;
    }

    const handled = [handleAuthRoute, handleConfigRoute, handleHistoryRoute, handleSessionRoute];
    for (const route of handled) {
      if (await route(ctx, runtime)) {
        return;
      }
    }

    await next();
    if (ctx.body == null && ctx.status === 404) {
      ctx.body = "Not found";
    }
  });

  app.on("error", (err, ctx) => {
    const pathInfo = ctx?.path || "unknown";
    console.warn(`[koa] error path=${pathInfo} error=${err?.message || String(err)}`);
  });

  return { app, runtime };
}
