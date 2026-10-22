import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { compileScript, parse } from "vue/compiler-sfc";
import { createRenderer, h, nextTick } from "vue";

function compile(file) {
  const { descriptor } = parse(fs.readFileSync(file, "utf8"), { filename: file.pathname });
  const source = compileScript(descriptor, { id: file.pathname, inlineTemplate: true }).content
    .replace(/from\s+["']([^"']+)["']/g, (_, name) => `from ${JSON.stringify(name.endsWith(".vue")
      ? compile(new URL(name, file)) : name.startsWith(".") ? new URL(name, file).href : import.meta.resolve(name))}`);
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}
const Component = (await import(compile(new URL("../web/src/components/composer/CodexQueuedMessages.vue", import.meta.url)))).default;
const find = (root, predicate) => [...(predicate(root) ? [root] : []), ...(root.children || []).flatMap((child) => find(child, predicate))];
const text = (root) => [root.text || "", ...(root.children || []).map(text)].join(" ");
function mount(messages, extra = {}) {
  const root = { children: [] }, events = [];
  const renderer = createRenderer({
    createElement: (type) => ({ type, props: {}, children: [] }), createText: (text) => ({ text }), createComment: () => ({}),
    setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: (node) => node.parent, nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    insert(node, parent, anchor) {
      if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node);
      node.parent = parent; const index = parent.children.indexOf(anchor);
      if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node);
    },
    remove(node) { if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node); },
    patchProp: (node, key, previous, value) => { node.props[key] = value; }
  });
  const render = (messages, extra = {}) => renderer.render(h(Component, { messages, ...extra,
    onCancel: (id) => events.push(["cancel", id]), onGuide: (id) => events.push(["guide", id]),
    onRestore: (id) => events.push(["restore", id]), onCheck: (id) => events.push(["check", id]) }), root);
  render(messages, extra);
  return { root, events, render, close: () => renderer.render(null, root) };
}
const message = (state) => ({ id: "queue", text: "A pending message", images: [], state,
  request: { id: "queue", state, mode: "queue", input: { text: "A pending message" } } });
const button = (root, prefix) => find(root, (node) => node.type === "button" && node.props["aria-label"]?.startsWith(prefix))[0];

test("one queue row survives submitting, dispatching and confirmed waiting without duplicate status panels", async () => {
  const harness = mount([message("sending")], { canGuide: true });
  try {
    const row = find(harness.root, (node) => node.type === "li")[0];
    for (const state of ["sending", "dispatching", "received", "queued"]) {
      harness.render([message(state)], { canGuide: true }); await nextTick();
      assert.equal(find(harness.root, (node) => node.type === "li")[0], row);
      assert.equal(Boolean(button(harness.root, "引导排队")), ["received", "queued"].includes(state));
      assert.equal(Boolean(button(harness.root, "撤回排队")), state === "queued");
      assert.equal(find(harness.root, (node) => node.props?.["aria-label"] === "消息提交状态").length, 0);
      assert.doesNotMatch(text(harness.root), /已中断|已撤回|等待执行/);
    }
    button(harness.root, "撤回排队").props.onClick();
    assert.deepEqual(harness.events, [["cancel", "queue"]]);
    harness.render([message("queued")], { actions: { "cancel:queue": true } }); await nextTick();
    assert.equal(button(harness.root, "撤回排队").props.disabled, true);
    harness.render([]); await nextTick();
    assert.equal(find(harness.root, (node) => node.type === "li").length, 0);
  } finally { harness.close(); }
});

test("guide and delete coexist; desktop-owned queue explains its limit without sending or deleting", async () => {
  const harness = mount([message("queued")], { canGuide: false, runningTask: true });
  try {
    const guide = button(harness.root, "引导排队");
    assert.equal(guide.props.disabled, true);
    assert.match(guide.props.title, /Codex 桌面端/);
    assert.ok(button(harness.root, "撤回排队"));
    guide.props.onClick();
    assert.deepEqual(harness.events, []);
    harness.render([message("received")], { canGuide: true, runningTask: true }); await nextTick();
    assert.equal(button(harness.root, "引导排队").props.disabled, false);
    button(harness.root, "引导排队").props.onClick();
    assert.deepEqual(harness.events, [["guide", "queue"]]);
  } finally { harness.close(); }
});

test("a compact preview can reveal full text and all images without submitting the message", async () => {
  const entry = { ...message("queued"), text: "A long message\n".repeat(30),
    images: [{ url: "/api/attachments/images/one" }, { url: "/api/attachments/images/two" }] };
  const harness = mount([entry]);
  try {
    assert.equal(find(harness.root, (node) => node.type === "img").length, 1);
    const preview = button(harness.root, "查看待发送"); preview.props.onClick(); await nextTick();
    assert.equal(preview.props["aria-expanded"], true);
    assert.equal(find(harness.root, (node) => node.type === "img").length, 3);
    assert.ok(find(harness.root, (node) => node.type === "p" && node.text === entry.text).length);
    assert.deepEqual(harness.events, []);
  } finally { harness.close(); }
});

test("queue failures and uncertain outcomes expose recovery without guide or cancel actions", async () => {
  const harness = mount([]);
  try {
    for (const state of ["failed", "rejected", "unknown"]) {
      const entry = message(state); entry.request.error = { message: "Could not confirm" };
      harness.render([entry], { canGuide: true }); await nextTick();
      assert.equal(button(harness.root, "引导排队"), undefined);
      assert.equal(button(harness.root, "撤回排队"), undefined);
      assert.equal(find(harness.root, (node) => node.props?.["aria-label"] === "消息提交状态").length, 1);
      const recovery = button(harness.root, state === "unknown" ? "再次核对" : "恢复这条");
      recovery.props.onClick();
      assert.deepEqual(harness.events.at(-1), [state === "unknown" ? "check" : "restore", "queue"]);
    }
  } finally { harness.close(); }
});
