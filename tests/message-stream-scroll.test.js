import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { compileScript, parse } from "vue/compiler-sfc";
import { createRenderer, h, markRaw, nextTick } from "vue";
import { createMessageStreamScroll } from "../web/src/lib/message-stream-scroll.js";

function sourceUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

function compileComponentUrl(file, overrides) {
  if (overrides[file.href]) return overrides[file.href];
  const { descriptor } = parse(fs.readFileSync(file, "utf8"), { filename: file.pathname });
  const compiled = compileScript(descriptor, { id: file.pathname, inlineTemplate: true }).content;
  return sourceUrl(compiled.replace(/from\s+["']([^"']+)["']/g, (_, name) => {
    const resolved = name.startsWith(".") ? new URL(name, file).href : import.meta.resolve(name);
    return `from ${JSON.stringify(overrides[resolved] || (name.endsWith(".vue")
      ? compileComponentUrl(new URL(resolved), overrides) : resolved))}`;
  }));
}

function elements(root, predicate) {
  return [...(predicate(root) ? [root] : []), ...(root.children || []).flatMap((node) => elements(node, predicate))];
}

const hasClass = (node, name) => String(node.props?.class || "").split(/\s+/).includes(name);
async function flush() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  await nextTick();
}

function viewModel(count = 1) {
  return {
    version: count, latestFileChangeTurnId: "",
    turns: [{ id: "old-turn", status: "completed", fileChanges: [], segments: [{
      id: "old-process", kind: "process", defaultCollapsed: true,
      items: Array.from({ length: count }, (_, index) => ({ id: `item-${index}`, type: "commandExecution" }))
    }] }]
  };
}

async function mountedChat(initialProps = {}) {
  const previousWindow = globalThis.window, previousObserver = globalThis.ResizeObserver;
  const root = { children: [] }, listeners = new Map(), observers = [], scrolls = [];
  const geometry = { baseHeight: 800, growth: 0, composerGrowth: 0, resizeCount: 0, onResize: null };
  const fixtureWindow = {
    innerHeight: 720,
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
    visualViewport: {
      height: 720, offsetTop: 0,
      addEventListener(name, callback) { listeners.set(`visual-${name}`, callback); },
      removeEventListener(name) { listeners.delete(`visual-${name}`); }
    },
    __scrollResize() { geometry.resizeCount += 1; geometry.onResize?.(); }
  };
  globalThis.window = fixtureWindow;
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
  };
  const renderer = createRenderer({
    createElement(type) {
      let top = 0;
      const node = markRaw({ type, props: {}, children: [], style: {},
        get clientHeight() { return hasClass(this, "message-stream") ? 557 - geometry.composerGrowth : 0; },
        get scrollHeight() {
          return hasClass(this, "message-stream")
            ? geometry.baseHeight + geometry.growth + elements(root, (child) => hasClass(child, "process-item")).length * 120 : 48;
        },
        get scrollTop() { return top; },
        set scrollTop(value) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
        scrollTo(options) {
          scrolls.push(options);
          this.scrollTop = options.top;
          this.props.onScroll?.({ target: this });
        },
        getBoundingClientRect() {
          const stream = elements(root, (child) => hasClass(child, "message-stream"))[0];
          if (hasClass(this, "turn-process-toggle")) {
            const y = 68 + 300 - (stream?.scrollTop || 0);
            return { top: y, bottom: y + 32, height: 32 };
          }
          return { top: 68, bottom: 68 + this.clientHeight, right: 1000,
            height: hasClass(this, "chat-composer-host") ? 90 + geometry.composerGrowth : this.clientHeight };
        },
        querySelector(selector) { return elements(this, (child) => hasClass(child, selector.slice(1)))[0] || null; }
      });
      return node;
    },
    createText: (text) => ({ text }), createComment: (text) => ({ text }),
    setText(node, text) { node.text = text; },
    setElementText(node, text) { node.text = text; node.children = []; },
    parentNode: (node) => node?.parent || null,
    nextSibling: (node) => node?.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    insert(node, parent, anchor) {
      if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node);
      node.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index >= 0) parent.children.splice(index, 0, node); else parent.children.push(node);
    },
    remove(node) { if (node?.parent) node.parent.children = node.parent.children.filter((child) => child !== node); },
    patchProp(node, key, previous, value) { node.props[key] = value; }
  });
  const vueUrl = JSON.stringify(import.meta.resolve("vue"));
  const component = (await import(compileComponentUrl(new URL("../web/src/components/ChatView.vue", import.meta.url), {
    [new URL("../web/src/components/composer/ChatComposer.vue", import.meta.url).href]: sourceUrl(`
      import { h } from ${vueUrl};
      export default { setup(props, { expose }) {
        expose({ resizeComposer() { window.__scrollResize(); } });
        return () => h('div', { class: 'composer-probe' });
      } };`),
    [new URL("../web/src/components/thread-item/ThreadItemRenderer.vue", import.meta.url).href]: sourceUrl(`
      import { h } from ${vueUrl};
      export default { props: ['item'], setup(props) {
        return () => h('div', { class: 'process-item', 'data-item-id': props.item.id });
      } };`)
  }))).default;
  let props = { sessionKey: "thread", openToken: 1, composerOptions: { attachments: [] }, gitState: {},
    threadSnapshot: { version: 1, turns: [] }, threadViewModel: viewModel(), onProcessToggle: () => {}, ...initialProps };
  function render(patch = {}) { props = { ...props, ...patch }; renderer.render(h(component, props), root); }
  const stream = () => elements(root, (node) => hasClass(node, "message-stream"))[0];
  const toggle = () => elements(root, (node) => hasClass(node, "turn-process-toggle"))[0];
  render(); await flush();
  return {
    geometry, scrolls, observers, listeners, stream, toggle, render, window: fixtureWindow,
    shell: () => elements(root, (node) => hasClass(node, "chat-shell"))[0],
    composer: () => elements(root, (node) => hasClass(node, "composer-probe"))[0],
    grow(count) {
      render({ threadSnapshot: { version: count, turns: [] }, threadViewModel: viewModel(count) });
      observers.at(-1).callback();
    },
    unmount() { renderer.render(null, root); },
    async cleanup() {
      renderer.render(null, root); await flush();
      globalThis.window = previousWindow; globalThis.ResizeObserver = previousObserver;
    }
  };
}

test("chat uses the shared viewport contract while fractional keyboard changes keep the draft and inspection", async () => {
  const chat = await mountedChat();
  try {
    chat.render({ draft: "QA_VIEWPORT_DRAFT" }); await flush();
    chat.toggle().props.onClick(); await flush();
    const top = chat.stream().scrollTop;
    chat.window.visualViewport.height = 349.375;
    chat.window.visualViewport.offsetTop = 20.25;
    chat.listeners.get("visual-resize")(); await flush();
    assert.equal(chat.shell().props.style["--chat-keyboard-inset"], "350.375px");
    assert.equal(chat.shell().props.style["--chat-vh"], undefined, "Chat does not publish a competing root height");
    assert.ok(Object.hasOwn(chat.stream().props, "data-app-scroll"));
    assert.equal(chat.composer().props.draft, "QA_VIEWPORT_DRAFT");
    chat.grow(61); await flush();
    assert.equal(chat.stream().scrollTop, top);
  } finally { await chat.cleanup(); }
});

test("real process-toggle pauses following before parent work and keeps the header visible through pagination", async () => {
  const chat = await mountedChat();
  try {
    const initialTop = chat.stream().scrollTop, headerTop = chat.toggle().getBoundingClientRect().top;
    assert.ok(headerTop >= 68 && headerTop < 625);
    chat.render({ onProcessToggle(payload) {
      assert.deepEqual(payload, { turnId: "old-turn", segmentId: "old-process", expanded: true });
      chat.stream().props.onScroll({ target: chat.stream() });
      chat.observers.at(-1).callback();
    } });
    chat.toggle().props.onClick();
    await flush();
    for (const count of [30, 60, 61]) { chat.grow(count); await flush(); }
    assert.equal(chat.stream().scrollTop, initialTop, "pagination must not drag the reader to the new bottom");
    assert.equal(chat.toggle().getBoundingClientRect().top, headerTop);
    assert.equal(elements(chat.stream(), (node) => hasClass(node, "process-item")).length, 61);
  } finally { await chat.cleanup(); }
});

test("a queued composer correction cannot override a later real expansion", async () => {
  const chat = await mountedChat();
  try {
    const initialTop = chat.stream().scrollTop;
    chat.geometry.onResize = () => {
      chat.geometry.onResize = null;
      nextTick(() => chat.toggle().props.onClick());
    };
    chat.render({ draft: "multiline draft" });
    await flush();
    chat.grow(61); await flush();
    assert.equal(chat.stream().scrollTop, initialTop);
  } finally { await chat.cleanup(); }
});

test("composer, viewport and near-bottom layout changes preserve explicit inspection", async () => {
  const chat = await mountedChat();
  try {
    chat.geometry.baseHeight = 600;
    chat.stream().scrollTop = 43;
    chat.toggle().props.onClick(); await flush();
    chat.stream().scrollTop = 100;
    chat.stream().props.onScroll({ target: chat.stream() });
    const top = chat.stream().scrollTop;
    chat.geometry.composerGrowth = 50;
    chat.render({ draft: "more draft" });
    chat.listeners.get("resize")();
    chat.observers.at(-1).callback(); await flush();
    assert.equal(chat.stream().scrollTop, top, "near-bottom geometry alone must not resume following");
    chat.grow(61); await flush();
    assert.equal(chat.stream().scrollTop, top);
  } finally { await chat.cleanup(); }
});

test("ordinary restoration, image growth, upward scrolling and genuine bottom gestures keep their behavior", async () => {
  const chat = await mountedChat();
  try {
    const stream = chat.stream();
    stream.scrollTop = 20; stream.props.onScroll({ target: stream }); await flush();
    assert.equal(stream.scrollTop, 243);
    chat.geometry.growth = 300; chat.observers.at(-1).callback(); await flush();
    assert.equal(stream.scrollTop, 543);
    chat.geometry.composerGrowth = 60;
    chat.render({ draft: "growing input" }); await flush();
    assert.equal(stream.scrollTop, 603, "ordinary input resizing keeps the current bottom");
    chat.geometry.composerGrowth = 0;
    chat.render({ draft: "" }); await flush();
    assert.equal(stream.scrollTop, 543);
    stream.props.onWheelPassive({ deltaY: -100 }); stream.scrollTop = 100;
    stream.props.onScroll({ target: stream });
    chat.geometry.growth = 600; chat.observers.at(-1).callback(); await flush();
    assert.equal(stream.scrollTop, 100);
    stream.props.onWheelPassive({ deltaY: 100 }); stream.scrollTop = stream.scrollHeight;
    stream.props.onScroll({ target: stream });
    chat.geometry.growth = 900; chat.observers.at(-1).callback(); await flush();
    assert.equal(stream.scrollTop, 1143);
    chat.toggle().props.onClick(); await flush();
    stream.scrollTop = stream.scrollHeight;
    stream.props.onWheelPassive({ deltaY: 100 });
    chat.geometry.growth = 1200; chat.observers.at(-1).callback(); await flush();
    assert.equal(stream.scrollTop, 1563, "a downward gesture at the bottom resumes even without a scroll event");
  } finally { await chat.cleanup(); }
});

test("new session and open token reset following, and unmount clears layout work and listeners", async () => {
  const chat = await mountedChat();
  try {
    chat.toggle().props.onClick(); await flush(); chat.grow(61); await flush();
    chat.render({ sessionKey: "next-thread" }); await flush();
    assert.equal(chat.stream().scrollTop, chat.stream().scrollHeight - chat.stream().clientHeight);
    chat.toggle().props.onClick(); await flush();
    chat.toggle().props.onClick(); await flush();
    chat.stream().scrollTop = 100;
    chat.render({ openToken: 2 }); await flush();
    assert.equal(chat.stream().scrollTop, chat.stream().scrollHeight - chat.stream().clientHeight);
    const observer = chat.observers.at(-1);
    chat.render({ draft: "pending" });
    chat.unmount();
    const resizeCount = chat.geometry.resizeCount, scrollCount = chat.scrolls.length;
    observer.callback(); await flush();
    assert.equal(chat.geometry.resizeCount, resizeCount);
    assert.equal(chat.scrolls.length, scrollCount);
    assert.equal(chat.listeners.size, 0);
    assert.ok(chat.observers.every((item) => item.disconnected));
  } finally { await chat.cleanup(); }
});

test("queued force is invalidated by newer reading intent, context changes and disposal", () => {
  const callbacks = [], element = { scrollTop: 100, scrollHeight: 1000, clientHeight: 500 };
  let context = "first";
  const scroll = createMessageStreamScroll({ getElement: () => element, getContext: () => context,
    nextTick: (callback) => callbacks.push(callback) });
  const drain = () => { while (callbacks.length) callbacks.shift()(); };
  scroll.scrollToBottom(true); scroll.inspect(); drain();
  assert.equal(element.scrollTop, 100);
  scroll.reset(); scroll.scrollToBottom(true); context = "second"; drain();
  assert.equal(element.scrollTop, 100);
  scroll.reset(); scroll.scrollToBottom(true); scroll.dispose(); drain();
  assert.equal(element.scrollTop, 100);
});

function historyFixture() {
  const element = { scrollTop: 500, scrollHeight: 1200, clientHeight: 500, getBoundingClientRect: () => ({ right: 1000 }) };
  const pending = [];
  let context = "first", hasMore = true, loading = false;
  const scroll = createMessageStreamScroll({ getElement: () => element, getContext: () => context, nextTick,
    getHasOlder: () => hasMore, getLoadingOlder: () => loading, onReachTop: () => {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      pending.push({ resolve, reject }); return promise;
    } });
  function up(top = 0) {
    scroll.handleStreamWheel({ deltaY: -100 });
    element.scrollTop = top; scroll.handleStreamScroll({ target: element });
  }
  return { element, pending, scroll, up, setHasMore: (value) => { hasMore = value; }, setLoading: (value) => { loading = value; },
    switchContext() { context = "second"; scroll.reset(); } };
}

test("history loads once on a real upward reach, waits while busy and keeps the prepend reading offset", async () => {
  const f = historyFixture();
  const anchorBehaviors = [];
  f.element.scrollTo = ({ top, behavior }) => { f.element.scrollTop = top; anchorBehaviors.push(behavior); };
  try {
    f.element.scrollTop = 0; f.scroll.handleStreamScroll({ target: f.element }); await flush();
    assert.equal(f.pending.length, 0, "initial and programmatic positioning cannot load history");
    f.element.scrollTop = 300; f.up(81); await flush();
    assert.equal(f.pending.length, 0, "nearing the top does not start history reading");
    f.up(80); await flush();
    assert.equal(f.pending.length, 0);
    f.up(6); await flush();
    assert.equal(f.pending.length, 0, "Home or inertia is still moving before the actual top");
    f.up(0); await flush();
    assert.equal(f.pending.length, 1);
    f.up(0); f.scroll.handleStreamScroll({ target: f.element }); await flush();
    assert.equal(f.pending.length, 1, "a pending request remains single flight");
    f.element.scrollHeight += 600; f.pending[0].resolve(true); await flush();
    assert.equal(f.element.scrollTop, 0, "a newer wheel intent cancels the old anchor");
    anchorBehaviors.length = 0;
    f.element.scrollTop = 300; f.up(0); await flush();
    assert.equal(f.pending.length, 2);
    f.element.scrollHeight += 450; f.pending[1].resolve(true); await flush();
    assert.equal(f.element.scrollTop, 450, "prepend growth keeps the previous reading row at its offset");
    assert.deepEqual(anchorBehaviors, ["instant"], "CSS smooth scrolling cannot animate a prepend compensation");
    f.element.scrollTop = 0; f.scroll.handleStreamScroll({ target: f.element }); await flush();
    assert.equal(f.pending.length, 2, "layout or old gesture momentum cannot drain further pages");
    f.setHasMore(false); f.up(0); await flush();
    assert.equal(f.pending.length, 2);
    f.setHasMore(true); f.setLoading(true); f.up(0); await flush();
    assert.equal(f.pending.length, 2, "the parent's loading action also blocks reads");
  } finally { f.scroll.dispose(); for (const page of f.pending) page.resolve(false); }
});

test("history failures wait for explicit retry while keyboard and touch can initiate a top read", async () => {
  const f = historyFixture();
  try {
    f.element.scrollTop = 0;
    f.scroll.handleStreamKeydown({ key: "Home", target: { closest: () => null } }); await flush();
    assert.equal(f.pending.length, 1);
    f.pending[0].reject(new Error("older offline")); await flush();
    f.scroll.handleStreamKeydown({ key: "PageUp", target: { closest: () => null } }); f.up(0); await flush();
    assert.equal(f.pending.length, 1, "a failed page cannot automatically retry or loop");
    const retry = f.scroll.loadOlder({ manual: true }); await flush();
    assert.equal(f.pending.length, 2);
    f.pending[1].resolve(true); await retry;
    f.scroll.handleStreamTouchStart({ touches: [{ clientX: 20, clientY: 100 }] });
    f.scroll.handleStreamTouchMove({ touches: [{ clientX: 20, clientY: 140 }] }); await flush();
    assert.equal(f.pending.length, 3);
    f.scroll.handleStreamTouchEnd(); f.up(0); await flush();
    assert.equal(f.pending.length, 3, "ending the touch does not release an in-flight history read");
    f.pending[2].resolve(true); await flush();
  } finally { f.scroll.dispose(); for (const page of f.pending) page.resolve(false); }
});

test("history anchors the original visible turn when unrelated content changes height during a prepend", async () => {
  const f = historyFixture();
  let cardTop = 0;
  const card = { isConnected: true, getBoundingClientRect: () => ({ top: cardTop - f.element.scrollTop, bottom: cardTop + 100 - f.element.scrollTop }) };
  f.element.getBoundingClientRect = () => ({ top: 0, bottom: 600 });
  f.element.querySelectorAll = () => [card];
  try {
    f.up(0); await flush();
    assert.equal(f.pending.length, 1);
    cardTop = 600;
    f.element.scrollHeight += 561;
    f.pending[0].resolve(true); await flush();
    assert.equal(f.element.scrollTop, 600, "a 39px change below the anchor cannot shift the reading row");
    assert.equal(card.getBoundingClientRect().top, 0);
  } finally { f.scroll.dispose(); for (const page of f.pending) page.resolve(false); }
});

for (const replaced of [false, true]) {
  test(`history anchors the visible message within the same turn${replaced ? " after its DOM node is replaced" : ""}`, async () => {
    const f = historyFixture();
    let itemTop = 18;
    const card = { isConnected: true, getBoundingClientRect: () => ({ top: 0, bottom: 1600 }),
      querySelectorAll: () => [current] };
    const item = () => ({ isConnected: true, getAttribute: () => "item:[latest]",
      closest: () => card,
      getBoundingClientRect: () => ({ top: itemTop - f.element.scrollTop, bottom: itemTop + 100 - f.element.scrollTop }) });
    const original = item();
    let current = original;
    f.element.getBoundingClientRect = () => ({ top: 0, bottom: 600 });
    f.element.querySelectorAll = (selector) => selector === "[data-thread-item-id]" ? [current] : [card];
    try {
      f.up(0); await flush();
      assert.equal(f.pending.length, 1);
      itemTop += 600;
      f.element.scrollHeight += 561;
      if (replaced) { original.isConnected = false; current = item(); }
      f.pending[0].resolve(true); await flush();
      assert.equal(f.element.scrollTop, 600, "a stable turn top cannot substitute for the message's prepend offset");
      assert.equal(current.getBoundingClientRect().top, 18);
    } finally { f.scroll.dispose(); for (const page of f.pending) page.resolve(false); }
  });
}

test("a replaced history message is resolved within its original turn when item IDs repeat", async () => {
  const f = historyFixture();
  let itemTop = 12;
  const other = { getAttribute: () => "same", getBoundingClientRect: () => ({ top: 900, bottom: 1000 }) };
  let current;
  const card = { isConnected: true, querySelectorAll: () => [current] };
  const item = () => ({ isConnected: true, getAttribute: () => "same", closest: () => card,
    getBoundingClientRect: () => ({ top: itemTop - f.element.scrollTop, bottom: itemTop + 100 - f.element.scrollTop }) });
  const original = item(); current = original;
  f.element.getBoundingClientRect = () => ({ top: 0, bottom: 600 });
  f.element.querySelectorAll = () => [other, current];
  try {
    f.up(0); await flush();
    original.isConnected = false; current = item(); itemTop += 400;
    f.element.scrollHeight += 400; f.pending[0].resolve(true); await flush();
    assert.equal(f.element.scrollTop, 400);
    assert.equal(current.getBoundingClientRect().top, 12);
  } finally { f.scroll.dispose(); for (const page of f.pending) page.resolve(false); }
});

test("initial latest messages settle at the bottom instantly when their loading placeholder clears", async () => {
  const emptyModel = { version: 1, latestFileChangeTurnId: "", turns: [] };
  const chat = await mountedChat({ historyLoading: true, threadViewModel: emptyModel });
  try {
    const timeline = elements(chat.stream(), (node) => hasClass(node, "thread-turn-timeline"))[0];
    assert.equal(timeline.style.display, "none");
    chat.geometry.baseHeight = 1800;
    chat.render({ historyLoading: false, threadSnapshot: { version: 2, turns: [] }, threadViewModel: viewModel() });
    await flush();
    assert.notEqual(timeline.style.display, "none");
    assert.equal(chat.stream().scrollTop, chat.stream().scrollHeight - chat.stream().clientHeight);
    assert.ok(chat.scrolls.length > 0);
    assert.ok(chat.scrolls.every((scroll) => scroll.behavior === "instant"));
  } finally { await chat.cleanup(); }
});

test("initial loading hides even a nonempty receipt timeline until the latest history is ready", async () => {
  const chat = await mountedChat({ historyLoading: true, threadViewModel: viewModel() });
  try {
    const timeline = elements(chat.stream(), (node) => hasClass(node, "thread-turn-timeline"))[0];
    assert.equal(timeline.style.display, "none");
    chat.geometry.baseHeight = 1800;
    chat.render({ historyLoading: false, threadSnapshot: { version: 2, turns: [] }, threadViewModel: viewModel() });
    await flush();
    assert.notEqual(timeline.style.display, "none");
    assert.equal(chat.stream().scrollTop, chat.stream().scrollHeight - chat.stream().clientHeight);
  } finally { await chat.cleanup(); }
});

test("scrolling, context changes and disposal prevent an old history anchor from overriding the reader", async () => {
  for (const change of ["scroll", "context", "dispose"]) {
    const f = historyFixture();
    try {
      f.up(); await flush();
      assert.equal(f.pending.length, 1);
      if (change === "scroll") { f.element.scrollTop = 25; f.scroll.handleStreamScroll({ target: f.element }); }
      else if (change === "context") f.switchContext();
      else f.scroll.dispose();
      const top = f.element.scrollTop;
      f.element.scrollHeight += 600; f.pending[0].resolve(true); await flush();
      assert.equal(f.element.scrollTop, top, change);
    } finally { f.scroll.dispose(); for (const page of f.pending) page.resolve(false); }
  }
});

test("compiled ChatView automatically loads on an upward top reach and keeps the same row after prepend", async () => {
  let complete, reads = 0;
  const page = new Promise((resolve) => { complete = resolve; });
  const chat = await mountedChat({ hasOlder: true, onReachTop: () => { reads += 1; return page; } });
  try {
    assert.equal(reads, 0, "initial bottom settling cannot load older history");
    const stream = chat.stream();
    stream.props.onKeydown({ key: "PageUp", target: { closest: () => null } });
    stream.scrollTop = 30; stream.props.onScroll({ target: stream }); await flush();
    assert.equal(reads, 0);
    stream.scrollTop = 6; stream.props.onScroll({ target: stream }); await flush();
    assert.equal(reads, 0);
    stream.scrollTop = 0; stream.props.onScroll({ target: stream }); await flush();
    assert.equal(reads, 1);
    chat.geometry.baseHeight += 500;
    chat.render({ threadSnapshot: { version: 2, turns: [] } });
    chat.observers.at(-1).callback();
    complete(true); await flush();
    assert.equal(stream.scrollTop, 500);
    stream.props.onScroll({ target: stream }); await flush();
    assert.equal(reads, 1, "the layout correction does not load another page");
  } finally { complete(false); await chat.cleanup(); }
});

for (const gesture of ["touch", "scrollbar"]) {
  test(`history loading preserves the same ${gesture} gesture when the reader reverses to the bottom`, async () => {
    const f = historyFixture();
    try {
      if (gesture === "touch") {
        f.element.scrollTop = 100;
        f.scroll.handleStreamTouchStart({ touches: [{ clientX: 20, clientY: 100 }] });
        f.scroll.handleStreamTouchMove({ touches: [{ clientX: 20, clientY: 140 }] });
      } else f.scroll.handleStreamPointerDown({ target: f.element, pointerType: "mouse", clientX: 995 });
      f.element.scrollTop = 0; f.scroll.handleStreamScroll({ target: f.element }); await flush();
      assert.equal(f.pending.length, 1);
      if (gesture === "touch") f.scroll.handleStreamTouchMove({ touches: [{ clientX: 20, clientY: 0 }] });
      f.element.scrollTop = 700; f.scroll.handleStreamScroll({ target: f.element });
      assert.equal(f.scroll.isPinnedToBottom, true, "the ongoing gesture can resume bottom following");
      if (gesture === "touch") f.scroll.handleStreamTouchEnd();
      else f.scroll.handleStreamPointerUp();
      f.pending[0].resolve(true); await flush();
      assert.equal(f.element.scrollTop, 700, "the old history anchor cannot override the new bottom intent");
      f.element.scrollHeight += 600; f.scroll.scrollToBottom(); await flush();
      assert.equal(f.element.scrollTop, 1800);
    } finally { f.scroll.dispose(); for (const page of f.pending) page.resolve(false); }
  });
}

test("typing and horizontal gestures cannot end inspection; real touch, keys and scrollbar can resume at bottom", () => {
  for (const kind of ["touch", "keyboard", "scrollbar"]) {
    const callbacks = [], element = { scrollTop: 500, scrollHeight: 1000, clientHeight: 500,
      getBoundingClientRect: () => ({ right: 1000 }) };
    const scroll = createMessageStreamScroll({ getElement: () => element,
      nextTick: (callback) => callbacks.push(callback) });
    const drain = () => { while (callbacks.length) callbacks.shift()(); };
    scroll.inspect();
    scroll.handleStreamKeydown({ key: "End", target: { closest: () => ({}) } });
    scroll.handleStreamWheel({ deltaY: 0, deltaX: 100 });
    scroll.handleStreamTouchStart({ touches: [{ clientX: 20, clientY: 100 }] });
    scroll.handleStreamTouchMove({ touches: [{ clientX: 100, clientY: 102 }] });
    scroll.handleStreamTouchEnd();
    scroll.handleStreamScroll({ target: element });
    scroll.scrollToBottom(true); drain();
    assert.equal(element.scrollTop, 500);
    assert.equal(scroll.isPinnedToBottom, false);
    if (kind === "touch") {
      scroll.handleStreamTouchStart({ touches: [{ clientX: 20, clientY: 100 }] });
      scroll.handleStreamTouchMove({ touches: [{ clientX: 20, clientY: 80 }] });
      scroll.handleStreamTouchEnd();
    } else if (kind === "keyboard") {
      scroll.handleStreamKeydown({ key: "End", target: { closest: () => null } });
    } else {
      scroll.handleStreamPointerDown({ target: element, pointerType: "mouse", clientX: 995 });
      scroll.handleStreamPointerUp();
    }
    assert.equal(scroll.isPinnedToBottom, true, `${kind} can resume without needing another scroll event`);
    element.scrollHeight = 1500; scroll.scrollToBottom(); drain();
    assert.equal(element.scrollTop, 1500);
    scroll.dispose();
  }
});

test("queued layout callbacks and observers keep their context ownership across reset and disposal", () => {
  const callbacks = [];
  let context = "first", updates = 0;
  const scroll = createMessageStreamScroll({ getElement: () => null, getContext: () => context,
    nextTick: (callback) => callbacks.push(callback) });
  const firstObserver = scroll.captureContext();
  scroll.schedule(() => { updates += 1; });
  context = "second";
  assert.equal(firstObserver(), false, "the immediate context check works before Vue's reset watcher");
  callbacks.shift()();
  assert.equal(updates, 0);
  scroll.reset();
  const secondObserver = scroll.captureContext();
  scroll.schedule(() => { updates += 1; });
  scroll.inspect(); callbacks.shift()();
  assert.equal(updates, 1, "current layout measurement survives a reading intent change");
  scroll.schedule(() => { updates += 1; }); scroll.reset(); callbacks.shift()();
  assert.equal(updates, 1);
  assert.equal(secondObserver(), false);
  scroll.schedule(() => { updates += 1; }); scroll.dispose(); callbacks.shift()();
  assert.equal(updates, 1);
});

function momentumFixture() {
  let clock = 0;
  const callbacks = [], element = { scrollTop: 200, scrollHeight: 2000, clientHeight: 500,
    scrollTo({ top }) { this.scrollTop = Math.min(top, this.scrollHeight - this.clientHeight); } };
  const scroll = createMessageStreamScroll({ getElement: () => element, now: () => clock,
    nextTick: (callback) => callbacks.push(callback) });
  const drain = () => { while (callbacks.length) callbacks.shift()(); };
  return {
    scroll, element, drain,
    at(time, top = element.scrollTop) {
      clock = time; element.scrollTop = top; scroll.handleStreamScroll({ target: element });
    },
    gesture(kind, direction = 1) {
      if (kind === "wheel") scroll.handleStreamWheel({ deltaY: direction * 100 });
      else {
        scroll.handleStreamTouchStart({ touches: [{ clientX: 20, clientY: 100 }] });
        scroll.handleStreamTouchMove({ touches: [{ clientX: 20, clientY: 100 - direction * 20 }] });
        scroll.handleStreamTouchEnd();
      }
    },
    cleanup() { scroll.dispose(); drain(); }
  };
}

for (const kind of ["touch", "wheel"]) {
  test(`${kind} momentum still resumes following when continuous movement reaches bottom after 1000ms`, () => {
    const fixture = momentumFixture();
    try {
      fixture.scroll.inspect(); fixture.gesture(kind);
      for (let step = 1; step <= 10; step += 1) fixture.at(step * 100, 200 + step * 130);
      assert.equal(fixture.scroll.isPinnedToBottom, true);
      fixture.element.scrollHeight += 400; fixture.scroll.scrollToBottom(); fixture.drain();
      assert.equal(fixture.element.scrollTop, 1900);
    } finally { fixture.cleanup(); }
  });
}

test("layout-only movement, idle gestures and repeated stationary scroll events cannot renew user intent", () => {
  for (const kind of ["no gesture", "idle", "stationary", "layout growth"]) {
    const fixture = momentumFixture();
    try {
      fixture.scroll.inspect();
      if (kind !== "no gesture") fixture.gesture("touch");
      if (kind === "no gesture") {
        for (let step = 1; step <= 10; step += 1) fixture.at(step * 100, 200 + step * 130);
      } else if (kind === "idle") fixture.at(800, 1500);
      else if (kind === "stationary") {
        for (let step = 1; step <= 10; step += 1) fixture.at(step * 100);
        fixture.at(1100, 1500);
      } else {
        for (let step = 1; step <= 10; step += 1) {
          fixture.element.scrollHeight += 100;
          fixture.at(step * 100, 200 + step * 130);
        }
        fixture.at(1100, fixture.element.scrollHeight - fixture.element.clientHeight);
      }
      assert.equal(fixture.scroll.isPinnedToBottom, false, kind);
      const top = fixture.element.scrollTop;
      fixture.element.scrollHeight += 400; fixture.scroll.scrollToBottom(); fixture.drain();
      assert.equal(fixture.element.scrollTop, top, kind);
    } finally { fixture.cleanup(); }
  }
});

test("upward momentum stays paused and does not authorize a later downward layout jump", () => {
  const fixture = momentumFixture();
  try {
    fixture.element.scrollTop = 1400;
    fixture.scroll.inspect(); fixture.gesture("wheel", -1);
    for (let step = 1; step <= 10; step += 1) fixture.at(step * 100, 1400 - step * 100);
    assert.equal(fixture.scroll.isPinnedToBottom, false);
    fixture.at(1100, 1500);
    assert.equal(fixture.scroll.isPinnedToBottom, false);
    fixture.element.scrollHeight += 400; fixture.scroll.scrollToBottom(); fixture.drain();
    assert.equal(fixture.element.scrollTop, 1500);
    fixture.gesture("touch"); fixture.at(1200, 1900);
    assert.equal(fixture.scroll.isPinnedToBottom, true, "a new downward gesture establishes the new direction");
  } finally { fixture.cleanup(); }
});

test("momentum still expires after 750ms without effective movement", () => {
  for (const time of [749, 750, 751]) {
    const fixture = momentumFixture();
    try {
      fixture.scroll.inspect(); fixture.gesture("wheel"); fixture.at(time, 1500);
      assert.equal(fixture.scroll.isPinnedToBottom, time < 750, `${time}ms`);
    } finally { fixture.cleanup(); }
  }
});

test("inspection, reset and disposal cut off a continuing momentum chain", () => {
  for (const action of ["inspect", "reset", "dispose"]) {
    const fixture = momentumFixture();
    try {
      fixture.scroll.inspect(); fixture.gesture("touch");
      for (let step = 1; step <= 5; step += 1) fixture.at(step * 100, 200 + step * 100);
      fixture.scroll[action]();
      fixture.at(600, 800);
      if (action === "reset") {
        assert.equal(fixture.scroll.isPinnedToBottom, true, "old momentum cannot unpin a new context");
        fixture.drain();
        assert.equal(fixture.element.scrollTop, 1500);
      } else {
        fixture.at(700, 1500);
        assert.equal(fixture.scroll.isPinnedToBottom, false, action);
        fixture.element.scrollHeight += 400; fixture.scroll.scrollToBottom(true); fixture.drain();
        assert.equal(fixture.element.scrollTop, 1500, action);
      }
    } finally { fixture.cleanup(); }
  }
});

for (const kind of ["touch", "wheel", "layout"]) {
  test(`compiled ChatView ${kind} trajectory preserves intent through 1000ms and later growth`, async () => {
    const previousNow = Date.now;
    let clock = 0, chat;
    Date.now = () => clock;
    try {
      chat = await mountedChat();
      chat.toggle().props.onClick(); await flush();
      chat.geometry.baseHeight = 2000;
      const stream = chat.stream();
      stream.scrollTop = 200;
      if (kind === "touch") {
        stream.props.onTouchstartPassive({ touches: [{ clientX: 20, clientY: 100 }] });
        stream.props.onTouchmovePassive({ touches: [{ clientX: 20, clientY: 80 }] });
        stream.props.onTouchend();
      } else if (kind === "wheel") stream.props.onWheelPassive({ deltaY: 100 });
      const bottom = stream.scrollHeight - stream.clientHeight;
      for (let step = 1; step <= 10; step += 1) {
        clock = step * 100; stream.scrollTop = 200 + (bottom - 200) * step / 10;
        stream.props.onScroll({ target: stream }); await flush();
      }
      assert.equal(stream.scrollTop, bottom);
      chat.geometry.growth += 400;
      chat.render({ threadSnapshot: { version: 2, turns: [] } });
      chat.observers.at(-1).callback(); await flush();
      assert.equal(stream.scrollTop, bottom + (kind === "layout" ? 0 : 400));
    } finally {
      try {
        if (chat) {
          await chat.cleanup();
          assert.equal(chat.listeners.size, 0);
          assert.ok(chat.observers.every((observer) => observer.disconnected));
        }
      } finally { Date.now = previousNow; }
    }
  });
}

test("one touch gesture can reverse upward at bottom, retain reading on growth, then resume downward momentum", () => {
  const fixture = momentumFixture();
  try {
    fixture.element.scrollTop = 1300; fixture.scroll.inspect();
    fixture.scroll.handleStreamTouchStart({ touches: [{ clientX: 20, clientY: 300 }] });
    fixture.scroll.handleStreamTouchMove({ touches: [{ clientX: 20, clientY: 100 }] });
    fixture.at(100, 1500); fixture.drain();
    assert.equal(fixture.scroll.isPinnedToBottom, true);
    fixture.scroll.handleStreamTouchMove({ touches: [{ clientX: 20, clientY: 200 }] });
    fixture.at(200, 1400); fixture.drain();
    assert.equal(fixture.element.scrollTop, 1400, "the same touch's upward reversal must not be corrected to bottom");
    assert.equal(fixture.scroll.isPinnedToBottom, false);
    fixture.element.scrollHeight += 400; fixture.scroll.scrollToBottom(); fixture.drain();
    assert.equal(fixture.element.scrollTop, 1400);
    fixture.scroll.handleStreamTouchMove({ touches: [{ clientX: 20, clientY: 100 }] });
    fixture.at(300, 1500); fixture.scroll.handleStreamTouchEnd();
    for (let step = 1; step <= 10; step += 1) fixture.at(300 + step * 100, 1500 + step * 40);
    assert.equal(fixture.scroll.isPinnedToBottom, true);
    fixture.element.scrollHeight += 400; fixture.scroll.scrollToBottom(); fixture.drain();
    assert.equal(fixture.element.scrollTop, 2300);
  } finally { fixture.cleanup(); }
});

test("touch direction updates keep the vertical deadzone and horizontal filter after a valid movement", () => {
  const fixture = momentumFixture();
  try {
    fixture.element.scrollTop = 1500; fixture.scroll.inspect();
    fixture.scroll.handleStreamTouchStart({ touches: [{ clientX: 20, clientY: 300 }] });
    fixture.scroll.handleStreamTouchMove({ touches: [{ clientX: 20, clientY: 100 }] });
    assert.equal(fixture.scroll.isPinnedToBottom, true);
    fixture.scroll.handleStreamTouchMove({ touches: [{ clientX: 50, clientY: 110 }] });
    assert.equal(fixture.scroll.isPinnedToBottom, true, "horizontal movement does not change the direction");
    fixture.scroll.handleStreamTouchMove({ touches: [{ clientX: 20, clientY: 104 }] });
    assert.equal(fixture.scroll.isPinnedToBottom, true, "four pixels remain inside the vertical deadzone");
    fixture.scroll.handleStreamTouchMove({ touches: [{ clientX: 20, clientY: 105 }] });
    assert.equal(fixture.scroll.isPinnedToBottom, false, "five vertical pixels establish an upward reversal");
  } finally { fixture.cleanup(); }
});

test("compiled ChatView honors an upward reversal and its inertia within the original touch gesture", async () => {
  const previousNow = Date.now;
  let clock = 0, chat;
  Date.now = () => clock;
  try {
    chat = await mountedChat();
    chat.toggle().props.onClick(); await flush();
    chat.geometry.baseHeight = 2000;
    const stream = chat.stream(), bottom = stream.scrollHeight - stream.clientHeight;
    stream.scrollTop = bottom - 200;
    stream.props.onTouchstartPassive({ touches: [{ clientX: 20, clientY: 300 }] });
    stream.props.onTouchmovePassive({ touches: [{ clientX: 20, clientY: 100 }] });
    clock = 100; stream.scrollTop = bottom; stream.props.onScroll({ target: stream }); await flush();
    stream.props.onTouchmovePassive({ touches: [{ clientX: 20, clientY: 200 }] });
    clock = 200; stream.scrollTop = bottom - 100; stream.props.onScroll({ target: stream }); await flush();
    assert.equal(stream.scrollTop, bottom - 100);
    chat.geometry.growth += 400;
    chat.render({ threadSnapshot: { version: 2, turns: [] } });
    chat.observers.at(-1).callback(); await flush();
    assert.equal(stream.scrollTop, bottom - 100, "growth keeps the reversed touch's reading position");
    stream.props.onTouchend();
    for (let step = 1; step <= 10; step += 1) {
      clock = 200 + step * 100; stream.scrollTop = bottom - 100 - step * 30;
      stream.props.onScroll({ target: stream }); await flush();
    }
    chat.geometry.growth += 400;
    chat.render({ threadSnapshot: { version: 3, turns: [] } });
    chat.observers.at(-1).callback(); await flush();
    assert.equal(stream.scrollTop, bottom - 400, "upward momentum remains paused after 1000ms and further growth");
  } finally {
    try {
      if (chat) {
        await chat.cleanup();
        assert.equal(chat.listeners.size, 0);
        assert.ok(chat.observers.every((observer) => observer.disconnected));
      }
    } finally { Date.now = previousNow; }
  }
});
