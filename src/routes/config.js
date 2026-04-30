import { readCodexDesktopDefaults } from "../sessions/shared/codexDesktopConfig.js";

export async function handleConfigRoute(ctx, runtime) {
  if (ctx.path !== "/api/config") {
    return false;
  }

  if (!runtime.requireAuthorized(ctx)) {
    return true;
  }

  const codexDefaults = readCodexDesktopDefaults(runtime.config);
  runtime.json(ctx, 200, {
    host: runtime.config.host,
    port: runtime.config.port,
    defaultCwd: runtime.config.defaultCwd,
    timezone: runtime.config.timezone,
    defaultProvider: "codex",
    providers: runtime.sessionManager.providerCatalog(),
    codexDefaults
  });
  return true;
}
