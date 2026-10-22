import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parse, compileScript } from "@vue/compiler-sfc";
import { createRenderer, h, nextTick, reactive } from "vue";
import { createComposerRuntimeController, createComposerSubmissionController } from "../web/src/lib/composer-runtime.js";
import { createAttachmentRecord, collectAttachmentLimitError, createComposerOptions, createWorkspaceGitState, buildInputRequest, validateGitBranchName } from "../web/src/lib/composer.js";
import { createLiveViewState } from "../web/src/lib/app-state.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const state = { codexDefaults: {}, loading: false, liveView: createLiveViewState() };
  state.liveView.liveSessionId = "live-a";
  const composerDraft = { value: "draft" };
  const composerOptions = { value: createComposerOptions() };
  const uploads = [];
  const inputs = [];
  const applied = [];
  let generation = 1;
  let threadId = "";
  let attachCount = 0;
  const runtime = createComposerRuntimeController({
    state, composerDraft, composerOptions, workspaceGitState: { value: createWorkspaceGitState() },
    createComposerOptions, createWorkspaceGitState, createAttachmentRecord, collectAttachmentLimitError,
    getActiveThreadId: () => threadId, getExpectedThreadId: () => "", getActiveProviderId: () => "codex",
    getModels: () => [], getCanInterrupt: () => false, getLoading: () => state.loading,
    setStatus: (value) => { state.statusText = value; },
    request: (url, options) => { const item = { url, options, ...deferred() }; uploads.push(item); return item.promise; }
  });
  const send = (kind, body) => { const item = { kind, body, ...deferred() }; inputs.push(item); return item.promise; };
  const submit = createComposerSubmissionController({
    state, composerDraft, composerOptions,
    getContext: () => ({ activation: generation, provider: "codex", threadId, expectedThreadId: "", liveSessionId: state.liveView.liveSessionId }),
    isContextCurrent: (context) => context.activation === generation,
    getCanSend: () => true, waitForComposerPersistence: async () => true,
    uploadImageAttachments: runtime.uploadImageAttachments, ensureLiveSession: async () => "live-a",
    attachLiveSocket: async () => { attachCount += 1; state.liveView.socket = {}; },
    requestSessionInput: (id, body) => send(id, body), requestThreadInput: (provider, id, body) => send(id, body),
    applyInputResponse: (payload) => { applied.push(payload); threadId = payload.session?.resumeSessionId || threadId; },
    createUserMessage: (text) => ({ id: `user-${inputs.length}`, role: "user", text }),
    setMessages: (value) => { state.liveView.messages = value; }, finalizeAssistantStream() {},
    setStatus: (value) => { state.statusText = value; }, syncActiveThreadSession: async () => false, startHistorySyncLoop() {}
  });
  return { state, composerDraft, composerOptions, uploads, inputs, applied, runtime, submit,
    get attachCount() { return attachCount; }, switchThread: () => { generation += 1; state.loading = false; threadId = "thread-b"; } };
}

const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
const image = (name = "截图.png") => new File(["image"], name, { type: "image/png" });

test("first input keeps its websocket, consumes POST identity, and routes the next turn by thread", async () => {
  const h = harness();
  const first = h.submit.submitInput();
  await flush();
  assert.equal(h.attachCount, 1);
  assert.equal(h.inputs[0].kind, "live-a");
  assert.equal(h.composerDraft.value, "draft");
  const response = { session: { id: "live-a", resumeSessionId: "thread-a" }, turnId: "turn-a" };
  h.inputs[0].resolve(response);
  assert.deepEqual(await first, response);
  assert.deepEqual(h.applied, [response]);
  assert.equal(h.composerDraft.value, "");
  h.composerDraft.value = "second";
  const second = h.submit.submitInput();
  await flush();
  assert.equal(h.attachCount, 1);
  assert.equal(h.inputs[1].kind, "thread-a");
  h.inputs[1].resolve({ turnId: "turn-b" });
  await second;
});

test("image upload precedes image-only input and serializes only the returned ID", async () => {
  const h = harness();
  h.composerDraft.value = "";
  const file = image();
  h.runtime.addAttachments({ files: [file], kindHint: "image" });
  const pending = h.submit.submitInput();
  await flush();
  assert.equal(h.inputs.length, 0);
  assert.equal(h.uploads[0].url, "/api/attachments/images");
  assert.equal(h.uploads[0].options.body, file);
  assert.deepEqual(h.uploads[0].options.headers, { "Content-Type": "image/png", "X-File-Name": encodeURIComponent(file.name) });
  h.uploads[0].resolve({ attachment: { id: "uploaded-a", url: "/api/attachments/images/uploaded-a" } });
  await flush();
  assert.deepEqual(h.inputs[0].body.attachments, [{ id: "uploaded-a" }]);
  assert.equal(h.inputs[0].body.data, "");
  h.inputs[0].resolve({ turnId: "image-turn" });
  await pending;
  assert.deepEqual(h.composerOptions.value.attachments, []);
});

test("an accepted thread input reconnects when the backend replaces the live session", async () => {
  const h = harness();
  h.state.liveView.socket = {};
  const pending = h.submit.submitInput();
  await flush();
  h.inputs[0].resolve({ session: { id: "replacement", resumeSessionId: "thread-a" }, turnId: "turn-a" });
  await pending;
  assert.equal(h.attachCount, 1);
  assert.equal(h.composerDraft.value, "");
});

test("upload and input failures retain draft and image while retry reuses the uploaded ID", async () => {
  const h = harness();
  h.runtime.addAttachments({ files: [image()], kindHint: "image" });
  const first = h.submit.submitInput();
  await flush();
  h.uploads[0].reject(new Error("upload failed"));
  await first;
  assert.equal(h.inputs.length, 0);
  assert.equal(h.composerDraft.value, "draft");
  assert.equal(h.composerOptions.value.attachments[0].status, "failed");
  const retry = h.submit.submitInput();
  await flush();
  h.uploads[1].resolve({ attachment: { id: "uploaded-a" } });
  await flush();
  h.inputs[0].reject(new Error("input failed"));
  await retry;
  assert.equal(h.composerDraft.value, "draft");
  assert.equal(h.composerOptions.value.attachments[0].uploadedId, "uploaded-a");
  assert.deepEqual(h.state.liveView.messages, []);
  const last = h.submit.submitInput();
  await flush();
  assert.equal(h.uploads.length, 2);
  assert.deepEqual(h.inputs[1].body.attachments, [{ id: "uploaded-a" }]);
  h.inputs[1].resolve({ turnId: "retry-turn" });
  await last;
});

test("stale POST failure cannot replace the next thread draft, attachment or status", async () => {
  const h = harness();
  const first = h.submit.submitInput();
  await flush();
  h.switchThread();
  h.composerDraft.value = "new thread draft";
  h.runtime.addAttachments({ files: [image("new.png")], kindHint: "image" });
  h.state.statusText = "new thread status";
  h.inputs[0].reject(new Error("old failure"));
  await first;
  assert.equal(h.composerDraft.value, "new thread draft");
  assert.equal(h.composerOptions.value.attachments[0].name, "new.png");
  assert.equal(h.state.statusText, "new thread status");
});

test("identical text in a different thread is not suppressed by the previous thread fingerprint", async () => {
  const h = harness();
  const first = h.submit.submitInput();
  await flush();
  h.inputs[0].resolve({ turnId: "first" });
  await first;
  h.switchThread();
  h.composerDraft.value = "draft";
  const second = h.submit.submitInput();
  await flush();
  assert.equal(h.inputs.length, 2);
  assert.equal(h.inputs[1].kind, "thread-b");
  h.inputs[1].resolve({ turnId: "second" });
  await second;
});

test("late attachment retry success cannot clear the next thread status", async () => {
  const h = harness();
  h.runtime.addAttachments({ files: [image()], kindHint: "image" });
  const retry = h.runtime.retryAttachment(h.composerOptions.value.attachments[0].id);
  h.switchThread();
  h.composerOptions.value.attachments = [];
  h.state.statusText = "thread-b status";
  h.uploads[0].resolve({ attachment: { id: "old-upload" } });
  await retry;
  assert.equal(h.state.statusText, "thread-b status");
  assert.deepEqual(h.composerOptions.value.attachments, []);
});

function gitHarness() {
  let activation = 1;
  let threadId = "a";
  const state = { codexDefaults: {}, statusText: "" };
  const composerOptions = { value: createComposerOptions() };
  const workspaceGitState = { value: createWorkspaceGitState({ available: true, isGitRepo: true, currentBranch: "main" }) };
  const operations = [], reads = [], patches = [];
  const runtime = createComposerRuntimeController({
    state, composerOptions, composerDraft: { value: "" }, workspaceGitState, createComposerOptions, createWorkspaceGitState, validateGitBranchName,
    getActiveThreadId: () => threadId, getExpectedThreadId: () => threadId, getActiveProviderId: () => "codex", getActiveWorkspaceCwd: () => `/workspace/${threadId}`,
    getActivationToken: () => activation, getModels: () => [], getLoading: () => false, getCanInterrupt: () => false,
    setStatus: (text) => { state.statusText = text; },
    requestWorkspaceGitCheckout: (cwd, branch) => { const op = { cwd, branch, ...deferred() }; operations.push(op); return op.promise; },
    requestWorkspaceGitBranchCreate: (cwd, branch) => { const op = { cwd, branch, ...deferred() }; operations.push(op); return op.promise; },
    requestWorkspaceGit: (cwd) => { const op = { cwd, ...deferred() }; reads.push(op); return op.promise; },
    patchThreadComposerState: async (...args) => { patches.push(args); return {}; }
  });
  runtime.syncComposerContext();
  return { runtime, state, composerOptions, workspaceGitState, operations, reads, patches,
    switchThread: () => { activation += 1; threadId = "b"; runtime.syncComposerContext(); state.statusText = "B status";
      workspaceGitState.value = createWorkspaceGitState({ currentBranch: "branch-b" }); } };
}

for (const method of ["switchGitBranch", "createGitBranch"]) {
  for (const fails of [false, true]) {
    test(`${method} late ${fails ? "failure" : "success"} does not refresh or persist into another thread`, async () => {
      const h = gitHarness();
      const pending = h.runtime[method]("feature");
      h.switchThread();
      if (fails) h.operations[0].reject(new Error("old checkout error"));
      else h.operations[0].resolve({});
      await pending;
      assert.deepEqual(h.reads, []);
      assert.deepEqual(h.patches, []);
      assert.equal(h.state.statusText, "B status");
      assert.equal(h.workspaceGitState.value.currentBranch, "branch-b");
    });
  }
}

test("Git refresh completing after a thread change cannot persist the previous cwd on the new thread", async () => {
  const h = gitHarness();
  const pending = h.runtime.switchGitBranch("feature");
  h.operations[0].resolve({});
  await flush();
  assert.equal(h.reads[0].cwd, "/workspace/a");
  h.switchThread();
  h.reads[0].resolve({ currentBranch: "feature", isGitRepo: true, cwd: "/workspace/a" });
  await pending;
  assert.deepEqual(h.patches, []);
  assert.equal(h.workspaceGitState.value.currentBranch, "branch-b");
  assert.equal(h.state.statusText, "B status");
});

test("attachment limit blocks the seventh image and files larger than 20 MiB", () => {
  const h = harness();
  h.runtime.addAttachments({ files: Array.from({ length: 7 }, (_, index) => image(`${index}.png`)), kindHint: "image" });
  assert.equal(h.composerOptions.value.attachments.length, 6);
  assert.match(h.state.statusText, /6/);
  const large = createAttachmentRecord({ name: "large.png", type: "image/png", size: 20 * 1024 * 1024 + 1 });
  assert.match(collectAttachmentLimitError([], large), /20MB/);
  assert.deepEqual(buildInputRequest({ composerOptions: { attachments: [large] } }).attachments, []);
});

test("interrupt sends a control input and preserves the live socket", async () => {
  const h = harness();
  const socket = {};
  h.state.liveView.socket = socket;
  h.state.liveView.activeInputStream = true;
  const pending = h.submit.interruptActiveSession();
  assert.deepEqual(h.inputs[0].body, { type: "interrupt", reason: "user_interrupt" });
  h.inputs[0].resolve({});
  await pending;
  assert.equal(h.state.liveView.socket, socket);
  assert.equal(h.state.liveView.activeInputStream, false);
  assert.equal(h.state.statusText, "当前流程已中断。");
});

async function loadComposer(name = "ChatComposer") {
  const url = new URL(`../web/src/components/composer/${name}.vue`, import.meta.url);
  const { descriptor } = parse(fs.readFileSync(url, "utf8"), { filename: url.pathname });
  let source = compileScript(descriptor, { id: "critical-composer", inlineTemplate: true }).content;
  source = source.replaceAll('from "vue"', `from ${JSON.stringify(import.meta.resolve("vue"))}`)
    .replace('from "../../lib/composer.js"', `from ${JSON.stringify(new URL("../web/src/lib/composer.js", import.meta.url).href)}`)
    .replace(/^import (\w+) from "\.\/[^\"]+\.vue";$/gm, "const $1 = { render: () => null };");
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).default;
}

function renderer() {
  return createRenderer({
    createElement: (type) => ({ type, props: {}, children: [], style: {}, scrollHeight: 48 }),
    createText: (text) => ({ type: "text", text }), createComment: (text) => ({ type: "comment", text }),
    setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: (node) => node.parent,
    nextSibling: (node) => node.parent.children[node.parent.children.indexOf(node) + 1] || null,
    insert: (node, parent, anchor) => {
      if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node);
      node.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index >= 0) parent.children.splice(index, 0, node);
      else parent.children.push(node);
    },
    remove: (node) => { node.parent.children = node.parent.children.filter((child) => child !== node); },
    patchProp: (node, key, previous, next) => { node.props[key] = next; }
  });
}
const elements = (node, predicate) => [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap((child) => elements(child, predicate))];

test("running composer exposes an enabled stop action that emits interrupt", async () => {
  const Component = await loadComposer();
  const { render } = renderer();
  const root = { children: [] };
  const events = [];
  render(h(Component, { composerOptions: createComposerOptions(), gitState: createWorkspaceGitState(), canInterrupt: true, loading: true,
    onInterrupt: () => events.push("interrupt"), onSubmit: () => events.push("submit") }), root);
  await nextTick();
  const stop = elements(root, (node) => node.type === "button" && node.props["aria-label"] === "停止生成")[0];
  assert.ok(stop);
  assert.equal(stop.props.disabled, false);
  stop.props.onClick();
  assert.deepEqual(events, ["interrupt"]);
  assert.equal(elements(root, (node) => node.type === "input" && node.props.accept === "image/*").length, 2);
  render(null, root);
});

for (const name of ["ComposerSettings", "GitBranchMenu"]) {
  test(`${name} can refresh unavailable Git without allowing writes or repeated reads`, async () => {
    const Component = await loadComposer(name);
    const { render } = renderer();
    const root = { children: [] };
    const events = [];
    const props = {
      composerOptions: createComposerOptions(),
      gitState: createWorkspaceGitState({ available: false, isGitRepo: true, currentBranch: "main",
        branches: [{ name: "feature", current: false }], error: "读取超时，请重新确认工作区状态" }),
      onRefreshGit: () => events.push("refresh"), onRefresh: () => events.push("refresh")
    };
    try {
      render(h(Component, props), root);
      await nextTick();
      const refresh = elements(root, (node) => node.type === "button" && node.props["aria-label"] === "刷新 Git 状态")[0];
      assert.ok(refresh);
      assert.equal(Boolean(refresh.props.disabled), false);
      refresh.props.onClick();
      assert.deepEqual(events, ["refresh"]);
      assert.ok(elements(root, (node) => node.props?.role === "status").length);
      const writeControls = elements(root, (node) => node.type === "button" && ["git-entry", "branch-chip", "branch-create"].some((cls) => node.props.class?.split(" ").includes(cls)));
      if (name === "ComposerSettings") assert.equal(writeControls.length, 0);
      else assert.ok(writeControls.length);
      assert.equal(writeControls.every((node) => node.props.disabled), true);
      render(h(Component, { ...props, gitState: { ...props.gitState, loading: true } }), root);
      await nextTick();
      assert.equal(elements(root, (node) => node.props?.["aria-label"] === "刷新 Git 状态")[0].props.disabled, true);
      render(h(Component, { ...props, disabled: true }), root);
      await nextTick();
      assert.equal(elements(root, (node) => node.props?.["aria-label"] === "刷新 Git 状态")[0].props.disabled, true);
    } finally { render(null, root); }
  });
}

const settleApp = async () => {
  for (let index = 0; index < 3; index += 1) await new Promise(setImmediate);
  await nextTick();
};

async function mountPreloadingApp(t, { routeName = "chat", routeId = "history:codex:thread", auth = deferred() } = {}) {
  const previousWindow = globalThis.window;
  const route = reactive({ name: routeName, params: { sessionId: routeId }, query: {}, fullPath: "/initial" });
  const calls = [], loads = [], views = [], errors = [], resources = new Map(), listeners = new Map(), storage = new Map();
  let reloads = 0;
  const resource = (name) => {
    if (!resources.has(name)) resources.set(name, deferred());
    return resources.get(name);
  };
  const request = async (url, options) => {
    calls.push({ url, options });
    return url.startsWith("/api/sessions?") ? { sessions: [], projectGroups: [] } : {};
  };
  const navigate = async (target) => {
    if (typeof target !== "string") Object.assign(route, { params: {}, query: {}, ...target });
  };
  globalThis.window = { location: { protocol: "http:", host: "localhost", reload: () => reloads++ },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: (name) => listeners.delete(name),
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout };
  globalThis.__preloadAppTest = { route, router: { push: navigate, replace: navigate },
    requestAuthSession: () => { calls.push({ url: "/api/auth/session" }); return auth.promise; }, request,
    requestSessionById: (id) => { calls.push({ url: `/api/sessions/${id}` }); return Promise.resolve(null); },
    load: (name) => { loads.push(name); return resource(name).promise; }
  };
  const asModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const realApi = await import("../web/src/lib/api.js");
  const overrides = {
    "./lib/api.js": asModule(Object.keys(realApi).map((name) => name === "AUTH_EXPIRED_EVENT"
      ? "export const AUTH_EXPIRED_EVENT='codex-auth-expired';"
      : `export const ${name}=(...args)=>globalThis.__preloadAppTest.${name}?.(...args);`).join("\n")),
    "vue-router": asModule("export const useRoute=()=>globalThis.__preloadAppTest.route;export const useRouter=()=>globalThis.__preloadAppTest.router;"),
    "./lib/async-view.js": asModule(`import {defineAppView as define} from ${JSON.stringify(new URL("../web/src/lib/async-view.js", import.meta.url).href)};
      export function defineAppView(loader, options) { const name=loader.toString().match(/components\\/(\\w+)/)[1];
        return define(()=>globalThis.__preloadAppTest.load(name), options); }`),
    "./lib/preview.js": asModule("export const previewState={open:false};export const closeLocalPreview=()=>{};export const invalidateLocalPreviewPosition=()=>{};"),
    "./components/preview/PreviewHost.vue": asModule("export default {render(){return null;}};")
  };
  const file = new URL("../web/src/App.vue", import.meta.url);
  const { descriptor } = parse(fs.readFileSync(file, "utf8"), { filename: file.pathname });
  const compiled = compileScript(descriptor, { id: "preloading-app", inlineTemplate: true }).content;
  const source = compiled.replace(/from\s+["']([^"']+)["']/g, (_match, name) =>
    `from ${JSON.stringify(overrides[name] || (name === "vue" ? import.meta.resolve("vue") : new URL(name, file).href))}`);
  const Component = (await import(asModule(source))).default;
  const root = { children: [] }, app = renderer().createApp(Component);
  app.config.errorHandler = (error) => errors.push(error);
  t.after(() => {
    app.unmount(); globalThis.window = previousWindow; delete globalThis.__preloadAppTest;
  });
  app.mount(root); await settleApp();
  const resolveView = (name) => resource(name).resolve({
    props: ["threadId"], setup(props, { emit }) {
      views.push({ name, props, emit });
      if (name === "CodexThreadView") void request(`/api/v2/codex/threads/${props.threadId}`);
      return () => h(name);
    }
  });
  return { auth, route, calls, loads, views, errors, root, resolveView, resource,
    expire: () => listeners.get("codex-auth-expired")(),
    get state() { return window.__codexWebDebug.state; }, get reloads() { return reloads; } };
}

for (const [routeName, routeId, view] of [
  ["sessions", "", "SessionListView"],
  ["chat", "history:codex:thread", "CodexThreadView"],
  ["chat", "history:claude:thread", "ChatView"],
  ["login", "", "LoginView"]
]) {
  test(`mounted App preloads ${view} and its required shared view while keeping config, sidebar, metadata and mutations behind auth`, async (t) => {
    const app = await mountPreloadingApp(t, { routeName, routeId });
    const required = view === "CodexThreadView" ? ["ChatView", view] : [view];
    assert.deepEqual(app.loads, required);
    assert.deepEqual(app.calls.map(({ url }) => url), ["/api/auth/session"]);
    assert.deepEqual(app.views, []);
    if (view === "CodexThreadView") app.resolveView("ChatView");
    app.resolveView(view); await settleApp();
    assert.deepEqual(app.views, []);
    assert.deepEqual(app.calls.map(({ url }) => url), ["/api/auth/session"]);
    app.auth.resolve({ authenticated: routeName !== "login" }); await settleApp();
    assert.ok(app.views.some((item) => item.name === view));
    assert.deepEqual(app.loads, required);
    assert.equal(app.reloads, 0);
    assert.deepEqual(app.errors, []);
    assert.equal(app.calls.some(({ options }) => options?.method && options.method !== "GET"), false);
  });
}

test("mounted App waits for a resolved route, follows hash changes, and cannot mount a previous speculative success", async (t) => {
  const app = await mountPreloadingApp(t, { routeName: null, routeId: "" });
  assert.deepEqual(app.loads, []);
  app.route.name = "chat"; app.route.params.sessionId = "history:codex:previous"; await settleApp();
  assert.deepEqual(app.loads, ["ChatView", "CodexThreadView"]);
  app.route.name = "sessions"; app.route.params = {}; await settleApp();
  app.resolveView("ChatView"); app.resolveView("CodexThreadView"); app.resolveView("SessionListView"); await settleApp();
  assert.deepEqual(app.views, []);
  assert.deepEqual(app.calls.map(({ url }) => url), ["/api/auth/session"]);
  app.auth.resolve({ authenticated: true }); await settleApp();
  assert.deepEqual(app.views.map(({ name }) => name), ["SessionListView"]);
  assert.equal(app.calls.some(({ url }) => url.includes("/api/v2/codex/threads/")), false);
});

test("mounted App preloads the shared ChatView for an unknown live provider without speculating metadata or mutations", async (t) => {
  const app = await mountPreloadingApp(t, { routeId: "unknown-live-session" });
  assert.deepEqual(app.loads, ["ChatView"]);
  app.resolveView("ChatView"); await settleApp();
  assert.deepEqual(app.views, []);
  assert.deepEqual(app.calls.map(({ url }) => url), ["/api/auth/session"]);
  app.auth.resolve({ authenticated: false }); await settleApp();
  app.resolveView("LoginView"); await settleApp();
  assert.deepEqual(app.views.map(({ name }) => name), ["LoginView"]);
  assert.deepEqual(app.calls.map(({ url }) => url), ["/api/auth/session"]);
});

for (const change of ["route", "auth"]) {
  test(`mounted App ignores an old chunk failure immediately after ${change} changes while preserving its current view`, async (t) => {
    const app = await mountPreloadingApp(t);
    app.auth.resolve({ authenticated: true }); await settleApp();
    if (change === "route") { app.route.name = "sessions"; app.route.params = {}; }
    else app.expire();
    const status = app.state.statusText;
    app.resource("CodexThreadView").reject(new Error("Unable to preload CSS for /assets/old.css"));
    await settleApp();
    const current = change === "route" ? "SessionListView" : "LoginView";
    app.resolveView(current); await settleApp();
    assert.equal(app.reloads, 0);
    assert.equal(app.state.statusText, status);
    assert.ok(app.views.some(({ name }) => name === current), JSON.stringify({ loads: app.loads,
      views: app.views.map(({ name }) => name), route: app.route.name, authenticated: app.state.isAuthenticated,
      errors: app.errors.map((error) => error.stack) }));
    assert.equal(app.views.some(({ name }) => name === "CodexThreadView"), false);
    assert.equal(elements(app.root, (node) => node.props?.role === "alert").length, 0);
  });
}

test("mounted App shares code across pending thread switches and mounts only the current thread", async (t) => {
  const app = await mountPreloadingApp(t);
  app.auth.resolve({ authenticated: true }); await settleApp();
  app.route.params.sessionId = "history:codex:next-thread"; await settleApp();
  app.resolveView("ChatView"); app.resolveView("CodexThreadView"); await settleApp();
  assert.deepEqual(app.loads, ["ChatView", "CodexThreadView"]);
  assert.deepEqual(app.views.map(({ name, props }) => [name, props.threadId]), [["CodexThreadView", "next-thread"]]);
  assert.equal(app.calls.some(({ url }) => url === "/api/v2/codex/threads/thread"), false);
  assert.deepEqual(app.errors, []);
});

for (const resource of ["JS", "CSS"]) {
  test(`mounted App retains a speculative ${resource} failure for one recovery and a visible actionable permanent failure`, async (t) => {
    const app = await mountPreloadingApp(t);
    const failure = new Error(resource === "CSS" ? "Unable to preload CSS for /assets/old.css"
      : "Failed to fetch dynamically imported module: /assets/old.js");
    app.resource("CodexThreadView").reject(failure); await settleApp();
    assert.equal(app.reloads, 0);
    assert.deepEqual(app.errors, []);
    app.auth.resolve({ authenticated: true }); await settleApp();
    assert.equal(app.reloads, 1);
    app.route.params.sessionId = "history:codex:next-thread"; await settleApp();
    assert.equal(app.reloads, 1);
    assert.deepEqual(app.loads, ["ChatView", "CodexThreadView"]);
    assert.deepEqual(app.errors, [failure]);
    assert.equal(elements(app.root, (node) => node.props?.role === "alert").length, 1);
    const reload = elements(app.root, (node) => node.type === "button")[0];
    assert.equal(reload.text, "重新加载");
    reload.props.onClick();
    assert.equal(app.reloads, 2);
    assert.deepEqual(app.views, []);
  });
}

test("mounted App keeps a speculative JS failure quiet after an unauthenticated result", async (t) => {
  const app = await mountPreloadingApp(t);
  app.resource("CodexThreadView").reject(new Error("Failed to fetch dynamically imported module: /assets/old.js"));
  await settleApp();
  assert.equal(app.reloads, 0);
  assert.deepEqual(app.errors, []);
  app.auth.resolve({ authenticated: false }); await settleApp();
  app.resolveView("LoginView"); await settleApp();
  assert.deepEqual(app.views.map(({ name }) => name), ["LoginView"]);
  assert.deepEqual(app.calls.map(({ url }) => url), ["/api/auth/session"]);
  assert.equal(app.reloads, 0);
  assert.deepEqual(app.errors, []);
});

test("mounted App starts both imports but waits for the shared ChatView before mounting or reading Codex metadata", async (t) => {
  const app = await mountPreloadingApp(t);
  assert.deepEqual(app.loads, ["ChatView", "CodexThreadView"]);
  app.resolveView("CodexThreadView");
  app.auth.resolve({ authenticated: true }); await settleApp();
  assert.deepEqual(app.views, []);
  assert.equal(app.calls.some(({ url }) => url.includes("/api/v2/codex/threads/")), false);
  app.resolveView("ChatView"); await settleApp();
  assert.deepEqual(app.views.map(({ name }) => name), ["CodexThreadView"]);
  assert.equal(app.calls.filter(({ url }) => url === "/api/v2/codex/threads/thread").length, 1);
  assert.deepEqual(app.errors, []);
});

for (const phase of ["pending", "failed"]) {
  test(`mounted App carries ${phase} shared ChatView failure into the current Codex consumer`, async (t) => {
    const app = await mountPreloadingApp(t, { routeId: "unknown-live-session" });
    const failure = new Error("Unable to preload CSS for /assets/ChatView.css");
    if (phase === "failed") { app.resource("ChatView").reject(failure); await settleApp(); }
    app.route.params.sessionId = "history:codex:current-thread"; await settleApp();
    assert.deepEqual(app.loads, ["ChatView", "CodexThreadView"]);
    app.resolveView("CodexThreadView");
    assert.deepEqual(app.calls.map(({ url }) => url), ["/api/auth/session"]);
    app.auth.resolve({ authenticated: true }); await settleApp();
    assert.deepEqual(app.views, []);
    if (phase === "pending") {
      assert.equal(app.reloads, 0);
      app.resource("ChatView").reject(failure); await settleApp();
    }
    assert.equal(app.reloads, 1);
    assert.equal(app.calls.some(({ url }) => url.includes("/api/v2/codex/threads/")), false);
    assert.deepEqual(app.views, []);
    assert.deepEqual(app.errors, []);
  });
}

test("mounted App retains a Codex-first shared CSS failure when navigating into legacy chat", async (t) => {
  const app = await mountPreloadingApp(t);
  app.resolveView("CodexThreadView");
  app.resource("ChatView").reject(new Error("Unable to preload CSS for /assets/ChatView.css")); await settleApp();
  app.route.params.sessionId = "history:claude:legacy-thread"; await settleApp();
  assert.deepEqual(app.calls.map(({ url }) => url), ["/api/auth/session"]);
  app.auth.resolve({ authenticated: true }); await settleApp();
  assert.equal(app.reloads, 1);
  assert.deepEqual(app.views, []);
  assert.equal(app.calls.some(({ url }) => url.includes("/api/v2/codex/threads/")), false);
});

for (const [routeName, view] of [["sessions", "SessionListView"], ["login", "LoginView"]]) {
  test(`mounted App can leave failed shared chat dependencies for unrelated ${routeName} without reload or chat reads`, async (t) => {
    const app = await mountPreloadingApp(t);
    app.resolveView("CodexThreadView");
    app.route.name = routeName; app.route.params = {}; await settleApp();
    app.resolveView(view);
    app.resource("ChatView").reject(new Error("Unable to preload CSS for /assets/ChatView.css")); await settleApp();
    assert.equal(app.reloads, 0);
    assert.deepEqual(app.calls.map(({ url }) => url), ["/api/auth/session"]);
    app.auth.resolve({ authenticated: routeName !== "login" }); await settleApp();
    assert.deepEqual(app.views.map(({ name }) => name), [view]);
    assert.equal(app.reloads, 0);
    assert.deepEqual(app.errors, []);
    assert.equal(app.calls.some(({ url }) => url.includes("/api/v2/codex/threads/")), false);
    assert.equal(app.calls.some(({ options }) => options?.method && options.method !== "GET"), false);
  });
}
