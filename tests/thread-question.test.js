import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parse, compileScript } from "vue/compiler-sfc";
import { createRenderer, h, nextTick, reactive } from "vue";
import { presentCodexItem } from "../src/sessions/codex/itemPresentation.js";
import { normalizeThreadItem } from "../web/src/lib/thread-item-renderers.js";
import { presentCodexChatItem } from "../web/src/lib/codex-chat-presentation.js";
import { buildQuestionAnswer } from "../web/src/lib/codex-question-history.js";
import { QUESTION_DOCK } from "../web/src/lib/codex-question-dock.js";
import { createCodexInteractionState } from "../web/src/lib/codex-interactions/state.js";

const native = (patch = {}) => ({ id: "call_question", type: "agentMessage", delivery: "async", phase: "final_answer",
  text: "Choose a path?\n1. First\n2. Second", questions: [{ title: "Choose a path?", options: ["First", "Second"] }], ...patch });
const dto = (patch = {}) => ({ ...presentCodexItem(native()).presentation.question, ...patch });

test("native desktop question fields become a bounded presentation without inferring an answer state", () => {
  const source = native();
  const before = structuredClone(source);
  const item = presentCodexItem(source);
  assert.deepEqual(item.presentation.question, { questions: [{ id: "0", title: "Choose a path?", options: ["First", "Second"] }],
    source: "desktop", delivery: "async", callId: "call_question", truncated: false });
  assert.equal(item.presentation.text, "");
  assert.equal(item.presentation.question.status, undefined);
  assert.deepEqual(source, before);
});

test("native asynchronous questions without optional options retain a freeform presentation", () => {
  const source = native({ questions: [{ title: "Describe what happened" }] });
  const item = presentCodexItem(source);
  assert.deepEqual(item.presentation.question?.questions, [{ id: "0", title: "Describe what happened", options: [] }]);
  assert.equal(item.presentation.text, "");
  assert.equal(source.questions[0].options, undefined);
});

test("ordinary prose and malformed native records never become an actionable question", () => {
  for (const patch of [{ delivery: undefined }, { questions: undefined }, { type: "userMessage" }, { id: "message_plain" },
    { questions: [{ title: "", options: [] }] }, { questions: [{ title: "Choose", options: [{ label: "unrecognized" }] }] },
    { questions: [{ title: "Choose", options: "unrecognized" }] }, { questions: [{ title: "Choose", options: null }] }]) {
    const item = presentCodexItem(native(patch));
    assert.equal(item.presentation.question, undefined);
    assert.match(item.presentation.text, /Choose a path/);
  }
});

test("oversized questions expose truncation and stay bounded independently of raw message text", () => {
  const item = presentCodexItem(native({ text: "raw duplicate".repeat(10_000), questions: Array.from({ length: 50 }, () => ({
    title: "Question ".repeat(1_000), options: Array.from({ length: 50 }, () => "Choice ".repeat(500))
  })) }));
  const question = item.presentation.question;
  assert.equal(question.truncated, true);
  assert.ok(question.questions.length <= 12);
  assert.ok(question.questions.every((entry) => entry.options.length <= 16 && entry.title.length <= 4_000));
  assert.ok(question.questions.reduce((sum, entry) => sum + entry.title.length + entry.options.reduce((n, option) => n + option.length, 0), 0) <= 16_000);
  assert.equal(item.hasDetails, false, "hidden duplicate prose must not start a detail download");
});

test("normalization forwards root and payload question metadata and suppresses duplicate prose", () => {
  for (const item of [{ question: dto() }, { payload: { question: dto() } }]) {
    const normalized = normalizeThreadItem({ id: "call_question", kind: "AgentMessage", text: "duplicate prose", ...item });
    assert.equal(normalized.question.callId, "call_question");
    assert.equal(normalized.body, "");
    assert.equal(normalized.category, "primary");
  }
  assert.equal(normalizeThreadItem({ kind: "AgentMessage", text: "ordinary answer" }).body, "ordinary answer");
  assert.equal(normalizeThreadItem({ kind: "AgentMessage", text: "ordinary question", payload: { question: "unstructured text" } }).body, "ordinary question");
  const tool = normalizeThreadItem({ kind: "DynamicToolCall", text: "tool output", payload: { question: dto() } });
  assert.equal(tool.question, null);
  assert.equal(tool.body, "tool output");
});

function componentUrl(file) {
  const { descriptor } = parse(fs.readFileSync(file, "utf8"), { filename: file.pathname });
  const source = compileScript(descriptor, { id: file.pathname, inlineTemplate: true }).content.replace(/from\s+["']([^"']+)["']/g,
    (_, name) => `from ${JSON.stringify(name.endsWith(".vue") ? componentUrl(new URL(name, file)) : name.startsWith(".") ? new URL(name, file).href : import.meta.resolve(name))}`);
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}
const elements = (node, predicate) => [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap((child) => elements(child, predicate))];
const text = (node) => [node.text || "", ...(node.children || []).map(text)].join(" ");
async function mount(t, values, name = "ThreadQuestionCard", providers = []) {
  const component = (await import(componentUrl(new URL(`../web/src/components/thread-item/${name}.vue`, import.meta.url)))).default;
  const renderer = createRenderer({
    createElement: (type) => ({ type, props: {}, children: [], style: {} }), createText: (text) => ({ text }), createComment: (text) => ({ text }),
    setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: (node) => node?.parent || null,
    nextSibling: (node) => node?.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    patchProp: (node, key, old, value) => { node.props[key] = value; },
    insert: (node, parent, anchor) => { if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node); node.parent = parent; const index = parent.children.indexOf(anchor); if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node); },
    remove: (node) => { if (node?.parent) node.parent.children = node.parent.children.filter((child) => child !== node); if (node) node.parent = null; }
  });
  const root = { children: [] }, props = reactive(values);
  const app = renderer.createApp({ render: () => h(component, props) });
  for (const [key, value] of providers) app.provide(key, value);
  let closed = false;
  const close = () => { if (!closed) { closed = true; app.unmount(); } };
  app.mount(root); await nextTick(); t.after(close);
  return { root, props, close, elements: (predicate) => elements(root, predicate) };
}

test("timeline question opens the single floating answer form instead of creating a second draft", async (t) => {
  const opened = [], bridge = { has: () => true, open: (id) => opened.push(id) };
  const ui = await mount(t, { question: dto({ status: "pending" }), canRespond: true }, "ThreadQuestionCard", [[QUESTION_DOCK, bridge]]);
  assert.equal(ui.elements((node) => node.type === "input").length, 0);
  ui.elements((node) => node.type === "button")[0].props.onClick();
  assert.deepEqual(opened, ["call_question"]);
  ui.props.floating = true; await nextTick();
  assert.ok(ui.elements((node) => node.type === "input").length > 0);
});

test("floating answers remove completed entries while preserving the remaining native index", async (t) => {
  const answers = [];
  const ui = await mount(t, { floating: true, canRespond: true, onAnswer: (value) => answers.push(value),
    question: dto({ status: "pending", answers: { "0": "First" }, questions: [
      { id: "0", title: "Already answered", options: [] }, { id: "1", title: "Remaining question", options: [] }
    ] }) });
  assert.equal(ui.elements((node) => node.type === "form").length, 1);
  assert.doesNotMatch(text(ui.root), /Already answered/);
  ui.elements((node) => node.type === "textarea")[0].props.onInput({ target: { value: "Second answer" } }); await nextTick();
  ui.elements((node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  assert.equal(answers[0].index, 1);
});

test("compact floating cards retain the question and response status without repeating the dock heading", async (t) => {
  const ui = await mount(t, { floating: true, canRespond: true, question: dto({ status: "pending" }) });
  assert.equal(ui.elements((node) => node.type === "header").length, 0);
  assert.equal(ui.elements((node) => node.type === "legend")[0].text, "Choose a path?");
  assert.match(text(ui.root), /First.*Second.*提交回答/);
  assert.doesNotMatch(text(ui.root), /等待回答/);
  for (const response of [
    { pendingResponses: { "0": "unknown" } },
    { pendingResponse: true, responseState: "unknown" }
  ]) {
    ui.props.question = dto({ status: "pending", ...response }); await nextTick();
    assert.match(text(ui.root), /Choose a path/);
    assert.match(text(ui.root), /回答待确认/);
    assert.equal(ui.elements((node) => node.type === "button").length, 0, "unconfirmed responses cannot be submitted again");
  }
});

test("question dock reports its visible expansion, preserves drafts and releases space after all answers", async (t) => {
  const expanded = [], store = createCodexInteractionState("thread", { reactive });
  const first = dto({ status: "pending" });
  const ui = await mount(t, { questions: [], canRespond: true, interactionState: store.state,
    onExpanded: (value) => expanded.push(value) }, "../composer/CodexQuestionDock");
  const toggle = () => ui.elements((node) => node.props?.["aria-controls"])[0];
  assert.deepEqual(expanded, [false]);
  ui.props.questions = [first]; await nextTick();
  assert.equal(expanded.at(-1), true);
  ui.elements((node) => node.type === "input").at(-1).props.onChange(); await nextTick();
  ui.elements((node) => node.type === "textarea")[0].props.onInput({ target: { value: "Keep this draft" } }); await nextTick();
  toggle().props.onClick(); await nextTick();
  assert.equal(expanded.at(-1), false);
  const second = dto({ callId: "call_second", status: "pending", questions: [{ id: "0", title: "Second question", options: [] }] });
  ui.props.questions = [first, second]; await nextTick();
  assert.equal(expanded.at(-1), true, "a newly waiting question reopens the dock");
  assert.equal(toggle().props["aria-expanded"], true);
  assert.equal(ui.elements((node) => node.type === "textarea")[0].props.value, "Keep this draft");
  ui.props.questions = [first, second].map((question) => ({ ...question, status: "answered", answers: { "0": "Done" } }));
  await nextTick();
  assert.equal(expanded.at(-1), false, "answered questions restore the ordinary chat area");
  assert.equal(ui.elements((node) => node.props?.["aria-label"] === "Codex 悬浮提问").length, 0);
  ui.props.questions = [dto({ callId: "call_third", status: "pending" })]; await nextTick();
  assert.equal(expanded.at(-1), true);
  ui.close();
  assert.equal(expanded.at(-1), false, "leaving the thread releases attention layout state");
  store.dispose();
});

test("unknown and closed historical questions remain records without misleading pending actions", async (t) => {
  for (const status of [undefined, "closed"]) {
    const ui = await mount(t, { question: dto({ status }), canRespond: true });
    assert.match(text(ui.root), /问题记录/);
    assert.doesNotMatch(text(ui.root), /请在桌面端回答|等待回答|提交回答/);
    assert.equal(ui.elements((node) => ["input", "textarea", "button"].includes(node.type)).length, 0);
  }
});

test("ended async question keeps its text without answering controls or a waiting label", async (t) => {
  const ui = await mount(t, { question: dto({ status: "pending", active: false }), canRespond: true });
  assert.match(text(ui.root), /Choose a path/);
  assert.doesNotMatch(text(ui.root), /等待回答|已回答|回答暂不可用|提交回答/);
  assert.equal(ui.elements((node) => ["input", "textarea", "button"].includes(node.type)).length, 0);
});

test("a known pending question requires an available response capability", async (t) => {
  const ui = await mount(t, { question: dto({ status: "pending" }) });
  assert.match(text(ui.root), /等待回答/);
  assert.match(text(ui.root), /回答暂不可用/);
  assert.doesNotMatch(text(ui.root), /请在桌面端回答/);
  assert.match(text(ui.root), /First.*Second/);
  assert.equal(ui.elements((node) => ["input", "textarea", "button"].includes(node.type)).length, 0);
});

test("answered questions become plain question text without repeating answers, choices or status labels", async (t) => {
  const answers = [];
  const ui = await mount(t, { question: dto({ status: "answered", answers: { 0: "Second" } }), canRespond: true, onAnswer: (answer) => answers.push(answer) });
  assert.match(text(ui.root), /Choose a path/);
  assert.doesNotMatch(text(ui.root), /First|Second|已回答|请在桌面端回答|提交回答/);
  assert.equal(ui.elements((node) => ["input", "textarea", "button"].includes(node.type)).length, 0);
  assert.equal(answers.length, 0);
});

test("multi-question cards keep confirmed, skipped and queued entries read-only while other questions remain editable", async (t) => {
  const answers = [];
  const question = dto({ status: "pending", answers: { 0: "First", 1: "" }, pendingResponses: { 2: "queued" },
    questions: Array.from({ length: 4 }, (_, index) => ({ id: String(index), title: `Question ${index}`, options: [`Option ${index}`] })) });
  const ui = await mount(t, { question, canRespond: true, onAnswer: (answer) => answers.push(answer) });
  assert.doesNotMatch(text(ui.root), /First|已跳过/);
  assert.match(text(ui.root), /Question 0.*Question 1/);
  assert.match(text(ui.root), /回答已排队/);
  assert.equal(ui.elements((node) => node.type === "button").length, 1);
  assert.equal(ui.elements((node) => node.type === "input")[0].props.value, "Option 3");
  const forms = ui.elements((node) => node.type === "form");
  for (const form of forms.slice(0, 3)) form.props.onSubmit({ preventDefault() {} });
  assert.equal(answers.length, 0);
  ui.elements((node) => node.type === "input")[0].props.onChange(); await nextTick();
  forms[3].props.onSubmit({ preventDefault() {} });
  assert.equal(answers[0].index, 3);
  ui.props.question = { ...question, pendingResponse: true, responseState: "queued", pendingResponses: { 2: "queued", 3: "queued" } }; await nextTick();
  forms[3].props.onSubmit({ preventDefault() {} });
  assert.equal(answers.length, 1, "a pending receipt must prevent duplicate submission");
  assert.equal(ui.elements((node) => node.type === "button").length, 0);
  assert.match(text(ui.root), /回答已排队/);
  assert.doesNotMatch(text(ui.root), /请在桌面端回答|已回答/);
});

test("pending option and freeform responses only emit on explicit submit and never become locally answered", async (t) => {
  const answers = [];
  const ui = await mount(t, { question: dto({ status: "pending" }), canRespond: true, onAnswer: (answer) => answers.push(answer) });
  const form = () => ui.elements((node) => node.type === "form")[0];
  const submit = () => form().props.onSubmit({ preventDefault() {} });
  submit(); assert.equal(answers.length, 0);
  ui.elements((node) => node.type === "input")[1].props.onChange(); await nextTick();
  assert.equal(answers.length, 0);
  submit(); await nextTick();
  assert.equal(answers[0].answer, "Second");
  assert.equal(answers[0].index, 0);
  assert.equal(answers[0].question.callId, "call_question");
  assert.match(text(ui.root), /等待回答/);
  assert.doesNotMatch(text(ui.root), /已回答/);
  ui.elements((node) => node.type === "input").at(-1).props.onChange(); await nextTick();
  ui.elements((node) => node.type === "textarea")[0].props.onInput({ target: { value: "A different choice" } }); await nextTick();
  submit(); assert.equal(answers[1].answer, "A different choice");
  ui.props.question = dto({ callId: "call_next", status: "pending" }); await nextTick();
  assert.equal(ui.elements((node) => node.type === "button")[0].props.disabled, true);
});

test("truncated questions cannot submit incomplete content and queued answers do not claim completion", async (t) => {
  const ui = await mount(t, { question: dto({ status: "pending", truncated: true }), canRespond: true });
  assert.match(text(ui.root), /部分已省略/);
  assert.equal(ui.elements((node) => node.type === "button").length, 0);
  ui.props.question = dto({ status: "queued", answers: { 0: "Second" } }); await nextTick();
  assert.match(text(ui.root), /回答已排队/);
  assert.doesNotMatch(text(ui.root), /已回答|提交回答/);
  assert.equal(ui.elements((node) => node.type === "button").length, 0);
});

test("the real item renderer forwards answer events and renders structured questions without duplicate markdown", async (t) => {
  const answers = [];
  const ui = await mount(t, { item: { id: "call_question", category: "primary", kind: "agentmessage", body: "DUPLICATE_MARKDOWN",
    question: dto({ status: "pending" }) }, canAnswerQuestions: true, onQuestionAnswer: (answer) => answers.push(answer) }, "ThreadItemRenderer");
  assert.doesNotMatch(text(ui.root), /DUPLICATE_MARKDOWN/);
  assert.equal(ui.elements((node) => node.props?.innerHTML).length, 0);
  ui.elements((node) => node.type === "input")[0].props.onChange(); await nextTick();
  ui.elements((node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  assert.equal(answers[0].question.callId, "call_question");
  assert.equal(answers[0].answer, "First");
  ui.props.item.question = dto({ status: "pending", pendingResponse: true }); await nextTick();
  assert.equal(ui.elements((node) => node.type === "button").length, 0);
  assert.match(text(ui.root), /回答待确认/);
  assert.doesNotMatch(text(ui.root), /请在桌面端回答/);
});

test("native freeform questions render an immediate text field and submit through the real item renderer", async (t) => {
  const presented = presentCodexItem(native({ questions: [{ title: "Describe what happened" }] }));
  assert.ok(presented.presentation.question);
  const question = { ...presented.presentation.question, status: "pending" };
  const item = normalizeThreadItem({ id: presented.id, kind: "AgentMessage", text: presented.presentation.text, question });
  const answers = [];
  const ui = await mount(t, { item, canAnswerQuestions: true, onQuestionAnswer: (answer) => answers.push(answer) }, "ThreadItemRenderer");
  assert.equal(ui.elements((node) => node.type === "input").length, 0);
  const fields = ui.elements((node) => node.type === "textarea");
  assert.equal(fields.length, 1);
  assert.equal(fields[0].props["aria-label"], "Describe what happened");
  fields[0].props.onInput({ target: { value: "The page stayed empty" } }); await nextTick();
  assert.equal(answers.length, 0);
  ui.elements((node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  assert.equal(answers[0].question.callId, "call_question");
  assert.equal(answers[0].index, 0);
  assert.equal(answers[0].answer, "The page stayed empty");
});

test("native answer renders one user bubble with a muted question quote and plain answer", async (t) => {
  const answer = "<img src=x onerror=alert(1)>\nA longer reply";
  const wire = buildQuestionAnswer(dto(), 0, answer);
  const item = normalizeThreadItem(presentCodexChatItem({ id: "reply", type: "userMessage", text: wire }));
  const ui = await mount(t, { item }, "ThreadItemRenderer");
  assert.equal(ui.elements((node) => node.type === "article").length, 1);
  assert.equal(ui.elements((node) => node.type === "blockquote")[0].text, "Choose a path?");
  assert.equal(ui.elements((node) => node.type === "p")[0].text, answer);
  assert.equal(text(ui.root).split(answer).length - 1, 1);
  assert.doesNotMatch(text(ui.root), /回答：|send_user_message_question_reply/);
  assert.equal(ui.elements((node) => node.props?.innerHTML || node.type === "img").length, 0, "answers are text, not executable markup");
});

test("multi-question replies keep each question with its own answer and display skipped replies", async (t) => {
  const replies = [{ questionItemId: "one", question: "First question", answer: "First answer" },
    { questionItemId: "two", question: "Second question", answer: "" }];
  const ui = await mount(t, { replies }, "ThreadQuestionReply");
  assert.deepEqual(ui.elements((node) => node.type === "blockquote").map((node) => node.text), ["First question", "Second question"]);
  assert.deepEqual(ui.elements((node) => node.type === "p").map((node) => node.text), ["First answer", "已跳过"]);
});
