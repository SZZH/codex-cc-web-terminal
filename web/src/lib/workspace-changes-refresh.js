export function createWorkspaceChangesRefresh({ read, onResult, onError, onLoading,
  onSuspend = () => {}, onResume = () => {}, visibility = globalThis.document }) {
  let context = { cwd: "", interactive: false };
  let visible = false, needed = true, disposed = false, generation = 0;
  let active = null;
  const eligible = () => !disposed && context.interactive && Boolean(context.cwd) && visible && !visibility?.hidden;

  function invalidate() {
    generation += 1;
    const pending = active;
    active = null;
    pending?.cancel();
    onLoading(false);
    onSuspend();
  }
  function refresh({ silent = false, automatic = false } = {}) {
    if (disposed || !context.interactive || !context.cwd || automatic && !eligible()) return Promise.resolve();
    if (active) return active.promise;
    const current = generation;
    const identity = context;
    const controller = new AbortController();
    let cancel;
    const cancellation = new Promise((resolve) => {
      cancel = () => { controller.abort(); resolve(null); };
    });
    needed = false;
    if (!silent) onLoading(true);
    let response;
    try { response = read(identity.cwd, { summary: true, signal: controller.signal }); }
    catch (error) { response = Promise.reject(error); }
    const result = Promise.resolve(response).then((result) => {
      if (!disposed && generation === current && result) { onResult(result); onLoading(false); }
    }).catch((error) => {
      if (!disposed && generation === current) { onError(error); onLoading(false); }
    });
    const operation = Promise.race([result, cancellation]).finally(() => {
      if (generation !== current || disposed) return;
      active = null;
      onLoading(false);
    });
    active = { promise: operation, cancel };
    return operation;
  }
  function resume() {
    if (!eligible()) return;
    if (needed) void refresh({ automatic: true });
    else onResume();
  }
  function configure(next) {
    invalidate();
    context = { ...next, cwd: String(next.cwd || "").trim() };
    needed = true;
    resume();
  }
  function setVisible(value) {
    if (disposed || visible === value) return;
    visible = value;
    if (!value) {
      if (active) needed = true;
      invalidate();
    } else resume();
  }
  function visibilityChanged() {
    if (disposed) return;
    if (visibility?.hidden) {
      if (active) needed = true;
      invalidate();
    } else resume();
  }
  visibility?.addEventListener?.("visibilitychange", visibilityChanged);
  function dispose() {
    if (disposed) return;
    disposed = true;
    invalidate();
    visibility?.removeEventListener?.("visibilitychange", visibilityChanged);
  }
  return { configure, setVisible, refresh, invalidate, dispose };
}
