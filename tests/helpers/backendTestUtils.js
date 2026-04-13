import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync } from "node:fs";

export function createTempDir(prefix = "codex-cc-web-terminal-test-") {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function createBaseConfig(rootDir, overrides = {}) {
  const dataDir = overrides.dataDir || path.join(rootDir, "data");
  const codexSessionsDir = overrides.codexSessionsDir || path.join(rootDir, ".codex", "sessions");
  const ccSessionsDir = overrides.ccSessionsDir || path.join(rootDir, ".claude", "projects");

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(codexSessionsDir, { recursive: true });
  mkdirSync(ccSessionsDir, { recursive: true });

  return {
    root: rootDir,
    home: rootDir,
    platform: process.platform,
    host: "127.0.0.1",
    port: 0,
    accessToken: "test-access-token",
    defaultCwd: rootDir,
    shellBin: process.env.SHELL || "/bin/zsh",
    shellArgs: ["-l"],
    shellQuoteStyle: "posix",
    codexBin: "codex",
    codexModel: "gpt-5",
    codexModels: ["gpt-5", "gpt-5-mini"],
    codexProfile: "",
    codexFullAccess: true,
    codexNoAltScreen: true,
    codexExtraArgs: [],
    codexAppServerEnabled: true,
    codexAppServerListenUrl: "ws://127.0.0.1:8777",
    codexAppServerConnectTimeoutMs: 1000,
    codexAppServerRequestTimeoutMs: 5000,
    ccBin: "claude",
    ccModel: "sonnet",
    ccModels: ["sonnet"],
    ccFullAccess: true,
    ccExtraArgs: [],
    authSessionCookieName: "codex_web_term_session",
    authSessionTtlMs: 24 * 60 * 60 * 1000,
    secureCookies: false,
    authRateLimitWindowMs: 10 * 60 * 1000,
    authRateLimitMaxAttempts: 5,
    authRateLimitBlockMs: 15 * 60 * 1000,
    tailscaleOnly: false,
    trustedCidrs: [],
    wsHeartbeatMs: 50,
    sessionBufferLimit: 250000,
    maxQueuedInputs: 200,
    dataDir,
    codexSessionsDir,
    ccSessionsDir,
    timezone: "UTC",
    ...overrides
  };
}

export async function startTestServer({ sessionManager, configOverrides = {} } = {}) {
  const { createKoaApp } = await import("../../src/koa-app.js");
  const rootDir = createTempDir();
  const config = createBaseConfig(rootDir, configOverrides);
  const { app, runtime } = createKoaApp({ config, sessionManager });
  const server = http.createServer(app.callback());

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    app,
    runtime,
    server,
    config,
    rootDir,
    baseUrl,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

export function getSetCookieHeaders(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  const value = response.headers.get("set-cookie");
  return value ? [value] : [];
}

export function joinCookies(setCookieHeaders) {
  return setCookieHeaders
    .map((value) => String(value || "").split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

export function parseCookieValue(cookieHeader, key) {
  const targetKey = String(key || "").trim();
  if (!targetKey) {
    return "";
  }
  const cookies = String(cookieHeader || "").split(/;\s*/);
  for (const cookie of cookies) {
    const index = cookie.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const name = cookie.slice(0, index).trim();
    if (name !== targetKey) {
      continue;
    }
    return cookie.slice(index + 1).trim();
  }
  return "";
}

export async function login(baseUrl, token, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...extraHeaders
    },
    body: JSON.stringify({ token })
  });

  return {
    response,
    cookies: joinCookies(getSetCookieHeaders(response))
  };
}

export async function waitForMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export async function waitForCondition(predicate, { timeoutMs = 500, intervalMs = 10 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}
