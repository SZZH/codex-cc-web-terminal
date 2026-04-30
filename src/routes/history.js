import { createHistoryPayloadResolver } from "./historyPayloads.js";
import { parseHistoryQuery, parseScopedHistoryRoute, parseThreadRoute } from "./historyRouteParams.js";

export async function handleHistoryRoute(ctx, runtime) {
  const historyPayloads = createHistoryPayloadResolver(runtime.sessionManager);
  const { getThreadBundle, getThreadConversationPayload, getThreadMessagesPayload, getContinuationPayload } = historyPayloads;

  if (ctx.path === "/api/history-messages" && ctx.method === "GET") {
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    try {
      const { provider, resumeSessionId } = parseHistoryQuery(ctx.url);
      runtime.json(ctx, 200, getThreadMessagesPayload(provider, resumeSessionId));
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path.startsWith("/api/history-sessions/") && ctx.path.endsWith("/messages") && ctx.method === "GET") {
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    const match = parseScopedHistoryRoute(ctx.path, "messages");
    if (!match) {
      runtime.json(ctx, 404, { error: "Not Found" });
      return true;
    }

    const { provider, resumeSessionId } = match;
    try {
      runtime.json(ctx, 200, getThreadMessagesPayload(provider, resumeSessionId));
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path.startsWith("/api/history-sessions/") && ctx.path.endsWith("/conversation") && ctx.method === "GET") {
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    const match = parseScopedHistoryRoute(ctx.path, "conversation");
    if (!match) {
      runtime.json(ctx, 404, { error: "Not Found" });
      return true;
    }

    const { provider, resumeSessionId } = match;
    try {
      runtime.json(ctx, 200, getThreadConversationPayload(provider, resumeSessionId));
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path.startsWith("/api/history-sessions/") && ctx.path.endsWith("/thread") && ctx.method === "GET") {
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    const match = parseScopedHistoryRoute(ctx.path, "thread");
    if (!match) {
      runtime.json(ctx, 404, { error: "Not Found" });
      return true;
    }

    const { provider, resumeSessionId } = match;
    try {
      runtime.json(ctx, 200, getThreadBundle(provider, resumeSessionId));
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path.startsWith("/api/history-sessions/") && ctx.path.endsWith("/continuation") && ctx.method === "GET") {
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    const match = parseScopedHistoryRoute(ctx.path, "continuation");
    if (!match) {
      runtime.json(ctx, 404, { error: "Not Found" });
      return true;
    }

    const { provider, resumeSessionId } = match;
    try {
      runtime.json(ctx, 200, getContinuationPayload(provider, resumeSessionId));
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path.startsWith("/api/threads/") && ctx.method === "GET") {
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    const match = parseThreadRoute(ctx.path);
    if (!match) {
      runtime.json(ctx, 404, { error: "Not Found" });
      return true;
    }

    const { provider, resumeSessionId, suffix } = match;

    try {
      if (!suffix) {
        runtime.json(ctx, 200, getThreadBundle(provider, resumeSessionId));
        return true;
      }
      if (suffix === "composer-state") {
        return false;
      }
      if (suffix === "conversation") {
        runtime.json(ctx, 200, getThreadConversationPayload(provider, resumeSessionId));
        return true;
      }
      if (suffix === "continuation") {
        runtime.json(ctx, 200, getContinuationPayload(provider, resumeSessionId));
        return true;
      }
      runtime.json(ctx, 404, { error: "Not Found" });
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
