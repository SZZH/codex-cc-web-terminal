import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { compileScript, parse } from "vue/compiler-sfc";
import { createRenderer, h, nextTick } from "vue";

const apiUrl = `data:text/javascript;base64,${Buffer.from(`
  export const calls = [];
  export const reads = [];
  export const state = { load: null, apply: null };
  const empty = () => ({ files: [], isGitRepo: true, capabilities: { liveChanges: true, applyPatch: true, gitRevert: true } });
  export async function requestWorkspaceChanges(...args) { reads.push(args); return state.load ? state.load(...args) : empty(); }
  export async function applyPatchWorkspaceChanges(...args) { calls.push(args); return state.apply ? state.apply(...args) : empty(); }
  export async function reversePatchWorkspaceChanges(...args) { calls.push(args); return state.apply ? state.apply(...args) : empty(); }
`).toString("base64")}`;
const api = await import(apiUrl);
const previewUrl = `data:text/javascript;base64,${Buffer.from("export const calls = []; export function openLocalPreview(value) { calls.push(value); }").toString("base64")}`;
const preview = await import(previewUrl);
beforeEach(() => { api.calls.length = 0; api.reads.length = 0; api.state.load = null; api.state.apply = null; preview.calls.length = 0; });
const componentUrl = new URL("../web/src/components/thread-item/WorkspaceChangesPanel.vue", import.meta.url);
const { descriptor } = parse(fs.readFileSync(componentUrl, "utf8"), { filename: componentUrl.pathname });
const source = compileScript(descriptor, { id: "workspace-changes-test", inlineTemplate: true }).content
  .replaceAll('from "vue"', `from ${JSON.stringify(import.meta.resolve("vue"))}`)
  .replace('from "../../lib/api.js"', `from ${JSON.stringify(apiUrl)}`)
  .replace('from "../../lib/preview.js"', `from ${JSON.stringify(previewUrl)}`)
  .replace('from "../../lib/workspace-changes-refresh.js"', `from ${JSON.stringify(new URL("../web/src/lib/workspace-changes-refresh.js", import.meta.url).href)}`)
  .replace('from "../../lib/element-visibility.js"', `from ${JSON.stringify(new URL("../web/src/lib/element-visibility.js", import.meta.url).href)}`);
const Component = (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).default;

function mountPanel(t, props) {
  const { render } = createRenderer({
    createElement: (type) => ({ type, props: {}, children: [] }),
    createText: (text) => ({ type: "text", text }),
    createComment: (text) => ({ type: "comment", text }),
    setText: (node, text) => { node.text = text; },
    setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: (node) => node.parent,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    insert(node, parent, anchor = null) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(node);
      else parent.children.splice(index, 0, node);
    },
    remove: (node) => { node.parent.children = node.parent.children.filter((child) => child !== node); },
    patchProp: (node, key, previous, next) => { node.props[key] = next; }
  });
  const root = { children: [] };
  const update = (next = {}) => { props = { ...props, ...next }; render(h(Component, props), root); };
  update();
  let unmounted = false;
  const unmount = () => { if (!unmounted) { render(null, root); unmounted = true; } };
  t.after(unmount);
  const find = (predicate, node = root) => [
    ...(predicate(node) ? [node] : []), ...(node.children || []).flatMap((child) => find(predicate, child))
  ];
  const byClass = (name) => find((node) => String(node.props?.class || "").split(" ").includes(name));
  return { update, byClass, unmount };
}

function trackVisibility(t) {
  const previous = globalThis.IntersectionObserver;
  const observers = [];
  globalThis.IntersectionObserver = class {
    constructor(callback, options) { this.callback = callback; this.options = options; this.disconnected = 0; observers.push(this); }
    observe(element) { this.element = element; }
    disconnect() { this.disconnected += 1; }
    emit(isIntersecting) { this.callback([{ target: this.element, isIntersecting }]); }
  };
  t.after(() => { globalThis.IntersectionObserver = previous; });
  return observers;
}

const fixtureFiles = (count) => Array.from({ length: count }, (_, index) => ({
  path: `src/file-${index + 1}.js`, status: "M", additions: 2, deletions: 1,
  diff: `@@ -1 +1 @@\n-old ${index}\n+new ${index}`
}));

test("file summaries preview three rows while totals include every file, and expand/collapse", async (t) => {
  const panel = mountPanel(t, { files: fixtureFiles(28) });
  assert.equal(panel.byClass("workspace-change-file").length, 3);
  assert.equal(panel.byClass("workspace-changes-summary")[0].children[0].text, "已编辑 28 个文件");
  assert.deepEqual(panel.byClass("workspace-changes-stats")[0].children.map((node) => node.text), ["+56", "-28"]);
  let toggle = panel.byClass("workspace-changes-toggle")[0];
  assert.equal(toggle.children[0].text, "再显示 25 个文件");
  assert.equal(toggle.props["aria-expanded"], false);
  toggle.props.onClick();
  await nextTick();
  assert.equal(panel.byClass("workspace-change-file").length, 28);
  toggle = panel.byClass("workspace-changes-toggle")[0];
  assert.equal(toggle.children[0].text, "收起文件列表");
  assert.equal(toggle.props["aria-expanded"], true);
  toggle.props.onClick();
  await nextTick();
  assert.equal(panel.byClass("workspace-change-file").length, 3);
});

test("three or fewer files have no list toggle", (t) => {
  const panel = mountPanel(t, { files: fixtureFiles(3) });
  assert.equal(panel.byClass("workspace-change-file").length, 3);
  assert.equal(panel.byClass("workspace-changes-toggle").length, 0);
  panel.update({ files: [] });
  assert.equal(panel.byClass("workspace-changes").length, 0);
});

test("live file additions preserve list expansion and workspace changes reset the preview", async (t) => {
  const panel = mountPanel(t, { cwd: "/workspace/a", files: fixtureFiles(4) });
  panel.byClass("workspace-changes-toggle")[0].props.onClick();
  await nextTick();
  panel.update({ files: fixtureFiles(5) });
  await nextTick();
  assert.equal(panel.byClass("workspace-change-file").length, 5);
  panel.update({ cwd: "/workspace/b" });
  await nextTick();
  assert.equal(panel.byClass("workspace-change-file").length, 3);
});

test("individual diffs stay independent of list collapse and revert-all includes hidden files", async (t) => {
  const allFiles = fixtureFiles(5);
  const panel = mountPanel(t, { cwd: "/workspace/a", files: allFiles, interactive: true });
  await nextTick();
  panel.byClass("workspace-change-icon")[0].props.onClick();
  await nextTick();
  assert.equal(panel.byClass("workspace-change-diff").length, 1);
  panel.byClass("workspace-changes-toggle")[0].props.onClick();
  await nextTick();
  panel.byClass("workspace-changes-toggle")[0].props.onClick();
  await nextTick();
  assert.equal(panel.byClass("workspace-change-diff").length, 1);
  api.calls.length = 0;
  panel.byClass("workspace-changes-action")[0].props.onClick();
  await nextTick();
  assert.deepEqual(api.calls[0][1].map((file) => file.path), allFiles.map((file) => file.path));
});

const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); await nextTick(); };
const nonGit = () => ({ files: [], isGitRepo: false, capabilities: { liveChanges: false, applyPatch: true, gitRevert: false } });

test("workspace reads fall back to immediate loading without a visibility observer", async (t) => {
  const previous = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = undefined;
  t.after(() => { globalThis.IntersectionObserver = previous; });
  api.state.load = nonGit;
  const panel = mountPanel(t, { cwd: "/reports", interactive: true, files: fixtureFiles(1) });
  await settle();
  assert.deepEqual(api.reads.map(([cwd]) => cwd), ["/reports"]);
  assert.equal(panel.byClass("workspace-changes-action").length, 1);
});

test("offscreen history stays visible and loads once on the first nearby observation", async (t) => {
  const observers = trackVisibility(t);
  api.state.load = nonGit;
  const panel = mountPanel(t, { cwd: "/reports", interactive: true, files: fixtureFiles(5) });
  await settle();
  assert.equal(observers.length, 1);
  assert.equal(panel.byClass("workspace-change-file").length, 3);
  assert.equal(panel.byClass("workspace-changes-action").length, 0);
  assert.equal(api.reads.length, 0);
  observers[0].emit(false); await settle();
  assert.equal(api.reads.length, 0);
  observers[0].emit(true); await settle();
  assert.deepEqual(api.reads.map(([cwd]) => cwd), ["/reports"]);
  assert.equal(panel.byClass("workspace-changes-action").length, 1);
  observers[0].emit(true); observers[0].emit(false); observers[0].emit(true); await settle();
  assert.equal(api.reads.length, 1);
});

test("an empty live panel retains its observed anchor before loading and after an empty response", async (t) => {
  const observers = trackVisibility(t);
  api.state.load = nonGit;
  const panel = mountPanel(t, { cwd: "/reports", interactive: true, files: [] });
  await settle();
  const anchor = observers[0]?.element;
  assert(anchor, "empty panels need an element that can enter the viewport");
  assert.equal(panel.byClass("workspace-changes").length, 0);
  assert.equal(api.reads.length, 0);
  observers[0].emit(true); await settle();
  assert.equal(api.reads.length, 1);
  assert.equal(panel.byClass("workspace-changes").length, 0);
  assert.equal(observers[0].element, anchor);
});

test("offscreen file and workspace changes wait for visibility and read only the latest identity", async (t) => {
  const observers = trackVisibility(t);
  api.state.load = nonGit;
  const panel = mountPanel(t, { cwd: "/old", interactive: true, files: fixtureFiles(1) });
  panel.update({ cwd: "/new", files: fixtureFiles(2) }); await settle();
  assert.equal(api.reads.length, 0);
  assert.equal(panel.byClass("workspace-change-file").length, 2);
  observers[0].emit(true); await settle();
  assert.deepEqual(api.reads.map(([cwd]) => cwd), ["/new"]);
  observers[0].emit(false);
  panel.update({ files: fixtureFiles(3) }); await settle();
  assert.equal(api.reads.length, 1);
  assert.equal(panel.byClass("workspace-changes-action").length, 0);
  observers[0].emit(true); await settle();
  assert.deepEqual(api.reads.map(([cwd]) => cwd), ["/new", "/new"]);
});

for (const nextProps of [{ cwd: "/new" }, { interactive: false }]) {
  test(`a visibility read cannot publish after identity changes to ${JSON.stringify(nextProps)}`, async (t) => {
    const observers = trackVisibility(t);
    let finish;
    api.state.load = () => new Promise((resolve) => { finish = resolve; });
    const panel = mountPanel(t, { cwd: "/old", interactive: true, files: fixtureFiles(1) });
    observers[0].emit(true); await settle();
    observers[0].emit(true); await settle();
    assert.equal(api.reads.length, 1);
    observers[0].emit(false);
    panel.update(nextProps); await settle();
    finish(nonGit()); await settle();
    assert.equal(api.reads.length, 1);
    assert.equal(panel.byClass("workspace-changes-action").length, 0);
    assert.equal(panel.byClass("workspace-changes-error").length, 0);
    if (nextProps.interactive === false) {
      observers[0].emit(true); await settle();
      assert.equal(api.reads.length, 1);
      panel.update({ interactive: true }); await settle();
      assert.equal(api.reads.length, 2);
    }
  });
}

test("unmount disconnects visibility and ignores queued observer callbacks and reads", async (t) => {
  const observers = trackVisibility(t);
  let finish;
  api.state.load = () => new Promise((resolve) => { finish = resolve; });
  const panel = mountPanel(t, { cwd: "/reports", interactive: true, files: fixtureFiles(1) });
  observers[0].emit(true); await settle();
  panel.unmount();
  assert.equal(observers[0].disconnected, 1);
  finish(nonGit()); observers[0].emit(false); observers[0].emit(true); await settle();
  assert.equal(api.reads.length, 1);
  assert.equal(panel.byClass("workspace-changes").length, 0);
});

test("explicit refresh after an uncertain write reads while offscreen without resending the write", async (t) => {
  const observers = trackVisibility(t);
  api.state.load = nonGit;
  api.state.apply = () => { throw Object.assign(new Error("Uncertain write"), { executionState: "unknown" }); };
  const panel = mountPanel(t, { cwd: "/reports", interactive: true, files: fixtureFiles(1) });
  observers[0].emit(true); await settle();
  panel.byClass("workspace-changes-action")[0].props.onClick(); await settle();
  observers[0].emit(false);
  panel.byClass("workspace-changes-refresh")[0].props.onClick(); await settle();
  assert.equal(api.reads.length, 2);
  assert.equal(api.calls.length, 1);
  assert.equal(panel.byClass("workspace-changes-action").length, 0);
  assert.match(panel.byClass("workspace-changes-error")[0].text, /已刷新工作区/);
  observers[0].emit(true); await settle();
  assert.equal(api.reads.length, 2);
});

test("non-Git history remains visible and filenames open previews independently of diff arrows", async (t) => {
  api.state.load = nonGit;
  const panel = mountPanel(t, { cwd: "/reports", interactive: true,
    files: [{ path: "周报.docx", status: "A", additions: 0, deletions: 0, diff: "" }] });
  await settle();
  assert.equal(panel.byClass("workspace-change-file").length, 1);
  assert.equal(panel.byClass("workspace-changes-error").length, 0);
  assert.equal(panel.byClass("workspace-changes-action").length, 0);
  panel.byClass("workspace-change-main")[0].props.onClick(); await settle();
  assert.deepEqual(preview.calls, [{ target: "周报.docx", cwd: "/reports" }]);
  assert.equal(panel.byClass("workspace-change-diff").length, 0);
  panel.byClass("workspace-change-icon")[0].props.onClick(); await settle();
  assert.equal(panel.byClass("workspace-change-diff").length, 1);
  assert.equal(preview.calls.length, 1);
});

test("complete non-Git text patches can be reversed and restored while retaining history", async (t) => {
  api.state.load = nonGit; api.state.apply = nonGit;
  const allFiles = fixtureFiles(1);
  const panel = mountPanel(t, { cwd: "/reports", interactive: true, files: allFiles });
  assert.equal(panel.byClass("workspace-changes-action").length, 0);
  await settle();
  panel.byClass("workspace-changes-action")[0].props.onClick(); await settle();
  assert.equal(panel.byClass("workspace-change-file").length, 1);
  assert.equal(panel.byClass("workspace-changes-action")[0].text, "恢复");
  panel.byClass("workspace-changes-action")[0].props.onClick(); await settle();
  assert.deepEqual(api.calls.map((args) => args[2] || "reverse"), ["reverse", "forward"]);
  assert.equal(panel.byClass("workspace-changes-action")[0].text, "撤销");
  assert.deepEqual(api.calls[0][1], allFiles);
});

test("binary, truncated, incomplete and unsafe history diffs never offer patch actions", async (t) => {
  api.state.load = nonGit;
  const base = fixtureFiles(1)[0];
  const panel = mountPanel(t, { cwd: "/reports", interactive: true, files: [] });
  for (const file of [
    { ...base, diff: "Binary files a/file and b/file differ" },
    { ...base, truncated: true },
    { ...base, diff: "@@ -1,2 +1,2 @@\n-before\n+after" },
    { ...base, path: "../outside.txt" },
    { ...base, path: "/outside.txt" }
  ]) {
    panel.update({ files: [file] }); await settle();
    assert.equal(panel.byClass("workspace-change-file").length, 1);
    assert.equal(panel.byClass("workspace-changes-action").length, 0);
  }
  assert.equal(api.calls.length, 0);
});

test("real workspace and patch errors remain visible without deleting official history", async (t) => {
  api.state.load = async () => { throw new Error("EACCES: workspace is not readable"); };
  const panel = mountPanel(t, { cwd: "/blocked", interactive: true, files: fixtureFiles(1) });
  await settle();
  assert.equal(panel.byClass("workspace-change-file").length, 1);
  assert.match(panel.byClass("workspace-changes-error")[0].text, /EACCES/);
  assert.equal(panel.byClass("workspace-changes-action").length, 0);
  api.state.load = nonGit;
  api.state.apply = async () => { throw new Error("Patch context does not match current file content"); };
  panel.update({ cwd: "/reports" }); await settle();
  panel.byClass("workspace-changes-action")[0].props.onClick(); await settle();
  assert.match(panel.byClass("workspace-changes-error")[0].text, /Patch context/);
  assert.equal(panel.byClass("workspace-change-file").length, 1);
  assert.equal(panel.byClass("workspace-changes-action")[0].text, "撤销");
});

test("a late capability response cannot enable patch actions for a different workspace", async (t) => {
  let resolveOld;
  api.state.load = (cwd) => cwd === "/old" ? new Promise((resolve) => { resolveOld = resolve; })
    : Promise.reject(new Error("Workspace unavailable"));
  const panel = mountPanel(t, { cwd: "/old", interactive: true, files: fixtureFiles(1) });
  panel.update({ cwd: "/new" }); await settle();
  resolveOld(nonGit()); await settle();
  assert.equal(panel.byClass("workspace-changes-action").length, 0);
  assert.match(panel.byClass("workspace-changes-error")[0].text, /Workspace unavailable/);
});

for (const executionState of ["applied", "unknown"]) {
  test(`patch ${executionState} errors only offer a read refresh and never resend the write`, async (t) => {
    let reads = 0;
    api.state.load = async () => { reads += 1; return nonGit(); };
    api.state.apply = async () => { throw Object.assign(new Error("status refresh fixture"), { executionState }); };
    const panel = mountPanel(t, { cwd: "/reports", interactive: true, files: fixtureFiles(1) });
    await settle();
    panel.byClass("workspace-changes-action")[0].props.onClick();
    await settle();
    assert.equal(api.calls.length, 1);
    assert.equal(panel.byClass("workspace-changes-action").length, 0);
    assert.match(panel.byClass("workspace-changes-error")[0].text, executionState === "applied" ? /操作已完成/ : /执行状态待确认/);
    panel.byClass("workspace-changes-refresh")[0].props.onClick();
    await settle();
    assert.equal(reads, 2);
    assert.equal(api.calls.length, 1);
    if (executionState === "applied") assert.equal(panel.byClass("workspace-changes-action")[0].text, "恢复");
    else assert.equal(panel.byClass("workspace-changes-action").length, 0);
    assert.equal(panel.byClass("workspace-change-file").length, 1);
  });
}

for (const executionState of ["success", "unknown"]) {
  test(`same-workspace appended files settle a pending ${executionState} write without trusting an earlier read`, async (t) => {
    let finishWrite, finishRead;
    let reads = 0;
    api.state.load = () => ++reads === 1 ? nonGit() : new Promise((resolve) => { finishRead = resolve; });
    api.state.apply = () => new Promise((resolve, reject) => { finishWrite = executionState === "success" ? resolve : () => reject(Object.assign(new Error("write uncertain"), { executionState: "unknown" })); });
    const panel = mountPanel(t, { cwd: "/reports", interactive: true, files: fixtureFiles(1) });
    await settle();
    panel.byClass("workspace-changes-action")[0].props.onClick();
    panel.update({ files: fixtureFiles(2) });
    await settle();
    assert.equal(api.calls.length, 1);
    finishWrite(nonGit());
    await settle();
    finishRead(nonGit());
    await settle();
    if (executionState === "success") {
      assert.equal(panel.byClass("workspace-changes-action")[0].props.disabled, false);
      api.state.apply = nonGit;
      panel.byClass("workspace-changes-action")[0].props.onClick();
      await settle();
      assert.deepEqual(api.calls[1][1].map((file) => file.path), ["src/file-2.js"]);
      assert.equal(panel.byClass("workspace-changes-action")[0].text, "恢复");
    } else {
      assert.equal(panel.byClass("workspace-changes-action").length, 0);
      assert.match(panel.byClass("workspace-changes-error")[0].text, /执行状态待确认/);
      assert.equal(api.calls.length, 1);
      assert.equal(panel.byClass("workspace-changes-refresh")[0].props.disabled, false);
    }
  });
}

test("live files use their canonical cwd for both preview and patch while history keeps caller cwd", async (t) => {
  const files = fixtureFiles(1);
  api.state.load = () => ({ ...nonGit(), cwd: "/repo", files });
  const live = mountPanel(t, { cwd: "/repo/sub", interactive: true, files: [] });
  await settle();
  live.byClass("workspace-change-main")[0].props.onClick();
  live.byClass("workspace-changes-action")[0].props.onClick();
  await settle();
  assert.equal(preview.calls[0].cwd, "/repo");
  assert.equal(api.calls[0][0], "/repo");
  const historical = mountPanel(t, { cwd: "/repo/sub", interactive: true, files });
  await settle();
  historical.byClass("workspace-change-main")[0].props.onClick();
  historical.byClass("workspace-changes-action")[0].props.onClick();
  await settle();
  assert.equal(preview.calls[1].cwd, "/repo/sub");
  assert.equal(api.calls[1][0], "/repo/sub");
});

test("history selection keeps trailing spaces in the selected filename", async (t) => {
  api.state.load = nonGit;
  const file = { ...fixtureFiles(1)[0], path: "sample.txt " };
  const panel = mountPanel(t, { cwd: "/reports", interactive: true, files: [file] });
  await settle();
  panel.byClass("workspace-changes-action")[0].props.onClick();
  await settle();
  assert.deepEqual(api.calls[0][1].map((entry) => entry.path), ["sample.txt "]);
});

test("completed workspace files use a summary and load only an expanded path", async (t) => {
  const observers = trackVisibility(t);
  const summary = { ...fixtureFiles(1)[0], diff: "", additions: null, deletions: null, statsKnown: false, detailsLoaded: false };
  api.state.load = (_cwd, options) => ({ ...nonGit(), cwd: "/repo", files: options?.summary ? [summary] : fixtureFiles(1) });
  const panel = mountPanel(t, { cwd: "/repo", interactive: true, files: [] });
  assert.equal(api.reads.length, 0);
  observers[0].emit(true); await settle();
  assert.equal(api.reads.length, 1);
  assert.equal(api.reads[0][1].summary, true);
  assert.match(panel.byClass("workspace-changes-summary")[0].children[0].text, /工作区变更/);
  assert.equal(panel.byClass("workspace-change-stat").length, 0, "unknown counts are not rendered as zero");
  assert.equal(panel.byClass("workspace-changes-action").length, 0);
  panel.byClass("workspace-change-icon")[0].props.onClick(); await settle();
  assert.equal(api.reads.length, 2);
  assert.deepEqual(api.reads[1][1].paths, [summary.path]);
  assert.equal(panel.byClass("workspace-change-code").length, 1);
  assert.equal(panel.byClass("workspace-changes-action").length, 1, "an explicitly loaded complete patch retains the ordinary safety contract");
});

test("completed official edits display immediately and read one summary without polling", async (t) => {
  const observers = trackVisibility(t);
  api.state.load = nonGit;
  const panel = mountPanel(t, { cwd: "/repo", interactive: true, files: fixtureFiles(1) });
  assert.match(panel.byClass("workspace-changes-summary")[0].children[0].text, /已编辑 1/);
  assert.equal(panel.byClass("workspace-change-file").length, 1);
  observers[0].emit(true); await settle();
  observers[0].emit(false); observers[0].emit(true); await settle();
  assert.equal(api.reads.length, 1);
  assert.equal(api.reads.every((args) => args[1]?.summary === true), true);
  assert.equal(panel.byClass("workspace-changes-action").length, 1);
});

test("a late expanded fallback diff cannot appear in another workspace", async (t) => {
  const observers = trackVisibility(t);
  let finishDetail;
  api.state.load = (_cwd, options) => options?.paths
    ? new Promise((resolve) => { finishDetail = resolve; })
    : { ...nonGit(), files: [{ ...fixtureFiles(1)[0], diff: "", detailsLoaded: false }] };
  const panel = mountPanel(t, { cwd: "/old", interactive: true, files: [] });
  observers[0].emit(true); await settle();
  panel.byClass("workspace-change-icon")[0].props.onClick(); await settle();
  const detailSignal = api.reads[1][1].signal;
  panel.update({ cwd: "/new" }); await settle();
  assert.equal(detailSignal.aborted, true);
  finishDetail({ ...nonGit(), files: fixtureFiles(1) }); await settle();
  assert.equal(panel.byClass("workspace-change-code").length, 0);
});

test("historical patches remain read-only while a different turn is changing the workspace", async (t) => {
  api.state.load = nonGit;
  const panel = mountPanel(t, { cwd: "/repo", interactive: true, readOnly: true, files: fixtureFiles(1) });
  await settle();
  assert.equal(panel.byClass("workspace-changes-action").length, 0);
  panel.update({ readOnly: false }); await settle();
  assert.equal(panel.byClass("workspace-changes-action").length, 1);
});

for (const suspension of ["offscreen", "hidden"]) {
  test(`an expanded unfinished file detail resumes after ${suspension} without rereading its summary`, async (t) => {
    const previousDocument = globalThis.document;
    const visibility = new EventTarget();
    visibility.hidden = false;
    globalThis.document = visibility;
    t.after(() => { globalThis.document = previousDocument; });
    const observers = trackVisibility(t);
    const pending = [];
    api.state.load = (_cwd, options) => options?.paths
      ? new Promise((resolve) => pending.push(resolve))
      : { ...nonGit(), files: [{ ...fixtureFiles(1)[0], diff: "", detailsLoaded: false }] };
    const panel = mountPanel(t, { cwd: "/repo", interactive: true, files: [] });
    observers[0].emit(true); await settle();
    panel.byClass("workspace-change-icon")[0].props.onClick(); await settle();
    assert.equal(api.reads.length, 2);
    const originalSignal = api.reads[1][1].signal;
    if (suspension === "offscreen") observers[0].emit(false);
    else { visibility.hidden = true; visibility.dispatchEvent(new Event("visibilitychange")); }
    await settle();
    assert.equal(originalSignal.aborted, true);
    if (suspension === "offscreen") observers[0].emit(true);
    else { visibility.hidden = false; visibility.dispatchEvent(new Event("visibilitychange")); }
    await settle();
    assert.equal(api.reads.length, 3);
    assert.equal(api.reads.filter(([, options]) => options.summary).length, 1);
    assert.deepEqual(api.reads[2][1].paths, ["src/file-1.js"]);
    assert.match(panel.byClass("workspace-change-empty")[0].text, /正在读取/);
    pending[0]({ ...nonGit(), files: [{ ...fixtureFiles(1)[0], diff: "obsolete diff" }] }); await settle();
    assert.equal(panel.byClass("workspace-change-code").length, 0);
    pending[1]({ ...nonGit(), files: fixtureFiles(1) }); await settle();
    assert.equal(panel.byClass("workspace-change-code").length, 1);
    if (suspension === "offscreen") { observers[0].emit(false); observers[0].emit(true); }
    else { visibility.hidden = true; visibility.dispatchEvent(new Event("visibilitychange")); visibility.hidden = false; visibility.dispatchEvent(new Event("visibilitychange")); }
    await settle();
    assert.equal(api.reads.length, 3, "a completed detail is not fetched again");
  });
}
