const STATUSES = new Set(["pending", "submitting", "submitted", "resolved", "unavailable", "unknown"]);
const TERMINAL = new Set(["resolved", "unavailable"]);
const copy = (value) => JSON.parse(JSON.stringify(value));
const dictionary = () => Object.create(null);

export function createCodexInteractionState(threadId, { reactive = (value) => value } = {}) {
  let disposed = false, generation = 0;
  const state = reactive({ threadId, interactions: dictionary(), order: [], drafts: dictionary(), actions: dictionary(),
    responseErrors: dictionary(), epoch: "", revision: 0, ready: false, loading: false, error: "" });

  function beginRead() { return { generation }; }
  function validateEnvelope(payload, rows) {
    if (!payload || typeof payload.epoch !== "string" || !payload.epoch || !Number.isSafeInteger(payload.revision) || payload.revision < 0 ||
      !Array.isArray(rows) || rows.some((row) => !row || typeof row.id !== "string" || !row.id || row.threadId !== threadId ||
        typeof row.method !== "string" || !row.params || typeof row.params !== "object" || !STATUSES.has(row.status) ||
        !Number.isSafeInteger(row.version) || row.version < 0)) throw new Error("交互响应格式无效，请重新核对。");
  }
  function clearDraft(id) { delete state.drafts[id]; }
  function unavailable(row, message) {
    state.interactions[row.id] = { ...row, status: "unavailable", error: { code: "interaction_unavailable", message } };
    clearDraft(row.id); delete state.actions[row.id]; delete state.responseErrors[row.id];
  }
  function acceptEnvelope(payload, read) {
    if (disposed || read && read.generation !== generation) return false;
    if (!state.epoch) generation += 1;
    if (state.epoch && state.epoch !== payload.epoch) {
      for (const row of Object.values(state.interactions)) if (!TERMINAL.has(row.status)) unavailable(row, "原连接已失效，此请求无法继续响应。");
      generation += 1; state.revision = 0;
    }
    if (state.epoch === payload.epoch && payload.revision < state.revision) return false;
    state.epoch = payload.epoch; state.revision = payload.revision;
    return true;
  }
  function upsert(row) {
    const previous = state.interactions[row.id];
    if (previous && (row.version < previous.version || TERMINAL.has(previous.status) && !TERMINAL.has(row.status) ||
      previous.status !== "pending" && row.status === "pending")) return;
    state.interactions[row.id] = copy(row);
    if (!state.order.includes(row.id)) state.order.push(row.id);
    if (row.status !== "pending") {
      clearDraft(row.id);
      if (row.status !== "unknown") { delete state.actions[row.id]; delete state.responseErrors[row.id]; }
    }
  }
  function applySnapshot(payload, read) {
    validateEnvelope(payload, payload?.interactions);
    if (!acceptEnvelope(payload, read)) return false;
    const ids = new Set(payload.interactions.map((row) => row.id));
    for (const row of payload.interactions) upsert(row);
    for (const row of Object.values(state.interactions)) {
      if (ids.has(row.id)) continue;
      if (!TERMINAL.has(row.status)) unavailable(row, "此交互已不在当前待办中，请以当前会话状态为准。");
      else { delete state.interactions[row.id]; state.order = state.order.filter((id) => id !== row.id); }
    }
    state.ready = true;
    return true;
  }
  function applyUpdate(payload, read) {
    validateEnvelope(payload, payload?.interaction ? [payload.interaction] : null);
    if (!acceptEnvelope(payload, read)) return false;
    upsert(payload.interaction);
    return true;
  }
  function setDraft(id, values) {
    if (disposed || state.interactions[id]?.status !== "pending" || state.actions[id]) return;
    state.drafts[id] = { ...state.drafts[id], ...values };
  }
  function dispose() {
    disposed = true; generation += 1;
    for (const id of Object.keys(state.drafts)) clearDraft(id);
    for (const id of Object.keys(state.actions)) delete state.actions[id];
  }
  return { state, beginRead, applySnapshot, applyUpdate, setDraft, clearDraft, dispose };
}
