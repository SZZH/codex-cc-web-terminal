import { readJsonTransfer } from "../runtime/http/readJsonTransfer.js";
import { createHistoryReadContext } from "../runtime/http/historyReadContext.js";
import { handleCodexInteractionRoute } from "./codexInteractions.js";
import { readInitialHistory } from "../sessions/codex/initialHistory.js";

function parsePath(url) {
  const prefix = "/api/v2/codex/threads";
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
  return url.pathname.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);
}

export async function handleCodexV2Route(ctx, runtime) {
  const url = new URL(ctx.url, "http://localhost");
  let parts;
  try { parts = parsePath(url); } catch { runtime.json(ctx, 400, { error: "Invalid URL" }); return true; }
  if (!parts) return false;
  if (!runtime.requireAuthorized(ctx)) return true;
  if (ctx.method !== "GET" && runtime.forbidCrossOrigin(ctx)) return true;
  const service = runtime.codexThreads;
  if (!service) { runtime.json(ctx, 503, { error: "Codex chat service is unavailable" }); return true; }
  let readContext;
  try {
    const [threadId, resource, resourceId, nested, itemId] = parts;
    const pageOptions = { cursor: url.searchParams.get("cursor") || undefined, limit: Number(url.searchParams.get("limit")) || 10,
      ...(url.searchParams.get("after") ? { after: url.searchParams.get("after") } : {}) };
    const historyOptions = () => {
      readContext = createHistoryReadContext(ctx);
      readContext.throwIfAborted();
      return { signal: readContext.signal };
    };
    let payload;
    let status = 200;
    let transferHistory = false;
    if (resource === "interactions") {
      payload = await handleCodexInteractionRoute({ ctx, runtime, service, parts });
    } else if (!parts.length && ctx.method === "POST") {
      payload = { thread: await service.createThread(runtime.parseJson(await runtime.readBody(ctx.req))) };
      status = 201;
    } else if (parts.length === 1 && ctx.method === "GET") {
      payload = { thread: await service.getThread(threadId, historyOptions()) };
    } else if (parts.length === 2 && resource === "initial-history" && ctx.method === "GET") {
      payload = await readInitialHistory(service, threadId, historyOptions());
      transferHistory = true;
    } else if (parts.length === 2 && resource === "turns" && ctx.method === "GET") {
      payload = await service.reader.listTurns(threadId, { ...pageOptions, ...historyOptions() });
      readContext.throwIfAborted();
      service.reconcileRequests(threadId, payload.turns || []);
      transferHistory = true;
    } else if (parts.length === 4 && resource === "turns" && nested === "items" && ctx.method === "GET") {
      const directions = url.searchParams.getAll("sortDirection");
      if (directions.length > 1 || directions.length && !["asc", "desc"].includes(directions[0])) {
        throw Object.assign(new Error("Invalid item sort direction"), { status: 400 });
      }
      payload = await service.reader.listItems(threadId, resourceId, {
        ...pageOptions, ...(directions.length ? { sortDirection: directions[0] } : {}), ...historyOptions()
      });
      readContext.throwIfAborted();
      service.reconcileItems?.(threadId, resourceId, payload.items || []);
      transferHistory = true;
    } else if (parts.length === 5 && resource === "turns" && nested === "items" && ctx.method === "GET") {
      payload = await service.reader.getItem(threadId, resourceId, itemId, historyOptions());
      readContext.throwIfAborted();
      service.reconcileItems?.(threadId, resourceId, payload.item ? [payload.item] : []);
      transferHistory = true;
    } else if (parts.length === 7 && resource === "turns" && nested === "items" && parts[5] === "images" && /^\d+$/.test(parts[6]) && ctx.method === "GET") {
      const media = await service.reader.getImage(threadId, resourceId, itemId, Number(parts[6]), historyOptions());
      readContext.throwIfAborted();
      if (!media?.bytes?.length || media.bytes.length > 20 * 1024 * 1024) throw Object.assign(new Error("Image exceeds the 20 MiB limit"), { status: 413 });
      ctx.status = 200;
      ctx.type = media.type;
      ctx.set("Content-Security-Policy", "sandbox; default-src 'none'");
      ctx.body = media.bytes;
      return true;
    } else if (parts.length === 4 && resource === "questions" && nested === "respond" && ctx.method === "POST") {
      payload = { request: await service.desktopQuestions.respond(threadId, resourceId, runtime.parseJson(await runtime.readBody(ctx.req))) };
      status = 202;
    } else if (parts.length === 2 && resource === "requests" && ctx.method === "POST") {
      payload = { request: service.submit(threadId, runtime.parseJson(await runtime.readBody(ctx.req))) };
      status = 202;
    } else if (parts.length === 4 && resource === "requests" && nested === "steer" && ctx.method === "POST") {
      payload = { request: service.promoteQueuedRequest(threadId, resourceId, runtime.parseJson(await runtime.readBody(ctx.req))) };
      status = 202;
    } else if (parts.length === 4 && resource === "requests" && nested === "cancel" && ctx.method === "POST") {
      payload = { request: await service.cancelQueuedRequest(threadId, resourceId) };
    } else if (parts.length === 2 && resource === "requests" && ctx.method === "GET") {
      void service.syncQueue?.(threadId);
      payload = { requests: service.requests.list(threadId) };
    } else if (parts.length === 3 && resource === "requests" && ctx.method === "GET") {
      const request = service.requests.get(threadId, resourceId);
      if (!request) { runtime.json(ctx, 404, { error: "Request not found" }); return true; }
      payload = { request };
    } else if (parts.length === 2 && resource === "interrupt" && ctx.method === "POST") {
      payload = await service.interrupt(threadId, runtime.parseJson(await runtime.readBody(ctx.req)));
    } else {
      runtime.json(ctx, 404, { error: "Not Found" });
      return true;
    }
    readContext?.throwIfAborted();
    runtime.json(ctx, status, payload);
    readContext?.throwIfAborted();
    if (transferHistory) readJsonTransfer(ctx, runtime);
  } catch (error) {
    if (readContext?.cancelled) return true;
    const status = error.status || error.statusCode || (/not found|not exist/i.test(error.message) ? 404 : 400);
    runtime.json(ctx, status, { error: error.message || String(error), code: error.code || "request_failed" });
  } finally {
    readContext?.dispose();
  }
  return true;
}
