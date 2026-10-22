const READ_TIMEOUT_MS = 15000;

function abortReason(signal) {
  return signal?.reason || new DOMException("读取已取消。", "AbortError");
}

export async function withReadDeadline(signal, operation, { totalTimeoutMs = READ_TIMEOUT_MS, idleTimeoutMs,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (signal?.aborted) throw abortReason(signal);

  const controller = new AbortController();
  let totalTimer, idleTimer, stopped, finished = false, rejectCancellation;
  const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
  const cleanup = () => {
    clearTimer(totalTimer);
    clearTimer(idleTimer);
    signal?.removeEventListener("abort", onAbort);
  };
  const stop = (error) => {
    if (finished || stopped) return;
    stopped = error;
    cleanup();
    rejectCancellation(error);
    controller.abort(error);
  };
  const onAbort = () => stop(abortReason(signal));
  const assertActive = () => { if (stopped) throw stopped; };
  const timeout = () => stop(Object.assign(new Error("读取超时，请重试。"), { code: "READ_TIMEOUT" }));
  const progress = () => {
    assertActive();
    if (finished || !idleTimeoutMs) return;
    clearTimer(idleTimer);
    idleTimer = setTimer(timeout, idleTimeoutMs);
  };

  signal?.addEventListener("abort", onAbort, { once: true });
  totalTimer = setTimer(timeout, totalTimeoutMs);
  progress();
  try {
    // Keep a rejection handler on the operation even when a transport ignores abort.
    return await Promise.race([operation({ signal: controller.signal, assertActive, progress }), cancellation]);
  } finally {
    finished = true;
    cleanup();
    // Recovery can leave the initial 401 and login response bodies unread.
    controller.abort();
  }
}
