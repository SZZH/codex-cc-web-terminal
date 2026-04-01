import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import { WebSocket } from "ws";

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
    this.connecting = null;
    this.shuttingDown = false;
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
    this.initialized = true;
  }

  async startProcess() {
    if (this.proc && !this.proc.killed) {
      return;
    }
    const args = ["app-server", "--listen", this.listenUrl];
    this.proc = spawn(this.config.codexBin, args, {
      cwd: this.config.root,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"]
    });
    this.proc.stderr?.on("data", (chunk) => {
      const line = String(chunk || "").trim();
      if (line) {
        this.emit("log", line);
      }
    });
    this.proc.on("exit", () => {
      this.connected = false;
      this.initialized = false;
      this.ws = null;
    });
    await wait(350);
  }

  async openWebSocket() {
    const url = this.listenUrl;
    this.ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("app-server websocket connect timeout")), 5000);
      this.ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    this.connected = true;
    this.ws.on("message", (raw) => this.handleMessage(raw));
    this.ws.on("close", () => {
      this.connected = false;
      this.initialized = false;
    });
  }

  handleMessage(raw) {
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
        pending.reject(new Error(msg.error?.message || "app-server request failed"));
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
    const id = msg.id;
    const method = String(msg.method || "");
    try {
      if (method === "item/commandExecution/requestApproval") {
        this.sendResponse(id, { decision: "acceptForSession" });
        return;
      }
      if (method === "item/fileChange/requestApproval") {
        this.sendResponse(id, { decision: "acceptForSession" });
        return;
      }
      if (method === "item/permissions/requestApproval") {
        this.sendResponse(id, {
          permissions: {
            fileSystem: {},
            network: { enabled: true }
          },
          scope: "session"
        });
        return;
      }
      if (method === "item/tool/requestUserInput") {
        this.sendError(id, -32001, "tool user input is not supported by this bridge");
        return;
      }
      if (method === "item/tool/call") {
        this.sendError(id, -32001, "dynamic tool call is not supported by this bridge");
        return;
      }
      this.sendError(id, -32601, `method not handled by bridge: ${method}`);
    } catch (error) {
      this.sendError(id, -32000, error?.message || String(error));
    }
  }

  request(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("app-server websocket not connected"));
    }
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server request timeout: ${method}`));
      }, 20000);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  async ensureThread(session) {
    await this.ensureReady();
    if (session.resumeSessionId) {
      await this.request("thread/resume", {
        threadId: session.resumeSessionId,
        cwd: session.cwd,
        model: session.model || null
      });
      return session.resumeSessionId;
    }
    const result = await this.request("thread/start", {
      cwd: session.cwd,
      model: session.model || null,
      experimentalRawEvents: false,
      persistExtendedHistory: true
    });
    const threadId = String(result?.thread?.id || "").trim();
    if (!threadId) {
      throw new Error("app-server thread/start did not return thread id");
    }
    session.resumeSessionId = threadId;
    return threadId;
  }

  async startTurn(session, text) {
    const threadId = await this.ensureThread(session);
    return this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: String(text || ""), text_elements: [] }]
    });
  }

  async shutdown() {
    this.shuttingDown = true;
    try {
      this.ws?.close();
    } catch {
      // no-op
    }
    try {
      this.proc?.kill("SIGTERM");
    } catch {
      // no-op
    }
    this.connected = false;
    this.initialized = false;
  }
}
