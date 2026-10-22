import path from "node:path";

import Koa from "koa";

import { handleAuthRoute } from "./routes/auth.js";
import { handleAttachmentRoute } from "./routes/attachments.js";
import { handleCodexV2Route } from "./routes/codexV2.js";
import { handleConfigRoute } from "./routes/config.js";
import { handleHistoryRoute } from "./routes/history.js";
import { handleSessionRoute } from "./routes/sessions.js";
import { handleSessionCatalogRoute } from "./routes/sessionCatalog.js";
import { handleWorkspaceChangesRoute } from "./routes/workspaceChanges.js";
import { handlePreviewRoute } from "./routes/previews.js";
import { createRuntime } from "./runtime/createRuntime.js";

export function createKoaApp({ config, sessionManager, codexThreads = null }) {
  const runtime = createRuntime({ config, sessionManager, codexThreads });

  const app = new Koa();
  app.use(async (ctx, next) => {
    ctx.set(runtime.responseHeaders());
    ctx.state.auth = {
      isAuthorized: () => runtime.isAuthorized(ctx.req),
      getAuthSession: () => runtime.getAuthSession(ctx.req)
    };
    try {
      await next();
    } catch (err) {
      ctx.app.emit("error", err, ctx);
      if (ctx.headerSent) {
        throw err;
      }
      runtime.json(ctx, 500, { error: err?.message || String(err) });
    }
  });

  app.use(async (ctx, next) => {
    if (runtime.shuttingDown && ctx.path !== "/api/health") {
      runtime.json(ctx, 503, { error: "Server is restarting", retryable: true });
      return;
    }

    if (ctx.path === "/api/health" && ctx.method === "GET") {
      runtime.json(ctx, 200, runtime.healthPayload());
      return;
    }

    if (!runtime.isAllowedClient(ctx.req)) {
      const clientIp = runtime.normalizeIp(runtime.getClientAddress(ctx.req));
      console.warn(`[access] denied client=${clientIp || "unknown"} url=${ctx.url || ""}`);
      runtime.json(ctx, 403, { error: "Client address is not allowed", clientIp });
      return;
    }

    const isApiPath = ctx.path === "/api" || ctx.path.startsWith("/api/");
    if (["GET", "HEAD"].includes(ctx.method) && !isApiPath) {
      if (runtime.routeVendor(ctx, ctx.path)) {
        return;
      }
      if (runtime.tryServeFrontendAsset(ctx, ctx.path)) {
        return;
      }
      const isAssetPath = ["/assets", "/vendor"].some((prefix) => ctx.path === prefix || ctx.path.startsWith(`${prefix}/`));
      if (!isAssetPath && !path.extname(ctx.path)) {
        runtime.serveFrontendIndex(ctx);
        return;
      }
    }

    const handled = [handleAuthRoute, handleAttachmentRoute, handlePreviewRoute, handleConfigRoute, handleCodexV2Route, handleHistoryRoute, handleSessionCatalogRoute, handleSessionRoute, handleWorkspaceChangesRoute];
    for (const route of handled) {
      if (await route(ctx, runtime)) {
        return;
      }
    }

    await next();
    if (ctx.body == null && ctx.status === 404) {
      ctx.status = 404;
      ctx.body = "Not found";
    }
  });

  app.on("error", (err, ctx) => {
    const pathInfo = ctx?.path || "unknown";
    console.warn(`[koa] error path=${pathInfo} error=${err?.message || String(err)}`);
  });

  return { app, runtime };
}
