import http from "node:http";

import { config } from "./config.js";
import { AppServerBridge } from "./appServerBridge.js";
import { createKoaApp } from "./koa-app.js";
import { SessionManager } from "./sessionManager.js";
import { installWebSocketServer } from "./routes/ws.js";

const appServerBridge = config.codexAppServerEnabled ? new AppServerBridge(config) : null;
const sessionManager = new SessionManager(config, { appServerBridge });
const { app, runtime } = createKoaApp({ config, sessionManager });
const server = http.createServer(app.callback());
const wsRuntime = installWebSocketServer(server, runtime);

let shutdownPromise = null;

async function shutdown(signal = "unknown") {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  runtime.shuttingDown = true;
  shutdownPromise = new Promise((resolve) => {
    wsRuntime.closeClients(signal);

    server.close(() => {
      wsRuntime.stop();
      appServerBridge?.shutdown();
      sessionManager.shutdown();
      resolve();
    });

    setTimeout(() => {
      wsRuntime.stop();
      appServerBridge?.shutdown();
      sessionManager.shutdown();
      resolve();
    }, 3000).unref();
  });

  return shutdownPromise;
}

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
