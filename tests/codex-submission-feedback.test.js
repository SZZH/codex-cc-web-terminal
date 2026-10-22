import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { compileScript, parse } from "vue/compiler-sfc";
import { createRenderer, h, nextTick } from "vue";

const file = new URL("../web/src/components/composer/CodexSubmissionFeedback.vue", import.meta.url);
const { descriptor } = parse(fs.readFileSync(file, "utf8"), { filename: file.pathname });
const compiled = compileScript(descriptor, { id: file.pathname, inlineTemplate: true }).content;
const source = compiled.replace(/from\s+["']([^"']+)["']/g, (_, name) =>
  `from ${JSON.stringify(name.startsWith(".") ? new URL(name, file).href : import.meta.resolve(name))}`);
const Component = (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).default;

function find(root, predicate) {
  return [...(predicate(root) ? [root] : []), ...(root.children || []).flatMap((child) => find(child, predicate))];
}
function text(root) { return [root.text || "", ...(root.children || []).map(text)].join(" "); }
function mount(props = {}) {
  const root = { children: [] }, events = [];
  const renderer = createRenderer({
    createElement: (type) => ({ type, props: {}, children: [] }),
    createText: (text) => ({ text }), createComment: (text) => ({ text }),
    setText: (node, value) => { node.text = value; },
    setElementText: (node, value) => { node.text = value; node.children = []; },
    parentNode: (node) => node?.parent || null,
    nextSibling: (node) => node?.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    insert(node, parent, anchor) {
      if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node);
      node.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node);
    },
    remove(node) { if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node); },
    patchProp: (node, key, previous, next) => { node.props[key] = next; }
  });
  const render = (next) => renderer.render(h(Component, { ...next,
    onRestore: (id) => events.push(["restore", id]), onCheck: (id) => events.push(["check", id]) }), root);
  render(props);
  return { root, events, render, close: () => renderer.render(null, root) };
}

test("failed desktop question replies refer back to the question card without a generic restore action", () => {
  const harness = mount({ request: { id: "answer", state: "rejected", executionRoute: "desktopQuestion", error: { message: "未发送" } } });
  try {
    assert.match(text(harness.root), /问题卡片中重新提交/);
    assert.equal(find(harness.root, (node) => node.type === "button").length, 0);
  } finally { harness.close(); }
});

test("the compiled submission feedback is silent until a submission and exposes neutral pending status", async () => {
  const harness = mount();
  try {
    assert.equal(find(harness.root, (node) => node.props?.role === "status").length, 0);
    harness.render({ pending: true }); await nextTick();
    const status = find(harness.root, (node) => node.props?.role === "status")[0];
    assert.equal(status.props["aria-label"], "消息提交状态");
    assert.equal(status.props["aria-busy"], true);
    assert.equal(status.props["aria-live"], "polite");
    assert.match(text(status), /正在提交/);
    assert.doesNotMatch(text(status), /已接收|已发送|失败/);
    assert.equal(find(harness.root, (node) => node.type === "button").length, 0);
    assert.equal(find(harness.root, (node) => node.props?.role === "region").length, 0);
  } finally { harness.close(); }
});

test("the compiled failure feedback preserves long errors and emits only the original receipt ID", async () => {
  const message = `连接失败\n${"long-error-without-spaces".repeat(50)}`;
  const request = { id: "original-id", state: "rejected", input: { text: "private original input", attachments: [{ id: "image" }] }, error: { message } };
  const harness = mount({ request });
  try {
    assert.ok(text(harness.root).includes(message));
    const detail = find(harness.root, (node) => node.props?.role === "region" && node.props?.["aria-label"] === "消息提交状态详情")[0];
    assert.ok(detail, "the complete long error has a named, independently focusable detail region");
    assert.equal(detail.props.tabindex, "0");
    assert.equal(detail.text, message, "the full error, including its newline and unbroken text, remains available");
    assert.equal(find(detail, (node) => node.type === "button").length, 0, "recovery actions stay outside the scrolling detail");
    assert.doesNotMatch(text(harness.root), /private original input/);
    assert.equal(find(harness.root, (node) => ["img", "textarea", "input"].includes(node.type)).length, 0);
    const restore = find(harness.root, (node) => node.type === "button")[0];
    assert.notEqual(restore.parent, detail);
    assert.equal(restore.props["aria-label"], "恢复这条消息到输入框");
    restore.props.onClick();
    assert.deepEqual(harness.events, [["restore", "original-id"]]);
    harness.render({ request, busy: true }); await nextTick();
    assert.equal(restore.props.disabled, true);
    assert.equal(restore.props["aria-busy"], true);
  } finally { harness.close(); }
});

test("the compiled unknown feedback distinguishes read-only confirmation from an explicit missing-receipt unlock", async () => {
  const harness = mount({ request: { id: "unknown-id", state: "unknown", confirmationDismissed: true, error: { code: "read_unavailable" } } });
  try {
    assert.match(text(harness.root), /正在确认发送状态/);
    assert.doesNotMatch(text(harness.root), /失败|\[object Object\]|解除发送锁定/);
    const check = find(harness.root, (node) => node.type === "button")[0];
    assert.equal(check.text, "再次核对");
    check.props.onClick();
    assert.deepEqual(harness.events, [["check", "unknown-id"]]);
    harness.render({ request: { id: "unknown-id", state: "unknown", error: { code: "receipt_not_found" } }, busy: true }); await nextTick();
    const unlock = find(harness.root, (node) => node.type === "button")[0];
    assert.equal(unlock.text, "核对并解除锁定");
    assert.equal(unlock.props.disabled, true);
    assert.equal(unlock.props["aria-busy"], true);
    assert.match(unlock.props.title, /不会自动重发|可能重复/);
  } finally { harness.close(); }
});

test("the compiled manually unlocked feedback retains an uncertainty warning without a repeat action", () => {
  const harness = mount({ request: { id: "unlocked", state: "unknown", confirmationDismissed: true, error: { code: "receipt_not_found" } } });
  try {
    assert.match(text(harness.root), /发送状态仍未确认/);
    assert.match(text(harness.root), /可能重复/);
    assert.doesNotMatch(text(harness.root), /未执行|发送失败/);
    assert.equal(find(harness.root, (node) => node.type === "button").length, 0);
  } finally { harness.close(); }
});
