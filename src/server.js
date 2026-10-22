import http from "node:http";

import { config } from "./config.js";
import { AppServerBridge } from "./appServerBridge.js";
import { createKoaApp } from "./koa-app.js";
import { SessionManager } from "./sessionManager.js";
import { installWebSocketServer } from "./routes/ws.js";
import { CodexThreadService } from "./sessions/codex/threadService.js";
import { getPreviewRegistry } from "./routes/previews.js";
import { PreviewGateway } from "./preview/gateway.js";
import { createRuntimeShutdown } from "./runtime/createRuntime.js";

const appServerBridge = config.codexAppServerEnabled ? new AppServerBridge(config) : null;
const sessionManager = new SessionManager(config, { appServerBridge });
const codexThreads = appServerBridge ? new CodexThreadService({ config, bridge: appServerBridge, sessionManager }) : null;
const { app, runtime } = createKoaApp({ config, sessionManager, codexThreads });
const server = http.createServer(app.callback());
const wsRuntime = installWebSocketServer(server, runtime);
const previewGateway = config.previewEnabled ? new PreviewGateway({ config, registry: getPreviewRegistry(runtime) }) : null;
if (previewGateway) {
  try { await previewGateway.start(); runtime.previewGatewayReady = true; }
  catch (error) { console.error(`Preview gateway could not start: ${error.message}`); await previewGateway.close(); }
}

const shutdown = createRuntimeShutdown({ runtime, server, wsRuntime, previewGateway, codexThreads, appServerBridge, sessionManager });

server.listen(config.port, config.host, () => {
  const displayHost = config.host === "0.0.0.0" ? "localhost" : config.host;
  console.log(`Codex/CC Web Terminal listening on http://${displayHost}:${config.port}`);
  console.log("Authentication: session cookie enabled");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await shutdown(signal);
    process.exit(0);
  });
}
