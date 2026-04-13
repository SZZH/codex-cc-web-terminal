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

export function createRuntime({ config, sessionManager }) {
  const runtime = {
    config,
    sessionManager,
    authSessions: new Map(),
    loginAttempts: new Map(),
    startedAt: Date.now(),
    shuttingDown: false,
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
    ...runtime.sessionManager.stats()
  });
  runtime.parseJson = (body) => {
    if (!body) {
      return {};
    }
    return JSON.parse(body);
  };

  return runtime;
}
