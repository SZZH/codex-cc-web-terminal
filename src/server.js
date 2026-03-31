import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

import { config } from "./config.js";
import { SessionManager } from "./sessionManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");
const webDistDir = path.join(__dirname, "..", "web", "dist");

const sessionManager = new SessionManager(config);
const authSessions = new Map();
const loginAttempts = new Map();
const startedAt = nowMs();
let shuttingDown = false;
let shutdownPromise = null;
const directoryBrowserLimit = 400;

function nowMs() {
  return Date.now();
}

function responseHeaders(extraHeaders = {}) {
  return {
    "Cache-Control": "no-store",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...extraHeaders
  };
}

function json(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...responseHeaders(extraHeaders)
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

function unauthorized(res) {
  json(res, 401, { error: "Unauthorized" });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
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
}

function parseCookies(req) {
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
    cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

function serializeCookie(name, value, options = {}) {
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
}

function clearAuthCookie(res) {
  res.setHeader(
    "Set-Cookie",
    serializeCookie(config.authSessionCookieName, "", {
      maxAge: 0,
      path: "/",
      sameSite: "Lax",
      secure: config.secureCookies
    })
  );
}

function createAuthSession(req) {
  const id = crypto.randomUUID();
  const expiresAt = nowMs() + config.authSessionTtlMs;
  authSessions.set(id, {
    id,
    expiresAt,
    ip: req.socket.remoteAddress || "",
    userAgent: String(req.headers["user-agent"] || "")
  });
  return { id, expiresAt };
}

function pruneExpiredAuthSessions() {
  const current = nowMs();
  for (const [id, session] of authSessions) {
    if (session.expiresAt <= current) {
      authSessions.delete(id);
    }
  }
}

function getClientAddress(req) {
  return String(req.socket.remoteAddress || "");
}

function normalizeIp(address) {
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
}

function ipv4ToInt(address) {
  const parts = normalizeIp(address).split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function isTailscaleIpv6(address) {
  const normalized = normalizeIp(address).toLowerCase();
  return normalized.startsWith("fd7a:115c:a1e0:");
}

function cidrContains(cidr, address) {
  const [baseAddress, prefixText] = String(cidr || "").split("/");
  const prefix = Number.parseInt(prefixText, 10);
  const baseInt = ipv4ToInt(baseAddress);
  const targetInt = ipv4ToInt(address);
  if (baseInt === null || targetInt === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (baseInt & mask) === (targetInt & mask);
}

function getAllowedCidrs() {
  const cidrs = [...config.trustedCidrs];
  if (config.tailscaleOnly) {
    cidrs.push("100.64.0.0/10", "127.0.0.0/8");
  }
  return cidrs;
}

function isAllowedClient(req) {
  const cidrs = getAllowedCidrs();
  if (cidrs.length === 0) {
    return true;
  }
  const clientIp = getClientAddress(req);
  if (config.tailscaleOnly && isTailscaleIpv6(clientIp)) {
    return true;
  }
  return cidrs.some((cidr) => cidrContains(cidr, clientIp));
}

function isTrustedOrigin(req) {
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

    // Dev-mode compatibility: allow loopback cross-port requests,
    // e.g. Vite dev server (127.0.0.1:5173) -> API server (127.0.0.1:3210).
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
}

function forbidCrossOrigin(req, res) {
  if (isTrustedOrigin(req)) {
    return false;
  }
  json(res, 403, { error: "Cross-origin request rejected" });
  return true;
}

function pruneLoginAttempts() {
  const current = nowMs();
  for (const [key, state] of loginAttempts) {
    const windowExpired = state.windowStartedAt + config.authRateLimitWindowMs <= current;
    const blockExpired = state.blockUntil <= current;
    if (windowExpired && blockExpired) {
      loginAttempts.delete(key);
    }
  }
}

function getLoginAttemptState(req) {
  pruneLoginAttempts();
  const key = getClientAddress(req);
  const current = nowMs();
  const existing = loginAttempts.get(key);
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

  if (existing.windowStartedAt + config.authRateLimitWindowMs <= current) {
    existing.windowStartedAt = current;
    existing.failedAttempts = 0;
    existing.blockUntil = 0;
  }

  return { key, state: existing };
}

function isLoginBlocked(req) {
  const { state } = getLoginAttemptState(req);
  return state.blockUntil > nowMs();
}

function recordFailedLogin(req) {
  const { key, state } = getLoginAttemptState(req);
  state.failedAttempts += 1;
  if (state.failedAttempts >= config.authRateLimitMaxAttempts) {
    state.blockUntil = nowMs() + config.authRateLimitBlockMs;
  }
  loginAttempts.set(key, state);
}

function clearFailedLogins(req) {
  loginAttempts.delete(getClientAddress(req));
}

function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function getAuthSession(req) {
  pruneExpiredAuthSessions();
  const cookies = parseCookies(req);
  const id = cookies[config.authSessionCookieName];
  if (!id) {
    return null;
  }
  const session = authSessions.get(id) || null;
  if (!session) {
    return null;
  }
  if (session.expiresAt <= nowMs()) {
    authSessions.delete(id);
    return null;
  }
  session.expiresAt = nowMs() + config.authSessionTtlMs;
  return session;
}

function isAuthorized(req) {
  return Boolean(getAuthSession(req));
}

function healthPayload() {
  return {
    ok: true,
    shuttingDown,
    uptimeSeconds: Math.floor((nowMs() - startedAt) / 1000),
    authSessions: authSessions.size,
    rateLimitedClients: [...loginAttempts.values()].filter((state) => state.blockUntil > nowMs()).length,
    wsClients: wss.clients.size,
    ...sessionManager.stats()
  };
}

async function shutdown(signal = "unknown") {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shuttingDown = true;
  shutdownPromise = new Promise((resolve) => {
    for (const ws of wss.clients) {
      try {
        ws.close(1012, `Server restarting (${signal})`);
      } catch {
        ws.terminate();
      }
    }

    server.close(() => {
      clearInterval(heartbeatInterval);
      sessionManager.shutdown();
      resolve();
    });

    setTimeout(() => {
      sessionManager.shutdown();
      resolve();
    }, 3000).unref();
  });

  return shutdownPromise;
}

function serveFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  res.writeHead(200, responseHeaders({ "Content-Type": contentType }));
  fs.createReadStream(filePath).pipe(res);
}

function frontendRootDir() {
  return webDistDir;
}

function resolveFrontendAsset(pathname) {
  const rootDir = frontendRootDir();
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
}

function contentTypeForFile(filePath) {
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
}

function tryServeFrontendAsset(res, pathname) {
  const filePath = resolveFrontendAsset(pathname);
  if (!filePath) {
    return false;
  }
  serveFile(res, filePath, contentTypeForFile(filePath));
  return true;
}

function serveFrontendIndex(res) {
  const filePath = path.join(frontendRootDir(), "index.html");
  if (!fs.existsSync(filePath)) {
    json(res, 503, { error: "Frontend assets are missing. Run `npm run web:build` first." });
    return;
  }
  serveFile(res, filePath, "text/html; charset=utf-8");
}

function parseJson(body) {
  if (!body) {
    return {};
  }

  return JSON.parse(body);
}

function resolveBrowserPath(rawPath) {
  const requested = String(rawPath || "").trim();
  const resolved = path.resolve(requested || config.defaultCwd);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }
  return resolved;
}

function listDirectoryPayload(rawPath) {
  const resolved = resolveBrowserPath(rawPath);
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
}

function routeVendor(res, pathname) {
  const vendorMap = {
    "/vendor/xterm.css": path.join(
      process.cwd(),
      "node_modules",
      "xterm",
      "css",
      "xterm.css"
    ),
    "/vendor/xterm.js": path.join(
      process.cwd(),
      "node_modules",
      "xterm",
      "lib",
      "xterm.js"
    ),
    "/vendor/xterm-addon-fit.js": path.join(
      process.cwd(),
      "node_modules",
      "@xterm",
      "addon-fit",
      "lib",
      "addon-fit.js"
    ),
    "/vendor/vue.js": path.join(
      process.cwd(),
      "node_modules",
      "vue",
      "dist",
      "vue.global.prod.js"
    )
  };

  const filePath = vendorMap[pathname];
  if (!filePath) {
    return false;
  }

  const contentType =
    pathname.endsWith(".css")
      ? "text/css; charset=utf-8"
      : "application/javascript; charset=utf-8";
  serveFile(res, filePath, contentType);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");

  if (shuttingDown && url.pathname !== "/api/health") {
    json(res, 503, { error: "Server is restarting", retryable: true });
    return;
  }

  if (!isAllowedClient(req)) {
    const clientIp = normalizeIp(getClientAddress(req));
    console.warn(`[access] denied client=${clientIp || "unknown"} url=${req.url || ""}`);
    json(res, 403, { error: "Client address is not allowed", clientIp });
    return;
  }

  if (url.pathname.startsWith("/vendor/")) {
    if (!routeVendor(res, url.pathname)) {
      res.writeHead(404);
      res.end("Not found");
    }
    return;
  }

  if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
    if (tryServeFrontendAsset(res, url.pathname)) {
      return;
    }
    if (!path.extname(url.pathname)) {
      serveFrontendIndex(res);
      return;
    }
  }

  if (url.pathname === "/") {
    serveFrontendIndex(res);
    return;
  }

  if (url.pathname === "/api/login" && req.method === "POST") {
    if (forbidCrossOrigin(req, res)) {
      return;
    }
    if (isLoginBlocked(req)) {
      json(res, 429, { error: "Too many login attempts. Try again later." });
      return;
    }
    try {
      const body = parseJson(await readBody(req));
      const providedToken = String(body.token || "").trim();
      if (!constantTimeEquals(providedToken, config.accessToken)) {
        recordFailedLogin(req);
        unauthorized(res);
        return;
      }

      clearFailedLogins(req);
      const authSession = createAuthSession(req);
      json(
        res,
        200,
        { ok: true, expiresAt: authSession.expiresAt },
        {
          "Set-Cookie": serializeCookie(config.authSessionCookieName, authSession.id, {
            maxAge: Math.floor(config.authSessionTtlMs / 1000),
            path: "/",
            sameSite: "Lax",
            secure: config.secureCookies
          })
        }
      );
    } catch (err) {
      json(res, 400, { error: err?.message || String(err) });
    }
    return;
  }

  if (url.pathname === "/api/logout" && req.method === "POST") {
    if (forbidCrossOrigin(req, res)) {
      return;
    }
    const authSession = getAuthSession(req);
    if (authSession) {
      authSessions.delete(authSession.id);
    }
    clearAuthCookie(res);
    json(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/config") {
    if (!isAuthorized(req)) {
      clearAuthCookie(res);
      unauthorized(res);
      return;
    }

    json(res, 200, {
      host: config.host,
      port: config.port,
      defaultCwd: config.defaultCwd,
      timezone: config.timezone,
      defaultProvider: "codex",
      providers: sessionManager.providerCatalog()
    });
    return;
  }

  if (url.pathname === "/api/sessions" && req.method === "GET") {
    if (!isAuthorized(req)) {
      clearAuthCookie(res);
      unauthorized(res);
      return;
    }

    json(res, 200, { sessions: sessionManager.listAll() });
    return;
  }

  if (url.pathname === "/api/archived-sessions" && req.method === "GET") {
    if (!isAuthorized(req)) {
      clearAuthCookie(res);
      unauthorized(res);
      return;
    }

    json(res, 200, { sessions: sessionManager.listArchived() });
    return;
  }

  if (url.pathname === "/api/history-messages" && req.method === "GET") {
    if (!isAuthorized(req)) {
      clearAuthCookie(res);
      unauthorized(res);
      return;
    }

    try {
      const provider = String(url.searchParams.get("provider") || "codex");
      const resumeSessionId = String(url.searchParams.get("resumeSessionId") || "");
      json(res, 200, sessionManager.getHistoricalMessages(provider, resumeSessionId));
    } catch (err) {
      json(res, 400, { error: err?.message || String(err) });
    }
    return;
  }

  if (url.pathname.startsWith("/api/history-sessions/") && url.pathname.endsWith("/messages") && req.method === "GET") {
    if (!isAuthorized(req)) {
      clearAuthCookie(res);
      unauthorized(res);
      return;
    }

    const parts = url.pathname.split("/");
    if (parts.length !== 6) {
      json(res, 404, { error: "Not Found" });
      return;
    }

    const provider = String(parts[3] || "codex").trim();
    const resumeSessionId = String(parts[4] || "").trim();
    try {
      json(res, 200, sessionManager.getHistoricalMessages(provider, resumeSessionId));
    } catch (err) {
      json(res, 400, { error: err?.message || String(err) });
    }
    return;
  }

  if (url.pathname === "/api/fs" && req.method === "GET") {
    if (!isAuthorized(req)) {
      clearAuthCookie(res);
      unauthorized(res);
      return;
    }

    try {
      json(res, 200, listDirectoryPayload(url.searchParams.get("path")));
    } catch (err) {
      json(res, 400, { error: err?.message || String(err) });
    }
    return;
  }

  if (url.pathname === "/api/sessions" && req.method === "POST") {
    if (forbidCrossOrigin(req, res)) {
      return;
    }
    if (!isAuthorized(req)) {
      clearAuthCookie(res);
      unauthorized(res);
      return;
    }

    try {
      const body = parseJson(await readBody(req));
      const session = sessionManager.create(body);
      console.log(
        `[session] created id=${session.id} provider=${session.provider} model=${session.model || ""} cwd=${session.cwd || ""} resume=${session.resumeSessionId || ""}`
      );
      json(res, 201, { session });
    } catch (err) {
      console.warn(`[session] create failed error=${err?.message || String(err)}`);
      json(res, 400, { error: err?.message || String(err) });
    }
    return;
  }

  if (url.pathname.startsWith("/api/sessions/") && req.method === "PATCH") {
    if (forbidCrossOrigin(req, res)) {
      return;
    }
    if (!isAuthorized(req)) {
      clearAuthCookie(res);
      unauthorized(res);
      return;
    }

    const id = url.pathname.split("/").at(-1);
    try {
      const body = parseJson(await readBody(req));
      const session = sessionManager.rename(id, body.name);
      json(res, 200, { session });
    } catch (err) {
      json(res, 400, { error: err?.message || String(err) });
    }
    return;
  }

  if (url.pathname.startsWith("/api/sessions/") && req.method === "DELETE") {
    if (forbidCrossOrigin(req, res)) {
      return;
    }
    if (!isAuthorized(req)) {
      clearAuthCookie(res);
      unauthorized(res);
      return;
    }

    const id = url.pathname.split("/").at(-1);
    json(res, 200, { ok: sessionManager.close(id) });
    return;
  }

  if (url.pathname === "/api/history-sessions/archive" && req.method === "POST") {
    if (forbidCrossOrigin(req, res)) {
      return;
    }
    if (!isAuthorized(req)) {
      clearAuthCookie(res);
      unauthorized(res);
      return;
    }

    try {
      const body = parseJson(await readBody(req));
      const session = sessionManager.archiveHistoricalSession(body.provider, body.resumeSessionId);
      json(res, 200, { session });
    } catch (err) {
      json(res, 400, { error: err?.message || String(err) });
    }
    return;
  }

  if (url.pathname === "/api/history-sessions/restore" && req.method === "POST") {
    if (forbidCrossOrigin(req, res)) {
      return;
    }
    if (!isAuthorized(req)) {
      clearAuthCookie(res);
      unauthorized(res);
      return;
    }

    try {
      const body = parseJson(await readBody(req));
      const session = sessionManager.restoreHistoricalSession(body.provider, body.resumeSessionId);
      json(res, 200, { session });
    } catch (err) {
      json(res, 400, { error: err?.message || String(err) });
    }
    return;
  }

  if (url.pathname === "/api/history-sessions" && req.method === "DELETE") {
    if (forbidCrossOrigin(req, res)) {
      return;
    }
    if (!isAuthorized(req)) {
      clearAuthCookie(res);
      unauthorized(res);
      return;
    }

    try {
      const body = parseJson(await readBody(req));
      json(res, 200, { ok: sessionManager.deleteHistoricalSession(body.provider, body.resumeSessionId) });
    } catch (err) {
      json(res, 400, { error: err?.message || String(err) });
    }
    return;
  }

  if (url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/resize") && req.method === "POST") {
    if (forbidCrossOrigin(req, res)) {
      return;
    }
    if (!isAuthorized(req)) {
      clearAuthCookie(res);
      unauthorized(res);
      return;
    }

    const parts = url.pathname.split("/");
    const id = parts[3];
    try {
      const body = parseJson(await readBody(req));
      sessionManager.resize(id, body.cols, body.rows);
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: err?.message || String(err) });
    }
    return;
  }

  if (url.pathname === "/api/health" && req.method === "GET") {
    json(res, 200, healthPayload());
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws, req, sessionId) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  try {
    sessionManager.attachClient(sessionId, ws);
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", error: err?.message || String(err) }));
    ws.close();
    return;
  }

  ws.on("message", (raw) => {
    try {
      const payload = JSON.parse(String(raw || "{}"));
      if (payload.type === "input") {
        sessionManager.write(sessionId, payload.data || "");
      } else if (payload.type === "resize") {
        sessionManager.resize(sessionId, payload.cols, payload.rows);
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", error: err?.message || String(err) }));
    }
  });
});

const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, config.wsHeartbeatMs);

wss.on("close", () => {
  clearInterval(heartbeatInterval);
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  if (!isAllowedClient(req)) {
    console.warn(`[ws] denied client=${normalizeIp(getClientAddress(req)) || "unknown"} reason=client-not-allowed`);
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!isTrustedOrigin(req)) {
    console.warn(
      `[ws] denied client=${normalizeIp(getClientAddress(req)) || "unknown"} reason=origin origin=${String(req.headers.origin || "")}`
    );
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!isAuthorized(req)) {
    console.warn(`[ws] denied client=${normalizeIp(getClientAddress(req)) || "unknown"} reason=unauthorized`);
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const sessionId = url.searchParams.get("sessionId") || "";
  if (!sessionId || !sessionManager.get(sessionId)) {
    console.warn(`[ws] denied client=${normalizeIp(getClientAddress(req)) || "unknown"} reason=session-not-found sessionId=${sessionId}`);
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    console.log(`[ws] connected client=${normalizeIp(getClientAddress(req)) || "unknown"} sessionId=${sessionId}`);
    wss.emit("connection", ws, req, sessionId);
  });
});

server.listen(config.port, config.host, () => {
  const displayHost = config.host === "0.0.0.0" ? "localhost" : config.host;
  console.log(`Codex/CC Web Terminal listening on http://${displayHost}:${config.port}`);
  console.log("Authentication: session cookie enabled");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await shutdown(signal);
    process.exit(0);
  });
}
