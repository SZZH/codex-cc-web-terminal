import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { compileScript, compileStyle, parse } from "vue/compiler-sfc";
import { createRenderer, h, markRaw, nextTick, reactive, shallowReactive } from "vue";

const sourceUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const componentUrls = new Map();
const purifier = sourceUrl("export default { sanitize: (html) => html };");
function compileComponent(file) {
  if (componentUrls.has(file.href)) return componentUrls.get(file.href);
  const { descriptor } = parse(fs.readFileSync(file, "utf8"), { filename: file.pathname });
  const source = compileScript(descriptor, { id: file.pathname, inlineTemplate: true }).content
    .replace(/from\s+["']([^"']+)["']/g, (_, name) => `from ${JSON.stringify(name === "dompurify" ? purifier : name.endsWith(".vue")
      ? compileComponent(new URL(name, file)) : name.startsWith(".") ? new URL(name, file).href : import.meta.resolve(name))}`);
  const url = sourceUrl(source);
  componentUrls.set(file.href, url);
  return url;
}
const load = async (path) => (await import(compileComponent(new URL(`../web/src/components/${path}.vue`, import.meta.url)))).default;
const find = (node, predicate) => [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap((child) => find(child, predicate))];
const syntheticImage = () => ({ url: "/synthetic-image.png", alt: "synthetic image" });

async function mount(t, view, { nativeApi = true } = {}) {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const body = { type: "body", children: [] }, root = { type: "root", children: [], parent: body };
  body.children.push(root);
  const document = { body, activeElement: body };
  const trace = [], nativeEvents = [], modalStack = [], errors = [], listeners = new Map();
  globalThis.document = document;
  globalThis.window = {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener(name, handler) { const handlers = listeners.get(name) || new Set(); handlers.add(handler); listeners.set(name, handlers); },
    removeEventListener(name, handler) { listeners.get(name)?.delete(handler); }
  };
  const connected = (node) => { while (node?.parent) node = node.parent; return node === body; };
  const element = (type) => {
    const node = markRaw({ type, props: {}, children: [], open: false,
      get isConnected() { return connected(this); },
      get disabled() { return Boolean(this.props.disabled); },
      matches(selector) { return selector === ":disabled" && this.disabled; },
      contains(target) { return find(this, (candidate) => candidate === target).length > 0; },
      focus(options) {
        trace.push({ action: "focus", node: this, options });
        if (!this.isConnected || this.disabled || (modalStack.length && !modalStack.at(-1).contains(this))) return;
        document.activeElement = this;
      },
      getBoundingClientRect: () => ({ left: 0, right: 390, top: 20.25, bottom: 362.125 })
    });
    if (type === "dialog" && nativeApi) {
      node.showModal = function () {
        assert.equal(this.isConnected, true);
        this.nativeOrigin = document.activeElement;
        this.open = true;
        modalStack.push(this);
        trace.push({ action: "show", node: this });
        find(this, (candidate) => candidate.type === "button" && !candidate.disabled)[0]?.focus();
      };
      node.close = function () {
        if (!this.open) return;
        const top = modalStack.at(-1) === this;
        this.open = false;
        modalStack.splice(modalStack.indexOf(this), 1);
        trace.push({ action: "close", node: this });
        if (top && this.nativeOrigin?.isConnected && !this.nativeOrigin.disabled) this.nativeOrigin.focus();
        else if (top) document.activeElement = body;
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
    patchProp: (node, key, _previous, value) => { node.props[key] = value; },
    querySelector: (selector) => selector === "body" ? body : null
  });
  const origin = element("button"); origin.parent = body; body.children.push(origin); origin.focus();
  const all = (predicate) => find(body, predicate);
  const byClass = (name) => all((node) => String(node.props?.class || "").split(/\s+/).includes(name));
  const flushNative = () => { for (const event of nativeEvents.splice(0)) event(); };
  const settle = async ({ events = true } = {}) => {
    for (let index = 0; index < 6; index += 1) await nextTick();
    if (events) { flushNative(); await nextTick(); }
  };
  const dispatch = (target, key, extra = {}) => {
    const event = { target, currentTarget: target, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
    for (let node = target; node && !event.stopped; node = node.parent) { event.currentTarget = node; node.props?.[key]?.(event); }
    if (!event.stopped && key === "onKeydown") for (const handler of listeners.get("keydown") || []) handler(event);
    return event;
  };
  let unmounted = false;
  const app = renderer.createApp({ render: () => view({ origin }) });
  app.config.errorHandler = (error) => errors.push(error);
  const unmount = () => { if (!unmounted) { app.unmount(); unmounted = true; } };
  t.after(async () => {
    try {
      unmount(); await settle();
      assert.equal(modalStack.length, 0);
      assert.equal([...listeners.values()].reduce((count, handlers) => count + handlers.size, 0), 0);
      assert.equal(all((node) => node.type === "dialog").length, 0);
    } finally { globalThis.window = previousWindow; globalThis.document = previousDocument; }
  });
  app.mount(root);
  await settle();
  return { body, document, trace, errors, origin, modalStack, listeners, all, byClass, dispatch, settle, unmount, flushNative, element,
    dialog: () => byClass("image-lightbox")[0], transform: () => byClass("image-lightbox-media")[0]?.props.style.transform,
    touch(target, key, points) { return dispatch(target, key, { touches: points.map(([clientX, clientY]) => ({ clientX, clientY })) }); }
  };
}

async function lightbox(t, options = {}) {
  const Component = await load("thread-item/ImageLightbox");
  const state = shallowReactive({ image: syntheticImage(), open: true });
  let closes = 0;
  const ui = await mount(t, ({ origin }) => state.open ? h(Component, { image: state.image, origin,
    onClose() { closes += 1; state.open = false; } }) : null, options);
  return { ...ui, state, closes: () => closes };
}

test("gallery previews mount one native dialog on demand and preserve image and focus contracts", async (t) => {
  const Component = await load("thread-item/ThreadItemRenderer");
  const ui = await mount(t, () => h(Component, { item: { id: "image", category: "user", imageItems: [syntheticImage()] } }));
  assert.equal(ui.dialog(), undefined);
  assert.equal(ui.listeners.size, 0, "closed renderer instances add no window key listeners");
  const opener = ui.byClass("thread-item-thumb")[0]; opener.focus();
  ui.dispatch(opener, "onClick"); await ui.settle();
  const dialog = ui.dialog();
  assert.equal(dialog.type, "dialog"); assert.equal(dialog.open, true); assert.equal(dialog.parent, ui.body);
  assert.equal(dialog.props["aria-modal"], "true"); assert.equal(dialog.props["aria-label"], "图片预览");
  const media = ui.byClass("image-lightbox-media")[0];
  assert.equal(media.props.src, syntheticImage().url); assert.equal(media.props.alt, syntheticImage().alt);
  assert.equal(ui.document.activeElement, ui.byClass("image-lightbox-close")[0]);
  assert.deepEqual(ui.trace.at(-1).options, { preventScroll: true });
  ui.dispatch(media, "onClick"); await ui.settle(); assert.equal(ui.dialog(), dialog);
  ui.dispatch(dialog, "onClick"); await ui.settle();
  assert.equal(ui.dialog(), undefined); assert.equal(ui.document.activeElement, opener);
  assert.deepEqual(ui.trace.at(-1).options, { preventScroll: true }); assert.deepEqual(ui.errors, []);
});

test("Markdown image click, Enter and Space use the same preview without changing other keys", async (t) => {
  const Component = await load("thread-item/ThreadItemRenderer");
  const ui = await mount(t, () => h(Component, { item: { id: "markdown", category: "primary", body: "![synthetic](/image.png)" } }));
  const markdown = ui.byClass("markdown-body")[0];
  const image = ui.element("img"); image.parent = markdown; markdown.children.push(image);
  image.getAttribute = (name) => ({ src: "/markdown-image.png", alt: "markdown image" })[name];
  image.closest = (selector) => selector === "img.markdown-image" ? image : null;
  assert.equal(ui.dispatch(image, "onKeydown", { type: "keydown", key: "Tab" }).defaultPrevented, false);
  assert.equal(ui.dialog(), undefined);
  for (const [type, key] of [["keydown", "Enter"], ["keydown", " "], ["click", undefined]]) {
    image.focus(); const event = ui.dispatch(image, type === "click" ? "onClick" : "onKeydown", { type, key }); await ui.settle();
    assert.equal(event.defaultPrevented, true); assert.equal(ui.byClass("image-lightbox-media")[0].props.src, "/markdown-image.png");
    ui.dispatch(ui.byClass("image-lightbox-close")[0], "onClick"); await ui.settle();
    assert.equal(ui.document.activeElement, image);
  }
});

test("two fingers become one and one becomes two without translation or scale jumps", async (t) => {
  const ui = await lightbox(t), dialog = ui.dialog();
  ui.touch(dialog, "onTouchstart", [[100,100],[200,100]]);
  ui.touch(dialog, "onTouchmove", [[50,100],[250,100]]); await ui.settle();
  assert.equal(ui.transform(), "translate3d(0px, 0px, 0) scale(2)");
  ui.touch(dialog, "onTouchend", [[250,100]]);
  ui.touch(dialog, "onTouchmove", [[260,110]]); await ui.settle();
  assert.equal(ui.transform(), "translate3d(10px, 10px, 0) scale(2)");
  ui.touch(dialog, "onTouchstart", [[260,110],[360,110]]);
  ui.touch(dialog, "onTouchmove", [[210,110],[410,110]]); await ui.settle();
  assert.equal(ui.transform(), "translate3d(10px, 10px, 0) scale(4)");
});

test("scale stays within one to four, cancel discards stale motion, and a new gesture continues", async (t) => {
  const ui = await lightbox(t), dialog = ui.dialog();
  ui.touch(dialog, "onTouchstart", [[0,0],[10,0]]);
  ui.touch(dialog, "onTouchmove", [[0,0],[100,0]]); await ui.settle();
  assert.equal(ui.transform(), "translate3d(45px, 0px, 0) scale(4)");
  ui.touch(dialog, "onTouchcancel", []);
  ui.touch(dialog, "onTouchmove", [[500,500]]); await ui.settle();
  assert.equal(ui.transform(), "translate3d(45px, 0px, 0) scale(4)");
  ui.touch(dialog, "onTouchstart", [[50,20]]); ui.touch(dialog, "onTouchmove", [[55,25]]); await ui.settle();
  assert.equal(ui.transform(), "translate3d(50px, 5px, 0) scale(4)");
  ui.touch(dialog, "onTouchstart", [[0,0],[100,0]]); ui.touch(dialog, "onTouchmove", [[0,0],[1,0]]);
  ui.touch(dialog, "onTouchend", []); await ui.settle();
  assert.equal(ui.transform(), "translate3d(0px, 0px, 0) scale(1)");
});

test("zoomed images cannot swallow the close control touch and click", async (t) => {
  const ui = await lightbox(t), dialog = ui.dialog();
  ui.touch(dialog, "onTouchstart", [[100,100],[200,100]]); ui.touch(dialog, "onTouchmove", [[50,100],[250,100]]);
  ui.touch(dialog, "onTouchend", []); await ui.settle();
  const button = ui.byClass("image-lightbox-close")[0];
  for (const key of ["onTouchstart", "onTouchmove", "onTouchend", "onTouchcancel"]) {
    assert.equal(ui.touch(button, key, [[10,10]]).defaultPrevented, false);
  }
  ui.dispatch(button, "onClick"); await ui.settle(); assert.equal(ui.closes(), 1); assert.equal(ui.dialog(), undefined);
});

test("Tab in either direction stays local and Escape does not also close PreviewHost", async (t) => {
  const Image = await load("thread-item/ImageLightbox"), Preview = await load("preview/PreviewHost");
  const state = reactive({ open: true, title: "synthetic preview", status: "error", error: "synthetic", revision: 1, url: "" });
  let previewCloses = 0, imageCloses = 0;
  const preview = { state, close() { previewCloses += 1; state.open = false; }, externalHref: () => "/synthetic-preview" };
  const image = shallowReactive({ open: true });
  const ui = await mount(t, ({ origin }) => [h(Preview, { controller: preview }), image.open ? h(Image, { image: syntheticImage(), origin,
    onClose() { imageCloses += 1; image.open = false; } }) : null]);
  const dialog = ui.dialog();
  for (const shiftKey of [false, true]) {
    const event = ui.dispatch(ui.byClass("image-lightbox-close")[0], "onKeydown", { key: "Tab", shiftKey });
    assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
    assert.equal(ui.document.activeElement, ui.byClass("image-lightbox-close")[0]);
  }
  ui.dispatch(dialog, "onKeydown", { key: "Escape" }); await ui.settle();
  assert.equal(imageCloses, 1); assert.equal(previewCloses, 0); assert.equal(state.open, true);
});

for (const method of ["cancel", "native-close", "button", "background"]) {
  test(`${method} closes exactly once even when native close arrives later`, async (t) => {
    const ui = await lightbox(t), dialog = ui.dialog();
    if (method === "cancel") ui.dispatch(dialog, "onCancel");
    else if (method === "native-close") dialog.close();
    else ui.dispatch(method === "button" ? ui.byClass("image-lightbox-close")[0] : dialog, "onClick");
    await ui.settle(); ui.flushNative(); await ui.settle();
    assert.equal(ui.closes(), 1); assert.equal(ui.dialog(), undefined); assert.equal(ui.document.activeElement, ui.origin);
  });
}

test("reopening before a queued native close preserves the new image, focus and reset transform", async (t) => {
  const ui = await lightbox(t), old = ui.dialog();
  ui.touch(old, "onTouchstart", [[0,0],[10,0]]); ui.touch(old, "onTouchmove", [[0,0],[20,0]]);
  ui.dispatch(old, "onKeydown", { key: "Escape" });
  ui.state.image = { url: "/reopened.png", alt: "reopened" }; ui.state.open = true;
  await ui.settle({ events: false }); ui.flushNative(); await ui.settle();
  assert.equal(ui.dialog().open, true); assert.equal(ui.byClass("image-lightbox-media")[0].props.src, "/reopened.png");
  assert.equal(ui.closes(), 1); assert.equal(ui.transform(), "translate3d(0px, 0px, 0) scale(1)");
  assert.equal(ui.document.activeElement, ui.byClass("image-lightbox-close")[0]);
});

test("unmount before the pending open invalidates nextTick work", async (t) => {
  const Image = await load("thread-item/ImageLightbox"), state = shallowReactive({ open: false });
  const ui = await mount(t, ({ origin }) => state.open ? h(Image, { image: syntheticImage(), origin }) : null);
  state.open = true; await nextTick(); ui.unmount(); await ui.settle();
  assert.equal(ui.trace.filter((entry) => entry.action === "show").length, 0);
  assert.equal(ui.dialog(), undefined);
});

test("unmount after native opening cancels pending focus and queued close cannot reclaim later focus", async (t) => {
  const Image = await load("thread-item/ImageLightbox"), state = shallowReactive({ open: false });
  let closes = 0;
  const ui = await mount(t, ({ origin }) => state.open ? h(Image, { image: syntheticImage(), origin, onClose: () => { closes += 1; } }) : null);
  state.open = true; await nextTick(); await nextTick();
  assert.equal(ui.trace.filter((entry) => entry.action === "show").length, 1);
  const before = ui.trace.length;
  ui.unmount();
  const replacement = ui.element("button"); replacement.parent = ui.body; ui.body.children.push(replacement); replacement.focus();
  await ui.settle();
  assert.equal(ui.document.activeElement, replacement); assert.equal(closes, 0);
  assert.equal(ui.trace.slice(before).some((entry) => entry.action === "focus" && entry.options?.preventScroll), false);
  assert.equal(ui.trace.filter((entry) => entry.action === "close").length, 1);
});

test("pending focus cannot override a newer Composer native dialog", async (t) => {
  const Image = await load("thread-item/ImageLightbox"), Composer = await load("composer/ComposerPopover");
  const state = shallowReactive({ image: syntheticImage(), composer: false, imageOpen: true });
  const ui = await mount(t, ({ origin }) => [state.imageOpen ? h(Image, { image: state.image, origin, onClose: () => { state.imageOpen = false; } }) : null,
    h(Composer, { open: state.composer, title: "输入设置", onClose: () => { state.composer = false; } })]);
  state.image = { url: "/changed.png", alt: "changed" }; state.composer = true;
  await ui.settle();
  const composer = ui.byClass("popover-drawer")[0], active = ui.document.activeElement;
  assert.equal(ui.modalStack.at(-1), composer); assert.equal(composer.contains(active), true);
  const composerOpened = ui.trace.findIndex((entry) => entry.action === "show" && entry.node === composer);
  assert.equal(ui.trace.slice(composerOpened).some((entry) => entry.action === "focus" && entry.node === ui.byClass("image-lightbox-close")[0]
    && entry.options?.preventScroll), false, "the image guard avoids even attempting focus beneath another native dialog");
  const image = ui.dialog(); image.close(); await ui.settle();
  assert.equal(composer.open, true); assert.equal(ui.document.activeElement, active);
  assert.equal(state.imageOpen, false); assert.deepEqual(ui.errors, []);
});

for (const unavailable of ["removed", "disabled"]) {
  test(`closing skips an opener that became ${unavailable}`, async (t) => {
    const ui = await lightbox(t);
    if (unavailable === "removed") { ui.body.children = ui.body.children.filter((node) => node !== ui.origin); ui.origin.parent = null; }
    else ui.origin.props.disabled = true;
    const before = ui.trace.length;
    ui.dispatch(ui.byClass("image-lightbox-close")[0], "onClick"); await ui.settle();
    assert.equal(ui.closes(), 1);
    assert.equal(ui.trace.slice(before).some((entry) => entry.action === "focus" && entry.node === ui.origin), false);
  });
}

for (const method of ["button", "native-close"]) {
  test(`explicit opener differs from native prior focus and ${method} restores it without scrolling`, async (t) => {
    const Image = await load("thread-item/ImageLightbox"), state = shallowReactive({ open: false });
    let closes = 0;
    const ui = await mount(t, ({ origin }) => state.open ? h(Image, { image: syntheticImage(), origin,
      onClose() { closes += 1; state.open = false; } }) : null);
    const prior = ui.element("textarea"); prior.parent = ui.body; ui.body.children.push(prior); prior.focus();
    state.open = true; await ui.settle();
    const dialog = ui.dialog();
    assert.equal(dialog.nativeOrigin, prior); assert.equal(ui.document.activeElement, ui.byClass("image-lightbox-close")[0]);
    if (method === "button") ui.dispatch(ui.byClass("image-lightbox-close")[0], "onClick");
    else dialog.close();
    await ui.settle();
    assert.equal(closes, 1); assert.equal(ui.document.activeElement, ui.origin);
    assert.equal(ui.trace.at(-1).node, ui.origin); assert.deepEqual(ui.trace.at(-1).options, { preventScroll: true });
  });
}

for (const moment of ["during native return", "before queued close"]) {
  test(`a valid new external focus ${moment} is not replaced with the explicit opener`, async (t) => {
    const Image = await load("thread-item/ImageLightbox"), state = shallowReactive({ open: false });
    const ui = await mount(t, ({ origin }) => state.open ? h(Image, { image: syntheticImage(), origin,
      onClose() { state.open = false; } }) : null);
    const prior = ui.element("textarea"), replacement = ui.element("button");
    for (const node of [prior, replacement]) { node.parent = ui.body; ui.body.children.push(node); }
    prior.focus(); state.open = true; await ui.settle();
    const before = ui.trace.length;
    if (moment === "during native return") {
      const nativeFocus = prior.focus.bind(prior);
      prior.focus = (options) => { nativeFocus(options); replacement.focus(); };
      ui.dispatch(ui.byClass("image-lightbox-close")[0], "onClick");
    } else {
      ui.dialog().close(); replacement.focus();
    }
    await ui.settle();
    assert.equal(ui.document.activeElement, replacement); assert.equal(ui.dialog(), undefined);
    assert.equal(ui.trace.slice(before).some((entry) => entry.action === "focus" && entry.node === ui.origin), false);
  });
}

test("missing native dialog capability fails explicitly without displaying an uncontrolled overlay", async (t) => {
  const ui = await lightbox(t, { nativeApi: false });
  assert.equal(ui.closes(), 1); assert.equal(ui.dialog(), undefined);
  assert.match(ui.errors[0]?.message || "", /不支持原生对话框/); assert.equal(ui.document.activeElement, ui.origin);
});

test("lightbox CSS compiles with one shared viewport contract and a close control above transformed media", () => {
  const source = fs.readFileSync(new URL("../web/src/components/thread-item/ImageLightbox.vue", import.meta.url), "utf8");
  const { descriptor } = parse(source);
  const result = compileStyle({ source: descriptor.styles[0].content, id: "image-lightbox", scoped: true });
  assert.deepEqual(result.errors, []);
  assert.match(result.code, /top:\s*var\(--app-viewport-top, 0px\)/);
  assert.match(result.code, /height:\s*var\(--app-viewport-height, 100dvh\)/);
  assert.match(result.code, /max-height:\s*min\(calc\(var\(--app-viewport-height/);
  assert.match(result.code, /\.image-lightbox-close[^}]*z-index:\s*1/s);
  assert.doesNotMatch(source, /addEventListener|100vh|88vh/);
});
