import { installAssetRuntime } from "./assets/frontendAssets.js";
import { installDirectoryBrowserRuntime } from "./assets/directoryBrowser.js";
import { installVendorAssetRuntime } from "./assets/vendorAssets.js";
import { installRequestBodyRuntime } from "./http/body.js";
import { installCookieRuntime } from "./http/cookies.js";
import { installResponseRuntime } from "./http/response.js";
import { installAuthSessionRuntime } from "./security/authSessions.js";
import { installClientAccessRuntime } from "./security/clientAccess.js";
import { installLoginRateLimitRuntime } from "./security/loginRateLimit.js";
import { installTrustedOriginRuntime } from "./security/trustedOrigin.js";
import { createWorkspaceService } from "../workspace/service.js";

export function createRuntime({ config, sessionManager, codexThreads = null }) {
  const runtime = {
    config,
    sessionManager,
    codexThreads,
    workspace: createWorkspaceService(),
    authSessions: new Map(),
    loginAttempts: new Map(),
    startedAt: Date.now(),
    shuttingDown: false,
    previewGatewayReady: false,
    wss: null
  };

  installResponseRuntime(runtime);
  installRequestBodyRuntime(runtime);
  installCookieRuntime(runtime);
  installClientAccessRuntime(runtime);
  installTrustedOriginRuntime(runtime);
  installLoginRateLimitRuntime(runtime);
  installAuthSessionRuntime(runtime);
  installAssetRuntime(runtime);
  installDirectoryBrowserRuntime(runtime);
  installVendorAssetRuntime(runtime);

  runtime.healthPayload = () => ({
    ok: true,
    shuttingDown: runtime.shuttingDown,
    uptimeSeconds: Math.floor((runtime.nowMs() - runtime.startedAt) / 1000),
    authSessions: runtime.authSessions.size,
    rateLimitedClients: [...runtime.loginAttempts.values()].filter((state) => state.blockUntil > runtime.nowMs()).length,
    wsClients: runtime.wss?.clients.size || 0,
    codexV2: runtime.codexThreads?.stats?.() || null,
    workspace: runtime.workspace.stats(),
    ...runtime.sessionManager.stats(),
    service: "codex-cc-web-terminal",
    pid: process.pid,
    preview: { enabled: runtime.config.previewEnabled !== false, ready: runtime.previewGatewayReady }
  });
  runtime.closeWorkspace = () => runtime.workspace.close();
  runtime.closeSidebar = () => runtime.sessionManager.codexSidebarService?.close();
  runtime.parseJson = (body) => {
    if (!body) {
      return {};
    }
    return JSON.parse(body);
  };

  return runtime;
}

export function createRuntimeShutdown({ runtime, server, wsRuntime, previewGateway, codexThreads, appServerBridge, sessionManager,
  forceConnectionsMs = 3000, onError = (error) => console.error("Shutdown cleanup failed:", error?.message || error) }) {
  let pending;
  return (signal = "unknown") => {
    if (pending) return pending;
    runtime.shuttingDown = true;
    runtime.previewGatewayReady = false;
    pending = (async () => {
      const closingServer = new Promise((resolve, reject) => {
        const forceConnections = setTimeout(() => {
          for (const socket of wsRuntime.wss.clients) socket.terminate();
          server.closeAllConnections();
        }, forceConnectionsMs);
        server.close((error) => { clearTimeout(forceConnections); if (error) reject(error); else resolve(); });
      });
      const results = await Promise.allSettled([
        () => runtime.closeWorkspace(), () => runtime.closeSidebar?.(), () => previewGateway?.close(), () => codexThreads?.shutdown(),
        () => wsRuntime.closeClients(signal), () => appServerBridge?.shutdown(), () => sessionManager.shutdown()
      ].map((close) => Promise.resolve().then(close)).concat(closingServer));
      try { wsRuntime.stop(); } catch (error) { onError(error); }
      for (const result of results) if (result.status === "rejected") onError(result.reason);
    })();
    return pending;
  };
}
