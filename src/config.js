import "dotenv/config";

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function env(name, fallback = "") {
  const value = process.env[name];
  if (value === undefined || value === null) {
    return fallback;
  }

  const trimmed = String(value).trim();
  return trimmed || fallback;
}

function intEnv(name, fallback) {
  const parsed = Number.parseInt(env(name, String(fallback)), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(name, fallback = false) {
  const value = env(name, fallback ? "1" : "0").toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function listEnv(name) {
  return env(name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

const root = process.cwd();
const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
const generatedToken = crypto.randomBytes(18).toString("base64url");

export const config = {
  root,
  home,
  host: env("HOST", "0.0.0.0"),
  port: intEnv("PORT", 3210),
  accessToken: env("ACCESS_TOKEN", generatedToken),
  defaultCwd: env("DEFAULT_CWD", home),
  powershellBin: env(
    "POWERSHELL_BIN",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  ),
  codexBin: env("CODEX_BIN", "codex"),
  codexModel: env("CODEX_MODEL", ""),
  codexProfile: env("CODEX_PROFILE", ""),
  codexFullAccess: boolEnv("CODEX_FULL_ACCESS", true),
  codexNoAltScreen: boolEnv("CODEX_NO_ALT_SCREEN", true),
  codexExtraArgs: listEnv("CODEX_EXTRA_ARGS"),
  authSessionCookieName: env("AUTH_SESSION_COOKIE_NAME", "codex_web_term_session"),
  authSessionTtlMs: intEnv("AUTH_SESSION_TTL_HOURS", 24) * 60 * 60 * 1000,
  secureCookies: boolEnv("SECURE_COOKIES", false),
  authRateLimitWindowMs: intEnv("AUTH_RATE_LIMIT_WINDOW_MINUTES", 10) * 60 * 1000,
  authRateLimitMaxAttempts: intEnv("AUTH_RATE_LIMIT_MAX_ATTEMPTS", 5),
  authRateLimitBlockMs: intEnv("AUTH_RATE_LIMIT_BLOCK_MINUTES", 15) * 60 * 1000,
  tailscaleOnly: boolEnv("TAILSCALE_ONLY", false),
  trustedCidrs: listEnv("TRUSTED_CIDRS"),
  wsHeartbeatMs: intEnv("WS_HEARTBEAT_SECONDS", 30) * 1000,
  sessionBufferLimit: 250000,
  dataDir: path.join(root, "data"),
  codexSessionsDir: env("CODEX_SESSIONS_DIR", path.join(home, ".codex", "sessions")),
  timezone: env("DISPLAY_TIMEZONE", "Australia/Melbourne")
};
