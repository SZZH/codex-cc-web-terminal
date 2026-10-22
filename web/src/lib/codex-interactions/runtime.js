export function createInteractionResponseId(crypto = globalThis.crypto) {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto?.getRandomValues === "function") crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createCodexInteractionRuntime({ store, base, call, isDisposed = () => false, onSettled = () => {},
  newId = createInteractionResponseId } = {}) {
  const { state } = store;
  let disposed = false, refreshPromise = null, readRevision = 0;
  const responses = new Map(), checks = new Map();
  const alive = () => !disposed && !isDisposed();
  const path = (id) => `${base}/interactions/${encodeURIComponent(id)}`;
  function needsRecovery() {
    return alive() && (!state.ready || Boolean(state.error) || Object.keys(state.actions).length > 0 ||
      state.order.some((id) => ["pending", "submitting", "submitted", "unknown"].includes(state.interactions[id]?.status)));
  }
  function refresh() {
    if (!alive()) return Promise.resolve(null);
    if (refreshPromise) return refreshPromise;
    const read = store.beginRead(), revision = ++readRevision;
    state.loading = true;
    refreshPromise = (async () => {
      try {
        const payload = await call(`${base}/interactions`);
        if (!alive()) return null;
        const applied = store.applySnapshot(payload, read);
        if (applied && revision === readRevision) state.error = "";
        return payload;
      } catch (error) {
        if (alive() && revision === readRevision) state.error = "交互读取失败，请检查连接后重试。";
        return null;
      } finally { if (alive()) state.loading = false; refreshPromise = null; onSettled(); }
    })();
    return refreshPromise;
  }
  function check(id) {
    if (!alive()) return Promise.resolve(null);
    if (checks.has(id)) return checks.get(id);
    const read = store.beginRead();
    const operation = (async () => {
      try {
        const payload = await call(path(id));
        if (!alive()) return null;
        store.applyUpdate(payload, read);
        if (state.interactions[id]?.status !== "pending") delete state.responseErrors[id];
        return payload.interaction;
      } catch (error) {
        if (alive()) state.responseErrors[id] = error.status === 404
          ? "此交互已失效，请刷新当前待办。" : "响应状态暂未确认，请稍后再次核对。";
        return null;
      } finally { checks.delete(id); onSettled(); }
    })();
    checks.set(id, operation); return operation;
  }
  function respond(id, response) {
    if (responses.has(id)) return responses.get(id);
    if (!alive() || !state.ready || state.interactions[id]?.status !== "pending" || state.actions[id]) return Promise.resolve(null);
    state.actions[id] = { status: "submitting", responseId: newId() };
    delete state.responseErrors[id];
    const responseId = state.actions[id].responseId, read = store.beginRead();
    const operation = (async () => {
      try {
        const payload = await call(`${path(id)}/respond`, { method: "POST", body: JSON.stringify({ responseId, response }) });
        if (!alive()) return null;
        store.applyUpdate(payload, read);
        if (state.interactions[id]?.status === "pending") {
          state.actions[id] = { status: "unknown", responseId };
          await check(id);
        }
        return payload.interaction;
      } catch (error) {
        if (!alive()) return null;
        if (["submitted", "resolved", "unavailable"].includes(state.interactions[id]?.status)) return state.interactions[id];
        const definitelyRejected = [400, 401, 403, 413, 422, 429].includes(error.status);
        store.clearDraft(id);
        if (definitelyRejected) {
          delete state.actions[id];
          state.responseErrors[id] = "响应未通过校验或暂时无法提交，请核对后重试。";
        } else {
          state.actions[id] = { status: "unknown", responseId };
          state.responseErrors[id] = "响应状态尚未确认，正在核对原交互。";
          await check(id);
        }
        return state.interactions[id];
      } finally { responses.delete(id); onSettled(); }
    })();
    responses.set(id, operation); return operation;
  }
  function dispose() { disposed = true; readRevision += 1; store.dispose(); }
  return { refresh, check, respond, needsRecovery, dispose };
}
