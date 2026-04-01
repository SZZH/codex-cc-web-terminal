export async function handleAuthRoute(ctx, runtime) {
  if (ctx.path === "/api/login" && ctx.method === "POST") {
    if (runtime.forbidCrossOrigin(ctx)) {
      return true;
    }
    if (runtime.isLoginBlocked(ctx.req)) {
      runtime.json(ctx, 429, { error: "Too many login attempts. Try again later." });
      return true;
    }
    try {
      const body = runtime.parseJson(await runtime.readBody(ctx.req));
      const providedToken = String(body.token || "").trim();
      if (!runtime.constantTimeEquals(providedToken, runtime.config.accessToken)) {
        runtime.recordFailedLogin(ctx.req);
        runtime.unauthorized(ctx);
        return true;
      }

      runtime.clearFailedLogins(ctx.req);
      const authSession = runtime.createAuthSession(ctx.req);
      runtime.json(
        ctx,
        200,
        { ok: true, expiresAt: authSession.expiresAt },
        {
          "Set-Cookie": runtime.serializeCookie(runtime.config.authSessionCookieName, authSession.id, {
            maxAge: Math.floor(runtime.config.authSessionTtlMs / 1000),
            path: "/",
            sameSite: "Lax",
            secure: runtime.config.secureCookies
          })
        }
      );
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path === "/api/logout" && ctx.method === "POST") {
    if (runtime.forbidCrossOrigin(ctx)) {
      return true;
    }
    const authSession = runtime.getAuthSession(ctx.req);
    if (authSession) {
      runtime.authSessions.delete(authSession.id);
    }
    runtime.clearAuthCookie(ctx);
    runtime.json(ctx, 200, { ok: true });
    return true;
  }

  return false;
}
