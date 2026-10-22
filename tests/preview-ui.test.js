import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { compileScript, parse } from "vue/compiler-sfc";
import { createRenderer, defineComponent, h, nextTick, ref } from "vue";
import { createPreviewController } from "../web/src/lib/preview.js";

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flush() { for (let index = 0; index < 15; index += 1) await Promise.resolve(); await nextTick(); }
const preview = (url = "https://phone-access.example:8444/preview/file") => ({ id: "file", title: "报告.pdf", kind: "file", url, expiresAt: "2030-01-01T00:00:00Z" });

test("preview creates an authenticated request and preserves the returned device-accessible URL", async () => {
  const calls = [];
  const controller = createPreviewController({ request: async (url, options) => { calls.push({ url, ...options }); return preview(); },
    window: { location: { origin: "https://phone-access.example" } } });
  await controller.open({ target: "docs/季度 report.pdf", cwd: "/work/项目" });
  assert.equal(calls[0].url, "/api/previews");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(JSON.parse(calls[0].body), { target: "docs/季度 report.pdf", cwd: "/work/项目" });
  assert.equal(controller.state.url, preview().url);
  assert.equal(controller.state.status, "frame-loading");
  controller.frameLoaded(controller.state.revision);
  assert.equal(controller.state.status, "ready");
  controller.close();
});

test("stale preview replies cannot replace the latest file or reopen a closed preview", async () => {
  const first = deferred(), second = deferred(); let count = 0;
  const controller = createPreviewController({ request: () => (++count === 1 ? first.promise : second.promise) });
  const a = controller.open({ target: "/tmp/a.pdf" });
  const oldRevision = controller.state.revision;
  const b = controller.open({ target: "/tmp/b.pdf" });
  second.resolve({ ...preview(), title: "B.pdf" }); await b;
  first.resolve({ ...preview(), title: "A.pdf" }); await a;
  assert.equal(controller.state.title, "B.pdf");
  controller.frameLoaded(oldRevision);
  assert.equal(controller.state.status, "frame-loading");
  const revision = controller.state.revision;
  controller.close(); controller.frameLoaded(revision);
  assert.equal(controller.state.open, false);
  assert.equal(controller.state.status, "idle");
});

test("an older preview timeout cannot abort a newer preview request", async () => {
  const pending = [], timers = new Map(); let timerId = 0;
  const controller = createPreviewController({ request: (_, options) => { const task = deferred(); pending.push({ ...task, signal: options.signal }); return task.promise; },
    setTimer: (callback) => { timers.set(++timerId, callback); return timerId; }, clearTimer: (id) => timers.delete(id) });
  const first = controller.open({ target: "/tmp/first.pdf" });
  const firstTimeout = timers.get(1);
  const second = controller.open({ target: "/tmp/second.pdf" });
  firstTimeout(); await first;
  assert.equal(pending[1].signal.aborted, false);
  pending[1].resolve(preview()); await second;
  assert.equal(controller.state.status, "frame-loading");
  controller.close();
});

test("API errors are readable and retry repeats the same target without changing to a local hostname", async () => {
  let failed = true; const inputs = [];
  const controller = createPreviewController({ request: async (_, options) => {
    if (options.method === "DELETE") return { ok: true };
    inputs.push(JSON.parse(options.body));
    if (failed) throw Object.assign(new Error("文件不存在或没有读取权限"), { status: 404 });
    return preview("https://phone-access.example:8446/service/app");
  } });
  await controller.open({ target: "http://localhost:5173/app", cwd: "/work" });
  assert.equal(controller.state.status, "error");
  assert.equal(controller.state.error, "文件不存在或没有读取权限");
  failed = false; await controller.retry();
  assert.equal(inputs[0].target, inputs[1].target);
  assert.equal(inputs[0].cwd, inputs[1].cwd);
  assert.notEqual(inputs[0].requestId, inputs[1].requestId);
  assert.equal(controller.state.url, "https://phone-access.example:8446/service/app");
  controller.close();
});

test("closing an in-flight service preview cancels its known request before the response", async () => {
  const reply = deferred(), calls = [];
  const requestId = "a".repeat(32);
  const controller = createPreviewController({ requestId: () => requestId, request: async (url, options) => {
    calls.push({ url, ...options });
    if (options.method === "DELETE") return { ok: true };
    return reply.promise;
  } });
  const opening = controller.open({ target: "http://localhost:5173" });
  assert.equal(JSON.parse(calls[0].body).requestId, requestId);
  controller.close(); await flush();
  assert.equal(calls[1].url, `/api/previews/${requestId}`);
  assert.equal(calls[1].method, "DELETE");
  reply.resolve({ ...preview(), kind: "service", id: requestId }); await opening;
  assert.equal(controller.state.open, false);
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
});

test("opening a separate window creates its own authenticated preview instead of reusing the panel grant", async () => {
  const controller = createPreviewController({ request: async () => ({ ...preview(), kind: "service" }) });
  await controller.open({ target: "http://localhost:5173/demo", cwd: "/work" });
  const href = new URL(controller.externalHref(), "https://chat.example");
  assert.equal(href.pathname, "/api/previews/open");
  assert.equal(href.searchParams.get("target"), "http://localhost:5173/demo");
  assert.notEqual(href.href, controller.state.url);
  controller.close(); await flush();
});

test("closing restores focus and scroll without resetting the underlying chat", async () => {
  const focusCalls = [], scrollCalls = [], scroller = { scrollTop: 415, scrollLeft: 3, isConnected: true };
  const control = { isConnected: true, focus: (options) => focusCalls.push(options) };
  const controller = createPreviewController({ request: async () => preview(), document: { activeElement: control, querySelectorAll: () => [scroller] },
    window: { scrollX: 0, scrollY: 7, scrollTo: (...args) => scrollCalls.push(args), requestAnimationFrame: (callback) => callback() } });
  await controller.open({ target: "/tmp/a.pdf" });
  scroller.scrollTop = 0; scroller.scrollLeft = 0;
  controller.close();
  assert.equal(scroller.scrollTop, 415); assert.equal(scroller.scrollLeft, 3);
  assert.deepEqual(focusCalls, [{ preventScroll: true }]);
  assert.deepEqual(scrollCalls, [[0, 7]]);
});

test("preview captures only marked app scrollers, including the list, and skips detached old elements", async () => {
  const list = { scrollTop: 1460, scrollLeft: 0, isConnected: true };
  const chat = { scrollTop: 415, scrollLeft: 3, isConnected: true };
  const unrelated = { scrollTop: 88, scrollLeft: 0, isConnected: true };
  const queries = [], frames = new Map(); let sequence = 0;
  const controller = createPreviewController({ request: async () => preview(),
    document: { querySelectorAll(selector) { queries.push(selector); return selector === "[data-app-scroll]" ? [list, chat] : []; } },
    window: { requestAnimationFrame(callback) { frames.set(++sequence, callback); return sequence; }, cancelAnimationFrame(id) { frames.delete(id); } }
  });
  try {
    await controller.open({ target: "/workspace/report.pdf" });
    list.scrollTop = 0; chat.scrollTop = 0; unrelated.scrollTop = 0; chat.isConnected = false;
    controller.close();
    const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback();
    assert.deepEqual(queries, ["[data-app-scroll]"]);
    assert.equal(list.scrollTop, 1460); assert.equal(chat.scrollTop, 0); assert.equal(unrelated.scrollTop, 0);
  } finally { controller.invalidatePosition(); controller.close(); }
  assert.equal(frames.size, 0);
});

function positionPreview(request = async () => preview()) {
  const focusCalls = [], scrollCalls = [], frames = new Map(), scheduled = [];
  const scroller = { scrollTop: 415, scrollLeft: 3, isConnected: true };
  const control = { isConnected: true, focus: (options) => focusCalls.push(options) };
  let frameId = 0;
  const window = { scrollX: 0, scrollY: 7, scrollTo: (...args) => scrollCalls.push(args),
    requestAnimationFrame(callback) { frames.set(++frameId, callback); scheduled.push(callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); }
  };
  const document = { activeElement: control, querySelectorAll: () => [scroller] };
  const controller = createPreviewController({ request, window, document });
  return { controller, window, document, scroller, focusCalls, scrollCalls, frames, scheduled,
    flushFrames() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); } };
}

test("an escaped older close callback cannot override a newly opened and closed preview", async () => {
  const host = positionPreview();
  await host.controller.open({ target: "/tmp/a.pdf" }); host.controller.close();
  const older = host.scheduled.at(-1);
  host.window.scrollY = 700;
  await host.controller.open({ target: "/tmp/b.pdf" }); host.controller.close();
  host.flushFrames(); older();
  assert.deepEqual(host.scrollCalls, [[0, 700]]);
  assert.equal(host.focusCalls.length, 1);
  assert.equal(host.frames.size, 0);
});

test("position invalidation cancels an already queued close without scrolling or focusing its old page", async () => {
  const host = positionPreview();
  await host.controller.open({ target: "/tmp/a.pdf" }); host.controller.close();
  const escaped = host.scheduled.at(-1);
  host.scroller.scrollTop = 0; host.scroller.scrollLeft = 0;
  host.controller.invalidatePosition();
  assert.equal(host.frames.size, 0);
  host.flushFrames(); escaped();
  assert.equal(host.scroller.scrollTop, 0); assert.equal(host.scroller.scrollLeft, 0);
  assert.deepEqual(host.scrollCalls, []); assert.deepEqual(host.focusCalls, []);
});

test("position invalidation also guards an uncancellable microtask close", async () => {
  const host = positionPreview(); delete host.window.requestAnimationFrame;
  await host.controller.open({ target: "/tmp/a.pdf" });
  host.scroller.scrollTop = 0;
  host.controller.close(); host.controller.invalidatePosition(); await flush();
  assert.equal(host.scroller.scrollTop, 0);
  assert.deepEqual(host.scrollCalls, []); assert.deepEqual(host.focusCalls, []);
});

test("invalidating a pending service bookmark retains the panel, request, ACK and grant lifecycle", async () => {
  const reply = deferred(), calls = [];
  const host = positionPreview(async (url, options) => {
    calls.push({ url, ...options });
    return options.method === "DELETE" ? { ok: true } : reply.promise;
  });
  const opening = host.controller.open({ target: "http://localhost:5173" });
  const revision = host.controller.state.revision, requestId = JSON.parse(calls[0].body).requestId;
  host.controller.invalidatePosition();
  assert.equal(calls.length, 1); assert.equal(calls[0].signal.aborted, false);
  assert.equal(host.controller.state.open, true); assert.equal(host.controller.state.status, "loading");
  assert.equal(host.controller.state.id, requestId); assert.equal(host.controller.state.revision, revision);
  reply.resolve({ ...preview(), id: requestId, kind: "service" });
  assert.equal((await opening).id, requestId);
  assert.equal(host.controller.state.open, true); assert.equal(host.controller.state.status, "frame-loading");
  assert.equal(host.controller.state.url, preview().url); assert.equal(calls.length, 1);
  host.controller.frameLoaded(revision); assert.equal(host.controller.state.status, "ready");
  host.controller.close(); await flush(); host.flushFrames();
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
  assert.equal(calls.at(-1).url, `/api/previews/${requestId}`);
  assert.deepEqual(host.scrollCalls, []); assert.deepEqual(host.focusCalls, []);
});

test("a new document opened after invalidation owns the new page scroll and focus", async () => {
  const host = positionPreview(), newFocus = [];
  await host.controller.open({ target: "/tmp/old.pdf" });
  host.controller.invalidatePosition();
  assert.equal(host.controller.state.open, true);
  host.window.scrollY = 700;
  const newScroller = { scrollTop: 900, scrollLeft: 12, isConnected: true };
  host.document.activeElement = { isConnected: true, focus: (options) => newFocus.push(options) };
  host.document.querySelectorAll = () => [newScroller];
  await host.controller.open({ target: "/tmp/new.pdf" });
  host.scroller.scrollTop = 0; newScroller.scrollTop = 0; newScroller.scrollLeft = 0;
  host.controller.close(); host.flushFrames();
  assert.deepEqual(host.scrollCalls, [[0, 700]]);
  assert.equal(host.scroller.scrollTop, 0);
  assert.equal(newScroller.scrollTop, 900); assert.equal(newScroller.scrollLeft, 12);
  assert.deepEqual(host.focusCalls, []); assert.deepEqual(newFocus, [{ preventScroll: true }]);
});

test("same-page target changes and retry preserve their original opener bookmark", async () => {
  let count = 0;
  const host = positionPreview(async () => { if (++count === 2) throw new Error("fixture unavailable"); return preview(); });
  const laterFocus = [];
  await host.controller.open({ target: "/tmp/a.pdf" });
  host.window.scrollY = 700;
  host.document.activeElement = { isConnected: true, focus: (options) => laterFocus.push(options) };
  await host.controller.open({ target: "/tmp/b.pdf" });
  assert.equal(host.controller.state.status, "error");
  await host.controller.retry();
  host.controller.close(); host.flushFrames();
  assert.deepEqual(host.scrollCalls, [[0, 7]]);
  assert.deepEqual(host.focusCalls, [{ preventScroll: true }]); assert.deepEqual(laterFocus, []);
});

for (const status of ["loading", "error"]) {
  test(`same-page close during ${status} still restores scroll and focus`, async () => {
    const reply = deferred();
    const host = positionPreview(() => status === "error" ? Promise.reject(new Error("fixture unavailable")) : reply.promise);
    const opening = host.controller.open({ target: "/tmp/a.pdf" });
    if (status === "error") await opening;
    assert.equal(host.controller.state.status, status);
    host.scroller.scrollTop = 0; host.scroller.scrollLeft = 0;
    host.controller.close(); host.flushFrames();
    assert.equal(host.scroller.scrollTop, 415); assert.equal(host.scroller.scrollLeft, 3);
    assert.deepEqual(host.scrollCalls, [[0, 7]]); assert.deepEqual(host.focusCalls, [{ preventScroll: true }]);
    reply.resolve(preview()); await opening;
  });
}

test("unsafe or same-origin viewer responses are rejected instead of embedded", async () => {
  for (const url of ["javascript:alert(1)", "https://app.example/preview"]) {
    const controller = createPreviewController({ request: async () => preview(url), window: { location: { origin: "https://app.example" } } });
    await controller.open({ target: "/tmp/a.pdf" });
    assert.equal(controller.state.status, "error"); assert.equal(controller.state.url, "");
    controller.close();
  }
});

function elements(root, match) { return [...(match(root) ? [root] : []), ...(root.children || []).flatMap((node) => elements(node, match))]; }
function renderer() {
  return createRenderer({
    createElement: (type) => ({ type, props: {}, children: [], focus() {} }), createText: (text) => ({ text }), createComment: (text) => ({ text }),
    setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: (node) => node?.parent, nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    insert: (node, parent, anchor) => { if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node); node.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node); },
    remove: (node) => { if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node); },
    patchProp: (node, key, before, after) => { node.props[key] = after; }
  });
}
async function previewHost() {
  const file = new URL("../web/src/components/preview/PreviewHost.vue", import.meta.url);
  const { descriptor } = parse(fs.readFileSync(file, "utf8"), { filename: file.pathname });
  const compiled = compileScript(descriptor, { id: "preview-host-test", inlineTemplate: true }).content.replace(/from\s+["']([^"']+)["']/g,
    (_, name) => `from ${JSON.stringify(name === "vue" ? import.meta.resolve("vue") : new URL(name, file).href)}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`)).default;
}

test("mounted preview retains a live chat and draft through loading, iframe, Escape and retry", async () => {
  const originalWindow = globalThis.window;
  const listeners = new Map();
  globalThis.window = { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: (name) => listeners.delete(name) };
  const controller = createPreviewController({ request: async () => preview() });
  const Host = await previewHost();
  let chatMounts = 0; const draft = ref("unsent draft");
  const Chat = defineComponent({ setup() { chatMounts += 1; return () => h("textarea", { value: draft.value }); } });
  const Shell = defineComponent({ setup() { return () => h("div", [h(Chat), h(Host, { controller })]); } });
  const { render } = renderer(), root = { children: [] };
  try {
    render(h(Shell), root); await flush();
    await controller.open({ target: "/tmp/report.pdf" }); await flush();
    const dialog = elements(root, (node) => node.props?.role === "dialog")[0];
    assert.equal(dialog.props["aria-modal"], true);
    const frame = elements(root, (node) => node.type === "iframe")[0];
    assert.equal(frame.props.src, preview().url);
    assert.equal(elements(root, (node) => node.type === "a")[0].props.target, "_blank");
    frame.props.onLoad({ currentTarget: { dataset: { previewRevision: controller.state.revision } } });
    await flush(); assert.equal(controller.state.status, "ready");
    listeners.get("keydown")({ key: "Escape", preventDefault() {} }); await flush();
    assert.equal(elements(root, (node) => node.props?.role === "dialog").length, 0);
    assert.equal(chatMounts, 1); assert.equal(draft.value, "unsent draft");
    await controller.open({ target: "/tmp/report.pdf" }); controller.frameFailed(controller.state.revision); await flush();
    const retry = elements(root, (node) => node.type === "button" && node.text === "重试")[0];
    assert.ok(retry); await retry.props.onClick(); await flush();
    assert.equal(controller.state.status, "frame-loading");
    assert.equal(chatMounts, 1);
  } finally { render(null, root); globalThis.window = originalWindow; }
});

test('service preview release completes before reusing its slot, without double deletion',async()=>{
  const deletion=deferred();const calls=[];
  const controller=createPreviewController({request:async(url,options)=>{calls.push({url,...options});if(options.method==='DELETE')return deletion.promise;return {...preview(),id:'service-id',kind:'service'};}});
  await controller.open({target:'http://localhost:5173'});controller.close();
  const reopening=controller.open({target:'http://localhost:5173'});await flush();
  assert.equal(calls.filter(c=>c.method==='POST').length,1);
  assert.equal(calls.filter(c=>c.method==='DELETE').length,1);
  deletion.resolve({ok:true});await reopening;
  assert.equal(calls.filter(c=>c.method==='POST').length,2);
  controller.close();await flush();
});

test('a pending service release has a bounded wait and does not allocate an unsafe reused slot',async()=>{
  const deletion=deferred(),timers=new Map();let seq=0;const calls=[];
  const controller=createPreviewController({request:async(url,options)=>{calls.push({url,...options});if(options.method==='DELETE')return deletion.promise;return {...preview(),id:'service-id',kind:'service'};},setTimer:fn=>{timers.set(++seq,fn);return seq;},clearTimer:id=>timers.delete(id)});
  await controller.open({target:'http://localhost:5173'});controller.close();
  const reopening=controller.open({target:'http://localhost:5173'});await flush();
  [...timers.values()].at(-1)();await reopening;
  assert.equal(controller.state.status,'error');assert.match(controller.state.error,/尚未关闭/);
  assert.equal(calls.filter(c=>c.method==='POST').length,1);deletion.resolve({ok:true});controller.close();
});
