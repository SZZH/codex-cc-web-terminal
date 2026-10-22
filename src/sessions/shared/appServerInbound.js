import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

const failure = (message) => Object.assign(new Error(message), { uncertain: true });

/** Inbound RPC responses belong to the socket that delivered the request. */
export class AppServerInbound extends EventEmitter {
  constructor(bridge) {
    super();
    this.bridge = bridge;
    this.requests = new Map();
    this.handler = null;
  }

  setHandler(handler) {
    if (this.handler && handler !== this.handler) throw new Error("inbound request handler is already registered");
    this.handler = handler;
    return () => { if (this.handler === handler) this.handler = null; };
  }

  handle(message, socket, generation) {
    const { id: rpcId, method, params = {} } = message;
    if (!(typeof rpcId === "string" || Number.isSafeInteger(rpcId))) return;
    if (this.requests.has(rpcId)) return;
    const request = {
      id: randomUUID(), rpcId, method, params, socket, generation, consumed: false, available: true,
      isCurrent: () => request.available && this.bridge.ws === request.socket && this.bridge.connectionGeneration === request.generation && request.socket?.readyState === 1,
      respond: (result) => this.send(request, { result }),
      reject: (code, message) => this.send(request, { error: { code, message } }).finally(() => {
        if (this.requests.get(rpcId) === request) this.requests.delete(rpcId);
      })
    };
    this.requests.set(rpcId, request);
    try {
      if (this.handler?.(request) === true) return;
      this.fallback(request);
    } catch {
      request.reject(-32000, "Unable to collect this user interaction").catch(() => {});
    }
  }

  fallback(request) {
    const method = request.method;
    let response;
    if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method)) response = { result: { decision: "decline" } };
    else if (method === "item/permissions/requestApproval") response = { result: { permissions: {}, scope: "turn" } };
    else if (method === "currentTime/read") response = { result: { currentTimeAt: Math.floor(Date.now() / 1000) } };
    else if (method === "item/tool/requestUserInput") response = { error: { code: -32001, message: "tool user input is not supported by this bridge" } };
    else if (method === "item/tool/call") response = { error: { code: -32001, message: "dynamic tool call is not supported by this bridge" } };
    else response = { error: { code: -32601, message: `method not handled by bridge: ${method}` } };
    this.send(request, response).catch(() => {}).finally(() => {
      if (this.requests.get(request.rpcId) === request) this.requests.delete(request.rpcId);
    });
  }

  send(request, payload) {
    if (!request.isCurrent()) return Promise.reject(failure("original app-server connection is unavailable or request resolved"));
    if (request.consumed) return Promise.reject(new Error("server request already answered"));
    request.consumed = true;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        request.settleError = null;
        if (error) reject(failure("app-server response delivery is uncertain"));
        else resolve();
      };
      request.settleError = (error) => finish(error);
      try { request.socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.rpcId, ...payload }), finish); }
      catch (error) { finish(error); }
    });
  }

  resolve({ requestId, threadId } = {}) {
    const request = this.requests.get(requestId);
    if (!request || request.params.threadId !== threadId) return;
    this.requests.delete(requestId);
    request.available = false;
    this.emit("resolved", request);
    request.settleError?.(failure("server request resolved"));
    request.socket = null;
    request.params = null;
  }

  invalidateRequest(request, reason = "connection_closed") {
    if (this.requests.get(request.rpcId) !== request) return;
    this.requests.delete(request.rpcId);
    request.available = false;
    this.emit("invalidated", request, reason);
    request.settleError?.(failure("original app-server connection is unavailable"));
    request.socket = null;
    request.params = null;
  }

  invalidate(reason = "connection_closed") {
    for (const request of [...this.requests.values()]) this.invalidateRequest(request, reason);
  }
}
