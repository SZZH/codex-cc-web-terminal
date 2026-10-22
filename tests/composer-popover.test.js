import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { compileScript, parse } from "vue/compiler-sfc";
import { createRenderer, h, markRaw, nextTick, reactive } from "vue";

const sourceUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const componentUrls = new Map();
function compileComponent(file) {
  if (componentUrls.has(file.href)) return componentUrls.get(file.href);
  const { descriptor } = parse(fs.readFileSync(file, "utf8"), { filename: file.pathname });
  const source = compileScript(descriptor, { id: file.pathname, inlineTemplate: true }).content
    .replace(/from\s+["']([^"']+)["']/g, (_, name) => `from ${JSON.stringify(name === "vue"
      ? import.meta.resolve("vue") : name.endsWith(".vue") ? compileComponent(new URL(name, file)) : new URL(name, file).href)}`);
  const url = sourceUrl(source);
  componentUrls.set(file.href, url);
  return url;
}
const load = async (name) => (await import(compileComponent(new URL(`../web/src/components/composer/${name}.vue`, import.meta.url)))).default;
const find = (node, predicate) => [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap((child) => find(child, predicate))];

async function mount(t, name, initialProps, { slots, nativeApi = true, renderAfter } = {}) {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const body = { type: "body", children: [] }, root = { type: "root", children: [], parent: body };
  body.children.push(root);
  const document = { body, activeElement: body,
    querySelector: (selector) => selector === "dialog[open]" ? find(body, (node) => node.type === "dialog" && node.open)[0] || null : null };
  globalThis.document = document;
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  const trace = [], nativeEvents = [], errors = [];
  const connected = (element) => {
    while (element?.parent) element = element.parent;
    return element === body;
  };
  const element = (type) => {
    const node = markRaw({ type, props: {}, children: [], style: {}, scrollHeight: 48, open: false,
      get isConnected() { return connected(this); },
      get disabled() { return Boolean(this.props.disabled); },
      matches(selector) { return selector === ":disabled" && this.disabled; },
      focus(options) { if (this.isConnected && !this.disabled) { document.activeElement = this; trace.push({ action: "focus", node: this, options }); } },
      getBoundingClientRect: () => ({ left: 100, right: 400, top: 100, bottom: 400 }),
      contains(target) { return find(this, (candidate) => candidate === target).length > 0; }
    });
    if (type === "dialog" && nativeApi) {
      node.showModal = function () {
        assert.equal(this.isConnected, true, "showModal requires the teleported node to be mounted");
        this.origin = document.activeElement;
        this.open = true;
        trace.push({ action: "show", node: this, origin: this.origin });
        const target = find(this, (candidate) => candidate.props && Object.hasOwn(candidate.props, "autofocus") && !candidate.disabled)[0]
          || find(this, (candidate) => candidate.type === "button" && !candidate.disabled)[0] || this;
        target.focus();
      };
      node.close = function () {
        if (!this.open) return;
        this.open = false;
        trace.push({ action: "close", node: this, connected: this.isConnected,
          originConnected: this.origin?.isConnected, originDisabled: this.origin?.disabled });
        if (this.origin?.isConnected && !this.origin.disabled) this.origin.focus();
        else document.activeElement = body;
        nativeEvents.push(() => this.props.onClose?.({ target: this }));
      };
    }
    return node;
  };
  const origin = element("button");
  origin.parent = body; body.children.push(origin); origin.focus();
  const renderer = createRenderer({
    createElement: element, createText: (text) => ({ text }), createComment: (text) => ({ text }),
    setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: (node) => node.parent, nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
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
    patchProp: (node, key, _previous, value) => {
      node.props[key] = value;
      if (key === "disabled" && value && node === document.activeElement) document.activeElement = body;
    },
    querySelector: (selector) => selector === "body" ? body : null
  });
  const props = reactive({ ...initialProps });
  const Component = await load(name);
  const app = renderer.createApp({ render: () => h("div", [h(Component, props, slots), renderAfter?.()]) });
  app.config.errorHandler = (error) => errors.push(error);
  app.mount(root);
  let unmounted = false;
  const unmount = () => { if (!unmounted) { app.unmount(); unmounted = true; } };
  t.after(() => { unmount(); globalThis.window = previousWindow; globalThis.document = previousDocument; });
  const flushNative = () => { for (const event of nativeEvents.splice(0)) event(); };
  const settle = async ({ events = true } = {}) => {
    for (let step = 0; step < 5; step += 1) await nextTick();
    if (events) { flushNative(); await nextTick(); }
  };
  const all = (predicate) => find(body, predicate);
  const byClass = (name) => all((node) => String(node.props?.class || "").split(/\s+/).includes(name));
  const click = (node, extra = {}) => {
    node.focus?.();
    node.props.onClick?.({ target: node, clientX: 150, clientY: 150, preventDefault() {}, stopPropagation() {}, ...extra });
  };
  await settle();
  return { props, body, root, trace, errors, origin, document, all, byClass, click, settle, flushNative, unmount, element,
    dialogs: () => all((node) => node.type === "dialog"),
    cancel(node) { const event = { target: node, prevented: false, preventDefault() { this.prevented = true; } }; node.props.onCancel(event); return event; }
  };
}

test("real teleported popover uses showModal, one accessible title, and closes before prop removal or unmount", async (t) => {
  const ui = await mount(t, "ComposerPopover", { open: false, title: "输入设置" });
  assert.equal(ui.dialogs().length, 0);
  ui.props.open = true; await ui.settle();
  const dialog = ui.dialogs()[0];
  assert.equal(dialog.open, true);
  assert.equal(dialog.parent, ui.body);
  assert.equal(dialog.props["aria-modal"], "true");
  assert.equal(ui.all((node) => node.props?.id === dialog.props["aria-labelledby"]).length, 1);
  assert.equal(ui.document.activeElement.props["aria-label"], "关闭输入设置");
  ui.props.open = false; await ui.settle();
  assert.equal(ui.trace.find((entry) => entry.action === "close").connected, true);
  assert.equal(ui.document.activeElement, ui.origin);
  ui.props.open = true; await ui.settle();
  const reopened = ui.dialogs()[0];
  ui.unmount();
  assert.equal(reopened.open, false);
  assert.equal(ui.trace.filter((entry) => entry.action === "close").length, 2);
  assert.deepEqual(ui.errors, []);
});

test("native cancel and explicit close emit only close, while queued old close events cannot dismiss a reopened popover", async (t) => {
  let closes = 0;
  const ui = await mount(t, "ComposerPopover", { open: false, title: "Git 分支", onClose: () => { closes += 1; ui.props.open = false; } });
  ui.props.open = true; await ui.settle();
  const first = ui.dialogs()[0];
  assert.equal(ui.cancel(first).prevented, true);
  await ui.settle({ events: false });
  assert.equal(closes, 1);
  ui.props.open = true; await ui.settle({ events: false });
  const second = ui.dialogs()[0];
  ui.flushNative(); await ui.settle();
  ui.cancel(first); await ui.settle();
  assert.equal(second.open, true);
  assert.equal(closes, 1);
  ui.click(ui.byClass("popover-close")[0]); await ui.settle();
  assert.equal(closes, 2);
  assert.equal(ui.dialogs().length, 0);
});

test("missing native dialog capability reports an error instead of displaying an uncontrolled overlay", async (t) => {
  let closes = 0;
  const ui = await mount(t, "ComposerPopover", { open: true, title: "输入设置", onClose: () => { closes += 1; } }, { nativeApi: false });
  assert.equal(closes, 1);
  assert.equal(ui.dialogs().length, 0);
  assert.match(ui.errors[0]?.message || "", /不支持原生对话框/);
  assert.equal(ui.document.activeElement, ui.origin);
});

test("backdrop dismissal requires a pointer starting and ending outside the actual panel", async (t) => {
  let closes = 0;
  const ui = await mount(t, "ComposerPopover", { open: false, title: "输入设置", onClose: () => { closes += 1; ui.props.open = false; } });
  ui.props.open = true; await ui.settle();
  const dialog = ui.dialogs()[0];
  const pointer = (outside) => ({ target: dialog, clientX: outside ? 20 : 150, clientY: outside ? 20 : 150 });
  dialog.props.onPointerdown(pointer(false)); dialog.props.onClick(pointer(false));
  dialog.props.onPointerdown(pointer(false)); dialog.props.onClick(pointer(true));
  dialog.props.onPointerdown(pointer(true)); dialog.props.onClick(pointer(false));
  dialog.props.onPointerdown(pointer(true)); dialog.props.onPointercancel(); dialog.props.onClick(pointer(true));
  assert.equal(closes, 0);
  dialog.props.onPointerdown(pointer(true)); dialog.props.onClick(pointer(true)); await ui.settle();
  assert.equal(closes, 1);
  assert.equal(ui.document.activeElement, ui.origin);
});

const composerProps = () => ({ draft: "kept draft", composerOptions: { model: "model", attachments: [], permissionMode: "default" },
  models: [{ value: "model", label: "Model" }], gitState: { available: true, isGitRepo: true, currentBranch: "main", branches: [{ name: "topic" }] }, canSend: true });

test("running composer settings remain available and Git branch is plain read-only text", async (t) => {
  const ui = await mount(t, "ChatComposer", { ...composerProps(), canInterrupt: true, allowFollowups: true });
  const trigger = ui.byClass("chat-composer-context-button")[0];
  assert.equal(Boolean(trigger.props.disabled), false);
  ui.click(trigger); await ui.settle();
  const settings = ui.dialogs()[0];
  assert.equal(trigger.props["aria-controls"], settings.props.id);
  assert.equal(ui.byClass("git-entry")[0].type, "div");
  assert.equal(ui.byClass("branch-chip").length, 0);
  assert.equal(ui.byClass("branch-create").length, 0);
  ui.props.canInterrupt = false; await ui.settle();
  assert.equal(ui.dialogs()[0], settings);
  ui.cancel(settings); await ui.settle();
  assert.equal(ui.document.activeElement, trigger);
  assert.equal(ui.props.draft, "kept draft");
  assert.deepEqual(ui.errors, []);
});

test("a submission loading transition closes settings without opening a branch dialog", async (t) => {
  const ui = await mount(t, "ChatComposer", composerProps());
  ui.click(ui.byClass("chat-composer-context-button")[0]); await ui.settle();
  ui.props.loading = true; await ui.settle();
  assert.equal(ui.dialogs().length, 0);
  assert.equal(ui.trace.filter((entry) => entry.action === "show").length, 1);
  assert.equal(ui.document.activeElement.isConnected, true);
});

for (const mode of ["queue", "steer"]) {
  test(`send menu uses native autofocus and ${mode} closes once with its original submit mode`, async (t) => {
    const submitted = [], stopped = [];
    const ui = await mount(t, "ComposerSendActions", { runningTask: true, hasInput: true, canInterrupt: true, followUpMode: "queue", disabled: false, canSteer: true,
      onSubmit: (body) => submitted.push(body), onInterrupt: () => stopped.push(true) });
    const toggle = ui.byClass("send-menu-toggle")[0];
    ui.click(toggle); await ui.settle();
    const dialog = ui.dialogs()[0], choices = find(ui.byClass("send-menu")[0], (node) => node.type === "button");
    assert.equal(ui.document.activeElement, choices[0]);
    assert.equal(ui.all((node) => node.props?.role === "dialog").length, 1);
    assert.equal(toggle.props["aria-controls"], dialog.props.id);
    ui.click(choices[mode === "queue" ? 0 : 1]); await ui.settle();
    assert.deepEqual(submitted, [{ mode }]);
    assert.deepEqual(stopped, []);
    assert.equal(ui.dialogs().length, 0);
    assert.equal(ui.document.activeElement, toggle);
  });
}

for (const patch of [{ runningTask: false }, { disabled: true }, { hasInput: false }]) {
  test(`send menu ${Object.keys(patch)[0]} transition uses a connected fallback when its native origin is unavailable`, async (t) => {
    let fallbackCalls = 0;
    const ui = await mount(t, "ComposerSendActions", { runningTask: true, hasInput: true, canInterrupt: true, followUpMode: "queue", disabled: false, canSteer: true,
      fallbackFocus: () => { fallbackCalls += 1; ui.origin.focus({ preventScroll: true }); } });
    ui.click(ui.byClass("send-menu-toggle")[0]); await ui.settle();
    Object.assign(ui.props, patch); await ui.settle();
    assert.equal(ui.dialogs().length, 0);
    assert.equal(fallbackCalls, 1);
    assert.equal(ui.document.activeElement, ui.origin);
    assert.deepEqual(ui.errors, []);
  });
}

for (const change of ["removed", "disabled"]) {
  test(`close rechecks a native origin that is still valid at close but ${change} later in the same DOM update`, async (t) => {
    const host = reactive({ present: true, disabled: false, draft: "QA_DIALOG_FOCUS_DRAFT" });
    let fallbackCalls = 0;
    const ui = await mount(t, "ComposerPopover", { open: false, title: "发送方式",
      fallbackFocus: () => { fallbackCalls += 1; ui.byClass("late-draft")[0].focus({ preventScroll: true }); } }, {
      renderAfter: () => [host.present ? h("button", { key: "origin", class: "late-origin", disabled: host.disabled }) : null,
        h("textarea", { key: "draft", class: "late-draft", value: host.draft })]
    });
    const origin = ui.byClass("late-origin")[0];
    origin.focus(); ui.props.open = true; await ui.settle();
    ui.props.open = false;
    if (change === "removed") host.present = false; else host.disabled = true;
    await ui.settle();
    const closed = ui.trace.find((entry) => entry.action === "close");
    assert.equal(closed.originConnected, true);
    assert.equal(closed.originDisabled, false);
    assert.equal(fallbackCalls, 1);
    assert.equal(ui.document.activeElement, ui.byClass("late-draft")[0]);
    assert.equal(host.draft, "QA_DIALOG_FOCUS_DRAFT");
  });
}

test("the post-close check cannot reclaim focus while a different native dialog is open", async (t) => {
  const host = reactive({ present: true });
  let fallbackCalls = 0;
  const ui = await mount(t, "ComposerPopover", { open: false, title: "发送方式",
    fallbackFocus: () => { fallbackCalls += 1; ui.origin.focus(); } }, {
    renderAfter: () => host.present ? h("button", { class: "late-origin" }) : null
  });
  ui.byClass("late-origin")[0].focus(); ui.props.open = true; await ui.settle();
  ui.props.open = false; host.present = false;
  await nextTick();
  const nextDialog = ui.element("dialog");
  nextDialog.parent = ui.body; ui.body.children.push(nextDialog); nextDialog.showModal();
  ui.document.activeElement = ui.body;
  await ui.settle();
  assert.equal(fallbackCalls, 0);
  assert.equal(nextDialog.open, true);
  assert.equal(ui.document.activeElement, ui.body);
  nextDialog.close();
});

test("the post-close check is cancelled when its composer unmounts before the next tick", async (t) => {
  const host = reactive({ present: true });
  let fallbackCalls = 0;
  const ui = await mount(t, "ComposerPopover", { open: false, title: "发送方式",
    fallbackFocus: () => { fallbackCalls += 1; ui.origin.focus(); } }, {
    renderAfter: () => host.present ? h("button", { class: "late-origin" }) : null
  });
  ui.byClass("late-origin")[0].focus(); ui.props.open = true; await ui.settle();
  ui.props.open = false; host.present = false;
  await nextTick();
  ui.unmount(); await ui.settle();
  assert.equal(fallbackCalls, 0);
  assert.equal(ui.dialogs().length, 0);
});
