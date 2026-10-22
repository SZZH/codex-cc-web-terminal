import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRenderer, h, nextTick, ref } from "vue";
import { defineAppView, recoverViewChunk } from "../web/src/lib/async-view.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  await nextTick();
};

function browser(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const storage = new Map();
  let reloads = 0;
  const window = { location: { reload: () => reloads++ }, sessionStorage: {
    getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value)
  } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: window });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete globalThis.window;
  });
  return { window, get reloads() { return reloads; } };
}

function mount(t, View, props = {}) {
  const renderer = createRenderer({
    createElement: (type) => ({ type, props: {}, children: [] }),
    createText: (text) => ({ type: "text", text }), createComment: (text) => ({ type: "comment", text }),
    setText: (node, text) => { node.text = text; },
    setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: (node) => node.parent, nextSibling: () => null,
    insert: (node, parent) => { node.parent = parent; parent.children.push(node); },
    remove: (node) => { node.parent.children = node.parent.children.filter((child) => child !== node); },
    patchProp: (node, key, _previous, value) => { node.props[key] = value; }
  });
  const root = { children: [] }, errors = [];
  const app = renderer.createApp({ render: () => h(View, props) });
  app.config.errorHandler = (error) => errors.push(error);
  app.mount(root);
  let closed = false;
  const close = () => { if (!closed) { app.unmount(); closed = true; } };
  t.after(close);
  return { root, errors, close };
}

const elements = (node, predicate) => [...(predicate(node) ? [node] : []),
  ...(node.children || []).flatMap((child) => elements(child, predicate))];
const nodeText = (node) => node.type === "comment" ? "" : [node.text || "", ...(node.children || []).map(nodeText)].join("");

test("mounted pending view shows loading immediately and replaces it when its code arrives", async (t) => {
  const pending = deferred();
  const View = defineAppView(() => pending.promise);
  const mounted = mount(t, View);
  const statuses = () => elements(mounted.root, (node) => node.props?.role === "status");
  assert.equal(statuses().length, 1);
  assert.equal(nodeText(statuses()[0]), "正在加载页面…");
  assert.equal(statuses()[0].props["aria-busy"], true);
  await flush();
  assert.equal(statuses().length, 1);
  assert.equal(statuses()[0].props["aria-busy"], true);
  pending.resolve({ render: () => h("main", "会话列表") }); await flush();
  assert.equal(statuses().length, 0);
  assert.equal(elements(mounted.root, (node) => node.type === "main" && node.text === "会话列表").length, 1);
  assert.deepEqual(mounted.errors, []);
});

test("a pending view failure replaces loading with the existing recovery action", async (t) => {
  const environment = browser(t), pending = deferred(), error = new Error("view initialization failed");
  const mounted = mount(t, defineAppView(() => pending.promise));
  assert.equal(elements(mounted.root, (node) => node.props?.role === "status").length, 1);
  pending.reject(error); await flush();
  assert.equal(elements(mounted.root, (node) => node.props?.role === "status").length, 0);
  assert.equal(elements(mounted.root, (node) => node.props?.role === "alert").length, 1);
  const reload = elements(mounted.root, (node) => node.type === "button" && node.text === "重新加载");
  assert.equal(reload.length, 1);
  assert.deepEqual(mounted.errors, [error]);
  assert.equal(environment.reloads, 0);
  reload[0].props.onClick();
  assert.equal(environment.reloads, 1);
});

for (const result of ["success", "failure"]) {
  test(`leaving a pending view removes its loading state before a late ${result}`, async (t) => {
    const environment = browser(t), pending = deferred(), currentRoute = ref("sessions");
    const View = defineAppView(() => pending.promise, { getGeneration: () => currentRoute.value });
    const mounted = mount(t, { render: () => currentRoute.value === "sessions" ? h(View) : h("main", "新页面") });
    assert.equal(elements(mounted.root, (node) => node.props?.role === "status").length, 1);
    currentRoute.value = "chat"; await flush();
    assert.equal(elements(mounted.root, (node) => node.props?.role === "status").length, 0);
    if (result === "success") pending.resolve({ render: () => h("main", "旧会话列表") });
    else pending.reject(new Error("Failed to fetch dynamically imported module: /assets/previous.js"));
    await flush();
    assert.equal(elements(mounted.root, (node) => node.type === "main" && node.text === "新页面").length, 1);
    assert.equal(elements(mounted.root, (node) => node.props?.role === "status" || node.props?.role === "alert").length, 0);
    assert.equal(environment.reloads, 0);
  });
}

test("unmounting a pending view removes loading and a late success does not mount it", async (t) => {
  const pending = deferred();
  let mounts = 0;
  const mounted = mount(t, defineAppView(() => pending.promise));
  assert.equal(elements(mounted.root, (node) => node.props?.role === "status").length, 1);
  mounted.close();
  assert.equal(mounted.root.children.length, 0);
  pending.resolve({ setup() { mounts++; return () => h("main", "旧会话列表"); } }); await flush();
  assert.equal(mounts, 0);
  assert.equal(mounted.root.children.length, 0);
  assert.deepEqual(mounted.errors, []);
});

test("stale hashed view bundle reloads once and does not cause a reload loop", () => {
  const storage = new Map();
  let reloads = 0;
  const environment = { window: { location: { reload: () => reloads++ }, sessionStorage: {
    getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value)
  } } };
  const error = new Error("Failed to fetch dynamically imported module: /assets/old-chat.js");
  assert.equal(recoverViewChunk(error, environment), true);
  assert.equal(recoverViewChunk(error, environment), false);
  assert.equal(reloads, 1);
  assert.equal(recoverViewChunk(new Error("Unrelated view error"), environment), false);
});

test("preload and mounted consumers share pending and successful view code without speculative mounting", async (t) => {
  const pending = deferred();
  let loads = 0, mounts = 0, submissions = 0;
  const View = defineAppView(() => { loads++; return pending.promise; });
  const first = View.preload(), second = View.preload();
  await flush();
  assert.equal(loads, 1);
  assert.equal(mounts, 0);
  const mounted = mount(t, View, { label: "current", title: "forwarded", onSubmit: () => submissions++ });
  await flush();
  assert.equal(loads, 1);
  assert.equal(mounts, 0);
  assert.equal(elements(mounted.root, (node) => node.props?.role === "status").length, 1);
  pending.resolve({ __esModule: true, default: { props: ["label"], emits: ["submit"], setup(props, { emit }) {
    mounts++;
    return () => h("button", { onClick: () => emit("submit") }, props.label);
  } } });
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  await flush();
  assert.equal(mounts, 1);
  assert.equal(elements(mounted.root, (node) => node.props?.role === "status").length, 0);
  const button = mounted.root.children.find((node) => node.type === "button");
  assert.equal(button.text, "current");
  assert.equal(button.props.title, "forwarded");
  button.props.onClick();
  assert.equal(submissions, 1);
  assert.equal(await View.preload(), true);
  mount(t, View); await flush();
  assert.equal(loads, 1);
  assert.equal(mounts, 2);
  assert.deepEqual(mounted.errors, []);
});

for (const asynchronous of [false, true]) {
  for (const message of ["Failed to fetch dynamically imported module: /assets/old-view.js", "Unable to preload CSS for /assets/old-view.css"]) {
    test(`${asynchronous ? "async" : "sync"} speculative ${message.includes("CSS") ? "CSS" : "JS"} failure stays quiet until a real consumer recovers once`, async (t) => {
      const environment = browser(t), error = new Error(message);
      let loads = 0;
      const View = defineAppView(() => {
        loads++;
        if (asynchronous) return Promise.reject(error);
        throw error;
      });
      assert.equal(await View.preload(), false);
      assert.equal(await View.preload(), false);
      assert.equal(environment.reloads, 0);
      const first = mount(t, View); await flush();
      assert.equal(environment.reloads, 1);
      assert.deepEqual(first.errors, []);
      const second = mount(t, View); await flush();
      assert.equal(environment.reloads, 1);
      assert.deepEqual(second.errors, [error]);
      assert.equal(elements(second.root, (node) => node.props?.role === "alert").length, 1);
      assert.equal(loads, 1, "failed CSS and JS resources stay retained instead of retrying an incomplete resource group");
    });
  }
}

test("unrelated retained loader failures remain observable without reloading or pretending to render", async (t) => {
  const environment = browser(t), error = new Error("view initialization failed");
  const View = defineAppView(() => Promise.reject(error));
  assert.equal(await View.preload(), false);
  const mounted = mount(t, View); await flush();
  assert.equal(environment.reloads, 0);
  assert.deepEqual(mounted.errors, [error]);
  assert.equal(elements(mounted.root, (node) => node.props?.role === "alert").length, 1);
  const reload = elements(mounted.root, (node) => node.type === "button")[0];
  assert.equal(reload.text, "重新加载");
  reload.props.onClick();
  assert.equal(environment.reloads, 1);
});

for (const change of ["route", "auth", "unmount"]) {
  for (const resource of ["JS", "CSS"]) {
    test(`${change} invalidation prevents an old mounted ${resource} failure from reloading its successor`, async (t) => {
      const environment = browser(t), pending = deferred();
      let generation = "auth-1:route-1";
      const View = defineAppView(() => pending.promise, { getGeneration: () => generation });
      const mounted = mount(t, View); await flush();
      if (change === "unmount") mounted.close();
      else generation = change === "auth" ? "auth-2:route-1" : "auth-1:route-2";
      pending.reject(new Error(resource === "CSS" ? "Unable to preload CSS for /assets/previous.css"
        : "Failed to fetch dynamically imported module: /assets/previous.js")); await flush();
      assert.equal(environment.reloads, 0);
      assert.equal(mounted.errors.length, 1);
    });
  }
}

test("chunk recovery recognizes CSS, tolerates unavailable browser storage, and permits a later bounded recovery", (t) => {
  const environment = browser(t), error = new Error("Unable to preload CSS for /assets/view.css");
  let time = 100_000;
  t.mock.method(Date, "now", () => time);
  assert.equal(recoverViewChunk(error), true);
  time += 29_999;
  assert.equal(recoverViewChunk(error), false);
  time += 1;
  assert.equal(recoverViewChunk(error), true);
  assert.equal(environment.reloads, 2);
  assert.equal(recoverViewChunk(error, {}), false);
  environment.window.sessionStorage.getItem = () => { throw new Error("blocked storage"); };
  assert.equal(recoverViewChunk(error), false);
});

function viteResources(t) {
  const environment = browser(t), links = [], events = [];
  environment.window.dispatchEvent = (event) => { events.push(event); return true; };
  const document = {
    getElementsByTagName: () => links,
    querySelector: (selector) => links.find((link) => selector === `link[href="${link.href}"]`
      || selector === `link[href="${link.href}"][rel="stylesheet"]` && link.rel === "stylesheet") || null,
    createElement: () => {
      const handlers = new Map();
      return { addEventListener: (name, callback) => handlers.set(name, callback),
        setAttribute() {}, settle: (name) => handlers.get(name)?.() };
    },
    head: { appendChild: (link) => links.push(link) }
  };
  const source = fs.readFileSync(new URL("../node_modules/vite/dist/node/chunks/node.js", import.meta.url), "utf8");
  const start = source.indexOf("function preload(baseModule, deps, importerUrl) {");
  const end = source.indexOf("function getPreloadCode(", start);
  assert.ok(start >= 0 && end > start, "exercise the installed Vite preload helper verbatim");
  const preload = new Function("document", "window", "assetsURL", "seen", "__VITE_IS_MODERN__", "scriptRel",
    `return ${source.slice(start, end)}`)(document, environment.window, (url) => url, {}, true, "modulepreload");
  return { ...environment, preload, links, events, get reloads() { return environment.reloads; },
    settle: (href, result) => {
      const link = links.find((item) => item.href === href);
      assert.ok(link, `resource was requested: ${href}`);
      link.settle(result);
    } };
}

function dependentViews(resources) {
  const starts = [], imports = [], mounts = [];
  const component = (name) => ({ setup() { mounts.push(name); return () => h(name); } });
  const ChatView = defineAppView(() => {
    starts.push("chat");
    return resources.preload(() => { imports.push("chat"); return Promise.resolve(component("chat-view")); },
      ["/assets/ChatView.js", "/assets/ChatView.css"]);
  });
  const CodexView = defineAppView(() => {
    starts.push("codex");
    return resources.preload(() => { imports.push("codex"); return Promise.resolve(component("codex-view")); },
      ["/assets/ChatView.js", "/assets/ChatView.css", "/assets/CodexView.css"]);
  }, { dependsOn: [ChatView] });
  return { ChatView, CodexView, starts, imports, mounts };
}

for (const first of ["chat", "codex"]) {
  test(`installed Vite ${first}-first shared CSS remains required while independent imports start concurrently`, async (t) => {
    const resources = viteResources(t), views = dependentViews(resources);
    const preload = (first === "chat" ? views.ChatView : views.CodexView).preload();
    if (first === "chat") await flush();
    const codex = views.CodexView.preload(), chat = views.ChatView.preload();
    const mounted = mount(t, views.CodexView);
    await flush();
    assert.deepEqual(views.starts, ["chat", "codex"], "the shared dependency registers its Vite resources first");
    assert.equal(resources.links.filter((link) => link.href === "/assets/ChatView.css").length, 1);
    resources.settle("/assets/CodexView.css", "load"); await flush();
    assert.deepEqual(views.imports, ["codex"], "Codex's own import proceeds while the shared CSS is pending");
    assert.deepEqual(views.mounts, [], "an independently imported module is not a complete consumer result");
    resources.settle("/assets/ChatView.css", "load");
    assert.deepEqual(await Promise.all([preload, codex, chat]), [true, true, true]); await flush();
    assert.deepEqual(views.imports, ["codex", "chat"]);
    assert.deepEqual(views.mounts, ["codex-view"]);
    assert.deepEqual(mounted.errors, []);
    assert.equal(resources.reloads, 0);
  });
}

for (const phase of ["pending", "failed"]) {
  test(`installed Vite ${phase} shared CSS failure cannot be hidden by a second view's successful import`, async (t) => {
    const resources = viteResources(t), views = dependentViews(resources);
    const chat = views.ChatView.preload(); await flush();
    if (phase === "failed") {
      resources.settle("/assets/ChatView.css", "error");
      assert.equal(await chat, false);
    }
    const codex = views.CodexView.preload(); await flush();
    resources.settle("/assets/CodexView.css", "load"); await flush();
    assert.deepEqual(views.imports, ["codex"]);
    assert.equal(resources.reloads, 0, "speculative shared dependency failures do not recover in the background");
    let current;
    if (phase === "pending") {
      current = mount(t, views.CodexView); await flush();
      assert.deepEqual(views.mounts, []);
    }
    if (phase === "pending") resources.settle("/assets/ChatView.css", "error");
    assert.deepEqual(await Promise.all([chat, codex]), [false, false]);
    current ||= mount(t, views.CodexView); await flush();
    assert.equal(resources.reloads, 1);
    assert.deepEqual(views.mounts, []);
    assert.deepEqual(current.errors, []);
    const repeated = mount(t, views.CodexView); await flush();
    assert.equal(resources.reloads, 1);
    assert.equal(elements(repeated.root, (node) => node.props?.role === "alert").length, 1);
    assert.match(repeated.errors[0].message, /Unable to preload CSS for \/assets\/ChatView.css/);
    assert.equal(resources.links.filter((link) => link.href === "/assets/ChatView.css").length, 1);
  });
}

test("installed Vite Codex-first failure also remains retained when a later consumer opens the shared ChatView", async (t) => {
  const resources = viteResources(t), views = dependentViews(resources);
  const codex = views.CodexView.preload(); await flush();
  assert.deepEqual(views.starts, ["chat", "codex"]);
  resources.settle("/assets/CodexView.css", "load");
  resources.settle("/assets/ChatView.css", "error");
  assert.equal(await codex, false);
  assert.equal(await views.ChatView.preload(), false);
  assert.equal(resources.reloads, 0);
  mount(t, views.ChatView); await flush();
  assert.equal(resources.reloads, 1);
  assert.deepEqual(views.mounts, []);
});

test("installed Vite Codex-only CSS failure does not poison its successful shared ChatView dependency", async (t) => {
  const resources = viteResources(t), views = dependentViews(resources);
  const codex = views.CodexView.preload(); await flush();
  resources.settle("/assets/CodexView.css", "error");
  resources.settle("/assets/ChatView.css", "load");
  assert.equal(await codex, false);
  assert.equal(await views.ChatView.preload(), true);
  const mounted = mount(t, views.ChatView); await flush();
  assert.deepEqual(views.mounts, ["chat-view"]);
  assert.equal(resources.reloads, 0);
  assert.deepEqual(mounted.errors, []);
});

for (const target of ["sessions-view", "login-view"]) {
  test(`installed Vite abandoned shared CSS failure cannot block or reload unrelated ${target}`, async (t) => {
    const resources = viteResources(t), views = dependentViews(resources);
    const chat = views.ChatView.preload(); await flush();
    const Unrelated = defineAppView(() => Promise.resolve({ render: () => h(target) }));
    assert.equal(await Unrelated.preload(), true);
    const mounted = mount(t, Unrelated); await flush();
    resources.settle("/assets/ChatView.css", "error");
    assert.equal(await chat, false); await flush();
    assert.equal(resources.reloads, 0);
    assert.equal(elements(mounted.root, (node) => node.type === target).length, 1);
    assert.deepEqual(mounted.errors, []);
    assert.deepEqual(views.mounts, []);
  });
}
