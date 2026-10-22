import test from "node:test";
import assert from "node:assert/strict";
import { createSessionListViewState } from "../web/src/lib/app-state.js";
import { createSessionListPosition } from "../web/src/lib/session-list-position.js";
import { createPreviewController } from "../web/src/lib/preview.js";

function positionHost() {
  const context = { mode: "groups", query: "", loaded: true };
  const page = { x: 0, y: 0, width: 1400, height: 12000, viewportWidth: 1200, viewportHeight: 800, rootTop: 30 };
  const nodes = [], frames = new Map(), listeners = new Map(), writes = [], windowWrites = [];
  let nextFrame = 0, current = true;
  const root = { isConnected: true, clientTop: 2,
    get scrollLeft() { return page.x; }, set scrollLeft(value) { page.x = value; },
    get scrollTop() { return page.y; }, set scrollTop(value) { page.y = value; },
    get scrollWidth() { return page.width; }, get scrollHeight() { return page.height; },
    get clientWidth() { return page.viewportWidth; }, get clientHeight() { return page.viewportHeight; },
    getBoundingClientRect() { return { top: page.rootTop, bottom: page.rootTop + 2 + page.viewportHeight }; },
    scrollTo(position) { writes.push(position); page.x = position.left; page.y = position.top; },
    querySelectorAll(selector) {
      const name = selector.slice(1, -1);
      return nodes.filter((node) => node.getAttribute(name) !== null);
    }
  };
  const view = {
    scrollX: 0, scrollY: 0,
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    addEventListener(name, callback) {
      const callbacks = listeners.get(name) || new Set(); callbacks.add(callback); listeners.set(name, callbacks);
    },
    removeEventListener(name, callback) {
      const callbacks = listeners.get(name); callbacks?.delete(callback); if (!callbacks?.size) listeners.delete(name);
    },
    scrollTo(position, top) {
      if (typeof position === "number") position = { left: position, top };
      windowWrites.push(position);
    }
  };
  const doc = {
    activeElement: null, querySelectorAll: (selector) => selector === "[data-app-scroll]" ? [root] : [],
    documentElement: { get clientHeight() { return page.viewportHeight; }, get clientWidth() { return page.viewportWidth; } },
    scrollingElement: { get scrollHeight() { return page.viewportHeight; }, get scrollWidth() { return page.viewportWidth; } }
  };
  const add = ({ sessionId = "", groupId = "", top, height = 60, measure } = {}) => {
    const group = groupId ? { getAttribute: (name) => name === "data-group-id" ? groupId : null } : null;
    const node = { top, height, groupId, sessionId,
      getAttribute(name) { return name === "data-session-id" ? sessionId || null : name === "data-group-id" && !sessionId ? groupId || null : null; },
      closest() { return group; },
      getBoundingClientRect() { measure?.(); return { top: page.rootTop + 2 + this.top - page.y, bottom: page.rootTop + 2 + this.top - page.y + this.height }; }
    };
    nodes.push(node); return node;
  };
  return { context, page, nodes, frames, listeners, writes, windowWrites, root, view, doc, add,
    invalidate() { current = false; },
    fire(name) { for (const callback of [...(listeners.get(name) || [])]) callback({ type: name }); },
    flush() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); },
    controller(viewState) { return createSessionListPosition({ viewState, getRoot: () => root,
      getContext: () => context, isCurrent: () => current, window: view, document: doc }); }
  };
}

function remember(host, viewState, top = 2300) {
  host.page.y = top;
  const leaving = host.controller(viewState);
  leaving.capture(); leaving.dispose(); host.page.y = 0;
}

for (const mode of ["groups", "activity"]) {
  test(`${mode} restores the visible session's viewport offset after preceding content grows`, () => {
    const host = positionHost(), state = createSessionListViewState();
    host.context.mode = mode; host.context.query = "release";
    const row = host.add({ sessionId: "old-thread", groupId: mode === "groups" ? "project:a" : "", top: 2340 });
    remember(host, state);
    assert.deepEqual(state.position, { mode, query: "release", left: 0, top: 2300,
      anchor: { kind: "session", sessionId: "old-thread", groupId: row.groupId, offset: 40 } });
    assert.doesNotThrow(() => JSON.stringify(state.position), "the finite snapshot retains no DOM references");
    row.top = 2600;
    const returning = host.controller(state);
    returning.restore(); host.flush();
    assert.equal(host.page.y, 2560);
    assert.equal(row.getBoundingClientRect().top - 32, 40);
    assert.equal(host.writes[0].behavior, "instant");
    assert.equal(host.listeners.size, 0);
    returning.dispose();
  });
}

test("list anchors exclude clipped rows and stay relative to a moved and resized scrolling viewport", () => {
  const host = positionHost(), state = createSessionListViewState();
  host.add({ sessionId: "clipped", top: 2270, height: 20 });
  const row = host.add({ sessionId: "visible", top: 2340 });
  remember(host, state);
  assert.equal(state.position.anchor.sessionId, "visible");
  host.page.rootTop = 180; host.page.viewportHeight = 250; row.top += 150;
  const returning = host.controller(state);
  try {
    returning.restore(); host.flush();
    assert.equal(row.getBoundingClientRect().top - host.page.rootTop - 2, 40);
    assert.equal(host.page.y, 2450);
    assert.equal(host.windowWrites.length, 0);
  } finally { returning.dispose(); }
});

test("duplicate session identities restore their captured group and missing group uses pixels", () => {
  const host = positionHost(), state = createSessionListViewState();
  host.add({ sessionId: "same", groupId: "pinned", top: 100 });
  const target = host.add({ sessionId: "same", groupId: "project:a", top: 2340 });
  remember(host, state);
  target.top = 2700;
  let returning = host.controller(state); returning.restore(); host.flush(); returning.dispose();
  assert.equal(host.page.y, 2660);
  host.nodes.splice(host.nodes.indexOf(target), 1); host.page.y = 0;
  returning = host.controller(state); returning.restore(); host.flush(); returning.dispose();
  assert.equal(host.page.y, 2300, "a duplicate in another group cannot replace the missing anchor");
});

test("a visible collapsed group can be an anchor when there are no visible session rows", () => {
  const host = positionHost(), state = createSessionListViewState();
  const group = host.add({ groupId: 'project:"special]name', top: 2320, height: 90 });
  remember(host, state); group.top += 400;
  const returning = host.controller(state); returning.restore(); host.flush(); returning.dispose();
  assert.equal(group.getBoundingClientRect().top - 32, 20);
  assert.equal(host.page.y, 2700, "identity comparison does not interpolate ids into CSS selectors");
});

test("pixel fallback and changed geometry are clamped to the shortened list element range", () => {
  const host = positionHost(), state = createSessionListViewState();
  host.page.x = 180; remember(host, state, 9000);
  host.page.height = 1100; host.page.width = 1200;
  const returning = host.controller(state); returning.restore(); host.flush(); returning.dispose();
  assert.deepEqual(host.writes, [{ left: 0, top: 300, behavior: "instant" }]);
});

test("restore waits for committed loaded data, runs once, and ignores later polling or preview layout changes", () => {
  const host = positionHost(), state = createSessionListViewState();
  host.add({ sessionId: "target", top: 2340 }); remember(host, state);
  host.context.loaded = false;
  const returning = host.controller(state); returning.restore(); host.flush();
  assert.equal(host.writes.length, 0); assert.equal(host.frames.size, 0); assert.equal(host.listeners.size, 4);
  host.context.loaded = true; returning.restore(); host.flush();
  assert.equal(host.page.y, 2300);
  host.page.y = 700; host.nodes[0].top += 500; host.page.viewportWidth = 500;
  returning.restore(); returning.restore(); host.flush();
  assert.equal(host.page.y, 700); assert.equal(host.writes.length, 1); assert.equal(host.listeners.size, 0);
  returning.dispose();
});

test("the actual preview controller retains ownership of its later close scroll", async () => {
  const host = positionHost(), state = createSessionListViewState(); remember(host, state);
  const returning = host.controller(state); returning.restore(); host.flush();
  host.page.y = 700;
  const preview = createPreviewController({ window: host.view, document: host.doc,
    request: async () => ({ id: "file", kind: "file", title: "report.md", url: "http://localhost:8444/preview/file" }) });
  await preview.open({ target: "/workspace/report.md" });
  host.page.y = 0; host.page.viewportWidth = 500;
  returning.restore(); preview.close(); host.flush();
  assert.equal(host.page.y, 700, "preview closes to its own saved page position");
  assert.equal(host.writes.length, 1, "only the initial list return uses the list controller");
  assert.deepEqual(host.windowWrites, [{ left: 0, top: 0 }], "the preview retains only its separate page bookmark");
  assert.equal(host.listeners.size, 0); assert.equal(host.frames.size, 0);
  returning.dispose();
});

for (const field of ["query", "mode"]) {
  test(`a changed ${field} cancels the saved context without writing`, () => {
    const host = positionHost(), state = createSessionListViewState(); remember(host, state);
    const returning = host.controller(state); returning.restore();
    host.context[field] = "changed"; host.flush(); returning.restore(); host.flush();
    assert.equal(host.writes.length, 0); assert.equal(host.frames.size, 0); assert.equal(host.listeners.size, 0);
    returning.dispose();
  });
}

for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) {
  test(`${event} cancels a pending return and releases every listener and frame`, () => {
    const host = positionHost(), state = createSessionListViewState(); remember(host, state);
    const returning = host.controller(state); returning.restore(); host.fire(event); host.flush();
    returning.restore(); host.flush();
    assert.equal(host.writes.length, 0); assert.equal(host.frames.size, 0); assert.equal(host.listeners.size, 0);
    returning.dispose();
  });
}

test("interaction while waiting for async data prevents a later restore", () => {
  const host = positionHost(), state = createSessionListViewState(); remember(host, state);
  host.context.loaded = false;
  const returning = host.controller(state); returning.restore(); host.fire("touchstart");
  host.context.loaded = true; returning.restore(); host.flush();
  assert.equal(host.writes.length, 0); assert.equal(host.listeners.size, 0);
  returning.dispose();
});

test("an immediate invalidation before queued cleanup and during geometry prevents scroll writes", () => {
  for (const duringGeometry of [false, true]) {
    const host = positionHost(), state = createSessionListViewState();
    host.add({ sessionId: "target", top: 2340 }); remember(host, state);
    if (duringGeometry) {
      const original = host.nodes[0].getBoundingClientRect;
      host.nodes[0].getBoundingClientRect = function () { host.invalidate(); return original.call(this); };
    }
    const returning = host.controller(state); returning.restore();
    if (!duringGeometry) host.invalidate();
    host.flush();
    assert.equal(host.writes.length, 0); assert.equal(host.listeners.size, 0);
    returning.dispose();
  }
});

test("leaving after generation invalidation captures only its old auth object", () => {
  const host = positionHost(), oldState = createSessionListViewState(), newState = createSessionListViewState();
  const leaving = host.controller(oldState); host.page.y = 1900; host.invalidate();
  leaving.capture(); leaving.dispose();
  assert.equal(oldState.position.top, 1900); assert.equal(newState.position, null);
  assert.equal(host.writes.length, 0);
});

test("unmount cancels scheduled work even if a queued frame callback escaped cancellation", () => {
  const host = positionHost(), state = createSessionListViewState(); remember(host, state);
  const returning = host.controller(state); returning.restore();
  const escaped = [...host.frames.values()][0]; returning.dispose(); escaped(); returning.restore();
  assert.equal(host.writes.length, 0); assert.equal(host.frames.size, 0); assert.equal(host.listeners.size, 0);
});

test("SSR without a document neither captures nor restores a page", () => {
  const state = createSessionListViewState();
  const controller = createSessionListPosition({ viewState: state, getRoot: () => null,
    getContext: () => ({ mode: "groups", query: "", loaded: true }), window: undefined, document: undefined });
  controller.capture(); controller.restore(); controller.dispose();
  assert.equal(state.position, null);
});
