import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { compileScript, parse } from "vue/compiler-sfc";
import { parse as parseHtml } from "@vue/compiler-dom";
import { computed, createRenderer, h, markRaw, nextTick, reactive } from "vue";
import hljs from "highlight.js/lib/common";
import { createThreadItemMarkdown } from "../web/src/lib/thread-item-markdown.js";
import { codeHighlighter, createCodeHighlighter } from "../web/src/lib/code-highlighting.js";
import { presentCodexItem } from "../src/sessions/codex/itemPresentation.js";
import { createCodexChatStore } from "../web/src/lib/codex-chat-store.js";
import { createCodexChatPresenter } from "../web/src/lib/codex-chat-presentation.js";
import { createThreadViewModelBuilder } from "../web/src/lib/thread-view-model.js";

// Existing cache assertions describe the warm highlighter. Cold loading is tested with isolated loaders below.
await codeHighlighter.load();

const primaryTags = ["p", "br", "pre", "code", "blockquote", "ul", "ol", "li", "a", "strong", "em", "del", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img", "span", "div", "table", "thead", "tbody", "tr", "th", "td"];
const primaryAttrs = ["href", "target", "rel", "class", "src", "alt", "title", "role", "tabindex", "loading", "decoding", "aria-label"];
const sourceUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const factoryUrl = new URL("../web/src/lib/thread-item-markdown.js", import.meta.url).href;
const markdownConstructorProbe = sourceUrl(`import MarkdownIt from ${JSON.stringify(import.meta.resolve("markdown-it"))};
export default function (...args) {
  globalThis.__threadItemMarkdownProbe.parserInitializations += 1;
  return new MarkdownIt(...args);
}`);
const trackedFactoryUrl = sourceUrl(fs.readFileSync(new URL(factoryUrl), "utf8")
  .replace(/from\s+["']([^"']+)["']/g, (_, name) => `from ${JSON.stringify(name === "markdown-it" ? markdownConstructorProbe
    : name.startsWith(".") ? new URL(name, factoryUrl).href : import.meta.resolve(name))}`));
const factoryProbe = sourceUrl(`import { createThreadItemMarkdown as create } from ${JSON.stringify(trackedFactoryUrl)};
export function createThreadItemMarkdown(options) {
  const current = globalThis.__threadItemMarkdownProbe, renderer = create({ ...options,
    ...(current.highlighter ? { highlighter: current.highlighter } : {}) });
  return { ...renderer,
    renderMarkdown(...args) { current.markdown += 1; return renderer.renderMarkdown(...args); },
    renderCodeFence(...args) { current.fence += 1; return renderer.renderCodeFence(...args); },
    clearFenceCache(...args) { current.clears += 1; return renderer.clearFenceCache?.(...args); }
  };
}`);
// Node has no DOM; this spy verifies the component's sanitizer boundary and options only.
const sanitizerProbe = sourceUrl("export default { sanitize(value, config) { const probe = globalThis.__threadItemMarkdownProbe; probe.sanitized.push({ value, config }); return probe.sanitize ? probe.sanitize(value, config) : value; } };");
const itemComponentFile = new URL("../web/src/components/thread-item/ThreadItemRenderer.vue", import.meta.url);
const timelineComponentFile = new URL("../web/src/components/thread-item/ThreadTurnTimeline.vue", import.meta.url);
function componentSource(file) {
  const { descriptor } = parse(fs.readFileSync(file, "utf8"), { filename: file.pathname });
  const source = compileScript(descriptor, { id: "thread-item-markdown-test", inlineTemplate: true }).content
    .replace(/from\s+["']([^"']+)["']/g, (_, name) => `from ${JSON.stringify(name === "dompurify" ? sanitizerProbe
      : name.endsWith("/thread-item-markdown.js") ? factoryProbe : name.endsWith(".vue") ? componentSource(new URL(name, file))
        : name.startsWith(".") ? new URL(name, file).href : import.meta.resolve(name))}`);
  return sourceUrl(source);
}
async function loadComponent(file) {
  return (await import(componentSource(file))).default;
}
function find(node, predicate) {
  return [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap((child) => find(child, predicate))];
}
function renderedTree(node) {
  return { type: node.type, text: node.text,
    props: Object.fromEntries(Object.entries(node.props || {}).filter(([key, value]) => !key.startsWith("on") && typeof value !== "function")),
    children: (node.children || []).map(renderedTree) };
}
async function mount(t, item, extra = {}, componentFile = itemComponentFile, { sanitize, highlighter } = {}) {
  const previous = globalThis.__threadItemMarkdownProbe;
  const probe = { markdown: 0, fence: 0, clears: 0, parserInitializations: 0, sanitized: [], sanitize, highlighter };
  globalThis.__threadItemMarkdownProbe = probe;
  const renderer = createRenderer({
    createElement: (type) => markRaw({ type, props: {}, children: [] }), createText: (text) => ({ text }), createComment: (text) => ({ text }),
    setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: (node) => node?.parent || null, nextSibling: (node) => node?.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    insert(node, parent, anchor) { if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node); node.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node); },
    remove(node) { if (node?.parent) node.parent.children = node.parent.children.filter((child) => child !== node); },
    patchProp: (node, key, _previous, value) => { node.props[key] = value; }
  });
  const Component = await loadComponent(componentFile), props = reactive({ ...(item ? { item } : {}), workspaceCwd: "/work", ...extra });
  const root = { children: [] }, app = renderer.createApp({ render: () => h(Component, props) });
  app.mount(root); await nextTick();
  let unmounted = false;
  const unmount = () => {
    if (!unmounted) { app.unmount(); unmounted = true; globalThis.__threadItemMarkdownProbe = previous; }
  };
  t.after(unmount);
  return { props, probe, unmount, output: (node = root) => renderedTree(node),
    html: () => find(root, (node) => node.props?.innerHTML).map((node) => node.props.innerHTML).join(""),
    all: (predicate) => find(root, predicate) };
}

// This parser-backed double models only allow-list structure, not DOMPurify's browser security behavior.
function allowListedHtml(value, config) {
  const tags = new Set(config.ALLOWED_TAGS), attrs = new Set(config.ALLOWED_ATTR);
  const voidTags = new Set(["br", "hr", "img"]);
  const render = (node) => {
    if (node.type !== 1) return node.loc.source;
    const children = node.children.map(render).join("");
    if (!tags.has(node.tag)) return children;
    const attributes = node.props.filter((prop) => prop.type === 6 && attrs.has(prop.name))
      .map((prop) => ` ${prop.loc.source}`).join("");
    return `<${node.tag}${attributes}>${children}${voidTags.has(node.tag) ? "" : `</${node.tag}>`}`;
  };
  return parseHtml(value).children.map(render).join("");
}
const htmlElements = (html, tag) => find(parseHtml(html), (node) => node.type === 1 && node.tag === tag);
function tableFixture(columns) {
  const row = (cells) => `| ${cells.join(" | ")} |`;
  const longWord = "unbrokenword".repeat(120);
  return { longWord, source: [
    row(Array.from({ length: columns }, (_, index) => `列 ${index + 1}`)),
    row(Array(columns).fill("---")),
    row(Array.from({ length: columns }, (_, index) => index === 0 ? "中文内容" : "")),
    row(Array.from({ length: columns }, (_, index) => index === 0 ? "first\\|second" : "`inline`")),
    row(Array.from({ length: columns }, (_, index) => index === 0 ? longWord : `row 3 cell ${index + 1}`))
  ].join("\n") };
}
function trackHighlights(t) {
  const original = hljs.highlight, originalAuto = hljs.highlightAuto;
  const calls = { known: 0, auto: 0 };
  hljs.highlight = function (...args) { calls.known += 1; return original.apply(this, args); };
  hljs.highlightAuto = function (...args) { calls.auto += 1; return originalAuto.apply(this, args); };
  t.after(() => { hljs.highlight = original; hljs.highlightAuto = originalAuto; });
  return calls;
}
const primary = (body, extra = {}) => ({ id: "answer", category: "primary", kind: "agentmessage", body, ...extra });
const processItem = (body, extra = {}) => ({ id: "command", category: "process", kind: "commandexecution", body, ...extra });
const commandOutput = (lines, prefix = "RESULT") => Array.from({ length: lines }, (_, index) =>
  `export ${prefix}_${index}="record-${index} path=/work/result/${index} done"`).join("\n");
const typedCommand = (body) => ({ ...presentCodexItem({ id: "command", type: "commandExecution", command: "printenv",
  aggregatedOutput: body, status: "completed" }, { detail: true }), detailsLoaded: true });
const typedAnswer = (text, status = "inProgress") => presentCodexItem({ id: "answer", type: "agentMessage", text, status }, { detail: true });
function pendingHighlighter() {
  let resolve, reject, loads = 0;
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  const highlighter = createCodeHighlighter(() => { loads += 1; return pending; });
  return { highlighter, resolve: () => resolve({ default: hljs }), reject, get loads() { return loads; } };
}
async function mountProcessTimeline(t, { lines = 760, expanded = true } = {}) {
  const store = createCodexChatStore("process-stream", { reactive });
  store.upsertTurn({ id: "history", status: "completed", items: [presentCodexItem({ id: "historic-answer", type: "agentMessage",
    text: "Historical **answer**.", status: "completed" }, { detail: true })] });
  store.upsertTurn({ id: "live", status: "inProgress", items: [typedCommand(commandOutput(lines)), typedAnswer("Live answer.")] });
  const present = createCodexChatPresenter(), build = createThreadViewModelBuilder();
  const snapshot = computed(() => present(store.state)), model = computed(() => build(snapshot.value, { assistantName: "Codex" }));
  const ui = await mount(t, null, { snapshot, threadViewModel: model, processExpanded: { live: expanded } }, timelineComponentFile);
  const generation = store.beginSocket(); let sequence = 0;
  return { ...ui, store, snapshot, model,
    async delta() {
      store.applyEvent({ schemaVersion: 2, epoch: "", threadId: "process-stream", seq: ++sequence, type: "item.delta",
        payload: { turnId: "live", itemId: "answer", field: "text", text: `\nDelta ${sequence}: **detail**.` } }, generation);
      await nextTick();
    },
    processNode: () => ui.all((node) => node.type === "article" && String(node.props?.class || "").includes("thread-item-process"))[0] };
}

test("cold Markdown imports highlighting only for code and refreshes its bounded fallback cache", async (t) => {
  const lazy = pendingHighlighter(), calls = trackHighlights(t);
  const plain = createThreadItemMarkdown({ highlighter: lazy.highlighter });
  const coded = createThreadItemMarkdown({ highlighter: lazy.highlighter });
  let plainRenders = 0, codeRenders = 0;
  const plainHtml = computed(() => { plainRenders += 1; return plain.renderMarkdown("**plain** `inline`"); });
  const codeHtml = computed(() => { codeRenders += 1; return coded.renderMarkdown("```js\nconst safe = '<script>&';\n```\n"); });
  assert.match(plainHtml.value, /<strong>plain<\/strong>/);
  await Promise.resolve();
  assert.equal(lazy.loads, 0);
  const fallback = codeHtml.value;
  assert.match(fallback, /&lt;script&gt;&amp;/);
  assert.doesNotMatch(fallback, /<script>|hljs-keyword/);
  assert.equal(codeHtml.value, fallback);
  await Promise.resolve();
  assert.equal(lazy.loads, 1);
  assert.equal(calls.known, 0);
  lazy.resolve(); await lazy.highlighter.load();
  assert.match(codeHtml.value, /hljs-keyword/);
  assert.match(plainHtml.value, /<strong>plain<\/strong>/);
  assert.equal(plainRenders, 1);
  assert.equal(codeRenders, 2);
  assert.equal(calls.known, 1);
  coded.renderMarkdown("```js\nconst safe = '<script>&';\n```\nnext tail");
  assert.equal(calls.known, 1, "the highlighted result replaces the cached escaped fallback");
});

test("cold code escapes source and untrusted language metadata before any highlighter is available", () => {
  const lazy = pendingHighlighter(), renderer = createThreadItemMarkdown({ highlighter: lazy.highlighter });
  const html = renderer.renderCodeFence('<img onerror="bad"> & \'text\'', 'x\" onmouseover=\"bad');
  assert.match(html, /language-plaintext/);
  assert.match(html, /&lt;img onerror=&quot;bad&quot;&gt; &amp; &#x27;text&#x27;/);
  assert.doesNotMatch(html, /<img|onmouseover/);
});

test("compiled cold code upgrades through the same sanitizer with stable wrapper and text", async (t) => {
  const lazy = pendingHighlighter();
  const ui = await mount(t, primary("```js\nconst safe = '<script>&';\nconsole.log(safe);\n```"), {}, itemComponentFile,
    { highlighter: lazy.highlighter, sanitize: allowListedHtml });
  const original = ui.html();
  assert.doesNotMatch(original, /hljs-keyword/);
  assert.equal(ui.probe.sanitized.length, 1);
  const structure = (html) => ({ pre: htmlElements(html, "pre").map((node) => node.props),
    code: htmlElements(html, "code").map((node) => node.props) });
  const codeText = (html) => {
    const text = (node) => node.type === 1 ? node.children.map(text).join("") : node.content || "";
    return htmlElements(html, "code").map(text);
  };
  lazy.resolve(); await lazy.highlighter.load(); await nextTick();
  assert.match(ui.html(), /hljs-keyword/);
  assert.deepEqual(structure(ui.html()), structure(original));
  assert.deepEqual(codeText(ui.html()), codeText(original));
  assert.equal(ui.probe.sanitized.length, 2);
  assert.deepEqual(ui.probe.sanitized[1].config, ui.probe.sanitized[0].config);
});

test("late highlighting uses the latest streamed code and leaves unmounted or plain items alone", async (t) => {
  for (const state of ["rewrite", "plain", "unmounted"]) await t.test(state, async (t) => {
    const lazy = pendingHighlighter(), calls = trackHighlights(t);
    const ui = await mount(t, processItem("echo initial"), {}, itemComponentFile, { highlighter: lazy.highlighter });
    if (state === "rewrite") ui.props.item = processItem("echo current");
    if (state === "plain") ui.props.item = primary("plain replacement");
    if (state === "unmounted") ui.unmount();
    await nextTick();
    const before = ui.probe.sanitized.length;
    lazy.resolve(); await lazy.highlighter.load(); await nextTick();
    assert.equal(ui.probe.sanitized.length, before + (state === "rewrite" ? 1 : 0));
    assert.equal(calls.known, state === "rewrite" ? 1 : 0);
    if (state === "rewrite") { assert.match(ui.html(), /current/); assert.doesNotMatch(ui.html(), /initial/); }
    if (state === "plain") assert.equal(ui.html(), "<p>plain replacement</p>");
  });
});

test("a failed highlighting chunk retains safe code across later streaming updates", async (t) => {
  const lazy = pendingHighlighter();
  const ui = await mount(t, processItem("echo '<script>'"), {}, itemComponentFile, { highlighter: lazy.highlighter });
  lazy.reject(new Error("chunk unavailable")); await lazy.highlighter.load(); await nextTick();
  assert.match(ui.html(), /&lt;script&gt;/);
  ui.props.item = processItem("echo '<script>current</script>'"); await nextTick();
  assert.match(ui.html(), /current/);
  assert.doesNotMatch(ui.html(), /<script>|hljs-built_in/);
  assert.equal(lazy.loads, 1);
});

test("extracted Markdown retains typography, line breaks, escaping and local image/link rules", () => {
  let cwd = "/work/one";
  const renderer = createThreadItemMarkdown({ getCwd: () => cwd });
  const source = '**bold**\n"quoted"\n![image](/tmp/a.png) [doc](docs/a.pdf) [web](https://example.com)\n<script>alert(1)</script> [bad](javascript:alert%281%29)';
  const html = renderer.renderMarkdown(source);
  assert.match(html, /<strong>bold<\/strong><br>/);
  assert.match(html, /“quoted”/);
  assert.match(html, /src="\/api\/local-file-image\?path=%2Ftmp%2Fa.png"/);
  assert.match(html, /role="button" tabindex="0"/);
  assert.match(html, /cwd=%2Fwork%2Fone/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.doesNotMatch(html, /<script>|href="javascript:/);
  cwd = "/work/two";
  assert.match(renderer.renderMarkdown(source), /cwd=%2Fwork%2Ftwo/);
});

test("extracted fence output preserves plaintext escaping and original language aliases", () => {
  const renderer = createThreadItemMarkdown();
  assert.equal(renderer.renderCodeFence('< & "', "text"), '<pre class="code-block language-plaintext family-code"><span class="code-lang">text</span><span class="code-scroll"><code class="hljs language-plaintext">&lt; &amp; &quot;</code></span></pre>');
  for (const language of ["sh", "shell", "zsh", "console", "env"]) {
    const html = renderer.renderCodeFence("echo hello", language);
    assert.match(html, /language-bash family-shell/);
    assert.match(html, /<span class="code-lang">bash<\/span>/);
  }
  assert.match(renderer.renderCodeFence("SELECT 1", "sql"), /language-sql family-sql/);
  assert.match(renderer.renderCodeFence('const value = "safe";', "js"), /language-js family-code/);
});

test("actual compiled primary keeps the sanitizer boundary, options, images and cwd links", async (t) => {
  const ui = await mount(t, primary('![image](/tmp/a.png) [doc](docs/a.pdf)\n<script>alert(1)</script> [bad](javascript:alert%281%29)'));
  assert.equal(ui.probe.markdown, 1);
  assert.deepEqual(ui.probe.sanitized[0].config, { ALLOWED_TAGS: primaryTags, ALLOWED_ATTR: primaryAttrs });
  assert.match(ui.html(), /local-file-image/);
  assert.match(ui.html(), /cwd=%2Fwork/);
  assert.doesNotMatch(ui.html(), /<script>|href="javascript:/);
  ui.props.workspaceCwd = "/other"; await nextTick();
  assert.match(ui.html(), /cwd=%2Fother/);
  assert.equal(ui.probe.sanitized.length, 2);
});

test("actual compiled process code retains its separate sanitizer options and user plain text", async (t) => {
  const ui = await mount(t, { id: "command", category: "process", kind: "commandexecution", body: "echo safe", statusLabel: "running" });
  assert.equal(ui.probe.markdown, 0);
  assert.equal(ui.probe.fence, 1);
  assert.match(ui.html(), /language-bash/);
  assert.deepEqual(ui.probe.sanitized[0].config, { ALLOWED_TAGS: ["pre", "code", "span"], ALLOWED_ATTR: ["class"] });
  ui.props.item = { id: "command", category: "user", body: "**plain user**" }; await nextTick();
  assert.equal(ui.probe.markdown, 0);
  assert.equal(ui.html(), "");
  assert.equal(ui.all((node) => node.type === "pre")[0].text, "**plain user**");
});

test("compiled plain text and process code initialize Markdown only when primary text first needs it", async (t) => {
  const ui = await mount(t, { id: "message", category: "user", body: "**plain user**" });
  assert.equal(ui.probe.parserInitializations, 0);
  ui.props.item = processItem("echo safe"); await nextTick();
  assert.equal(ui.probe.fence, 1);
  assert.equal(ui.probe.parserInitializations, 0);
  ui.props.item = primary("| File | Image |\n| --- | --- |\n| [doc](docs/a.pdf) | ![result](/tmp/a.png) |"); await nextTick();
  assert.equal(ui.probe.parserInitializations, 1);
  assert.match(ui.html(), /markdown-table-scroll/);
  assert.match(ui.html(), /cwd=%2Fwork/);
  assert.match(ui.html(), /local-file-image/);
  ui.props.workspaceCwd = "/changed"; await nextTick();
  assert.match(ui.html(), /cwd=%2Fchanged/);
  ui.props.item = primary("**next body**"); await nextTick();
  assert.equal(ui.probe.parserInitializations, 1);
  assert.match(ui.html(), /<strong>next body<\/strong>/);
});

test("compiled Markdown tables keep native rows and cells after the component allow-list boundary", async (t) => {
  for (const columns of [2, 9]) await t.test(`${columns} columns with multiple rows, blank cells, Chinese and a long word`, async (t) => {
    const { source, longWord } = tableFixture(columns);
    const ui = await mount(t, primary(source), {}, itemComponentFile, { sanitize: allowListedHtml });
    assert.equal(htmlElements(ui.probe.sanitized[0].value, "table").length, 1, "Markdown must generate the table before cleaning");
    assert.equal(htmlElements(ui.html(), "table").length, 1, "the component allow-list must retain the generated table");
    assert.equal(htmlElements(ui.html(), "thead").length, 1);
    assert.equal(htmlElements(ui.html(), "tbody").length, 1);
    assert.equal(htmlElements(ui.html(), "tr").length, 4);
    assert.equal(htmlElements(ui.html(), "th").length, columns);
    assert.equal(htmlElements(ui.html(), "td").length, columns * 3);
    assert.match(ui.html(), /中文内容/);
    assert.match(ui.html(), /first\|second/);
    assert(ui.html().includes(longWord));
    assert.equal(htmlElements(ui.html(), "td").filter((node) => !node.children.length).length, columns - 1);
    const scroll = htmlElements(ui.html(), "div").find((node) => node.props.some((prop) => prop.name === "class" && prop.value?.content === "markdown-table-scroll"));
    assert(scroll, "a table needs its own scrolling container");
    assert.equal(scroll.children.filter((node) => node.tag === "table").length, 1);
    const attributes = Object.fromEntries(scroll.props.map((prop) => [prop.name, prop.value?.content]));
    assert.equal(attributes.tabindex, "0");
    assert.equal(attributes.role, "region");
    assert(attributes["aria-label"]);
  });
});

test("original primary allow-list reproduces table structure loss despite valid Markdown output", () => {
  const rendered = createThreadItemMarkdown().renderMarkdown(tableFixture(9).source);
  const tags = primaryTags.filter((tag) => !["div", "table", "thead", "tbody", "tr", "th", "td"].includes(tag));
  assert.equal(htmlElements(rendered, "table").length, 1);
  const stripped = allowListedHtml(rendered, { ALLOWED_TAGS: tags, ALLOWED_ATTR: primaryAttrs });
  assert.equal(htmlElements(stripped, "table").length, 0);
  assert.equal(htmlElements(stripped, "th").length, 0);
  assert.equal(htmlElements(stripped, "td").length, 0);
  assert.match(stripped, /中文内容/);
});

test("compiled table cells retain escaped HTML and existing safe image and link rules", async (t) => {
  const source = '| Content | Media |\n| --- | --- |\n| <img src=x onerror="alert(1)" style="width:999px"><script>alert(1)</script> | ![image](/tmp/table.png) |\n| [bad](javascript:alert%281%29) [data](data:text/html;base64,PHNjcmlwdD4=) | [doc](docs/a.pdf) [web](https://example.com) |';
  const ui = await mount(t, primary(source), {}, itemComponentFile, { sanitize: allowListedHtml });
  assert.equal(htmlElements(ui.html(), "table").length, 1);
  assert.equal(htmlElements(ui.html(), "script").length, 0);
  assert.equal(htmlElements(ui.html(), "img").length, 1);
  assert.match(ui.html(), /&lt;img/);
  assert.match(ui.html(), /local-file-image\?path=%2Ftmp%2Ftable.png/);
  assert.match(ui.html(), /role="button" tabindex="0"/);
  assert.match(ui.html(), /cwd=%2Fwork/);
  assert.match(ui.html(), /href="https:\/\/example.com"/);
  assert.doesNotMatch(ui.html(), /(?:href|src)="(?:javascript:|data:text\/html)/);
  const config = ui.probe.sanitized[0].config;
  assert(!config.ALLOWED_ATTR.includes("style"));
  assert(!config.ALLOWED_ATTR.some((name) => /^on/i.test(name)));
  assert(!find(parseHtml(ui.html()), (node) => node.type === 1 && node.props.some((prop) => prop.name === "style" || /^on/i.test(prop.name))).length);
});

test("fence cache keys include exact source and raw language while retaining auto detection", (t) => {
  const calls = trackHighlights(t), renderer = createThreadItemMarkdown();
  const source = "const value = 1;";
  const first = renderer.renderCodeFence(source, "js");
  assert.equal(renderer.renderCodeFence(source, "js"), first);
  assert.equal(calls.known, 1);
  renderer.renderCodeFence(`${source}\n`, "js");
  renderer.renderCodeFence(source, "ts");
  renderer.renderCodeFence(source, " JS ");
  assert.equal(calls.known, 4);
  const detected = renderer.renderCodeFence(source, "unknown-language");
  assert.equal(renderer.renderCodeFence(source, "unknown-language"), detected);
  assert.equal(calls.auto, 1);
});

test("fence cache evicts after eight entries and remains isolated per factory", (t) => {
  const calls = trackHighlights(t), renderer = createThreadItemMarkdown();
  const code = (index) => `const entry${index} = ${index};`;
  for (let index = 0; index < 8; index++) renderer.renderCodeFence(code(index), "js");
  renderer.renderCodeFence(code(0), "js");
  assert.equal(calls.known, 8);
  renderer.renderCodeFence(code(8), "js");
  renderer.renderCodeFence(code(0), "js");
  assert.equal(calls.known, 10);
  createThreadItemMarkdown().renderCodeFence(code(0), "js");
  assert.equal(calls.known, 11);
});

test("fence string budget evicts before entry limit and oversize output stays complete and uncached", (t) => {
  const calls = trackHighlights(t), renderer = createThreadItemMarkdown();
  const code = (index) => `${index}${"x".repeat(18000)}`;
  for (let index = 0; index < 3; index++) renderer.renderCodeFence(code(index), "text");
  renderer.renderCodeFence(code(0), "text");
  assert.equal(calls.known, 3);
  renderer.renderCodeFence(code(3), "text");
  renderer.renderCodeFence(code(0), "text");
  assert.equal(calls.known, 5, "the 256 KiB budget evicts with only four candidate entries");
  const huge = "z".repeat(70000), before = calls.known;
  assert(renderer.renderCodeFence(huge, "text").includes(huge));
  assert(renderer.renderCodeFence(huge, "text").includes(huge));
  assert.equal(calls.known, before + 2, "oversize content must render fully each time");
});

test("fence budget includes retained language strings", (t) => {
  const calls = trackHighlights(t), renderer = createThreadItemMarkdown();
  const language = "unknown".repeat(20000);
  const expected = renderer.renderCodeFence("safe", language);
  assert.equal(renderer.renderCodeFence("safe", language), expected);
  assert.equal(calls.auto, 2);
});

test("failed highlighter results never enter the fence cache and explicit clearing releases entries", (t) => {
  const original = hljs.highlight;
  let calls = 0;
  hljs.highlight = function (...args) { calls += 1; if (calls === 1) throw new Error("highlight failed"); return original.apply(this, args); };
  t.after(() => { hljs.highlight = original; });
  const renderer = createThreadItemMarkdown(), source = "const value = 1;";
  assert.throws(() => renderer.renderCodeFence(source, "js"), /highlight failed/);
  const expected = renderer.renderCodeFence(source, "js");
  assert.equal(renderer.renderCodeFence(source, "js"), expected);
  assert.equal(calls, 2);
  renderer.clearFenceCache();
  assert.equal(renderer.renderCodeFence(source, "js"), expected);
  assert.equal(calls, 3);
});

test("Markdown tails reuse closed fences while growing code recomputes the current source", (t) => {
  const calls = trackHighlights(t), renderer = createThreadItemMarkdown();
  const closed = "```js\nconst fixed = 1;\n```\n";
  for (let index = 0; index < 12; index++) assert.match(renderer.renderMarkdown(`${closed}tail ${index}`), new RegExp(`tail ${index}`));
  assert.equal(calls.known, 1);
  for (let index = 0; index < 12; index++) assert.match(renderer.renderMarkdown(`\`\`\`js\nconst growing = ${index};\n`), new RegExp(String(index)));
  assert.equal(calls.known, 13);
});

test("compiled unchanged sibling item objects avoid Markdown while live metadata still updates", async (t) => {
  const ui = await mount(t, primary("**same**"));
  for (let index = 0; index < 8; index++) {
    ui.props.item = primary("**same**", { status: "completed", isLiveOverlay: index % 2 === 0 });
    await nextTick();
  }
  assert.equal(ui.probe.markdown, 1);
  assert.equal(ui.probe.sanitized.length, 1);
  assert.equal(ui.all((node) => node.type === "article")[0].props.class.includes("is-live-overlay"), false);
  ui.props.item = primary("**changed**"); await nextTick();
  assert.equal(ui.probe.markdown, 2);
  assert.match(ui.html(), /<strong>changed<\/strong>/);
});

test("compiled category transitions preserve primary Markdown, process code and status rendering", async (t) => {
  const ui = await mount(t, primary("echo safe"));
  ui.props.item = { id: "answer", category: "process", kind: "commandexecution", body: "echo safe", status: "running", statusLabel: "Running" }; await nextTick();
  assert.match(ui.html(), /language-bash/);
  assert.equal(ui.probe.markdown, 1);
  assert.equal(ui.all((node) => node.props?.["data-status"] === "running")[0].text, "Running");
  ui.props.item = { ...ui.props.item, kind: "filechange", status: "completed", statusLabel: "Done" }; await nextTick();
  assert.match(ui.html(), /language-diff/);
  assert.equal(ui.all((node) => node.props?.["data-status"] === "completed")[0].text, "Done");
  ui.props.item = primary("echo safe"); await nextTick();
  assert.equal(ui.html(), "<p>echo safe</p>\n".trim());
});

test("compiled authoritative rewrite, language, cwd and image changes still rerender and sanitize", async (t) => {
  const calls = trackHighlights(t);
  const prefix = "```js\nconst draft = 1;\n```\n";
  const ui = await mount(t, primary(`${prefix}[doc](docs/a.pdf)`));
  ui.props.item = primary(`${prefix}[doc](docs/a.pdf)\n\nstreamed tail`); await nextTick();
  assert.equal(ui.probe.markdown, 2);
  assert.equal(calls.known, 1);
  assert.equal(ui.probe.sanitized.length, 2, "a fence hit must not bypass primary sanitization");
  const final = "```ts\nconst official = 2;\n```\n\n![image](/tmp/final.png) [doc](docs/final.pdf)\n\nFinal calibrated.";
  ui.props.item = primary(final, { status: "completed" }); await nextTick();
  assert.equal(calls.known, 2);
  assert.equal(ui.probe.sanitized.length, 3);
  assert.match(ui.html(), /official/);
  assert.doesNotMatch(ui.html(), /draft|streamed tail/);
  assert.match(ui.html(), /local-file-image\?path=%2Ftmp%2Ffinal.png/);
  ui.props.workspaceCwd = "/alternate"; await nextTick();
  assert.match(ui.html(), /cwd=%2Falternate/);
  assert.equal(ui.probe.markdown, 4);
  assert.equal(calls.known, 2);
  assert.equal(ui.probe.sanitized.length, 4);
});

test("compiled renderer clears private fence entries on item identity changes and unmount", async (t) => {
  const calls = trackHighlights(t), prefix = "```js\nconst fixed = 1;\n```\n";
  const ui = await mount(t, primary(prefix));
  ui.props.item = primary(`${prefix}next item`, { id: "other-answer" }); await nextTick();
  assert.equal(ui.probe.clears, 1);
  assert.equal(calls.known, 2);
  ui.unmount();
  assert.equal(ui.probe.clears, 2);
});

test("compiled typed timeline keeps an overbudget completed process stable during sibling deltas and final rewrites", async (t) => {
  const body = commandOutput(760), expected = createThreadItemMarkdown().renderCodeFence(body, "bash");
  assert(2 * (body.length + "bash".length + expected.length) > 256 * 1024);
  const calls = trackHighlights(t), ui = await mountProcessTimeline(t);
  const initialProcess = ui.output(ui.processNode()), initialSanitized = ui.probe.sanitized.length;
  assert.equal(ui.probe.fence, 1);
  assert.equal(calls.known, 1);
  assert(ui.html().includes(expected));
  for (let index = 0; index < 24; index++) {
    await ui.delta();
    assert.deepEqual(ui.output(ui.processNode()), initialProcess);
  }
  assert.equal(ui.probe.fence, 1, "stable process source and language must avoid even an uncached fence call");
  assert.equal(calls.known, 1);
  assert.equal(ui.probe.sanitized.length, initialSanitized + 24);
  const official = commandOutput(760, "OFFICIAL");
  ui.store.upsertItem("live", typedCommand(official)); await nextTick();
  assert.equal(ui.probe.fence, 2);
  assert.equal(calls.known, 2);
  assert(ui.html().includes("OFFICIAL_759"));
  assert(!ui.html().includes("RESULT_759"));
  ui.store.upsertItem("live", typedAnswer("Authoritative **final**.", "completed"));
  ui.store.upsertTurn({ id: "live", status: "completed" }); await nextTick();
  const completedOutput = ui.output();
  assert(ui.html().includes("Authoritative <strong>final</strong>"));
  const snapshot = ui.snapshot.value, threadViewModel = ui.model.value;
  ui.unmount();
  const fresh = await mount(t, null, { snapshot, threadViewModel, processExpanded: { live: true } }, timelineComponentFile);
  assert.deepEqual(fresh.output(), completedOutput, "streamed and authoritatively rewritten output must match a fresh full mount");
});

test("compiled typed timeline avoids repeated process sanitization when a small fence would hit the cache", async (t) => {
  const calls = trackHighlights(t), ui = await mountProcessTimeline(t, { lines: 120 });
  const initialProcess = ui.output(ui.processNode()), initialSanitized = ui.probe.sanitized.length;
  for (let index = 0; index < 24; index++) await ui.delta();
  assert.deepEqual(ui.output(ui.processNode()), initialProcess);
  assert.equal(calls.known, 1);
  assert.equal(ui.probe.fence, 1);
  assert.equal(ui.probe.sanitized.length, initialSanitized + 24, "only the live answer crosses the sanitizer boundary");
});

test("compiled typed timeline keeps collapsed large process work unmounted and releases it on collapse", async (t) => {
  const calls = trackHighlights(t), ui = await mountProcessTimeline(t, { expanded: false });
  const initialSanitized = ui.probe.sanitized.length;
  for (let index = 0; index < 8; index++) await ui.delta();
  assert.equal(ui.processNode(), undefined);
  assert.equal(ui.probe.fence, 0);
  assert.equal(calls.known, 0);
  assert.equal(ui.probe.sanitized.length, initialSanitized + 8);
  ui.props.processExpanded.live = true; await nextTick();
  assert.equal(ui.probe.fence, 1);
  const expandedOutput = ui.output(ui.processNode());
  ui.props.processExpanded.live = false; await nextTick();
  assert.equal(ui.processNode(), undefined);
  assert.equal(ui.probe.clears, 1);
  ui.props.processExpanded.live = true; await nextTick();
  assert.equal(ui.probe.fence, 2);
  assert.equal(calls.known, 2);
  assert.deepEqual(ui.output(ui.processNode()), expandedOutput);
});

test("compiled process primitive inputs still follow source, language, category and identity changes", async (t) => {
  const renderer = createThreadItemMarkdown();
  const original = '{"value":1}', changed = '{"value":2}', auto = "echo safe\npwd", official = "echo authoritative";
  const expected = { bash: renderer.renderCodeFence(original, "bash"), json: renderer.renderCodeFence(original, "json"),
    changed: renderer.renderCodeFence(changed, "json"), auto: renderer.renderCodeFence(auto, ""),
    diff: renderer.renderCodeFence(auto, "diff"), official: renderer.renderCodeFence(official, "bash"), empty: renderer.renderCodeFence("", "bash") };
  const calls = trackHighlights(t), ui = await mount(t, processItem(original));
  assert.equal(ui.html(), expected.bash);
  ui.props.item = processItem(original, { kind: "dynamictoolcall" }); await nextTick();
  assert.equal(ui.html(), expected.json);
  const jsonFenceCalls = ui.probe.fence, jsonSanitized = ui.probe.sanitized.length;
  ui.props.item = processItem(original, { kind: "mcptoolcall" }); await nextTick();
  assert.equal(ui.html(), expected.json);
  assert.equal(ui.probe.fence, jsonFenceCalls, "a kind change with the same JSON language must keep the stable body");
  assert.equal(ui.probe.sanitized.length, jsonSanitized);
  ui.props.item = processItem(changed, { kind: "mcptoolcall" }); await nextTick();
  assert.equal(ui.html(), expected.changed);
  ui.props.item = processItem(auto, { kind: "reasoning" }); await nextTick();
  assert.equal(ui.html(), expected.auto);
  assert.equal(calls.auto, 1);
  ui.props.item = processItem(auto, { kind: "filechange" }); await nextTick();
  assert.equal(ui.html(), expected.diff);
  assert.deepEqual(ui.probe.sanitized.at(-1).config, { ALLOWED_TAGS: ["pre", "code", "span"], ALLOWED_ATTR: ["class"] });
  ui.props.item = primary("**Final**", { id: "command" }); await nextTick();
  assert.equal(ui.html(), "<p><strong>Final</strong></p>");
  assert.deepEqual(ui.probe.sanitized.at(-1).config, { ALLOWED_TAGS: primaryTags, ALLOWED_ATTR: primaryAttrs });
  ui.props.item = { id: "command", category: "user", kind: "usermessage", body: "**literal**" }; await nextTick();
  assert.equal(ui.html(), "");
  assert.equal(ui.all((node) => node.type === "pre")[0].text, "**literal**");
  ui.props.item = processItem(""); await nextTick(); assert.equal(ui.html(), expected.empty);
  ui.props.item = processItem("inline plain", { kind: "dynamictoolcall" }); await nextTick(); assert.equal(ui.html(), "");
  ui.props.item = processItem(official, { status: "completed", statusLabel: "Done" }); await nextTick();
  assert.equal(ui.html(), expected.official);
  const beforeIdentity = calls.known, beforeClears = ui.probe.clears;
  ui.props.item = processItem(official, { id: "different", status: "completed" }); await nextTick();
  assert.equal(ui.probe.clears, beforeClears + 1);
  assert.equal(ui.html(), expected.official);
  ui.props.item = processItem("echo another", { id: "different" }); await nextTick();
  ui.props.item = processItem(official, { id: "different" }); await nextTick();
  assert.equal(calls.known, beforeIdentity + 2, "identity clearing must release the previous item's fence entries");
  assert.equal(ui.html(), expected.official);
});
