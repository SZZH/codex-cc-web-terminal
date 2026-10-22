const OWNERS = ["connection", "events", "poll", "older", "submit", "interrupt",
  "promote", "cancel", "restore", "confirmation"];

export function createCodexRuntimeErrors({ state, isDisposed }) {
  const slots = Object.fromEntries(OWNERS.map((owner) => [owner, { revision: 0, failure: null }]));
  let order = 0;
  let disposed = false;

  function current(token) {
    return token && !disposed && !isDisposed() && slots[token.owner]?.revision === token.revision;
  }

  function publish() {
    const latest = Object.values(slots).map((slot) => slot.failure).filter(Boolean)
      .reduce((latest, failure) => !latest || failure.order > latest.order ? failure : latest, null);
    state.errorOwner = latest?.owner || "";
    state.error = latest?.message || "";
  }

  function begin(owner, target = "") {
    if (disposed || isDisposed()) return null;
    if (!Object.hasOwn(slots, owner)) throw new Error(`Unknown runtime error owner: ${owner}`);
    return { owner, target, revision: ++slots[owner].revision };
  }

  function fail(token, error) {
    if (!current(token)) return false;
    slots[token.owner].failure = { owner: token.owner, target: token.target, message: error?.message || String(error), order: ++order };
    publish();
    return true;
  }

  function succeed(token) {
    if (!current(token) || slots[token.owner].failure?.target !== token.target) return false;
    slots[token.owner].failure = null;
    publish();
    return true;
  }

  function dispose() {
    disposed = true;
    for (const slot of Object.values(slots)) slot.failure = null;
  }

  return { begin, fail, succeed, dispose };
}
