import { withReadDeadline } from "./api-read-deadline.js";

export function createCodexReadRequests({ request, timeoutMs, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const reads = new Set();
  let disposed = false;
  function cancelled() { return new DOMException("会话读取已取消。", "AbortError"); }

  async function call(path, options = {}) {
    const isRead = String(options.method || "GET").toUpperCase() === "GET";
    if (isRead) return read(path, options);
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimer(() => {
        const error = new Error("连接超时，发送状态将自动核对。");
        reject(error); controller.abort(error);
      }, timeoutMs ?? 15000);
    });
    try {
      return await Promise.race([
        request(path, { ...options, signal: controller.signal }), deadline
      ]);
    } finally {
      clearTimer(timer);
    }
  }
  async function read(path, options) {
    if (disposed) throw cancelled();
    const controller = new AbortController();
    const cancel = () => controller.abort(cancelled());
    const onAbort = () => controller.abort(options.signal.reason || cancelled());
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    reads.add(cancel);
    try {
      return await withReadDeadline(controller.signal,
        (readContext) => request(path, { ...options, signal: readContext.signal, readContext }), {
          totalTimeoutMs: timeoutMs ?? 120000,
          ...(timeoutMs == null ? { idleTimeoutMs: 30000 } : {}),
          setTimer, clearTimer
        });
    } finally {
      reads.delete(cancel);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const cancel of reads) cancel();
    reads.clear();
  }
  return { call, dispose };
}
