const positive = (value) => Number.isFinite(value) && value > 0 ? value : 0;

export function measureAppViewport(view = globalThis.window) {
  const innerHeight = positive(view?.innerHeight);
  const visibleHeight = positive(view?.visualViewport?.height);
  const height = visibleHeight || innerHeight;
  const offsetTop = visibleHeight && Number.isFinite(view?.visualViewport?.offsetTop)
    ? Math.max(0, view.visualViewport.offsetTop) : 0;
  return { height, offsetTop, keyboardInset: Math.max(0, innerHeight - height - offsetTop) };
}

export function createAppViewport({ window: view = globalThis.window, document: doc = globalThis.document } = {}) {
  const properties = ["--app-viewport-height", "--app-viewport-top", "--app-viewport-bottom"];
  let active = false, disposed = false, viewport = null, style = null, previous = [];

  function sync() {
    if (!active || disposed) return;
    const { height, offsetTop, keyboardInset } = measureAppViewport(view);
    if (!height) return;
    for (const [index, value] of [height, offsetTop, keyboardInset].entries()) {
      style?.setProperty?.(properties[index], `${value}px`);
    }
  }

  function start() {
    if (active || disposed || !view) return;
    active = true;
    style = doc?.documentElement?.style;
    previous = properties.map((name) => [name, style?.getPropertyValue?.(name) || "", style?.getPropertyPriority?.(name) || ""]);
    viewport = view.visualViewport;
    view.addEventListener?.("resize", sync, { passive: true });
    viewport?.addEventListener?.("resize", sync, { passive: true });
    viewport?.addEventListener?.("scroll", sync, { passive: true });
    sync();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (!active) return;
    active = false;
    view?.removeEventListener?.("resize", sync);
    viewport?.removeEventListener?.("resize", sync);
    viewport?.removeEventListener?.("scroll", sync);
    for (const [name, value, priority] of previous) {
      if (value) style?.setProperty?.(name, value, priority);
      else style?.removeProperty?.(name);
    }
  }

  return { start, dispose };
}
