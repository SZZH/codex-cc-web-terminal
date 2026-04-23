<script setup>
import { computed } from "vue";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import hljs from "highlight.js";

const props = defineProps({
  item: { type: Object, required: true },
  assistantName: { type: String, default: "Codex" }
});

function normalizeLanguageTag(lang) {
  const key = String(lang || "")
    .trim()
    .toLowerCase();
  if (!key) {
    return "";
  }
  if (["sh", "shell", "zsh", "console", "env"].includes(key)) {
    return "bash";
  }
  if (["plain", "text"].includes(key)) {
    return "plaintext";
  }
  return key;
}

function classifyLanguageFamily(language) {
  const key = String(language || "").toLowerCase();
  if (!key) {
    return "plain";
  }
  if (["sql", "postgresql", "mysql", "plsql"].includes(key)) {
    return "sql";
  }
  if (["bash", "shell", "zsh", "powershell", "pwsh", "fish", "sh"].includes(key)) {
    return "shell";
  }
  if (
    [
      "javascript",
      "typescript",
      "tsx",
      "jsx",
      "json",
      "yaml",
      "toml",
      "ini",
      "xml",
      "html",
      "css",
      "scss",
      "less",
      "dockerfile",
      "nginx",
      "markdown"
    ].includes(key)
  ) {
    return "config";
  }
  return "code";
}

function renderCodeFence(sourceText, languageTag = "") {
  const normalizedLanguage = normalizeLanguageTag(languageTag);
  let highlighted = "";
  let resolvedLanguage = "";

  if (normalizedLanguage && hljs.getLanguage(normalizedLanguage)) {
    highlighted = hljs.highlight(sourceText, {
      language: normalizedLanguage,
      ignoreIllegals: true
    }).value;
    resolvedLanguage = normalizedLanguage;
  } else {
    const auto = hljs.highlightAuto(sourceText);
    highlighted = auto.value;
    resolvedLanguage = String(auto.language || "plaintext").toLowerCase();
  }

  const family = classifyLanguageFamily(resolvedLanguage);
  const languageLabel = resolvedLanguage === "plaintext" ? "text" : resolvedLanguage;
  return [
    `<pre class="code-block language-${resolvedLanguage} family-${family}">`,
    `<span class="code-lang">${languageLabel}</span>`,
    `<span class="code-scroll"><code class="hljs language-${resolvedLanguage}">${highlighted}</code></span>`,
    "</pre>"
  ].join("");
}

const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  typographer: true,
  highlight(code, language) {
    return renderCodeFence(String(code || ""), language);
  }
});

const shouldRenderMarkdown = computed(() => props.item?.category === "primary");
const isProcessItem = computed(() => props.item?.category === "process");
const processKindClass = computed(() => {
  if (!isProcessItem.value) {
    return "";
  }
  const kind = String(props.item?.kind || "").trim().toLowerCase();
  if (kind === "reasoning") return "is-reasoning";
  if (kind === "commandexecution") return "is-command";
  if (kind === "filechange") return "is-file";
  if (kind === "mcptoolcall" || kind === "dynamictoolcall" || kind === "websearch") return "is-tool";
  if (kind === "collabagenttoolcall") return "is-collab";
  return "is-other";
});
const processHeader = computed(() => {
  if (!isProcessItem.value) {
    return "";
  }
  return String(props.item?.title || props.item?.label || "").trim();
});
const processSummary = computed(() => {
  if (!isProcessItem.value) {
    return "";
  }
  const summary = String(props.item?.summary || "").trim();
  const label = String(props.item?.label || "").trim();
  if (!summary || summary === label) {
    return "";
  }
  return summary;
});
const processStatus = computed(() => {
  if (!isProcessItem.value) {
    return "";
  }
  return String(props.item?.statusLabel || "").trim();
});
const processBody = computed(() => {
  if (!isProcessItem.value) {
    return "";
  }
  return String(props.item?.body || "").trim();
});
const shouldRenderProcessCode = computed(() => {
  if (!isProcessItem.value) {
    return false;
  }
  const kind = String(props.item?.kind || "").trim().toLowerCase();
  if (["commandexecution", "filechange"].includes(kind)) {
    return true;
  }
  const body = processBody.value;
  if (!body) {
    return false;
  }
  return (
    body.includes("\n") ||
    /^\s*[\[{]/.test(body) ||
    /^diff --git/m.test(body) ||
    /^@@/m.test(body) ||
    /(^|\n)(npm |pnpm |yarn |node |python |python3 |bash |zsh |git |curl |cd |ls |cat |sed |rg )/.test(body)
  );
});
const renderedProcessBody = computed(() => {
  if (!shouldRenderProcessCode.value) {
    return "";
  }
  const kind = String(props.item?.kind || "").trim().toLowerCase();
  const language =
    kind === "commandexecution"
      ? "bash"
      : kind === "filechange"
        ? "diff"
        : processBody.value.trim().startsWith("{") || processBody.value.trim().startsWith("[")
          ? "json"
          : "";
  return DOMPurify.sanitize(renderCodeFence(processBody.value, language), {
    ALLOWED_TAGS: ["pre", "code", "span"],
    ALLOWED_ATTR: ["class"]
  }).trim();
});

const renderedBody = computed(() => {
  const body = String(props.item?.body || "").trim();
  if (!body) {
    return "";
  }
  if (!shouldRenderMarkdown.value) {
    return "";
  }
  return DOMPurify.sanitize(md.render(body), {
    ALLOWED_TAGS: [
      "p",
      "br",
      "pre",
      "code",
      "blockquote",
      "ul",
      "ol",
      "li",
      "a",
      "strong",
      "em",
      "del",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hr",
      "img",
      "span"
    ],
    ALLOWED_ATTR: ["href", "target", "rel", "class", "src", "alt", "title"]
  }).trim();
});

const itemClasses = computed(() => [
  "thread-item-card",
  `thread-item-${props.item?.category || "process"}`,
  `thread-item-kind-${props.item?.kind || "unknown"}`,
  processKindClass.value,
  {
    "is-live-overlay": Boolean(props.item?.isLiveOverlay),
    "is-unknown-item": Boolean(props.item?.isUnknown)
  }
]);

</script>

<template>
  <article :class="itemClasses">
    <header v-if="isProcessItem" class="thread-item-header">
      <span class="thread-item-kind-pill">{{ processHeader }}</span>
      <span v-if="processStatus" class="thread-item-status">{{ processStatus }}</span>
    </header>
    <p v-if="processSummary" class="thread-item-summary">{{ processSummary }}</p>
    <div
      v-if="isProcessItem && renderedProcessBody"
      class="thread-item-body process-code"
      v-html="renderedProcessBody"
    ></div>
    <div
      v-else-if="isProcessItem && processBody"
      class="thread-item-body process-body"
      :title="processBody"
    >{{ processBody }}</div>
    <div
      v-else-if="renderedBody"
      class="thread-item-body markdown-body"
      v-html="renderedBody"
    ></div>
    <pre
      v-else-if="item.body"
      class="thread-item-body plain-body"
    >{{ item.body }}</pre>
  </article>
</template>

<style scoped>
.thread-item-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.thread-item-status {
  flex-shrink: 0;
  font-size: 11px;
  line-height: 1.35;
  color: #8a7768;
  padding-top: 4px;
}

.thread-item-kind-pill {
  display: inline-flex;
  align-items: center;
  min-height: 26px;
  padding: 0 11px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1;
  font-weight: 700;
  letter-spacing: 0.02em;
  background: rgba(214, 203, 193, 0.9);
  color: #5f5146;
}

.thread-item-summary {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.55;
  color: #756456;
}

.markdown-body :deep(pre code) {
  padding: 0;
  border-radius: 0;
  background: transparent;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre;
  max-width: 100%;
}

.markdown-body :deep(pre.code-block) {
  position: relative;
  margin: 0;
  padding-top: 28px;
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid rgba(81, 88, 106, 0.9);
  background:
    radial-gradient(circle at top right, rgba(118, 129, 160, 0.12), transparent 28%),
    linear-gradient(180deg, rgba(33, 37, 48, 0.98), rgba(22, 25, 34, 0.98));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.04),
    0 12px 30px rgba(26, 24, 32, 0.18);
}

.markdown-body :deep(pre.code-block .code-lang) {
  position: absolute;
  top: 8px;
  right: 10px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10px;
  line-height: 1.3;
  text-transform: lowercase;
  letter-spacing: 0.01em;
  border: 1px solid rgba(111, 124, 156, 0.42);
  background: rgba(255, 255, 255, 0.08);
  color: #d5ddf5;
}

.markdown-body :deep(pre.code-block .code-scroll) {
  display: block;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0 14px 14px;
}

.markdown-body :deep(pre.code-block.family-sql) {
  border-color: rgba(151, 126, 88, 0.82);
}

.markdown-body :deep(pre.code-block.family-shell) {
  border-color: rgba(102, 136, 102, 0.84);
}

.markdown-body :deep(pre.code-block.family-config) {
  border-color: rgba(97, 121, 171, 0.84);
}

.markdown-body :deep(pre.code-block .hljs) {
  display: block;
  min-width: max-content;
  color: #e8ecf8;
  background: transparent;
}

.markdown-body :deep(.hljs-comment),
.markdown-body :deep(.hljs-quote) {
  color: #8d96ad;
  font-style: italic;
}

.markdown-body :deep(.hljs-keyword),
.markdown-body :deep(.hljs-selector-tag),
.markdown-body :deep(.hljs-literal),
.markdown-body :deep(.hljs-built_in),
.markdown-body :deep(.hljs-type) {
  color: #f0b776;
  font-weight: 600;
}

.markdown-body :deep(.hljs-string),
.markdown-body :deep(.hljs-title),
.markdown-body :deep(.hljs-name),
.markdown-body :deep(.hljs-section),
.markdown-body :deep(.hljs-attribute),
.markdown-body :deep(.hljs-symbol),
.markdown-body :deep(.hljs-bullet) {
  color: #86d7aa;
}

.markdown-body :deep(.hljs-number),
.markdown-body :deep(.hljs-meta),
.markdown-body :deep(.hljs-variable),
.markdown-body :deep(.hljs-template-variable),
.markdown-body :deep(.hljs-params) {
  color: #8fb0ff;
}

.process-body {
  font-size: 12.5px;
  line-height: 1.72;
  color: #4a4037;
  white-space: pre-wrap;
  word-break: break-word;
}

.process-code :deep(.process-code-block) {
  margin: 0;
  border-radius: 14px;
  border: 1px solid rgba(81, 88, 106, 0.88);
  background:
    radial-gradient(circle at top right, rgba(118, 129, 160, 0.12), transparent 28%),
    linear-gradient(180deg, rgba(33, 37, 48, 0.98), rgba(22, 25, 34, 0.98));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.04),
    0 10px 24px rgba(26, 24, 32, 0.16);
}

.process-code :deep(.code-lang) {
  color: #d5ddf5;
  border-color: rgba(111, 124, 156, 0.42);
  background: rgba(255, 255, 255, 0.08);
}

.process-code :deep(.code-scroll) {
  padding: 0 14px 14px;
}

.process-code :deep(.hljs) {
  color: #e8ecf8;
}

.process-code :deep(.hljs-comment),
.process-code :deep(.hljs-quote) {
  color: #8d96ad;
  font-style: italic;
}

.process-code :deep(.hljs-keyword),
.process-code :deep(.hljs-selector-tag),
.process-code :deep(.hljs-literal),
.process-code :deep(.hljs-built_in),
.process-code :deep(.hljs-type) {
  color: #f0b776;
}

.process-code :deep(.hljs-string),
.process-code :deep(.hljs-title),
.process-code :deep(.hljs-name),
.process-code :deep(.hljs-section),
.process-code :deep(.hljs-attribute),
.process-code :deep(.hljs-symbol),
.process-code :deep(.hljs-bullet) {
  color: #86d7aa;
}

.process-code :deep(.hljs-number),
.process-code :deep(.hljs-meta),
.process-code :deep(.hljs-variable),
.process-code :deep(.hljs-template-variable),
.process-code :deep(.hljs-params) {
  color: #8fb0ff;
}

.thread-item-process {
  position: relative;
  overflow: visible;
  border-radius: 18px;
  border: 1px solid rgba(215, 205, 196, 0.96);
  background:
    linear-gradient(180deg, rgba(255, 252, 249, 0.94), rgba(246, 240, 234, 0.94)),
    rgba(247, 243, 239, 0.9);
  padding: 14px 16px 15px 18px;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.58) inset,
    0 10px 24px rgba(123, 103, 86, 0.05);
}

.thread-item-process::before {
  content: "";
  position: absolute;
  inset: 12px auto 12px 0;
  width: 3px;
  border-radius: 999px;
  background: rgba(181, 153, 128, 0.8);
}

.thread-item-process.is-reasoning::before {
  background: linear-gradient(180deg, #b58d63 0%, #9d6f45 100%);
}

.thread-item-process.is-command::before {
  background: linear-gradient(180deg, #7e8f73 0%, #5f7355 100%);
}

.thread-item-process.is-file::before {
  background: linear-gradient(180deg, #7a88ad 0%, #5f6f97 100%);
}

.thread-item-process.is-tool::before {
  background: linear-gradient(180deg, #9b7fb0 0%, #80639a 100%);
}

.thread-item-process.is-collab::before {
  background: linear-gradient(180deg, #c07c72 0%, #a85f55 100%);
}

.thread-item-process.is-other::before {
  background: linear-gradient(180deg, #8c8c8c 0%, #707070 100%);
}

.thread-item-process.is-reasoning .thread-item-kind-pill {
  background: rgba(214, 195, 174, 0.9);
  color: #6d4b2d;
}

.thread-item-process.is-command .thread-item-kind-pill {
  background: rgba(199, 213, 191, 0.92);
  color: #49603f;
}

.thread-item-process.is-file .thread-item-kind-pill {
  background: rgba(203, 212, 233, 0.92);
  color: #4d5f87;
}

.thread-item-process.is-tool .thread-item-kind-pill {
  background: rgba(220, 208, 233, 0.92);
  color: #654c7d;
}

.thread-item-process.is-collab .thread-item-kind-pill {
  background: rgba(233, 205, 199, 0.92);
  color: #7f4c44;
}
</style>
