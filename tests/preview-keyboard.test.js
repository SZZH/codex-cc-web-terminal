import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { compileScript, parse } from "vue/compiler-sfc";
import { createRenderer, h, markRaw, nextTick, reactive } from "vue";
import { createPreviewController } from "../web/src/lib/preview.js";
import { handleLocalPreviewLink, previewOpenHref } from "../web/src/lib/markdown-links.js";

const compiled = new Map();
function componentUrl(file) {
  if (compiled.has(file.href)) return compiled.get(file.href);
  const { descriptor } = parse(fs.readFileSync(file, "utf8"), { filename: file.pathname });
  const source = compileScript(descriptor, { id: file.pathname, inlineTemplate: true }).content
    .replace(/from\s+["']([^"']+)["']/g, (_, name) => `from ${JSON.stringify(name === "vue" ? import.meta.resolve("vue")
      : name.endsWith(".vue") ? componentUrl(new URL(name, file)) : new URL(name, file).href)}`);
  const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  compiled.set(file.href, url);
  return url;
}
const load = async (name) => (await import(componentUrl(new URL(`../web/src/components/${name}.vue`, import.meta.url)))).default;
const find = (node, predicate) => [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap((child) => find(child, predicate))];
const snapshot = (state) => Object.fromEntries(["open", "url", "status", "revision", "id", "kind"].map((key) => [key, state[key]]));
const composerProps = { composerOptions: { model: "fixture", attachments: [], permissionMode: "default" },
  models: [{ value: "fixture", label: "Fixture" }], gitState: { available: true, isGitRepo: true, currentBranch: "main", branches: [] }, canSend: true };
const assertFocus = (ui, target, message) => assert.equal(ui.document.activeElement === target, true, message);

async function mount(t, { compact = false } = {}) {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const body = { type: "body", children: [] }, root = { type: "root", children: [], parent: body };
  body.children.push(root);
  const listeners = new Map(), modalStack = [], nativeEvents = [], timers = new Map(), calls = [], grants = new Set(), errors = [], focusCalls = [];
  let timerId = 0, pageFocused = true;
  const mediaListeners = new Set();
  const media = { matches: compact, addEventListener: (_name, listener) => mediaListeners.add(listener), removeEventListener: (_name, listener) => mediaListeners.delete(listener) };
  const scroller = { scrollTop: 415, scrollLeft: 3, isConnected: true };
  const document = { body, activeElement: body,
    querySelector: (selector) => selector === "dialog[open]" ? find(body, (node) => node.type === "dialog" && node.open)[0] || null : null,
    querySelectorAll: () => [scroller], hasFocus: () => pageFocused };
  const window = { matchMedia: (query) => query.includes("959px") ? media : { matches: false },
    addEventListener(name, callback) { const set = listeners.get(name) || new Set(); set.add(callback); listeners.set(name, set); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); } };
  globalThis.document = document; globalThis.window = window;
  const connected = (node) => { while (node?.parent) node = node.parent; return node === body; };
  const element = (type) => {
    const node = markRaw({ type, props: {}, children: [], style: {}, scrollHeight: 48, open: false,
      get isConnected() { return connected(this); }, get disabled() { return Boolean(this.props.disabled); },
      matches(selector) { return selector === ":disabled" && this.disabled; },
      contains(target) { return find(this, (entry) => entry === target).length > 0; },
      focus(options) {
        focusCalls.push({ node: this, options });
        if (!this.isConnected || this.disabled || (modalStack.length && !modalStack.at(-1).contains(this))) return;
        document.activeElement = this;
        for (const listener of listeners.get("focusin") || []) listener({ target: this });
      },
      querySelectorAll() { return find(this, (entry) => (entry.type === "button" && !entry.disabled) || entry.type === "a" || entry.type === "iframe"); },
      getBoundingClientRect: () => ({ left: 20, right: 400, top: 20, bottom: 400 })
    });
    if (type === "dialog") {
      node.showModal = function () {
        assert.equal(this.isConnected, true);
        this.nativeOrigin = document.activeElement; this.open = true; modalStack.push(this);
        (find(this, (entry) => entry.type === "button" && !entry.disabled)[0] || this).focus();
      };
      node.close = function () {
        if (!this.open) return;
        const top = modalStack.at(-1) === this;
        this.open = false; modalStack.splice(modalStack.indexOf(this), 1);
        if (top) { document.activeElement = body; this.nativeOrigin?.focus?.(); }
        nativeEvents.push(() => this.props.onClose?.({ target: this }));
      };
    }
    return node;
  };
  const renderer = createRenderer({
    createElement: element, createText: (text) => ({ text }), createComment: (text) => ({ text }),
    setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: (node) => node?.parent, nextSibling: (node) => node?.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    insert(node, parent, anchor) {
      if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node);
      node.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node);
    },
    remove(node) {
      if (node === document.activeElement || node.contains?.(document.activeElement)) document.activeElement = body;
      if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node);
      node.parent = null;
    },
    patchProp: (node, key, _before, after) => { node.props[key] = after; }, querySelector: (selector) => selector === "body" ? body : null
  });
  const controller = createPreviewController({ document, window, requestId: () => "f".repeat(32),
    setTimer(callback) { timers.set(++timerId, callback); return timerId; }, clearTimer: (id) => timers.delete(id),
    request: async (url, options) => {
      calls.push({ url, method: options.method });
      if (options.method === "DELETE") { grants.delete(url.split("/").at(-1)); return { ok: true }; }
      const id = JSON.parse(options.body).requestId; grants.add(id);
      return { id, kind: "service", title: "Fixture service", url: "http://127.0.0.1:41992/fixture" };
    } });
  const ui = reactive({ draft: "kept draft", image: null });
  const [Preview, Composer, Image] = await Promise.all([load("preview/PreviewHost"), load("composer/ChatComposer"), load("thread-item/ImageLightbox")]);
  const app = renderer.createApp({ render: () => h("div", [
    h("a", { class: "preview-link", href: previewOpenHref({ target: "http://localhost:5173" }), onClick(event) { handleLocalPreviewLink(event, controller.open); } }, "Fixture service"),
    h("button", { class: "image-link", onClick(event) { ui.image = { url: "/fixture.png", alt: "Fixture image", origin: event.currentTarget }; } }, "Fixture image"),
    h(Composer, { ...composerProps, draft: ui.draft, "onUpdate:draft": (value) => { ui.draft = value; } }),
    h(Preview, { controller }), ui.image ? h(Image, { image: ui.image, origin: ui.image.origin, onClose() { ui.image = null; } }) : null
  ]) });
  app.config.errorHandler = (error) => errors.push(error);
  const settle = async () => { for (let index = 0; index < 8; index += 1) await nextTick(); for (const callback of nativeEvents.splice(0)) callback(); await nextTick(); };
  t.after(async () => {
    try {
      app.unmount(); await settle();
      assert.equal(modalStack.length, 0); assert.equal(timers.size, 0); assert.equal(grants.size, 0);
      assert.equal([...listeners.values()].reduce((count, set) => count + set.size, 0), 0);
      assert.equal(mediaListeners.size, 0);
      assert.equal(find(body, (node) => node.type === "dialog").length, 0); assert.deepEqual(errors, []);
    } finally { globalThis.window = previousWindow; globalThis.document = previousDocument; }
  });
  const all = (predicate) => find(body, predicate);
  const byClass = (name) => all((node) => String(node.props?.class || "").split(/\s+/).includes(name))[0];
  const dispatch = (target, property, extra = {}) => {
    const event = { type: property === "onClick" ? "click" : "keydown", key: "", button: 0, target, currentTarget: target,
      defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
    for (let node = target; node && !event.stopped; node = node.parent) { event.currentTarget = node; node.props?.[property]?.(event); }
    if (!event.stopped && property === "onKeydown") for (const listener of listeners.get("keydown") || []) listener(event);
    return event;
  };
  const click = (node) => { node.focus(); return dispatch(node, "onClick"); };
  const key = (value, extra = {}) => {
    const event = dispatch(document.activeElement, "onKeydown", { key: value, ...extra });
    if (value === "Escape" && !event.defaultPrevented && modalStack.length) {
      const dialog = modalStack.at(-1), cancel = { target: dialog, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
      dialog.props.onCancel?.(cancel);
      if (!cancel.defaultPrevented) dialog.close();
    }
    return event;
  };
  app.mount(root); await settle();
  const anchor = byClass("preview-link");
  anchor.getAttribute = (name) => anchor.props[name]; anchor.closest = () => anchor;
  click(anchor); await settle();
  const frame = all((node) => node.type === "iframe")[0];
  frame.props.onLoad({ currentTarget: { dataset: { previewRevision: controller.state.revision } } }); await settle();
  assert.equal(controller.state.status, "ready");
  return { controller, ui, document, modalStack, grants, calls, focusCalls, byClass, all, click, key, settle, scroller,
    resizeCompact(value) { media.matches = value; for (const listener of mediaListeners) listener(); },
    setPageFocused(value) { pageFocused = value; },
    focusin() { for (const listener of listeners.get("focusin") || []) listener({ target: document.activeElement }); }
  };
}

test("settings Escape closes only the native modal, preserves the service and draft, then closes preview once", async (t) => {
  const ui = await mount(t), before = snapshot(ui.controller.state);
  ui.click(ui.byClass("chat-composer-context-button")); await ui.settle();
  const dialog = ui.byClass("popover-drawer"); assert.equal(dialog.open, true);
  const first = ui.key("Escape"); await ui.settle();
  assert.equal(first.defaultPrevented, false); assert.equal(dialog.open, false);
  assert.deepEqual(snapshot(ui.controller.state), before); assert.equal(ui.ui.draft, "kept draft");
  assert.equal(ui.byClass("chat-composer-draft").props.value, "kept draft");
  assert.equal(ui.grants.size, 1); assert.equal(ui.calls.filter((call) => call.method === "DELETE").length, 0);
  assert.equal(ui.key("Escape").defaultPrevented, true); await ui.settle();
  assert.equal(ui.controller.state.open, false); assert.equal(ui.grants.size, 0);
  ui.key("Escape"); await ui.settle();
  assert.equal(ui.calls.filter((call) => call.method === "DELETE").length, 1);
});

test("already consumed Escape and Tab events cannot close or move focus in a compact preview", async (t) => {
  const ui = await mount(t, { compact: true }), before = snapshot(ui.controller.state);
  for (const key of ["Escape", "Tab"]) for (const shiftKey of [false, true]) {
    const close = ui.byClass("preview-close"); close.focus();
    const count = ui.focusCalls.length;
    ui.key(key, { shiftKey, defaultPrevented: true }); await ui.settle();
    assert.deepEqual(snapshot(ui.controller.state), before); assert.equal(ui.document.activeElement, close);
    assert.equal(ui.focusCalls.length, count);
  }
});

test("a current native settings dialog keeps Tab and Shift+Tab outside the compact preview trap", async (t) => {
  const ui = await mount(t, { compact: true });
  ui.click(ui.byClass("chat-composer-context-button")); await ui.settle();
  const active = ui.document.activeElement, before = snapshot(ui.controller.state);
  for (const shiftKey of [false, true]) {
    const count = ui.focusCalls.length;
    assert.equal(ui.key("Tab", { shiftKey }).defaultPrevented, false);
    assert.equal(ui.document.activeElement, active); assert.equal(ui.focusCalls.length, count);
  }
  assert.deepEqual(snapshot(ui.controller.state), before);
});

test("the real image lightbox retains Tab locally and Escape preserves the background service", async (t) => {
  const ui = await mount(t, { compact: true }), before = snapshot(ui.controller.state);
  ui.click(ui.byClass("image-link")); await ui.settle();
  const dialog = ui.byClass("image-lightbox"), close = ui.byClass("image-lightbox-close");
  for (const shiftKey of [false, true]) {
    const event = ui.key("Tab", { shiftKey }); assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
    assert.equal(ui.document.activeElement, close);
  }
  ui.key("Escape"); await ui.settle();
  assert.equal(dialog.open, false); assert.equal(ui.ui.image, null); assert.deepEqual(snapshot(ui.controller.state), before);
  assert.equal(ui.grants.size, 1); assert.equal(ui.calls.filter((call) => call.method === "DELETE").length, 0);
  ui.key("Escape"); await ui.settle(); assert.equal(ui.calls.filter((call) => call.method === "DELETE").length, 1);
});

for (const compact of [false, true]) {
  test(`ordinary ${compact ? "compact" : "desktop"} preview keeps its Escape and Tab behavior`, async (t) => {
    const ui = await mount(t, { compact }), close = ui.byClass("preview-close"), frame = ui.all((node) => node.type === "iframe")[0];
    close.focus(); assert.equal(ui.key("Tab", { shiftKey: true }).defaultPrevented, compact);
    assert.equal(ui.document.activeElement, compact ? frame : close);
    frame.focus(); assert.equal(ui.key("Tab").defaultPrevented, compact);
    assert.equal(ui.document.activeElement, compact ? close : frame);
    const link = ui.byClass("preview-external"); link.focus();
    assert.equal(ui.key("Tab").defaultPrevented, false); assert.equal(ui.key("ArrowLeft").defaultPrevented, false);
    assert.equal(ui.key("Escape").defaultPrevented, true); await ui.settle();
    assert.equal(ui.controller.state.open, false); assert.equal(ui.calls.filter((call) => call.method === "DELETE").length, 1);
  });
}

test("desktop settings closed after a compact resize return focus inside the same preview and preserve its service", async (t) => {
  const ui = await mount(t), before = snapshot(ui.controller.state), frame = ui.all((node) => node.type === "iframe")[0];
  ui.click(ui.byClass("chat-composer-context-button")); await ui.settle();
  const dialog = ui.byClass("popover-drawer"), active = ui.document.activeElement;
  ui.resizeCompact(true); await ui.settle();
  assertFocus(ui, active, "resize must not override the current native modal");
  ui.key("Escape"); await ui.settle();
  assert.equal(dialog.open, false); assertFocus(ui, ui.byClass("preview-close"), "closing settings must not return compact focus to the background");
  assert.deepEqual(snapshot(ui.controller.state), before); assert.equal(ui.all((node) => node.type === "iframe")[0] === frame, true);
  assert.equal(ui.key("Tab", { shiftKey: true }).defaultPrevented, true); assertFocus(ui, frame);
  assert.equal(ui.key("Tab").defaultPrevented, true); assertFocus(ui, ui.byClass("preview-close"));
  assert.equal(ui.grants.size, 1); assert.equal(ui.calls.filter((call) => call.method === "DELETE").length, 0);
  ui.scroller.scrollTop = 9; ui.key("Escape"); await ui.settle();
  assertFocus(ui, ui.byClass("preview-link")); assert.equal(ui.scroller.scrollTop, 415);
  assert.equal(ui.ui.draft, "kept draft"); assert.equal(ui.calls.filter((call) => call.method === "DELETE").length, 1);
});

test("compact focusin and resizing constrain background focus while desktop inputs remain available", async (t) => {
  const ui = await mount(t), draft = ui.byClass("chat-composer-draft"), frame = ui.all((node) => node.type === "iframe")[0];
  draft.focus(); assertFocus(ui, draft);
  ui.resizeCompact(true); await ui.settle(); assertFocus(ui, ui.byClass("preview-close"));
  draft.focus(); assertFocus(ui, ui.byClass("preview-close"));
  frame.focus(); assertFocus(ui, frame);
  ui.resizeCompact(false); await ui.settle(); draft.focus(); assertFocus(ui, draft);
});

test("compact Tab recovers an outside, body or null active element without changing already consumed events", async (t) => {
  const ui = await mount(t, { compact: true }), close = ui.byClass("preview-close"), frame = ui.all((node) => node.type === "iframe")[0];
  for (const active of [ui.byClass("chat-composer-context-button"), ui.document.body, null]) for (const shiftKey of [false, true]) {
    ui.document.activeElement = active;
    assert.equal(ui.key("Tab", { shiftKey, defaultPrevented: true }).defaultPrevented, true);
    assertFocus(ui, active, "a consumed event must not trigger a second keyboard action");
    const event = ui.key("Tab", { shiftKey });
    assert.equal(event.defaultPrevented, true); assertFocus(ui, shiftKey ? frame : close);
  }
});

test("a compact preview does not reclaim focus from browser chrome or another native modal", async (t) => {
  const ui = await mount(t), body = ui.document.body;
  ui.setPageFocused(false); ui.document.activeElement = body;
  const count = ui.focusCalls.length;
  ui.resizeCompact(true); await ui.settle(); ui.focusin();
  assert.equal(ui.key("Tab").defaultPrevented, false); assertFocus(ui, body); assert.equal(ui.focusCalls.length, count);
  ui.setPageFocused(true); ui.byClass("chat-composer-draft").focus();
  assertFocus(ui, ui.byClass("preview-close"));
  ui.resizeCompact(false); await ui.settle();
  ui.click(ui.byClass("chat-composer-context-button")); await ui.settle();
  const active = ui.document.activeElement;
  ui.resizeCompact(true); await ui.settle(); ui.focusin();
  assertFocus(ui, active); assert.equal(ui.key("Tab").defaultPrevented, false);
});
