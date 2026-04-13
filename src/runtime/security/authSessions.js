import crypto from "node:crypto";

export function installAuthSessionRuntime(runtime) {
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
}
