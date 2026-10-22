const finite = (value) => Number.isFinite(value) ? value : 0;
const clamp = (value, maximum) => Math.min(Math.max(0, finite(value)), maximum);
const interactions = ["wheel", "touchstart", "pointerdown", "keydown"];

function rootRange(root) {
  return {
    left: Math.max(0, finite(root.scrollWidth) - finite(root.clientWidth)),
    top: Math.max(0, finite(root.scrollHeight) - finite(root.clientHeight))
  };
}

const viewportTop = (root) => finite(root.getBoundingClientRect().top) + finite(root.clientTop);

function captureAnchor(root) {
  const start = viewportTop(root), end = start + finite(root.clientHeight);
  for (const [selector, kind] of [["[data-session-id]", "session"], ["[data-group-id]", "group"]]) {
    for (const element of root.querySelectorAll(selector)) {
      const { top, bottom } = element.getBoundingClientRect();
      if (!Number.isFinite(top) || bottom <= start || top >= end) continue;
      return {
        kind,
        sessionId: kind === "session" ? element.getAttribute("data-session-id") : "",
        groupId: element.closest("[data-group-id]")?.getAttribute("data-group-id") || "",
        offset: top - start
      };
    }
  }
  return null;
}

function findAnchor(root, anchor) {
  if (!anchor) return null;
  const selector = anchor.kind === "session" ? "[data-session-id]" : "[data-group-id]";
  return [...root.querySelectorAll(selector)].find((element) =>
    (anchor.kind !== "session" || element.getAttribute("data-session-id") === anchor.sessionId)
    && (element.closest("[data-group-id]")?.getAttribute("data-group-id") || "") === anchor.groupId);
}

export function createSessionListPosition({ viewState, getRoot, getContext, isCurrent = () => true,
  window: view = globalThis.window }) {
  const snapshot = viewState.position;
  let pending = Boolean(snapshot);
  let active = true;
  let frame = null;
  let listening = false;

  function stopListening() {
    if (!listening) return;
    for (const name of interactions) view.removeEventListener(name, cancel, true);
    listening = false;
  }

  function cancel() {
    pending = false;
    if (frame !== null) view.cancelAnimationFrame(frame);
    frame = null;
    stopListening();
  }

  function matches() {
    const context = getContext();
    return context.mode === snapshot.mode && context.query === snapshot.query;
  }

  function restore() {
    if (!pending || !active || !view) return;
    if (!isCurrent() || !matches()) { cancel(); return; }
    if (!listening) {
      for (const name of interactions) view.addEventListener(name, cancel, { capture: true, passive: true });
      listening = true;
    }
    if (!getContext().loaded || frame !== null) return;
    frame = view.requestAnimationFrame(() => {
      frame = null;
      if (!pending || !active || !isCurrent() || !matches()) { cancel(); return; }
      if (!getContext().loaded) return;
      const root = getRoot();
      if (!root || root.isConnected === false) { cancel(); return; }
      const element = findAnchor(root, snapshot.anchor);
      const offset = element?.getBoundingClientRect().top;
      const top = Number.isFinite(offset)
        ? finite(root.scrollTop) + offset - viewportTop(root) - snapshot.anchor.offset : snapshot.top;
      const range = rootRange(root);
      // A route or auth change can precede Vue's queued cleanup.
      if (!isCurrent() || !matches()) { cancel(); return; }
      cancel();
      const position = { left: clamp(snapshot.left, range.left), top: clamp(top, range.top), behavior: "instant" };
      if (root.scrollTo) root.scrollTo(position);
      else { root.scrollLeft = position.left; root.scrollTop = position.top; }
    });
  }

  function capture() {
    const root = getRoot();
    const context = getContext();
    if (!active || !view || !root || !context.loaded) return;
    const range = rootRange(root);
    // Leaving may already have advanced the route generation; write only our owned object.
    viewState.position = {
      mode: context.mode, query: context.query,
      left: clamp(root.scrollLeft, range.left), top: clamp(root.scrollTop, range.top),
      anchor: captureAnchor(root)
    };
  }

  function dispose() {
    cancel();
    active = false;
  }

  return { capture, restore, cancel, dispose };
}
