import fs from "node:fs";
import path from "node:path";

import { applySessionInputEvents, normalizeSessionInputEvents, openSessionSseStream } from "../transport/index.js";

function hasStreamTurnInput(events = []) {
  return events.some((event) => {
    if (event?.type === "interrupt") {
      return true;
    }
    return event?.type === "input" && String(event?.data || "") !== "";
  });
}

function isTurnTerminalInSnapshot(session, turnId) {
  const targetTurnId = String(turnId || "").trim();
  if (!session || !targetTurnId) {
    return false;
  }

  const status = String(
    session?.threadSnapshot?.turns?.find((turn) => String(turn?.id || "") === targetTurnId)?.status || ""
  ).trim().toLowerCase();
  return status === "completed" || status === "failed" || status === "aborted" || status === "interrupted";
}

async function openInputStream(ctx, runtime, session, events) {
  let stream = null;
  try {
    ctx.respond = false;
    ctx.status = 200;
    ctx.res.statusCode = 200;
    ctx.res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    ctx.res.setHeader("Connection", "keep-alive");
    ctx.res.setHeader("X-Accel-Buffering", "no");
    for (const [key, value] of Object.entries(runtime.responseHeaders())) {
      ctx.res.setHeader(key, value);
    }

    stream = openSessionSseStream({
      req: ctx.req,
      res: ctx.res,
      sessionManager: runtime.sessionManager,
      sessionId: session.id,
      keepaliveMs: runtime.config.wsHeartbeatMs
    });

    const { lastInputTurnId } = applySessionInputEvents(runtime.sessionManager, session.id, events);
    const liveSession = runtime.sessionManager.get(session.id) || session;
    const trackedTurnId = String(lastInputTurnId || liveSession.currentTurnId || "").trim();
    stream.setTrackedTurnId(trackedTurnId);
    if (isTurnTerminalInSnapshot(liveSession, trackedTurnId)) {
      stream.close();
    }
    return true;
  } catch (err) {
    if (!ctx.res.headersSent) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    } else {
      stream?.sendError(err);
      stream?.close();
    }
    return true;
  }
}

function resolveThreadBackedInputSession(runtime, session, { providerId = "" } = {}) {
  if (!session) {
    return null;
  }
  const threadId = String(session.resumeSessionId || session.threadSnapshot?.threadId || "").trim();
  if (!threadId) {
    return session;
  }
  if (typeof runtime.sessionManager.ensureLiveSessionForThread !== "function") {
    return session;
  }
  return runtime.sessionManager.ensureLiveSessionForThread(threadId, {
    providerId: String(providerId || session.provider || "").trim(),
    cwd: session.cwd,
    model: session.model,
    name: session.name
  });
}

export async function handleSessionRoute(ctx, runtime) {
  if (ctx.path === "/api/local-file-image" && ctx.method === "GET") {
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    try {
      const url = new URL(ctx.url, "http://localhost");
      const requestedPath = String(url.searchParams.get("path") || "").trim();
      const filePath = requestedPath
        ? path.normalize(path.isAbsolute(requestedPath) ? requestedPath : path.resolve(requestedPath))
        : "";

      if (!filePath) {
        runtime.json(ctx, 400, { error: "Missing image path" });
        return true;
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        runtime.json(ctx, 404, { error: "Image file not found" });
        return true;
      }

      const contentType = runtime.contentTypeForFile(filePath);
      if (!String(contentType || "").startsWith("image/")) {
        runtime.json(ctx, 400, { error: "Only image files are supported" });
        return true;
      }

      runtime.serveFile(ctx, filePath, contentType);
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path === "/api/sessions" && ctx.method === "GET") {
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    runtime.json(ctx, 200, {
      sessions: runtime.sessionManager.listAll(),
      projectGroups: runtime.sessionManager.listProjectGroups()
    });
    return true;
  }

  if (
    ctx.path.startsWith("/api/sessions/") &&
    ctx.method === "GET" &&
    !ctx.path.endsWith("/resize") &&
    !ctx.path.endsWith("/conversation")
  ) {
    if (runtime.forbidCrossOrigin(ctx)) {
      return true;
    }
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    const parts = ctx.path.split("/");
    const id = decodeURIComponent(parts[3] || "");
    const session = runtime.sessionManager.get(id);
    if (!session) {
      runtime.json(ctx, 404, { error: "Session not found" });
      return true;
    }
    runtime.json(ctx, 200, { session: runtime.sessionManager.serialize(session) });
    return true;
  }

  if (ctx.path.startsWith("/api/sessions/") && ctx.path.endsWith("/conversation") && ctx.method === "GET") {
    if (runtime.forbidCrossOrigin(ctx)) {
      return true;
    }
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    const parts = ctx.path.split("/");
    if (parts.length !== 5) {
      runtime.json(ctx, 404, { error: "Not Found" });
      return true;
    }
    const id = decodeURIComponent(parts[3] || "");
    const snapshot = runtime.sessionManager.getConversationSnapshot(id);
    if (!snapshot) {
      runtime.json(ctx, 404, { error: "Session not found" });
      return true;
    }
    runtime.json(ctx, 200, snapshot);
    return true;
  }

  if (ctx.path === "/api/archived-sessions" && ctx.method === "GET") {
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    runtime.json(ctx, 200, { sessions: runtime.sessionManager.listArchived() });
    return true;
  }

  if (ctx.path === "/api/fs" && ctx.method === "GET") {
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    try {
      const url = new URL(ctx.url, "http://localhost");
      runtime.json(ctx, 200, runtime.listDirectoryPayload(url.searchParams.get("path")));
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path === "/api/sessions" && ctx.method === "POST") {
    if (runtime.forbidCrossOrigin(ctx)) {
      return true;
    }
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    try {
      const body = runtime.parseJson(await runtime.readBody(ctx.req));
      const providerId = String(body.provider || "codex").trim().toLowerCase() || "codex";
      const resumeSessionId = String(body.resumeSessionId || "").trim();
      if (resumeSessionId) {
        const reusable = runtime.sessionManager.findRunningLiveSessionByResume(providerId, resumeSessionId);
        if (reusable) {
          runtime.json(ctx, 200, { session: reusable });
          return true;
        }
      }
      const session = runtime.sessionManager.create(body);
      console.log(
        `[session] created id=${session.id} provider=${session.provider} model=${session.model || ""} cwd=${session.cwd || ""} resume=${session.resumeSessionId || ""}`
      );
      runtime.json(ctx, 201, { session });
    } catch (err) {
      console.warn(`[session] create failed error=${err?.message || String(err)}`);
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path.startsWith("/api/sessions/") && ctx.path.endsWith("/input-stream") && ctx.method === "POST") {
    if (runtime.forbidCrossOrigin(ctx)) {
      return true;
    }
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    const parts = ctx.path.split("/");
    if (parts.length !== 5) {
      runtime.json(ctx, 404, { error: "Not Found" });
      return true;
    }

    const id = decodeURIComponent(parts[3] || "");
    const compatibilitySession = runtime.sessionManager.get(id);
    if (!compatibilitySession) {
      runtime.json(ctx, 404, { error: "Session not found" });
      return true;
    }

    try {
      const body = runtime.parseJson(await runtime.readBody(ctx.req));
      const events = normalizeSessionInputEvents(body);
      if (!hasStreamTurnInput(events)) {
        runtime.json(ctx, 400, { error: "input-stream requires a non-empty input event" });
        return true;
      }

      const liveSession = resolveThreadBackedInputSession(runtime, compatibilitySession, {
        providerId: String(compatibilitySession.provider || "").trim()
      });
      if (!liveSession) {
        runtime.json(ctx, 404, { error: "Session not found" });
        return true;
      }

      return await openInputStream(ctx, runtime, liveSession, events);
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
      return true;
    }
  }

  if (ctx.path.startsWith("/api/threads/") && ctx.path.endsWith("/input-stream") && ctx.method === "POST") {
    if (runtime.forbidCrossOrigin(ctx)) {
      return true;
    }
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    const parts = ctx.path.split("/");
    if (parts.length !== 6) {
      runtime.json(ctx, 404, { error: "Not Found" });
      return true;
    }

    const providerId = decodeURIComponent(parts[3] || "").trim();
    const threadId = decodeURIComponent(parts[4] || "").trim();
    if (!threadId) {
      runtime.json(ctx, 400, { error: "threadId is required" });
      return true;
    }

    try {
      const body = runtime.parseJson(await runtime.readBody(ctx.req));
      const events = normalizeSessionInputEvents(body);
      if (!hasStreamTurnInput(events)) {
        runtime.json(ctx, 400, { error: "input-stream requires a non-empty input event" });
        return true;
      }

      const session = runtime.sessionManager.ensureLiveSessionForThread(threadId, {
        providerId: String(body.provider || providerId || "").trim(),
        cwd: body.cwd,
        model: body.model,
        name: body.name
      });
      if (!session) {
        runtime.json(ctx, 404, { error: "Session not found" });
        return true;
      }

      return await openInputStream(ctx, runtime, session, events);
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
      return true;
    }
  }

  if (ctx.path.startsWith("/api/sessions/") && ctx.method === "PATCH") {
    if (runtime.forbidCrossOrigin(ctx)) {
      return true;
    }
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    const id = ctx.path.split("/").at(-1);
    try {
      const body = runtime.parseJson(await runtime.readBody(ctx.req));
      const session = runtime.sessionManager.rename(id, body.name);
      runtime.json(ctx, 200, { session });
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  if (ctx.path.startsWith("/api/sessions/") && ctx.method === "DELETE") {
    if (runtime.forbidCrossOrigin(ctx)) {
      return true;
    }
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    const id = ctx.path.split("/").at(-1);
    runtime.json(ctx, 200, { ok: runtime.sessionManager.close(id) });
    return true;
  }

  if (ctx.path === "/api/health" && ctx.method === "GET") {
    runtime.json(ctx, 200, runtime.healthPayload());
    return true;
  }

  if (ctx.path.startsWith("/api/sessions/") && ctx.path.endsWith("/resize") && ctx.method === "POST") {
    if (runtime.forbidCrossOrigin(ctx)) {
      return true;
    }
    if (!runtime.requireAuthorized(ctx)) {
      return true;
    }

    const parts = ctx.path.split("/");
    const id = parts[3];
    try {
      const body = runtime.parseJson(await runtime.readBody(ctx.req));
      runtime.sessionManager.resize(id, body.cols, body.rows);
      runtime.json(ctx, 200, { ok: true });
    } catch (err) {
      runtime.json(ctx, 400, { error: err?.message || String(err) });
    }
    return true;
  }

  return false;
}
