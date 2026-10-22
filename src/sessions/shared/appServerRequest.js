import { WebSocket } from "ws";

function abortedRequest() {
  return Object.assign(new Error("app-server request aborted"), { name: "AbortError", code: "ABORT_ERR" });
}

export function requestAppServer(bridge, method, params, options) {
  const signal = options?.signal;
  if (signal?.aborted) return Promise.reject(abortedRequest());
  const socket = bridge.ws;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("app-server websocket not connected"));
  }
  const requestTimeoutMs = Math.max(1_000, Number(bridge.config.codexAppServerRequestTimeoutMs) || 20_000);
  const id = bridge.nextId++;
  const payload = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (complete, value) => {
      if (settled) return;
      settled = true;
      bridge.pending.delete(id);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      complete(value);
    };
    const onAbort = () => settle(reject, abortedRequest());
    const timer = setTimeout(() => {
      settle(reject, Object.assign(new Error(`app-server request timeout: ${method}`), { uncertain: true }));
    }, requestTimeoutMs);
    bridge.pending.set(id, {
      resolve: (result) => settle(resolve, result),
      reject: (error) => settle(reject, error)
    });
    try {
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      const serialized = JSON.stringify(payload);
      // Serialization can invoke user-provided toJSON code that cancels this wait.
      if (!settled) socket.send(serialized);
    } catch (error) {
      settle(reject, error);
    }
  });
}
