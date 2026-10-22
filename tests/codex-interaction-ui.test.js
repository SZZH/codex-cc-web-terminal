import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parse, compileScript } from "vue/compiler-sfc";
import { createRenderer, h, nextTick, reactive } from "vue";
import { createCodexInteractionState } from "../web/src/lib/codex-interactions/state.js";
import { describeMcpForm, initialMcpValues, buildMcpFormResponse } from "../web/src/lib/codex-interactions/form.js";
import { validatePermissions } from "../src/sessions/codex/interactions/permissions.js";
import { validateForm } from "../src/sessions/codex/interactions/forms.js";

function componentUrl(file) {
  const { descriptor } = parse(fs.readFileSync(file, "utf8"), { filename: file.pathname });
  const source = compileScript(descriptor, { id: file.pathname, inlineTemplate: true }).content.replace(/from\s+["']([^"']+)["']/g,
    (_, name) => `from ${JSON.stringify(name.endsWith(".vue") ? componentUrl(new URL(name, file)) : name.startsWith(".") ? new URL(name, file).href : import.meta.resolve(name))}`);
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}
const elements = (node, predicate) => [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap((child) => elements(child, predicate))];
const text = (node) => [node.text || "", ...(node.children || []).map(text)].join(" ");
async function mount(name, props) {
  const component = (await import(componentUrl(new URL(`../web/src/components/composer/interactions/${name}.vue`, import.meta.url)))).default;
  const renderer = createRenderer({
    createElement: (type) => ({ type, props: {}, children: [] }), createText: (text) => ({ text }), createComment: (text) => ({ text }),
    setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: (node) => node?.parent || null,
    nextSibling: (node) => node?.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    patchProp: (node, key, old, value) => { node.props[key] = value; },
    insert: (node, parent, anchor) => { if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node); node.parent = parent; const index = parent.children.indexOf(anchor); if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node); },
    remove: (node) => { if (node?.parent) node.parent.children = node.parent.children.filter((child) => child !== node); if (node) node.parent = null; }
  });
  const root = { children: [] }; renderer.render(h(component, props), root); await nextTick();
  return { root, elements: (predicate) => elements(root, predicate), close: () => renderer.render(null, root) };
}

test("native question fields expose freeform, secret and Other without sending ordinary chat", async () => {
  const values = reactive({}), updates = [];
  const ui = await mount("QuestionFields", { questions: [
    { id: "choice", header: "Choice", question: "Pick", options: [{ label: "First", description: "one" }], isOther: true },
    { id: "free", question: "Explain", options: null }, { id: "secret", question: "Token", isSecret: true }
  ], values, onChange: (id, value) => { values[id] = value; updates.push([id, value]); } });
  try {
    assert.equal(ui.elements((node) => node.type === "input" && node.props.type === "password").length, 1);
    const radio = ui.elements((node) => node.type === "input" && node.props.type === "radio")[0];
    radio.props.onChange({ target: { value: "First" } }); await nextTick();
    assert.deepEqual(updates[0], ["choice", "First"]);
    assert.match(text(ui.root), /其他/);
    assert.equal(ui.elements((node) => node.type === "textarea").length, 1);
  } finally { ui.close(); }
});

const row = (method, params, patch = {}) => ({ id: "one", threadId: "thread", turnId: "turn", itemId: "item", method, params, status: "pending", version: 1, ...patch });
async function panel(interaction) {
  const store = createCodexInteractionState("thread", { reactive }), responses = [];
  store.applySnapshot({ interactions: [interaction], epoch: "registry", revision: 1 });
  const ui = await mount("CodexInteractionPanel", { state: store.state,
    onDraft: ({ id, patch }) => store.setDraft(id, patch), onRespond: (value) => responses.push(value) });
  return { ...ui, store, responses, button(label) { return ui.elements((node) => node.type === "button" && text(node).includes(label))[0]; },
    submit() { ui.elements((node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} }); } };
}

test("real question panel submits every question ID and skips without exposing secret answers", async () => {
  const ui = await panel(row("item/tool/requestUserInput", { isBlocking: true, questions: [
    { id: "choice", question: "Choose", options: [{ label: "A", description: "First" }] },
    { id: "secret", question: "Private", isSecret: true }, { id: "empty", question: "Optional" }
  ] }));
  try {
    assert.equal(ui.button("提交回答").props.disabled, true);
    ui.submit(); assert.equal(ui.responses.length, 0);
    ui.store.setDraft("one", { answers: { choice: "A", secret: "private-value" } }); await nextTick();
    ui.submit();
    assert.deepEqual(ui.responses[0], { id: "one", response: { answers: { choice: { answers: ["A"] }, secret: { answers: ["private-value"] }, empty: { answers: [] } } } });
    assert.doesNotMatch(text(ui.root), /private-value/);
    ui.button("全部跳过").props.onClick();
    assert.deepEqual(ui.responses[1].response, { answers: { choice: { answers: [] }, secret: { answers: [] }, empty: { answers: [] } } });
    ui.store.applyUpdate({ interaction: row("item/tool/requestUserInput", ui.store.state.interactions.one.params, { status: "resolved", version: 2 }), epoch: "registry", revision: 2 });
    await nextTick();
    assert.equal(ui.store.state.drafts.one, undefined);
    assert.equal(ui.elements((node) => node.type === "input" && node.props.type === "password").length, 0);
    assert.equal(ui.button("提交回答"), undefined);
    assert.equal(ui.elements((node) => node.type === "section").length, 0);
  } finally { ui.store.dispose(); ui.close(); }
});

test("command approvals preserve all offered decisions, stdin identity and persistent rules", async () => {
  const exec = ["git", "status"], network = { host: "example.test", action: "allow" };
  const offered = ["decline", "accept", "acceptForSession", "cancel", { acceptWithExecpolicyAmendment: { execpolicy_amendment: exec } },
    { applyNetworkPolicyAmendment: { network_policy_amendment: network } }];
  const ui = await panel(row("item/commandExecution/requestApproval", { kind: "writeStdin", approvalId: "stdin-a", command: "yes\n", cwd: "/project",
    networkApprovalContext: { host: "example.test", protocol: "https" }, proposedExecpolicyAmendment: exec, proposedNetworkPolicyAmendments: [network], availableDecisions: offered }));
  try {
    assert.match(text(ui.root), /确认写入终端/); assert.match(text(ui.root), /example.test.*https/);
    const buttons = ui.elements((node) => node.type === "button");
    assert.equal(buttons.length, offered.length);
    for (const button of buttons) button.props.onClick();
    assert.deepEqual(ui.responses.map((entry) => JSON.stringify(entry.response.decision)).sort(), offered.map((value) => JSON.stringify(value)).sort());
    assert.match(text(ui.root), /保存命令规则/);
  } finally { ui.store.dispose(); ui.close(); }
});

test("file approvals show actual file evidence and the requested write root", async () => {
  const ui = await panel(row("item/fileChange/requestApproval", { reason: "Update config", grantRoot: "/project/config" },
    { item: { changes: [{ path: "a.txt", kind: "update", diff: "+new\n-old" }] } }));
  try {
    assert.match(text(ui.root), /Update config/); assert.match(text(ui.root), /\/project\/config/); assert.match(text(ui.root), /a.txt.*修改/);
    assert.match(text(ui.root), /\+new/);
    ui.button("拒绝并继续").props.onClick(); assert.deepEqual(ui.responses[0].response, { decision: "decline" });
  } finally { ui.store.dispose(); ui.close(); }
});

test("permission controls grant only selected original entries and explicit scope", async () => {
  const entry = { access: "read", path: { type: "glob_pattern", pattern: "/data/*.csv" } };
  const ui = await panel(row("item/permissions/requestApproval", { cwd: "/project", permissions: { fileSystem: { read: ["/one"], write: ["/two"], entries: [entry], globScanMaxDepth: 2 }, network: { enabled: true } } }));
  try {
    assert.equal(ui.button("授予所选权限").props.disabled, true);
    assert.match(text(ui.root), /读取 · \/data\/\*\.csv（匹配路径）/);
    assert.doesNotMatch(text(ui.root), /glob_pattern|"access"|"type"/);
    const advanced = ui.elements((node) => node.type === "details" && text(node).includes("授权范围"))[0];
    assert.ok(advanced); assert.ok(!advanced.props.open);
    const checkboxes = ui.elements((node) => node.type === "input" && node.props.type === "checkbox");
    checkboxes[2].props.onChange({ target: { checked: true } }); await nextTick();
    ui.elements((node) => node.type === "select")[0].props.onChange({ target: { value: "session" } }); await nextTick();
    checkboxes.at(-1).props.onChange({ target: { checked: true } }); await nextTick();
    ui.submit();
    assert.deepEqual(ui.responses[0].response, { permissions: { fileSystem: { entries: [entry], globScanMaxDepth: 2 } }, scope: "session", strictAutoReview: true });
    ui.button("拒绝额外权限").props.onClick(); assert.deepEqual(ui.responses[1].response, { permissions: {}, scope: "turn" });
  } finally { ui.store.dispose(); ui.close(); }
});

for (const mode of ["form", "openai/form", "openaiForm"]) test(`MCP ${mode} renders typed fields and preserves false and zero`, async () => {
  const ui = await panel(row("mcpServer/elicitation/request", { mode, serverName: "Service", message: "Confirm details", requestedSchema: { type: "object", required: ["count", "enabled"], properties: {
    count: { type: "integer", minimum: 0, maximum: 3 }, enabled: { type: "boolean" },
    flavor: { type: "string", oneOf: [{ const: "a", title: "Alpha" }, { const: "b", title: "Beta" }] },
    many: { type: "array", minItems: 1, items: { anyOf: [{ const: "red", title: "Red" }, { const: "blue", title: "Blue" }] } }
  } } }, { turnId: null }));
  try {
    ui.elements((node) => node.type === "input" && node.props.type === "number")[0].props.onInput({ target: { value: "0" } }); await nextTick();
    ui.elements((node) => node.type === "select")[0].props.onChange({ target: { value: "option-0" } }); await nextTick();
    const choices = ui.elements((node) => node.type === "input" && node.props.type === "checkbox");
    choices[1].props.onChange({ target: { checked: true } }); await nextTick();
    ui.submit();
    assert.deepEqual(ui.responses[0].response, { action: "accept", content: { count: 0, enabled: false, flavor: "a", many: ["red"] } });
  } finally { ui.store.dispose(); ui.close(); }
});

test("MCP URL requires an explicit open and never responds merely because the link was clicked", async () => {
  const ui = await panel(row("mcpServer/elicitation/request", { mode: "url", serverName: "Service", url: "https://example.test/confirm", message: "Continue", elicitationId: "external" }, { turnId: null }));
  try {
    assert.equal(ui.button("已完成外部确认").props.disabled, true);
    const link = ui.elements((node) => node.type === "a")[0];
    assert.equal(link.props.rel, "noopener noreferrer"); link.props.onClick({ preventDefault() {} }); await nextTick();
    assert.equal(ui.responses.length, 0); assert.equal(ui.button("已完成外部确认").props.disabled, false);
    ui.button("已完成外部确认").props.onClick(); assert.deepEqual(ui.responses[0].response, { action: "accept" });
  } finally { ui.store.dispose(); ui.close(); }
});

test("unsafe URLs, unsupported schema and device verification offer no fabricated acceptance", async () => {
  for (const params of [
    { mode: "url", url: "javascript:alert(1)" }, { mode: "openai/userVerification", challenge: "opaque-proof-challenge" },
    { mode: "openai/form", requestedSchema: { type: "object", properties: {}, allOf: [] } }
  ]) {
    const ui = await panel(row("mcpServer/elicitation/request", { serverName: "Service", ...params }));
    try {
      assert.equal(ui.elements((node) => node.type === "a").length, 0);
      assert.equal(ui.button("确认提交"), undefined); assert.equal(ui.button("已完成外部确认"), undefined);
      ui.button("拒绝").props.onClick(); assert.deepEqual(ui.responses[0].response, { action: "decline" });
      assert.doesNotMatch(text(ui.root), /opaque-proof-challenge/);
    } finally { ui.store.dispose(); ui.close(); }
  }
});

test("standard MCP fields enforce known constraints with errors that do not echo answers", () => {
  const form = describeMcpForm({ mode: "form", requestedSchema: { type: "object", required: ["email"], properties: { email: { type: "string", format: "email" }, amount: { type: "integer", minimum: 0 } } } });
  assert.equal(form.supported, true);
  assert.throws(() => buildMcpFormResponse(form.fields, { email: "private-input", amount: 0 }), (error) => !error.message.includes("private-input"));
  assert.throws(() => buildMcpFormResponse(form.fields, { email: "name@example.test", amount: 0.5 }), /数值/);
});

test("server schema capability rejection suppresses acceptance even for locally renderable fields", async () => {
  const ui = await panel(row("mcpServer/elicitation/request", { mode: "form", serverName: "Service", message: "Form", requestedSchema: { type: "object", properties: { name: { type: "string" } } } },
    { error: { code: "unsupported_interaction_schema", message: "This schema requires unsupported validation" } }));
  try {
    assert.equal(ui.button("确认提交"), undefined);
    assert.match(text(ui.root), /尚不支持的结构校验/);
    ui.submit(); assert.equal(ui.responses.length, 0);
    ui.button("拒绝").props.onClick(); assert.deepEqual(ui.responses[0].response, { action: "decline" });
  } finally { ui.store.dispose(); ui.close(); }
});

test("typed MCP form root annotations remain supported while executable additional schemas do not", () => {
  const schema = { type: "object", title: "Details", description: "Review details", additionalProperties: false,
    properties: { name: { type: "string" } }, required: ["name"] };
  const form = describeMcpForm({ mode: "openai/form", requestedSchema: schema });
  assert.equal(form.supported, true);
  assert.deepEqual(buildMcpFormResponse(form.fields, { name: "ready" }), { action: "accept", content: { name: "ready" } });
  assert.equal(describeMcpForm({ mode: "form", requestedSchema: { ...schema, title: {} } }).supported, false);
  assert.equal(describeMcpForm({ mode: "form", requestedSchema: { ...schema, additionalProperties: { type: "string" } } }).supported, false);
});

test("file permission selection preserves fixed deny entries and passes the real backend validator", async () => {
  const denied = { access: "deny", path: { type: "path", path: "/project/private" } };
  const permissions = { fileSystem: { write: ["/project"], entries: [denied] } };
  const ui = await panel(row("item/permissions/requestApproval", { cwd: "/project", permissions }));
  try {
    const checks = ui.elements((node) => node.type === "input" && node.props.type === "checkbox");
    assert.equal(checks[1].props.checked, true); assert.equal(checks[1].props.disabled, true);
    checks[0].props.onChange({ target: { checked: true } }); await nextTick();
    ui.submit();
    assert.deepEqual(ui.responses[0].response, { permissions: { fileSystem: { write: ["/project"], entries: [denied] } }, scope: "turn" });
    assert.doesNotThrow(() => validatePermissions(ui.responses[0].response, permissions));
    ui.button("拒绝额外权限").props.onClick();
    assert.deepEqual(ui.responses[1].response, { permissions: {}, scope: "turn" });
    assert.doesNotThrow(() => validatePermissions(ui.responses[1].response, permissions));
  } finally { ui.store.dispose(); ui.close(); }
});

test("available decisions carry authoritative rules without duplicate proposal fields", async () => {
  const exec = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["echo", "ok"] } };
  const network = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "api.example.test", action: "deny" } } };
  const ui = await panel(row("item/commandExecution/requestApproval", { command: "echo ok", additionalPermissions: null, availableDecisions: ["accept", exec, network, "cancel"], proposedExecpolicyAmendment: null, proposedNetworkPolicyAmendments: null }));
  try {
    const actions = ui.elements((node) => node.type === "button");
    assert.equal(actions.length, 4);
    for (const action of actions) action.props.onClick();
    assert.deepEqual(ui.responses.map((entry) => entry.response.decision), ["accept", "cancel", exec, network]);
    assert.doesNotMatch(text(ui.root), /execpolicy_amendment|network_policy_amendment|"host"/);
    assert.match(text(ui.root), /长期.*api.example.test|api.example.test.*长期/);
  } finally { ui.store.dispose(); ui.close(); }
});

test("optional arrays can be absent and required empty strings follow schema constraints", async () => {
  for (const schema of [
    { type: "object", properties: { choices: { type: "array", minItems: 1, items: { type: "string", enum: ["a", "b"] } } } },
    { type: "object", required: ["value"], properties: { value: { type: "string" } } }
  ]) {
    const form = describeMcpForm({ mode: "form", requestedSchema: schema });
    const response = buildMcpFormResponse(form.fields, initialMcpValues(form.fields));
    assert.doesNotThrow(() => validateForm(schema, response.content));
    assert.deepEqual(response.content, schema.required ? { value: "" } : {});
    const fieldUi = await panel(row("mcpServer/elicitation/request", { mode: "form", serverName: "Service", message: "Value", requestedSchema: schema }));
    try {
      if (schema.required) assert.ok(!fieldUi.elements((node) => node.type === "input")[0].props.required);
      fieldUi.submit();
      assert.deepEqual(fieldUi.responses[0].response.content, response.content);
      assert.doesNotThrow(() => validateForm(schema, fieldUi.responses[0].response.content));
    } finally { fieldUi.store.dispose(); fieldUi.close(); }
  }
  const schema = { type: "object", required: ["value"], properties: { value: { type: "string", enum: [""] } } };
  const ui = await panel(row("mcpServer/elicitation/request", { mode: "form", serverName: "Service", message: "Value", requestedSchema: schema }));
  try {
    const select = ui.elements((node) => node.type === "select")[0];
    const options = ui.elements((node) => node.type === "option");
    assert.notEqual(options[0].props.value, options[1].props.value);
    select.props.onChange({ target: { value: options[1].props.value } }); await nextTick();
    ui.submit();
    assert.deepEqual(ui.responses[0].response.content, { value: "" });
    assert.doesNotThrow(() => validateForm(schema, ui.responses[0].response.content));
  } finally { ui.store.dispose(); ui.close(); }
});

test("polished approvals show two primary actions and keep persistent decisions in a closed disclosure", async () => {
  const ui = await panel(row("item/commandExecution/requestApproval", { command: "curl https://example.test", networkApprovalContext: { host: "example.test", protocol: "https" }, availableDecisions: ["accept", "acceptForSession", "decline", "cancel"] }));
  try {
    const isAdvanced = (node) => { for (let parent = node.parent; parent; parent = parent.parent) if (parent.type === "details") return true; return false; };
    const direct = ui.elements((node) => node.type === "button" && !isAdvanced(node));
    assert.equal(direct.length, 2);
    const disclosure = ui.elements((node) => node.type === "details" && text(node).includes("更多选项"))[0];
    assert.ok(disclosure); assert.ok(!disclosure.props.open);
    assert.match(text(ui.root), /curl https:\/\/example.test/);
    assert.doesNotMatch(text(ui.root), /等待处理|网络规则.*\{/);
  } finally { ui.store.dispose(); ui.close(); }
});

test("semantic task choices identify questions and targets then resolved tasks leave the composer automatically", async () => {
  const question = row("item/tool/requestUserInput", { isBlocking: true, questions: [{ id: "answer", question: "选择发布范围", header: "问题" }] });
  const network = row("item/commandExecution/requestApproval", { command: "curl https://api.example.test", networkApprovalContext: { host: "api.example.test", protocol: "https" } }, { id: "network" });
  const ui = await panel(question);
  try {
    ui.store.applySnapshot({ interactions: [question, network], epoch: "registry", revision: 2 }); await nextTick();
    const choices = ui.elements((node) => node.type === "option").map(text);
    assert.match(choices[0], /选择发布范围/); assert.match(choices[1], /网络访问.*api.example.test/);
    assert.ok(choices.every((label) => !/^\d+\s*·/.test(label.trim())));
    assert.equal(ui.elements((node) => node.type === "h2")[0].text, "选择发布范围");
    assert.equal(ui.elements((node) => node.type === "legend")[0].props.class, "sr-only");
    ui.store.applyUpdate({ interaction: { ...question, status: "resolved", version: 2 }, epoch: "registry", revision: 3 }); await nextTick();
    assert.equal(ui.elements((node) => node.type === "h2")[0].text, "确认网络访问");
    ui.store.applyUpdate({ interaction: { ...network, status: "resolved", version: 2 }, epoch: "registry", revision: 4 }); await nextTick();
    assert.equal(ui.elements((node) => node.type === "section").length, 0);
  } finally { ui.store.dispose(); ui.close(); }
});

test("unconfirmed responses stay visible and unavailable requests are compact and dismissible", async () => {
  const question = row("item/tool/requestUserInput", { questions: [{ id: "answer", question: "继续执行吗" }] });
  const ui = await panel(question);
  try {
    ui.store.applyUpdate({ interaction: { ...question, status: "unknown", version: 2 }, epoch: "registry", revision: 2 }); await nextTick();
    assert.ok(ui.button("核对响应状态")); assert.match(text(ui.root), /响应待核对/);
    assert.equal(ui.elements((node) => node.type === "textarea").length, 0);
    ui.store.applyUpdate({ interaction: { ...question, status: "unavailable", version: 3 }, epoch: "registry", revision: 3 }); await nextTick();
    assert.equal(ui.elements((node) => node.type === "form").length, 0);
    ui.elements((node) => node.props?.["aria-label"] === "关闭失效交互")[0].props.onClick(); await nextTick();
    assert.equal(ui.elements((node) => node.type === "section").length, 0);
  } finally { ui.store.dispose(); ui.close(); }
});
