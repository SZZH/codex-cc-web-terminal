/** An HTTP response owns only its current history read, including before headers exist. */
export function createHistoryReadContext(ctx) {
  const controller = new AbortController();
  const response = ctx.res;
  let closed = false;
  const close = () => {
    if (response?.writableFinished) return;
    closed = true;
    controller.abort();
  };
  response?.once("close", close);
  const check = () => {
    if (response?.destroyed && !response.writableFinished) close();
    controller.signal.throwIfAborted();
  };
  if (response?.destroyed && !response.writableFinished) close();
  return {
    signal: controller.signal,
    throwIfAborted: check,
    get cancelled() {
      if (response?.destroyed && !response.writableFinished) close();
      return controller.signal.aborted && (closed || response?.destroyed);
    },
    dispose() { response?.removeListener("close", close); }
  };
}
