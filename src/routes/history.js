export async function handleHistoryRoute(ctx, runtime) {
  if (ctx.path === "/api/history-messages" && ctx.method === "GET") {
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    try {
      const url = new URL(ctx.url, "http://localhost");
      const provider = String(url.searchParams.get("provider") || "codex");
      const resumeSessionId = String(url.searchParams.get("resumeSessionId") || "");
      runtime.json(ctx, 200, runtime.sessionManager.getHistoricalMessages(provider, resumeSessionId));
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path.startsWith("/api/history-sessions/") && ctx.path.endsWith("/messages") && ctx.method === "GET") {
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    const parts = ctx.path.split("/");
    if (parts.length !== 6) {
      runtime.json(ctx, 404, { error: "Not Found" });
      return true;
    }

    const provider = String(parts[3] || "codex").trim();
    const resumeSessionId = String(parts[4] || "").trim();
    try {
      runtime.json(ctx, 200, runtime.sessionManager.getHistoricalMessages(provider, resumeSessionId));
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path === "/api/history-sessions/archive" && ctx.method === "POST") {
    if (runtime.forbidCrossOrigin(ctx)) {
      return true;
    }
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    try {
      const body = runtime.parseJson(await runtime.readBody(ctx.req));
      const session = runtime.sessionManager.archiveHistoricalSession(body.provider, body.resumeSessionId);
      runtime.json(ctx, 200, { session });
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path === "/api/history-sessions/restore" && ctx.method === "POST") {
    if (runtime.forbidCrossOrigin(ctx)) {
      return true;
    }
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    try {
      const body = runtime.parseJson(await runtime.readBody(ctx.req));
      const session = runtime.sessionManager.restoreHistoricalSession(body.provider, body.resumeSessionId);
      runtime.json(ctx, 200, { session });
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path === "/api/history-sessions" && ctx.method === "DELETE") {
    if (runtime.forbidCrossOrigin(ctx)) {
      return true;
    }
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    try {
      const body = runtime.parseJson(await runtime.readBody(ctx.req));
      runtime.json(ctx, 200, {
        ok: runtime.sessionManager.deleteHistoricalSession(body.provider, body.resumeSessionId)
      });
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  return false;
}
