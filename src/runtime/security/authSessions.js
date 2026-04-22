import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function serializeAuthSession(session) {
  return {
    id: String(session?.id || "").trim(),
    createdAt: Number(session?.createdAt || 0),
    expiresAt: Number(session?.expiresAt || 0),
    ip: String(session?.ip || ""),
    userAgent: String(session?.userAgent || "")
  };
}

export function installAuthSessionRuntime(runtime) {
  const authSessionsPath = path.join(runtime.config.dataDir, "auth-sessions.json");

  runtime.loadAuthSessions = () => {
    try {
      const payload = JSON.parse(fs.readFileSync(authSessionsPath, "utf8"));
      runtime.authSessions.clear();
      for (const [id, session] of Object.entries(payload || {})) {
        const normalized = serializeAuthSession({ ...session, id: session?.id || id });
        if (!normalized.id || !Number.isFinite(normalized.expiresAt)) {
          continue;
        }
        runtime.authSessions.set(normalized.id, normalized);
      }
    } catch {
      runtime.authSessions.clear();
    }
  };

  runtime.saveAuthSessions = () => {
    fs.mkdirSync(runtime.config.dataDir, { recursive: true });
    const payload = Object.fromEntries(
      [...runtime.authSessions.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([id, session]) => [id, serializeAuthSession(session)])
    );
    fs.writeFileSync(authSessionsPath, JSON.stringify(payload, null, 2), "utf8");
  };

  runtime.loadAuthSessions();

  runtime.constantTimeEquals = (a, b) => {
    const left = Buffer.from(String(a || ""), "utf8");
    const right = Buffer.from(String(b || ""), "utf8");
    if (left.length !== right.length) {
      return false;
    }
    return crypto.timingSafeEqual(left, right);
  };

  runtime.createAuthSession = (req) => {
    const id = crypto.randomUUID();
    const expiresAt = runtime.nowMs() + runtime.config.authSessionTtlMs;
    runtime.authSessions.set(
      id,
      serializeAuthSession({
        id,
        createdAt: runtime.nowMs(),
        expiresAt,
        ip: req.socket.remoteAddress || "",
        userAgent: String(req.headers["user-agent"] || "")
      })
    );
    runtime.saveAuthSessions();
    return { id, expiresAt };
  };

  runtime.pruneExpiredAuthSessions = () => {
    const current = runtime.nowMs();
    let changed = false;
    for (const [id, session] of runtime.authSessions) {
      if (Number(session?.expiresAt || 0) <= current) {
        runtime.authSessions.delete(id);
        changed = true;
      }
    }
    if (changed) {
      runtime.saveAuthSessions();
    }
  };

  runtime.getAuthSessionStatus = (req) => {
    runtime.pruneExpiredAuthSessions();
    const cookies = runtime.parseCookies(req);
    const id = String(cookies[runtime.config.authSessionCookieName] || "").trim();
    if (!id) {
      return { session: null, reason: "missing_cookie", id: "" };
    }
    const session = runtime.authSessions.get(id) || null;
    if (!session) {
      return { session: null, reason: "session_not_found", id };
    }
    if (Number(session.expiresAt || 0) <= runtime.nowMs()) {
      runtime.authSessions.delete(id);
      runtime.saveAuthSessions();
      return { session: null, reason: "session_expired", id };
    }

    const nextExpiresAt = runtime.nowMs() + runtime.config.authSessionTtlMs;
    if (Math.abs(nextExpiresAt - Number(session.expiresAt || 0)) >= 60_000) {
      session.expiresAt = nextExpiresAt;
      runtime.saveAuthSessions();
    }
    return { session, reason: "", id };
  };

  runtime.getAuthSession = (req) => runtime.getAuthSessionStatus(req).session;

  runtime.attachAuthSessionCookie = (ctx, session) => {
    if (!ctx || !session?.id) {
      return;
    }
    ctx.set(
      "Set-Cookie",
      runtime.serializeCookie(runtime.config.authSessionCookieName, session.id, {
        maxAge: Math.floor(runtime.config.authSessionTtlMs / 1000),
        path: "/",
        sameSite: "Lax",
        secure: runtime.config.secureCookies
      })
    );
  };

  runtime.isAuthorized = (req) => Boolean(runtime.getAuthSession(req));

  runtime.requireAuthorized = (ctx) => {
    const { session, reason } = runtime.getAuthSessionStatus(ctx.req);
    if (!session) {
      runtime.clearAuthCookie(ctx);
      runtime.unauthorized(ctx, {
        reason: reason || "unauthorized",
        canReauthenticate: true
      });
      return false;
    }
    ctx.state ||= {};
    ctx.state.authSession = session;
    runtime.attachAuthSessionCookie(ctx, session);
    return true;
  };

  runtime.pruneExpiredAuthSessions();
}
