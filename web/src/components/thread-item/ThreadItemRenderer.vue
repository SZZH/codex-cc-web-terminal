<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import hljs from "highlight.js";

const props = defineProps({
  item: { type: Object, required: true },
  assistantName: { type: String, default: "Codex" }
});

const lightboxImage = ref(null);
const lightboxScale = ref(1);
const lightboxTranslateX = ref(0);
const lightboxTranslateY = ref(0);
const lightboxGesture = {
  startScale: 1,
  startDistance: 0,
  startTranslateX: 0,
  startTranslateY: 0,
  startTouchX: 0,
  startTouchY: 0,
  startMidpointX: 0,
  startMidpointY: 0
};

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
const processStatusTone = computed(() => {
  if (!isProcessItem.value) {
    return "default";
  }
  const status = String(props.item?.status || props.item?.phase || "").trim().toLowerCase();
  if (["failed", "error", "aborted"].includes(status)) {
    return status;
  }
  if (["completed", "done", "success"].includes(status)) {
    return "completed";
  }
  if (["running", "in_progress", "pending"].includes(status)) {
    return "running";
  }
  return "default";
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
const imageUrl = computed(() => String(props.item?.imageUrl || "").trim());
const imageAlt = computed(() => String(props.item?.imageAlt || "image").trim() || "image");
const imageItems = computed(() => {
  const items = Array.isArray(props.item?.imageItems) ? props.item.imageItems : [];
  if (items.length) {
    return items;
  }
  return imageUrl.value ? [{ url: imageUrl.value, alt: imageAlt.value }] : [];
});
const lightboxImageStyle = computed(() => ({
  transform: `translate3d(${lightboxTranslateX.value}px, ${lightboxTranslateY.value}px, 0) scale(${lightboxScale.value})`
}));

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

function openLightboxImage(image) {
  const url = String(image?.url || "").trim();
  if (!url) {
    return;
  }
  lightboxImage.value = {
    url,
    alt: String(image?.alt || "image").trim() || "image"
  };
  lightboxScale.value = 1;
  lightboxTranslateX.value = 0;
  lightboxTranslateY.value = 0;
}

function closeLightboxImage() {
  lightboxImage.value = null;
  lightboxScale.value = 1;
  lightboxTranslateX.value = 0;
  lightboxTranslateY.value = 0;
}

function getTouchDistance(touches) {
  if (!touches || touches.length < 2) {
    return 0;
  }
  const [a, b] = touches;
  return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
}

function getTouchMidpoint(touches) {
  if (!touches || touches.length < 2) {
    return { x: 0, y: 0 };
  }
  const [a, b] = touches;
  return {
    x: (a.clientX + b.clientX) / 2,
    y: (a.clientY + b.clientY) / 2
  };
}

function clampLightboxScale(value) {
  return Math.min(4, Math.max(1, value));
}

function handleLightboxTouchStart(event) {
  if (!lightboxImage.value) {
    return;
  }
  if (event.touches.length >= 2) {
    const midpoint = getTouchMidpoint(event.touches);
    lightboxGesture.startScale = lightboxScale.value;
    lightboxGesture.startDistance = getTouchDistance(event.touches);
    lightboxGesture.startTranslateX = lightboxTranslateX.value;
    lightboxGesture.startTranslateY = lightboxTranslateY.value;
    lightboxGesture.startMidpointX = midpoint.x;
    lightboxGesture.startMidpointY = midpoint.y;
    event.preventDefault();
    return;
  }
  if (event.touches.length === 1 && lightboxScale.value > 1) {
    const touch = event.touches[0];
    lightboxGesture.startTouchX = touch.clientX;
    lightboxGesture.startTouchY = touch.clientY;
    lightboxGesture.startTranslateX = lightboxTranslateX.value;
    lightboxGesture.startTranslateY = lightboxTranslateY.value;
    event.preventDefault();
  }
}

function handleLightboxTouchMove(event) {
  if (!lightboxImage.value) {
    return;
  }
  if (event.touches.length >= 2) {
    const midpoint = getTouchMidpoint(event.touches);
    const distance = getTouchDistance(event.touches);
    const ratio = lightboxGesture.startDistance > 0 ? distance / lightboxGesture.startDistance : 1;
    lightboxScale.value = clampLightboxScale(lightboxGesture.startScale * ratio);
    lightboxTranslateX.value = lightboxGesture.startTranslateX + (midpoint.x - lightboxGesture.startMidpointX);
    lightboxTranslateY.value = lightboxGesture.startTranslateY + (midpoint.y - lightboxGesture.startMidpointY);
    event.preventDefault();
    return;
  }
  if (event.touches.length === 1 && lightboxScale.value > 1) {
    const touch = event.touches[0];
    lightboxTranslateX.value = lightboxGesture.startTranslateX + (touch.clientX - lightboxGesture.startTouchX);
    lightboxTranslateY.value = lightboxGesture.startTranslateY + (touch.clientY - lightboxGesture.startTouchY);
    event.preventDefault();
  }
}

function handleLightboxTouchEnd() {
  if (lightboxScale.value <= 1) {
    lightboxScale.value = 1;
    lightboxTranslateX.value = 0;
    lightboxTranslateY.value = 0;
  }
}

function handleWindowKeydown(event) {
  if (event.key === "Escape" && lightboxImage.value) {
    closeLightboxImage();
  }
}

onMounted(() => {
  if (typeof window !== "undefined") {
    window.addEventListener("keydown", handleWindowKeydown);
  }
});

onBeforeUnmount(() => {
  if (typeof window !== "undefined") {
    window.removeEventListener("keydown", handleWindowKeydown);
  }
});

</script>

<template>
  <article :class="itemClasses">
    <header v-if="isProcessItem" class="thread-item-header">
      <span class="thread-item-kind-pill">{{ processHeader }}</span>
      <span v-if="processStatus" class="thread-item-status" :data-status="processStatusTone">{{ processStatus }}</span>
    </header>
    <div v-if="imageItems.length" class="thread-item-gallery">
      <button
        v-for="(image, index) in imageItems"
        :key="`${item.id}-image-${index}`"
        type="button"
        class="thread-item-thumb"
        :aria-label="`查看图片 ${index + 1}`"
        @click="openLightboxImage(image)"
      >
        <img class="thread-item-image" :src="image.url" :alt="image.alt" loading="lazy" decoding="async">
      </button>
    </div>
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

    <div
      v-if="lightboxImage"
      class="image-lightbox"
      @click="closeLightboxImage"
      @touchstart="handleLightboxTouchStart"
      @touchmove="handleLightboxTouchMove"
      @touchend="handleLightboxTouchEnd"
      @touchcancel="handleLightboxTouchEnd"
    >
      <button class="image-lightbox-close" type="button" aria-label="关闭预览" @click.stop="closeLightboxImage">×</button>
      <img
        class="image-lightbox-media"
        :src="lightboxImage.url"
        :alt="lightboxImage.alt"
        :style="lightboxImageStyle"
        loading="eager"
        decoding="async"
        @click.stop
      >
    </div>
  </article>
</template>

<style scoped>
.thread-item-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.thread-item-status {
  flex-shrink: 0;
  font-size: 11px;
  line-height: 1.35;
  color: var(--process-status-text);
  padding-top: 4px;
}

.thread-item-status[data-status="completed"] {
  color: #8d8073;
}

.thread-item-status[data-status="running"] {
  color: #9a8c80;
}

.thread-item-status[data-status="failed"],
.thread-item-status[data-status="error"],
.thread-item-status[data-status="aborted"] {
  color: #b04e44;
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
  border: 1px solid rgba(212, 202, 192, 0.96);
  background: rgba(247, 241, 234, 0.96);
  color: var(--process-pill-text);
}

.thread-item-summary {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--process-text-soft);
  overflow-wrap: anywhere;
  word-break: break-word;
}

.thread-item-gallery {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 0 0 10px;
}

.thread-item-thumb {
  display: block;
  padding: 0;
  border: 0;
  border-radius: 16px;
  background: transparent;
  cursor: zoom-in;
}

.thread-item-image {
  display: block;
  width: min(100%, 160px);
  max-width: 160px;
  height: auto;
  max-height: 160px;
  object-fit: cover;
  border-radius: 14px;
  border: 1px solid rgba(208, 198, 189, 0.9);
  background: rgba(248, 243, 238, 0.92);
  box-shadow: 0 8px 22px rgba(26, 24, 32, 0.08);
}

.markdown-body :deep(p),
.markdown-body :deep(li),
.markdown-body :deep(code) {
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-word;
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
  max-height: min(16rem, 36vh);
  overflow: auto;
  font-size: 12.5px;
  line-height: 1.68;
  color: var(--process-text);
  white-space: pre-wrap;
  word-break: break-word;
  padding-right: 2px;
}

.process-code {
  max-height: min(16rem, 36vh);
  overflow: auto;
  padding-right: 2px;
}

.process-code :deep(.process-code-block) {
  margin: 0;
  border-radius: 14px;
  border: 1px solid var(--process-code-border);
  background: var(--process-code-bg);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.56),
    0 6px 16px rgba(123, 103, 86, 0.06);
}

.process-code :deep(.code-lang) {
  color: var(--process-code-muted);
  border-color: rgba(201, 190, 180, 0.92);
  background: rgba(255, 252, 248, 0.82);
}

.process-code :deep(.code-scroll) {
  overflow-y: visible;
  padding: 0 14px 14px;
}

.process-code :deep(.hljs) {
  color: var(--process-code-text);
  background: transparent;
}

.process-code :deep(.hljs-comment),
.process-code :deep(.hljs-quote) {
  color: #aaa095;
  font-style: italic;
}

.process-code :deep(.hljs-keyword),
.process-code :deep(.hljs-selector-tag),
.process-code :deep(.hljs-literal),
.process-code :deep(.hljs-built_in),
.process-code :deep(.hljs-type) {
  color: #aa7a53;
}

.process-code :deep(.hljs-string),
.process-code :deep(.hljs-title),
.process-code :deep(.hljs-name),
.process-code :deep(.hljs-section),
.process-code :deep(.hljs-attribute),
.process-code :deep(.hljs-symbol),
.process-code :deep(.hljs-bullet) {
  color: #678871;
}

.process-code :deep(.hljs-number),
.process-code :deep(.hljs-meta),
.process-code :deep(.hljs-variable),
.process-code :deep(.hljs-template-variable),
.process-code :deep(.hljs-params) {
  color: #7488ab;
}

.thread-item-process {
  position: relative;
  overflow: visible;
  border-radius: 18px;
  border: 1px solid var(--process-border);
  background: rgba(255, 252, 248, 0.78);
  padding: 14px 16px;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.58) inset,
    0 6px 18px rgba(123, 103, 86, 0.04);
}

.thread-item-process::before {
  content: "";
  position: absolute;
  inset: 12px auto 12px 0;
  width: 2px;
  border-radius: 999px;
  background: rgba(191, 175, 161, 0.92);
}

.thread-item-process.is-reasoning::before {
  background: rgba(181, 141, 99, 0.9);
}

.thread-item-process.is-command::before {
  background: rgba(118, 136, 105, 0.9);
}

.thread-item-process.is-file::before {
  background: rgba(110, 126, 164, 0.88);
}

.thread-item-process.is-tool::before {
  background: rgba(136, 117, 153, 0.88);
}

.thread-item-process.is-collab::before {
  background: rgba(177, 114, 104, 0.88);
}

.thread-item-process.is-other::before {
  background: rgba(138, 129, 121, 0.88);
}

.thread-item-process.is-reasoning .thread-item-kind-pill {
  border-color: rgba(214, 195, 174, 0.96);
}

.thread-item-process.is-command .thread-item-kind-pill {
  border-color: rgba(198, 211, 189, 0.96);
}

.thread-item-process.is-file .thread-item-kind-pill {
  border-color: rgba(198, 207, 228, 0.96);
}

.thread-item-process.is-tool .thread-item-kind-pill {
  border-color: rgba(217, 205, 230, 0.96);
}

.thread-item-process.is-collab .thread-item-kind-pill {
  border-color: rgba(230, 201, 195, 0.96);
}

.image-lightbox {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(24, 19, 15, 0.76);
  backdrop-filter: blur(8px);
  touch-action: none;
  overscroll-behavior: contain;
}

.image-lightbox-media {
  max-width: min(100vw - 32px, 960px);
  max-height: min(100vh - 48px, 88vh);
  border-radius: 16px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
  background: rgba(255, 255, 255, 0.96);
  transform-origin: center center;
  user-select: none;
  -webkit-user-drag: none;
  touch-action: none;
  will-change: transform;
}

.image-lightbox-close {
  position: absolute;
  top: calc(env(safe-area-inset-top) + 12px);
  right: 14px;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.9);
  color: #3b3028;
  font-size: 24px;
  line-height: 1;
  cursor: pointer;
}
</style>
