import { PreviewRegistry, previewError } from "../preview/registry.js";
import { previewOrigin } from "../preview/gateway.js";

export function getPreviewRegistry(runtime) {
  return runtime.previewRegistry ||= new PreviewRegistry(runtime.config);
}

export async function handlePreviewRoute(ctx, runtime) {
  if (!ctx.path.startsWith("/api/previews")) return false;
  if (!runtime.requireAuthorized(ctx) || runtime.forbidCrossOrigin(ctx)) return true;
  try {
    if (runtime.config.previewEnabled === false) throw previewError("文件与网页预览尚未启用。", 503);
    const registry = getPreviewRegistry(runtime);
    const source = `${ctx.get("X-Forwarded-Proto") === "https" || ctx.secure ? "https" : "http"}://${ctx.host}`;
    if (ctx.path === "/api/previews" && ctx.method === "POST" || ctx.path === "/api/previews/open" && ctx.method === "GET") {
      if (!runtime.previewGatewayReady) throw previewError("预览网关未就绪，请稍后重试。", 503);
      const body = ctx.method === "POST" ? runtime.parseJson(await runtime.readBody(ctx.req)) : Object.fromEntries(new URL(ctx.url, "http://localhost").searchParams);
      const entry = registry.register({ target: body.target, cwd: body.cwd, ...(ctx.method === "POST" ? { requestId: body.requestId } : {}) });
      const url = `${previewOrigin(runtime.config, source, entry.port)}/_open/${entry.id}`;
      if (ctx.method === "GET") { ctx.redirect(url); ctx.set("Cache-Control", "no-store"); }
      else runtime.json(ctx, 201, { id: entry.id, title: entry.title, kind: entry.kind, url, expiresAt: new Date(entry.expiresAt).toISOString() });
      return true;
    }
    const match = /^\/api\/previews\/([a-zA-Z0-9_-]+)$/.exec(ctx.path);
    if (match && ctx.method === "DELETE") { registry.remove(match[1]); runtime.json(ctx, 200, { ok: true }); return true; }
    throw previewError("预览接口不存在。", 404);
  } catch (error) { runtime.json(ctx, error.status || 400, { error: error.message || "无法打开预览。" }); }
  return true;
}
