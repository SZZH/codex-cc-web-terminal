export async function readJsonWithProgress(response, { signal, assertActive = () => {}, progress } = {}) {
  const active = () => {
    assertActive();
    if (signal?.aborted) throw signal.reason || new DOMException("读取已取消。", "AbortError");
  };
  active();
  if (!response.body) return response.json();

  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = "", completed = false;
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      active();
      const { value, done } = await reader.read();
      active();
      if (value?.byteLength) progress?.();
      text += decoder.decode(value, { stream: !done });
      if (done) break;
    }
    const payload = JSON.parse(text);
    active();
    completed = true;
    return payload;
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!completed) cancel();
    reader.releaseLock();
  }
}
