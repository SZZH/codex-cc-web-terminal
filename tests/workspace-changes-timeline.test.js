import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parse, compileScript } from "vue/compiler-sfc";
import { createRenderer, h, nextTick, reactive } from "vue";

const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const panelUrl = moduleUrl(`import { h } from ${JSON.stringify(import.meta.resolve("vue"))};
  export const reads = [];
  export default { props: ["files", "interactive", "cwd", "readOnly"], setup(props) {
    if (props.interactive) reads.push(props.cwd);
    return () => h("aside", { class: "panel", interactive: props.interactive, files: props.files, readOnly: props.readOnly });
  } };`);
const panelApi = await import(panelUrl);
const segmentUrl = moduleUrl("export default { render() { return null; } };");
function compile(file, replacements) {
  const url = new URL(`../web/src/components/thread-item/${file}`, import.meta.url);
  const { descriptor } = parse(fs.readFileSync(url, "utf8"), { filename: url.pathname });
  let source = compileScript(descriptor, { id: file, inlineTemplate: true }).content;
  const imports = { vue: import.meta.resolve("vue"), ...replacements };
  for (const [from, to] of Object.entries(imports)) source = source.replaceAll(`from ${JSON.stringify(from)}`, `from ${JSON.stringify(to)}`);
  return moduleUrl(source);
}
const cardUrl = compile("ThreadTurnCard.vue", {
  "./ThreadTurnSegment.vue": segmentUrl,
  "./WorkspaceChangesPanel.vue": panelUrl,
  "../../lib/activity-time.js": new URL("../web/src/lib/activity-time.js", import.meta.url).href,
  "../../lib/element-visibility.js": new URL("../web/src/lib/element-visibility.js", import.meta.url).href
});
const timeline = (await import(compile("ThreadTurnTimeline.vue", {
  "./ThreadTurnCard.vue": cardUrl,
  "../../lib/thread-view-model.js": new URL("../web/src/lib/thread-view-model.js", import.meta.url).href
}))).default;

function mount(t, turns) {
  const props = reactive({ workspaceCwd: "/repo", snapshot: { turns } });
  const { render } = createRenderer({
    createElement: (type) => ({ type, props: {}, children: [] }),
    createText: (text) => ({ type: "text", text }), createComment: (text) => ({ type: "comment", text }),
    setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: (node) => node.parent, nextSibling: () => null,
    insert(node, parent, anchor = null) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = parent;
      const index = parent.children.indexOf(anchor);
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
    },
    remove: (node) => { node.parent.children = node.parent.children.filter((child) => child !== node); },
    patchProp: (node, key, _previous, value) => { node.props[key] = value; }
  });
  const root = { children: [] };
  render(h({ setup: () => () => h(timeline, props) }), root);
  t.after(() => render(null, root));
  const all = (predicate, node = root) => [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap((child) => all(predicate, child))];
  return { props, panels: () => all((node) => node.type === "aside"),
    statuses: () => all((node) => node.props?.class === "thread-turn-status") };
}

for (const status of ["inProgress", "running", "unknown"]) {
  test(`${status} turns do not mount a file area even with official file changes`, async (t) => {
    panelApi.reads.length = 0;
    const item = { id: "edit", kind: "FileChange", payload: { changes: { "one.js": { unified_diff: "+new" } } } };
    const ui = mount(t, [{ id: "active", status, items: [item] }]);
    await nextTick();
    assert.equal(ui.panels().length, 0);
    assert.equal(panelApi.reads.length, 0);
    ui.props.snapshot = { turns: [{ id: "active", status: "completed", items: [item] }] };
    await nextTick();
    assert.equal(ui.panels().length, 1);
    assert.equal(ui.panels()[0].props.interactive, true);
    assert.equal(panelApi.reads.length, 1);
  });
}

test("a completed turn without file changes never mounts or reads the workspace", async (t) => {
  panelApi.reads.length = 0;
  const ui = mount(t, [{ id: "finished", status: "completed", items: [] }]);
  await nextTick();
  assert.equal(ui.panels().length, 0);
  assert.equal(panelApi.reads.length, 0);
  ui.props.snapshot = { turns: [{ id: "finished", status: "completed", items: [
    { id: "empty-file-event", kind: "FileChange", payload: {} }
  ] }] };
  await nextTick();
  assert.equal(ui.panels().length, 0, "an event with no file paths must not fall back to unrelated Git changes");
  assert.equal(panelApi.reads.length, 0);
});

test("a later reply with no edits cannot inherit an earlier turn's file area", async (t) => {
  panelApi.reads.length = 0;
  const ui = mount(t, [{ id: "edited", status: "completed", items: [{ id: "edit", kind: "FileChange", payload: {
    changes: { "one.js": { unified_diff: "+new" } }
  } }] }]);
  await nextTick();
  assert.equal(ui.panels().length, 1);
  assert.equal(panelApi.reads.length, 1);
  ui.props.snapshot = { turns: [...ui.props.snapshot.turns, { id: "reply-only", status: "completed", items: [
    { id: "answer", kind: "AgentMessage", text: "A reply without any edits." }
  ] }] };
  await nextTick();
  assert.equal(ui.panels().length, 1);
  assert.equal(panelApi.reads.length, 1, "the new reply causes no workspace scan");
  assert.equal(ui.panels()[0].props.files[0].path, "one.js");
  ui.props.snapshot = { turns: [ui.props.snapshot.turns[1]] };
  await nextTick();
  assert.equal(ui.panels().length, 0);
  assert.equal(panelApi.reads.length, 1);
});

for (const status of ["running", "unknown", "unrecognized"]) {
  test(`completed history stays visible without workspace reads or writes while another turn is ${status}`, async (t) => {
    panelApi.reads.length = 0;
    const ui = mount(t, [
      { id: "earlier", status: "completed", items: [{ id: "edit", kind: "FileChange", payload: {
        changes: { "one.js": { unified_diff: "@@ -1 +1 @@\n-old\n+new" } }
      } }] },
      { id: "active", status, items: [] }
    ]);
    await nextTick();
    assert.equal(ui.panels().length, 1);
    assert.equal(ui.panels()[0].props.files[0].path, "one.js");
    assert.equal(ui.panels()[0].props.interactive, false);
    assert.equal(ui.panels().every((node) => node.props.readOnly), true);
    assert.equal(panelApi.reads.length, 0);
  });
}

for (const status of ["completed", "failed", "interrupted", "aborted", "cancelled"]) {
  test(`${status} is terminal for both the file area and footer`, async (t) => {
    const ui = mount(t, [{ id: "finished", status, items: [{ id: "edit", kind: "FileChange", payload: {
      changes: { "one.js": { unified_diff: "+new" } }
    } }] }]);
    await nextTick();
    assert.equal(ui.panels().length, 1);
    assert.equal(ui.statuses()[0].props["data-running"], "false");
    assert.equal(ui.statuses()[0].text, status === "completed" ? "已完成" : status === "failed" ? "失败" : "已中断");
    ui.props.snapshot = { turns: [{ id: "finished", status, items: [] }] };
    await nextTick();
    assert.equal(ui.panels().length, 0);
  });
}
