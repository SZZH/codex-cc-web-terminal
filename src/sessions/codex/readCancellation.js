export function throwIfReadAborted(signal) {
  signal?.throwIfAborted();
}

/** Leave this wait without cancelling shared initialization or trusting transport cancellation. */
export async function waitForHistoryRead(operation, signal) {
  throwIfReadAborted(signal);
  if (!signal) return operation();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (complete, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      complete(value);
    };
    const abort = () => finish(reject, signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try {
      // Both handlers stay attached if the caller leaves before this promise settles.
      Promise.resolve(operation()).then(
        (value) => signal.aborted ? abort() : finish(resolve, value),
        (error) => signal.aborted ? abort() : finish(reject, error)
      );
    } catch (error) { signal.aborted ? abort() : finish(reject, error); }
  });
}
