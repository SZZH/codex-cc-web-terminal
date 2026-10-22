import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import { WebSocket } from "ws";

import {
  buildAppServerThreadOptions,
  buildAppServerTurnOptions
} from "./sessions/shared/appServerOptions.js";
import { requestAppServer } from "./sessions/shared/appServerRequest.js";
import { AppServerInbound } from "./sessions/shared/appServerInbound.js";
import { normalizeRunnerInput } from "./sessions/shared/imageAttachments.js";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AppServerBridge extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.listenUrl = config.codexAppServerListenUrl;
    this.proc = null;
    this.ws = null;
    this.connected = false;
    this.initialized = false;
    this.nextId = 1;
    this.pending = new Map();
    this.connectionGeneration = 0;
    this.inbound = new AppServerInbound(this);
    this.connecting = null;
    this.shuttingDown = false;
  }

  isProcessAlive() {
    return Boolean(this.proc && this.proc.exitCode == null && !this.proc.killed);
  }

  resetConnectionState(socket = this.ws, generation = this.connectionGeneration) {
    if (socket !== this.ws || generation !== this.connectionGeneration) return;
    const wasConnected = this.connected || this.initialized;
    this.inbound.invalidate();
    this.connected = false;
    this.initialized = false;
    this.ws = null;
    if (wasConnected) {
      for (const request of this.pending.values()) request.reject(Object.assign(new Error("app-server connection closed"), { uncertain: true }));
      this.pending.clear();
      this.emit("disconnected");
    }
  }

  bindSocket(socket) {
    if (this.ws === socket) return;
    if (this.ws && this.ws !== socket) this.resetConnectionState();
    this.ws = socket;
    this.connected = true;
    const generation = ++this.connectionGeneration;
    socket.on("message", (raw) => this.handleMessage(raw, socket, generation));
    socket.on("close", () => this.resetConnectionState(socket, generation));
  }

  async ensureReady() {
    if (!this.config.codexAppServerEnabled) {
      throw new Error("codex app-server is disabled");
    }
    if (this.connected && this.initialized && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }
    this.connecting = this.connectInternal();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async connectInternal() {
    const maxAttempts = 3;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.startProcess();
        await this.openWebSocket();
        await this.request("initialize", {
          clientInfo: {
            name: "codex-cc-web-terminal",
            title: "Codex CC Web Terminal",
            version: "0.1.0"
          },
          capabilities: {
            experimentalApi: true
          }
        });
        this.sendNotification("initialized");
        this.initialized = true;
        return;
      } catch (error) {
        lastError = error;
        this.emit("log", `bridge connect attempt ${attempt} failed: ${error?.message || String(error)}`);
        await this.forceRestartProcess();
        await wait(500 * attempt);
      }
    }
    throw lastError || new Error("app-server connect failed");
  }

  async startProcess() {
    if (this.isProcessAlive()) {
      return;
    }
    this.proc = null;
    const args = ["app-server", "--listen", this.listenUrl];
    const proc = spawn(this.config.codexBin, args, {
      cwd: this.config.root,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"]
    });
    this.proc = proc;
    proc.stderr?.on("data", (chunk) => {
      const line = String(chunk || "").trim();
      if (line) {
        this.emit("log", line);
      }
    });
    proc.on("error", (error) => {
      this.emit("log", `app-server process error: ${error.message}`);
    });
    proc.on("exit", () => {
      if (this.proc !== proc) {
        return;
      }
      this.proc = null;
      this.resetConnectionState();
    });
    try {
      await new Promise((resolve, reject) => {
        const onSpawn = () => {
          proc.off("error", onError);
          resolve();
        };
        const onError = (error) => {
          proc.off("spawn", onSpawn);
          reject(error);
        };
        proc.once("spawn", onSpawn);
        proc.once("error", onError);
      });
    } catch (error) {
      if (this.proc === proc) {
        this.proc = null;
      }
      this.resetConnectionState();
      throw error;
    }
    await wait(1_200);
  }

  async openWebSocket() {
    const connectTimeoutMs = Math.max(1_000, Number(this.config.codexAppServerConnectTimeoutMs) || 5_000);
    const deadline = Date.now() + connectTimeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      const url = this.listenUrl;
      const socket = new WebSocket(url);
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("app-server websocket connect timeout")), 1_000);
          socket.once("open", () => {
            clearTimeout(timer);
            resolve();
          });
          socket.once("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });
        this.bindSocket(socket);
        return;
      } catch (error) {
        lastError = error;
        try {
          socket.close();
        } catch {
          // no-op
        }
        await wait(250);
      }
    }
    throw lastError || new Error("app-server websocket connect timeout");
  }

  async forceRestartProcess() {
    try {
      this.ws?.close();
    } catch {
      // no-op
    }
    try {
      if (this.isProcessAlive()) {
        this.proc.kill("SIGTERM");
      }
    } catch {
      // no-op
    }
    this.proc = null;
    this.resetConnectionState();
  }

  handleMessage(raw, socket = this.ws, generation = this.connectionGeneration) {
    if (socket !== this.ws || generation !== this.connectionGeneration) return;
    let msg;
    try {
      msg = JSON.parse(String(raw || "{}"));
    } catch {
      return;
    }
    if (Object.prototype.hasOwnProperty.call(msg, "id") && !msg.method) {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        return;
      }
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(Object.assign(new Error(msg.error?.message || "app-server request failed"), { rpcError: true, code: msg.error.code, data: msg.error.data }));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (Object.prototype.hasOwnProperty.call(msg, "id") && msg.method) {
      this.handleServerRequest(msg);
      return;
    }
    if (msg.method) {
      if (msg.method === "serverRequest/resolved") this.inbound.resolve(msg.params);
      this.emit("notification", msg);
    }
  }

  sendResponse(id, result) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result
      })
    );
  }

  sendNotification(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("app-server websocket not connected");
    }
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }));
  }

  sendError(id, code, message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code, message }
      })
    );
  }

  handleServerRequest(msg) {
    this.inbound.handle(msg, this.ws, this.connectionGeneration);
  }

  request(method, params, options) {
    return requestAppServer(this, method, params, options);
  }

  async ensureThread(session, options = buildAppServerThreadOptions(session)) {
    const resumeSessionId = session.resumeSessionId;
    await this.ensureReady();
    if (resumeSessionId) {
      await this.request("thread/resume", {
        threadId: resumeSessionId,
        ...options
      });
      return resumeSessionId;
    }
    const result = await this.request("thread/start", {
      ...options,
      ...(session.projectId ? { projectId: session.projectId } : {}),
      experimentalRawEvents: true
    });
    const threadId = String(result?.thread?.id || "").trim();
    if (!threadId) {
      throw new Error("app-server thread/start did not return thread id");
    }
    session.resumeSessionId = threadId;
    if (["user_provided", "custom_name"].includes(session.titleSource) && String(session.name || "").trim()) {
      await this.request("thread/name/set", { threadId, name: session.name });
    }
    return threadId;
  }

  async startTurn(session, text, images = []) {
    const input = normalizeRunnerInput(text, images);
    const threadOptions = buildAppServerThreadOptions(session);
    const turnOptions = buildAppServerTurnOptions(session);
    const threadId = await this.ensureThread(session, threadOptions);
    return this.request("turn/start", {
      threadId,
      ...turnOptions,
      input: [
        ...(input.text ? [{ type: "text", text: input.text, text_elements: [] }] : []),
        ...input.images.map((image) => ({ type: "localImage", path: image.path }))
      ]
    });
  }

  async interruptTurn(session, turnId) {
    const threadId = String(session?.resumeSessionId || "").trim();
    const targetTurnId = String(turnId || "").trim();
    if (!threadId || !targetTurnId) {
      throw new Error("app-server interrupt requires thread and turn ids");
    }
    return this.request("turn/interrupt", { threadId, turnId: targetTurnId });
  }

  async shutdown() {
    this.shuttingDown = true;
    await this.forceRestartProcess();
  }
}
