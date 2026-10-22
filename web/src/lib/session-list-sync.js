export function createSessionListSyncLoop({ refresh, shouldSync, intervalMs = 4000 }) {
  let current = null;

  function stop() {
    const owner = current;
    current = null;
    if (!owner) return;
    if (owner.timer !== null) owner.view.clearInterval(owner.timer);
    owner.page?.removeEventListener("visibilitychange", owner.onVisibility);
  }

  function start() {
    stop();
    if (typeof window === "undefined") return;
    const view = window;
    const documentRef = typeof document === "undefined" ? null : document;
    const page = typeof documentRef?.addEventListener === "function"
      && typeof documentRef?.removeEventListener === "function" ? documentRef : null;
    const owner = { view, page, timer: null, hidden: page?.visibilityState === "hidden", onVisibility: null };
    current = owner;

    function sync() {
      if (current !== owner || page?.visibilityState === "hidden" || !shouldSync()) return;
      refresh().catch(() => {});
    }

    owner.onVisibility = () => {
      if (current !== owner) return;
      const hidden = page.visibilityState === "hidden";
      const resumed = owner.hidden && !hidden;
      owner.hidden = hidden;
      if (resumed) sync();
    };
    page?.addEventListener("visibilitychange", owner.onVisibility);
    owner.timer = view.setInterval(sync, intervalMs);
  }

  return { start, stop };
}
