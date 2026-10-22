import { readCodexDesktopDefaults } from "../sessions/shared/codexDesktopConfig.js";
import { getAppServerModelCatalog } from "../sessions/shared/appServerModelCatalog.js";
import { readCodexFollowUpQueueMode } from "../sessions/shared/codexFollowUpMode.js";

export async function handleConfigRoute(ctx, runtime) {
  if (ctx.path !== "/api/config") {
    return false;
  }

  if (!runtime.requireAuthorized(ctx)) {
    return true;
  }

  const codexDefaults = readCodexDesktopDefaults(runtime.config);
  const providers = runtime.sessionManager.providerCatalog().map((provider) => ({ ...provider }));
  const codexProvider = providers.find((provider) => provider.id === "codex");
  const currentModels = typeof runtime.sessionManager.listLiveSessions === "function"
    ? runtime.sessionManager.listLiveSessions().filter((session) => session.provider === "codex").map((session) => session.model)
    : [];
  const [catalog, codexFollowUpQueueMode] = await Promise.all([getAppServerModelCatalog({
    bridge: runtime.sessionManager.appServerBridge,
    enabled: runtime.config.codexAppServerEnabled,
    fallbackModels: codexProvider?.models || [],
    configuredModels: [codexDefaults.model, codexProvider?.defaultModel, ...currentModels]
  }), readCodexFollowUpQueueMode({ config: runtime.config, bridge: runtime.sessionManager.appServerBridge,
    cwd: runtime.config.defaultCwd })]);
  if (codexProvider) {
    codexProvider.models = catalog.models;
    codexProvider.defaultModel = codexDefaults.model || codexProvider.defaultModel || catalog.models.find((model) => model.isDefault)?.value || "";
  }
  const { models, ...codexModelCatalog } = catalog;
  runtime.json(ctx, 200, {
    host: runtime.config.host,
    port: runtime.config.port,
    defaultCwd: runtime.config.defaultCwd,
    timezone: runtime.config.timezone,
    defaultProvider: "codex",
    providers,
    codexDefaults,
    codexFollowUpQueueMode,
    codexModelCatalog
  });
  return true;
}
