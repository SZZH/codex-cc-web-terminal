import { createSessionCatalogPages } from "../sessions/history/sessionCatalogPages.js";
import { buildSessionSidebarPayload } from "./sessionSidebar.js";
import { sendSidebarResponse } from "./sidebarResponse.js";

const catalogs = new WeakMap();

export async function handleSessionCatalogRoute(ctx, runtime) {
  if (ctx.path !== "/api/session-catalog" || ctx.method !== "GET") return false;
  if (!runtime.requireAuthorized(ctx)) return true;
  let catalog = catalogs.get(runtime);
  if (!catalog) {
    catalog = createSessionCatalogPages({ loadSnapshot: () => buildSessionSidebarPayload(runtime.sessionManager, runtime.codexThreads) });
    catalogs.set(runtime, catalog);
  }
  try {
    const payload = await catalog.read(new URL(ctx.url, "http://localhost").searchParams);
    await sendSidebarResponse(ctx, runtime, payload);
  } catch (error) {
    const known = [400, 409, 503].includes(error?.status)
      && ["CATALOG_INVALID_REQUEST", "CATALOG_SNAPSHOT_EXPIRED", "CATALOG_UNAVAILABLE"].includes(error?.code);
    runtime.json(ctx, known ? error.status : 503, { error: known ? error.message : "Session catalog could not be loaded",
      code: known ? error.code : "CATALOG_UNAVAILABLE" });
  }
  return true;
}
