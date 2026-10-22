const BOTTOM_THRESHOLD = 84;
const USER_SCROLL_WINDOW_MS = 750;
const HISTORY_TOP_THRESHOLD = 0;

export function createMessageStreamScroll({ getElement, nextTick, getContext = () => "", now = Date.now,
  getHasOlder = () => false, getLoadingOlder = () => false, onReachTop }) {
  let pinnedToBottom = true;
  let userScroll = null;
  let scrollbarPointerActive = false;
  let touchStart = null;
  let inspecting = false;
  let active = true;
  let contextGeneration = 0;
  let intentRevision = 0;
  let historyRead = null;
  let historyFailed = false;
  let historyIntent = -1;

  function isNearBottom(element, threshold = BOTTOM_THRESHOLD) {
    if (!element) return true;
    return element.scrollHeight - element.clientHeight - element.scrollTop <= threshold;
  }

  function captureContext() {
    const context = getContext(), generation = contextGeneration;
    return () => active && context === getContext() && generation === contextGeneration;
  }

  function schedule(callback) {
    const isCurrent = captureContext();
    nextTick(() => { if (isCurrent()) callback(); });
  }

  function scrollToBottom(force = false) {
    const revision = intentRevision;
    schedule(() => {
      const element = getElement();
      if (!element || revision !== intentRevision || inspecting || (!force && !pinnedToBottom)) return;
      pinnedToBottom = true;
      if (typeof element.scrollTo === "function") element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
      else element.scrollTop = element.scrollHeight;
    });
  }

  function inspect() {
    intentRevision += 1;
    pinnedToBottom = false;
    inspecting = true;
    userScroll = null;
    scrollbarPointerActive = false;
    touchStart = null;
  }

  function loadOlder({ manual = false } = {}) {
    if (!active || historyRead || getLoadingOlder() || !getHasOlder() || typeof onReachTop !== "function" ||
      !manual && (historyFailed || historyIntent === intentRevision)) return Promise.resolve(false);
    const element = getElement();
    if (!element) return Promise.resolve(false);
    intentRevision += 1;
    pinnedToBottom = false;
    inspecting = true;
    const owner = {}, isCurrent = captureContext(), revision = intentRevision;
    const top = element.scrollTop, height = element.scrollHeight;
    const anchor = historyAnchor(element);
    historyRead = owner; historyIntent = revision; historyFailed = false;
    owner.promise = Promise.resolve().then(() => isCurrent() && onReachTop()).then(async (result) => {
      if (!isCurrent() || historyRead !== owner) return false;
      historyFailed = result === false;
      await new Promise((resolve) => nextTick(resolve));
      // A pending page must not move a reader who scrolled or changed context meanwhile.
      if (!historyFailed && isCurrent() && historyRead === owner && revision === intentRevision &&
        getElement() === element && element.scrollTop === top) {
        const anchorElement = restoreHistoryAnchor(element, anchor);
        const anchorDelta = anchorElement
          ? anchorElement.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset : null;
        const restoredTop = Math.max(0, top + (Number.isFinite(anchorDelta) ? anchorDelta : Math.max(0, element.scrollHeight - height)));
        if (typeof element.scrollTo === "function") element.scrollTo({ top: restoredTop, behavior: "instant" });
        else element.scrollTop = restoredTop;
      }
      return !historyFailed;
    }).catch(() => {
      if (isCurrent() && historyRead === owner) historyFailed = true;
      return false;
    }).finally(() => {
      if (historyRead === owner) { historyRead = null; historyIntent = intentRevision; }
    });
    return owner.promise;
  }

  function historyAnchor(element) {
    if (!element.getBoundingClientRect || !element.querySelectorAll) return null;
    const bounds = element.getBoundingClientRect();
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    };
    const item = [...element.querySelectorAll("[data-thread-item-id]")].find(visible);
    const card = item?.closest?.(".thread-turn-card");
    const node = item || [...element.querySelectorAll(".thread-turn-card")].find(visible);
    return node ? { element: node, itemId: item?.getAttribute?.("data-thread-item-id"), card,
      offset: node.getBoundingClientRect().top - bounds.top } : null;
  }

  function restoreHistoryAnchor(element, anchor) {
    if (!anchor) return null;
    if (anchor.element.isConnected !== false) return anchor.element;
    if (!anchor.itemId || !element.querySelectorAll) return null;
    const parent = anchor.card?.isConnected !== false && anchor.card?.querySelectorAll ? anchor.card : element;
    return [...parent.querySelectorAll("[data-thread-item-id]")]
      .find((node) => node.getAttribute?.("data-thread-item-id") === anchor.itemId) || null;
  }

  function readAtTop() {
    if (getElement()?.scrollTop <= HISTORY_TOP_THRESHOLD) void loadOlder();
  }

  function handleStreamScroll(event) {
    if (!active) return;
    const position = scrollPosition(event.target), at = now();
    const nearBottom = isNearBottom(event.target);
    const recent = userScroll && at - userScroll.at < USER_SCROLL_WINDOW_MS;
    const delta = position.top - userScroll?.top;
    // Continue momentum only while real movement follows the gesture without a layout change.
    const continuing = recent && Number.isFinite(delta) && delta !== 0 &&
      position.height === userScroll.height && position.viewport === userScroll.viewport &&
      (!userScroll.direction || Math.sign(delta) === userScroll.direction);
    if (scrollbarPointerActive || continuing) {
      if (historyRead && delta !== 0) intentRevision += 1;
      userScroll = { ...position, at, direction: userScroll?.direction || 0 };
      pinnedToBottom = nearBottom;
      if (nearBottom) inspecting = false;
      if (delta < 0) readAtTop();
    } else {
      userScroll = recent ? { ...userScroll, ...position } : null;
      if (pinnedToBottom && !nearBottom) scrollToBottom();
    }
  }

  function scrollPosition(element = getElement()) {
    return { top: element?.scrollTop, height: element?.scrollHeight, viewport: element?.clientHeight };
  }

  function markUserScroll(direction = 0) {
    if (!active) return;
    intentRevision += 1;
    userScroll = { ...scrollPosition(), at: now(), direction: Math.sign(direction) };
    pinnedToBottom = direction > 0 && isNearBottom(getElement());
    if (pinnedToBottom) inspecting = false;
    if (direction < 0 && getElement()?.scrollTop <= 0) readAtTop();
  }

  function handleStreamWheel(event) {
    if (event.deltaY) markUserScroll(event.deltaY);
  }

  function handleStreamTouchStart(event) {
    const touch = event.touches?.[0];
    touchStart = touch ? { x: touch.clientX, y: touch.clientY } : null;
  }

  function handleStreamTouchMove(event) {
    const touch = event.touches?.[0];
    if (touch && touchStart && Math.abs(touch.clientY - touchStart.y) > 4 &&
      Math.abs(touch.clientY - touchStart.y) > Math.abs(touch.clientX - touchStart.x)) {
      markUserScroll(touchStart.y - touch.clientY);
      touchStart = { x: touch.clientX, y: touch.clientY };
    }
  }

  function handleStreamTouchEnd() {
    touchStart = null;
  }

  function handleStreamKeydown(event) {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key) &&
      !event.target?.closest?.("input, textarea, select, [contenteditable='true']")) {
      const forward = ["ArrowDown", "PageDown", "End"].includes(event.key) || (event.key === " " && !event.shiftKey);
      markUserScroll(forward ? 1 : -1);
    }
  }

  function handleStreamPointerDown(event) {
    const stream = getElement();
    const right = stream?.getBoundingClientRect().right;
    if (event.pointerType === "touch" || event.target !== stream || !Number.isFinite(right) ||
      event.clientX < right - 24 || event.clientX > right) return;
    scrollbarPointerActive = true;
    markUserScroll();
  }

  function handleStreamPointerUp() {
    if (scrollbarPointerActive) {
      pinnedToBottom = isNearBottom(getElement());
      if (pinnedToBottom) inspecting = false;
    }
    scrollbarPointerActive = false;
  }

  function reset() {
    contextGeneration += 1;
    intentRevision += 1;
    pinnedToBottom = true;
    inspecting = false;
    userScroll = null;
    scrollbarPointerActive = false;
    touchStart = null;
    historyRead = null; historyFailed = false; historyIntent = -1;
  }

  function dispose() {
    active = false;
    contextGeneration += 1;
    intentRevision += 1;
    userScroll = null;
    scrollbarPointerActive = false;
    touchStart = null;
    historyRead = null;
  }

  return {
    get isPinnedToBottom() { return pinnedToBottom; },
    isNearBottom, scrollToBottom, inspect, reset, dispose, schedule, captureContext, loadOlder,
    handleStreamScroll, handleStreamWheel, handleStreamTouchStart, handleStreamTouchMove,
    handleStreamTouchEnd, handleStreamKeydown, handleStreamPointerDown, handleStreamPointerUp
  };
}
