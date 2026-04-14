<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import hljs from "highlight.js";

const BOTTOM_THRESHOLD = 84;
const MAX_COMPOSER_HEIGHT = 160;

const props = defineProps({
  sessionKey: { type: String, default: "" },
  openToken: { type: [String, Number], default: 0 },
  title: { type: String, default: "会话" },
  threadId: { type: String, default: "" },
  expectedThreadId: { type: String, default: "" },
  threadMismatch: { type: Boolean, default: false },
  workspaceName: { type: String, default: "" },
  assistantName: { type: String, default: "Codex" },
  messages: { type: Array, default: () => [] },
  draft: { type: String, default: "" },
  canSend: Boolean,
  canInterrupt: Boolean,
  loading: Boolean,
  statusText: { type: String, default: "" }
});

const emit = defineEmits(["back", "update:draft", "submit", "interrupt"]);
const messageListEl = ref(null);
const composerEl = ref(null);
const viewportHeight = ref(0);
const keyboardInset = ref(0);
const isPinnedToBottom = ref(true);
const isTouchDevice = ref(false);
const showProcessDetails = ref(false);
const expandedEventGroups = ref(new Set());
const lightboxImage = ref(null);
const lightboxScale = ref(1);
const lightboxTranslateX = ref(0);
const lightboxTranslateY = ref(0);
const lightboxGesture = {
  mode: "",
  startScale: 1,
  startDistance: 0,
  startTranslateX: 0,
  startTranslateY: 0,
  startTouchX: 0,
  startTouchY: 0,
  startMidpointX: 0,
  startMidpointY: 0
};

const chatShellStyle = computed(() => ({
  "--chat-vh": viewportHeight.value ? `${viewportHeight.value}px` : undefined,
  "--chat-keyboard-inset": `${keyboardInset.value}px`
}));
const isRunning = computed(() => Boolean(props.canInterrupt));
const primaryActionLabel = computed(() => (isRunning.value ? "中断" : "发送"));
const canPrimaryAction = computed(() => (isRunning.value ? !props.loading : props.canSend && !props.loading));
const lightboxImageStyle = computed(() => ({
  transform: `translate3d(${lightboxTranslateX.value}px, ${lightboxTranslateY.value}px, 0) scale(${lightboxScale.value})`
}));

const PROCESS_PATTERNS = [
  /^›/,
  /^>/,
  /^Working\(/i,
  /^\d+% left/i,
  /^tokens?\b/i,
  /^subagent/i,
  /^thinking\b/i,
  /^•\s+/,
  /^tool\b/i,
  /^observation\b/i,
  /^bash\b/i,
  /^zsh\b/i,
  /^pwd\b/i,
  /^cd\b/i,
  /^\/Users\//,
  /^node_modules\//,
  /^<subagent_notification>/i,
  /^<\/subagent_notification>/i,
  /^\{".*agent_path".*\}$/,
  /esc to interrupt/i,
  /dangerously-bypass-approvals-and-sandbox/i,
  /codex resume/i,
  /'codex'.*'resume'/i,
  /current changes/i,
  /\bworkdir\b/i
];

const LANGUAGE_ALIAS = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  env: "bash",
  yml: "yaml",
  conf: "ini",
  config: "ini",
  text: "plaintext",
  plain: "plaintext",
  md: "markdown"
};

function normalizeLanguageTag(lang) {
  const key = String(lang || "")
    .trim()
    .toLowerCase();
  if (!key) {
    return "";
  }
  return LANGUAGE_ALIAS[key] || key;
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

function renderCodeFence(sourceText, languageTag) {
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
    `<code class="hljs language-${resolvedLanguage}">${highlighted}</code>`,
    "</pre>"
  ].join("");
}

function isLocalFilePathHref(href) {
  const value = String(href || "").trim();
  if (!value) {
    return false;
  }
  return (
    /^\/(Users|Volumes|private|tmp|var|opt|Applications)\//.test(value) ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

function isProcessLine(line) {
  const compact = String(line || "").trim();
  if (!compact) {
    return true;
  }
  return PROCESS_PATTERNS.some((pattern) => pattern.test(compact));
}

function splitMessageParts(message) {
  const text = String(message?.text || "").trim();
  if (!text || message?.role === "user") {
    return { primary: text, process: "" };
  }

  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => String(line || "").trim().length > 0);

  const processLines = lines.filter((line) => isProcessLine(line));
  return {
    // Keep full assistant text visible by default to avoid hiding real content.
    primary: lines.join("\n").trim(),
    process: processLines.join("\n").trim()
  };
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

const sanitizerConfig = {
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
  ALLOWED_ATTR: ["href", "target", "rel", "class", "src", "alt", "title", "loading", "decoding", "referrerpolicy"],
  FORBID_ATTR: ["style", "onerror", "onclick", "onload"]
};

function renderMarkdownToHtml(text) {
  const source = preprocessDisplayMarkdown(String(text || ""));
  if (!source.trim()) {
    return "";
  }
  const rendered = md.render(source);
  const sanitized = DOMPurify.sanitize(rendered, sanitizerConfig).trim();
  if (typeof window === "undefined" || !sanitized) {
    return sanitized;
  }

  const container = window.document.createElement("div");
  container.innerHTML = sanitized;
  for (const link of container.querySelectorAll("a[href]")) {
    const href = String(link.getAttribute("href") || "").trim();
    if (!isLocalFilePathHref(href)) {
      continue;
    }
    const replacement = window.document.createElement("span");
    replacement.className = "local-file-ref";
    replacement.textContent = link.textContent || href;
    link.replaceWith(replacement);
  }
  return container.innerHTML.trim();
}

function prettifyDirectiveLine(line) {
  const match = String(line || "").trim().match(/^::([a-z0-9-]+)\{([\s\S]*)\}$/i);
  if (!match) {
    return null;
  }

  const action = match[1];
  const payload = match[2].trim();
  return [
    `> 操作：\`${action}\``,
    payload ? `> 参数：\`${payload}\`` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function preprocessDisplayMarkdown(value) {
  const lines = String(value || "").split("\n");
  const output = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    const directive = prettifyDirectiveLine(line);
    if (directive) {
      output.push("", directive, "");
      continue;
    }
    output.push(line);
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n");
}

function extractFileMentions(value) {
  const source = String(value || "");
  if (!source) {
    return [];
  }
  const matches = [...source.matchAll(/\[[^\]]+\]\((\/[^)\s]+)\)/g)];
  const seen = new Set();
  const files = [];
  for (const match of matches) {
    const rawPath = String(match[1] || "").trim();
    if (!rawPath || seen.has(rawPath)) {
      continue;
    }
    seen.add(rawPath);
    const normalized = rawPath.replace(/#L\d+(C\d+)?$/i, "").replace(/:\d+(?::\d+)?$/i, "");
    const label = normalized.split("/").filter(Boolean).slice(-3).join("/");
    files.push({
      path: rawPath,
      label: label || rawPath
    });
  }
  return files;
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function mapEventTypeToZh(rawType, fallbackLabel = "事件") {
  const key = String(rawType || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_/-]/g, "");
  if (!key) {
    return fallbackLabel;
  }
  if (key.includes("commandexecution")) {
    return "命令执行";
  }
  if (key.includes("filechange")) {
    return "文件变更";
  }
  if (key.includes("reasoning")) {
    return "思考过程";
  }
  if (key.includes("agentmessage")) {
    return "执行进度";
  }
  if (key.includes("subagent") || key.includes("collab")) {
    return "子任务";
  }
  if (key.includes("reference") || key.includes("citation")) {
    return "引用信息";
  }
  if (key.includes("toolcall") || key.includes("mcptool")) {
    return "工具调用";
  }
  return fallbackLabel;
}

function mapStatusToZh(value) {
  const key = String(value || "").trim().toLowerCase();
  if (!key) {
    return "";
  }
  if (["success", "succeeded", "done", "completed", "ok"].includes(key)) {
    return "完成";
  }
  if (["running", "inprogress", "processing"].includes(key)) {
    return "执行中";
  }
  if (["failed", "error", "aborted", "cancelled", "canceled"].includes(key)) {
    return "失败";
  }
  return String(value || "").trim();
}

function isNoisySummary(value, rawType) {
  const text = compactText(value).toLowerCase();
  const type = compactText(rawType).toLowerCase();
  if (!text) {
    return true;
  }
  if (text === type) {
    return true;
  }
  if (["commentary", "reasoning", "agentmessage", "commandexecution", "event", "tool"].includes(text)) {
    return true;
  }
  return false;
}

function buildEventDetails(payload, rawType) {
  const source = payload && typeof payload === "object" ? payload : {};
  const nested = source.payload && typeof source.payload === "object" ? source.payload : {};
  const fields = [
    { label: "命令", value: nested.command || source.command },
    { label: "工具", value: nested.toolName || nested.tool_name || source.toolName || source.tool_name },
    { label: "路径", value: nested.path || source.path },
    { label: "状态", value: mapStatusToZh(nested.status || source.status) }
  ];
  const details = fields
    .map((item) => ({ ...item, value: compactText(item.value) }))
    .filter((item) => Boolean(item.value));
  if (details.length) {
    return details;
  }
  const fallback = mapEventTypeToZh(rawType, "");
  return fallback ? [{ label: "类型", value: fallback }] : [];
}

function buildEventCompactText(summary, details, fallbackType) {
  const cleanSummary = compactText(summary);
  if (cleanSummary) {
    return cleanSummary;
  }
  if (Array.isArray(details) && details.length > 0) {
    const first = details[0];
    if (first?.label && first?.value) {
      return `${first.label}：${first.value}`;
    }
  }
  return fallbackType || "事件";
}

function formatDurationLabel(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

const renderedMessages = computed(() =>
  props.messages.map((message) => {
    const parts = splitMessageParts(message);
    const partType = String(message?.partType || "").trim();
    const payload = message?.payload || {};
    const imageUrl = String(payload?.url || "").trim();
    const imageAlt = String(payload?.alt || "").trim() || "image";
    const structuredPart = new Set(["tool", "subagent", "reference", "event"]);
    const renderKind = partType === "image" && imageUrl ? "image" : structuredPart.has(partType) ? "event" : "markdown";
    const eventLabelMap = {
      tool: "工具调用",
      subagent: "子任务",
      reference: "引用",
      event: "事件"
    };
    const eventLabel = eventLabelMap[partType] || "事件";
    const eventRawType = String(payload?.rawType || message?.rawType || "").trim();
    const eventTypeText = mapEventTypeToZh(eventRawType, eventLabel);
    const baseSummary = compactText(payload?.summary || parts.primary || message.text || "");
    const eventSummary = isNoisySummary(baseSummary, eventRawType) ? "" : baseSummary;
    const eventDetails = buildEventDetails(payload, eventRawType);
    const eventCompactText = buildEventCompactText(eventSummary, eventDetails, eventTypeText);
    return {
      ...message,
      renderKind,
      imageUrl,
      imageAlt,
      eventLabel: eventTypeText,
      eventSummary,
      eventDetails,
      eventCompactText,
      displayText: parts.primary || "",
      renderedHtml: renderMarkdownToHtml(parts.primary || message.text || ""),
      fileMentions: message.role === "assistant" && renderKind === "markdown" ? extractFileMentions(message.text) : [],
      processText: parts.process || "",
      hasProcessDetails: Boolean(parts.process),
      processSummary: parts.primary ? "查看过程详情" : "查看运行过程"
    };
  })
);

const hasAnyProcessDetails = computed(() => renderedMessages.value.some((message) => message.hasProcessDetails));
const hasAssistantBody = computed(() =>
  renderedMessages.value.some(
    (message) => message.role === "assistant" && message.renderKind === "markdown" && compactText(message.displayText)
  )
);
const shouldCollapseCompletedGroups = computed(() => hasAssistantBody.value && !props.canInterrupt && !props.loading);
function isEventGroupExpanded(toggleId) {
  return expandedEventGroups.value.has(toggleId);
}

function toggleEventGroup(toggleId) {
  const next = new Set(expandedEventGroups.value);
  if (next.has(toggleId)) {
    next.delete(toggleId);
  } else {
    next.add(toggleId);
  }
  expandedEventGroups.value = next;
}

const visibleMessages = computed(() => {
  if (!shouldCollapseCompletedGroups.value) {
    return renderedMessages.value;
  }

  const output = [];
  let pendingEventGroup = [];
  const flushPending = () => {
    if (!pendingEventGroup.length) {
      return;
    }
    const toggleId = `event-toggle-${pendingEventGroup[0].id}`;
    if (pendingEventGroup.length === 1) {
      output.push(...pendingEventGroup);
      pendingEventGroup = [];
      return;
    }
    const timestamps = pendingEventGroup
      .map((message) => Date.parse(String(message.ts || message.timestamp || "")))
      .filter((value) => Number.isFinite(value));
    const durationLabel =
      timestamps.length >= 2 ? formatDurationLabel(Math.max(...timestamps) - Math.min(...timestamps)) : "";
    output.push({
      id: toggleId,
      toggleId,
      renderKind: "event-toggle",
      count: pendingEventGroup.length,
      durationLabel
    });
    if (isEventGroupExpanded(toggleId)) {
      output.push(...pendingEventGroup);
    } else {
      output.push(pendingEventGroup[pendingEventGroup.length - 1]);
    }
    pendingEventGroup = [];
  };

  for (const message of renderedMessages.value) {
    if (message.role === "assistant" && message.renderKind === "event") {
      pendingEventGroup.push(message);
      continue;
    }
    flushPending();
    output.push(message);
  }
  flushPending();
  return output;
});
const visibleThreadId = computed(() => String(props.threadId || props.expectedThreadId || "").trim());
const threadHint = computed(() => {
  if (!visibleThreadId.value) {
    return "thread_id: 暂未获取";
  }
  if (props.threadMismatch) {
    return `thread_id 不一致：当前 ${props.threadId} / 目标 ${props.expectedThreadId}`;
  }
  return `thread_id: ${visibleThreadId.value}`;
});

function isNearBottom(element, threshold = BOTTOM_THRESHOLD) {
  if (!element) {
    return true;
  }
  return element.scrollHeight - element.clientHeight - element.scrollTop <= threshold;
}

function resizeComposer(target, { keepBottom = false } = {}) {
  const el = target?.target || target;
  if (!el) {
    return;
  }
  const wasNearBottom = keepBottom && isNearBottom(messageListEl.value);
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
  el.style.overflowY = el.scrollHeight > MAX_COMPOSER_HEIGHT ? "auto" : "hidden";
  if (wasNearBottom) {
    scrollToBottom(true);
  }
}

function scrollToBottom(force = false) {
  nextTick(() => {
    const el = messageListEl.value;
    if (!el) {
      return;
    }
    if (!force && !isPinnedToBottom.value) {
      return;
    }

    const applyScroll = () => {
      el.scrollTop = el.scrollHeight;
      isPinnedToBottom.value = true;
    };

    applyScroll();
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(applyScroll);
      });
    }
  });
}

function handleInput(event) {
  emit("update:draft", event.target.value);
  resizeComposer(event, { keepBottom: true });
}

function handleComposerKeydown(event) {
  if (event.isComposing || event.keyCode === 229) {
    return;
  }

  const wantsSubmitShortcut =
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !isTouchDevice.value;

  if (wantsSubmitShortcut) {
    event.preventDefault();
    emit("submit");
  }
}

function handlePrimaryAction() {
  if (isRunning.value) {
    emit("interrupt");
    return;
  }
  emit("submit");
}

function handleStreamScroll(event) {
  isPinnedToBottom.value = isNearBottom(event.target);
}

function openLightboxImage(url, alt = "image") {
  const imageUrl = String(url || "").trim();
  if (!imageUrl) {
    return;
  }
  lightboxImage.value = {
    url: imageUrl,
    alt: String(alt || "image").trim() || "image"
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
  lightboxGesture.mode = "";
}

function handleMarkdownBodyClick(event) {
  const target = event?.target;
  if (!(target instanceof window.HTMLImageElement)) {
    return;
  }
  openLightboxImage(target.currentSrc || target.src || "", target.alt || "image");
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
    lightboxGesture.mode = "pinch";
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
    lightboxGesture.mode = "pan";
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
  lightboxGesture.mode = "";
}

function handleComposerFocus() {
  if (!isNearBottom(messageListEl.value)) {
    return;
  }
  scrollToBottom(true);
}

function syncViewportMetrics() {
  if (typeof window === "undefined") {
    return;
  }

  const viewport = window.visualViewport;
  const height = viewport?.height ? Math.round(viewport.height) : window.innerHeight;
  const inset = viewport
    ? Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop))
    : 0;

  viewportHeight.value = height;
  keyboardInset.value = inset;
}

function handleViewportChange() {
  syncViewportMetrics();
  resizeComposer(composerEl.value, { keepBottom: true });
  if (isPinnedToBottom.value) {
    scrollToBottom(true);
  }
}

function handleWindowResize() {
  syncViewportMetrics();
  resizeComposer(composerEl.value, { keepBottom: true });
}

function handleWindowKeydown(event) {
  if (event.key === "Escape" && lightboxImage.value) {
    closeLightboxImage();
  }
}

watch(
  () => props.messages.map((message) => `${message.id}:${message.text?.length || 0}`).join("|"),
  () => {
    scrollToBottom(false);
  },
  { flush: "post" }
);

watch(
  () => `${props.sessionKey}::${props.openToken}`,
  () => {
    isPinnedToBottom.value = true;
    expandedEventGroups.value = new Set();
    scrollToBottom(true);
  },
  { flush: "post", immediate: true }
);

watch(
  () => props.draft,
  () => {
    nextTick(() => resizeComposer(composerEl.value, { keepBottom: true }));
  },
  { flush: "post", immediate: true }
);

onMounted(() => {
  if (typeof window !== "undefined") {
    isTouchDevice.value =
      window.matchMedia?.("(pointer: coarse)").matches ||
      navigator.maxTouchPoints > 0;
    window.addEventListener("resize", handleWindowResize, { passive: true });
    window.addEventListener("keydown", handleWindowKeydown);
    window.visualViewport?.addEventListener("resize", handleViewportChange, { passive: true });
    window.visualViewport?.addEventListener("scroll", handleViewportChange, { passive: true });
  }
  syncViewportMetrics();
  scrollToBottom(true);
  resizeComposer(composerEl.value, { keepBottom: true });
});

onBeforeUnmount(() => {
  if (typeof window !== "undefined") {
    window.removeEventListener("resize", handleWindowResize);
    window.removeEventListener("keydown", handleWindowKeydown);
    window.visualViewport?.removeEventListener("resize", handleViewportChange);
    window.visualViewport?.removeEventListener("scroll", handleViewportChange);
  }
});
</script>

<template>
  <section class="mobile-shell chat-shell" :style="chatShellStyle">
    <header class="mobile-header compact">
      <button class="nav-button" aria-label="返回会话列表" @click="emit('back')">
        <span aria-hidden="true">‹</span>
      </button>
      <div class="header-copy">
        <h1>{{ title }}</h1>
      </div>
      <span class="header-spacer" aria-hidden="true"></span>
    </header>

    <main class="chat-screen">
      <section ref="messageListEl" class="message-stream" @scroll="handleStreamScroll">
        <article v-for="message in visibleMessages" :key="message.id" class="message-item" :class="message.role">
          <button
            v-if="message.renderKind === 'event-toggle'"
            type="button"
            class="event-collapsed-toggle"
            @click="toggleEventGroup(message.toggleId)"
          >
            {{ isEventGroupExpanded(message.toggleId) ? "收起执行过程" : "查看执行过程" }}
            <span class="event-collapsed-meta">
              （{{ message.count }} 条<span v-if="message.durationLabel">，{{ message.durationLabel }}</span>）
            </span>
          </button>

          <div v-if="message.renderKind === 'image'" class="message-bubble image-bubble">
            <img
              class="message-image"
              :src="message.imageUrl"
              :alt="message.imageAlt"
              loading="lazy"
              decoding="async"
              @click="openLightboxImage(message.imageUrl, message.imageAlt)"
            />
          </div>

          <div v-else-if="message.renderKind === 'event'" class="message-bubble event-bubble">
            <p class="event-compact">{{ message.eventCompactText }}</p>
            <dl v-if="message.eventDetails.length" class="event-details">
              <template v-for="detail in message.eventDetails" :key="`${message.id}-${detail.label}`">
                <dt>{{ detail.label }}</dt>
                <dd>{{ detail.value }}</dd>
              </template>
            </dl>
            <p
              v-if="message.eventSummary && message.eventSummary !== message.eventCompactText"
              class="event-summary"
            >
              {{ message.eventSummary }}
            </p>
          </div>

          <div v-else-if="message.displayText || message.role === 'user'" class="message-bubble">
            <div class="message-text markdown-body" v-html="message.renderedHtml" @click="handleMarkdownBodyClick"></div>
          </div>

          <section v-if="message.fileMentions?.length" class="change-scope-card">
            <p class="change-scope-title">{{ message.fileMentions.length }} 个文件已修改</p>
            <div class="change-scope-list">
              <div
                v-for="file in message.fileMentions"
                :key="`${message.id}-${file.path}`"
                class="change-scope-item"
              >
                {{ file.label }}
              </div>
            </div>
          </section>

          <details v-if="showProcessDetails && message.hasProcessDetails" class="message-process">
            <summary>{{ message.processSummary }}</summary>
            <pre class="message-process-text">{{ message.processText }}</pre>
          </details>
        </article>

      </section>

      <button
        v-if="hasAnyProcessDetails"
        class="process-toggle"
        type="button"
        @click="showProcessDetails = !showProcessDetails"
      >
        {{ showProcessDetails ? "隐藏过程详情" : "显示过程详情" }}
      </button>

      <p v-if="statusText" class="chat-status">{{ statusText }}</p>

      <form class="composer" @submit.prevent="emit('submit')">
        <textarea
          ref="composerEl"
          :value="draft"
          class="composer-input"
          rows="1"
          :placeholder="isTouchDevice ? '给 Codex 发消息…' : 'Enter 发送，Shift + Enter 换行'"
          :disabled="loading"
          :enterkeyhint="isTouchDevice ? 'enter' : 'send'"
          @input="handleInput"
          @focus="handleComposerFocus"
          @keydown="handleComposerKeydown"
        ></textarea>
        <button
          class="primary-button composer-send"
          type="button"
          :aria-label="isRunning ? '中断当前流程' : '发送消息'"
          :disabled="!canPrimaryAction"
          @click="handlePrimaryAction"
        >
          {{ primaryActionLabel }}
        </button>
      </form>
    </main>

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
  </section>
</template>

<style scoped>
.chat-shell {
  height: var(--chat-vh, 100dvh);
  min-height: var(--chat-vh, 100dvh);
  background:
    radial-gradient(circle at top, rgba(255, 255, 255, 0.5), transparent 34%),
    linear-gradient(180deg, rgba(248, 244, 239, 0.98) 0%, rgba(243, 237, 231, 0.95) 100%),
    #f4eee8;
  color: #342d28;
}

.mobile-header {
  position: sticky;
  top: 0;
  z-index: 10;
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) 32px;
  align-items: center;
  gap: 10px;
  padding: calc(env(safe-area-inset-top) + 10px) 14px 10px;
  background: rgba(247, 242, 237, 0.82);
  border-bottom: 1px solid rgba(214, 201, 190, 0.52);
  backdrop-filter: blur(18px);
}

.header-copy {
  min-width: 0;
  text-align: center;
}

.header-copy h1 {
  margin: 0;
  font-size: 16px;
  line-height: 1.25;
  font-weight: 600;
  color: #3d342d;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.thread-id {
  margin: 2px 0 0;
  font-size: 11px;
  line-height: 1.2;
  color: #7a6d62;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.thread-id.warn {
  color: #b5483d;
  font-weight: 600;
}

.nav-button {
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: rgba(229, 220, 212, 0.78);
  color: #56483d;
  font-size: 20px;
  font-weight: 600;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.nav-button span {
  transform: translateX(-1px);
}

.header-spacer {
  width: 32px;
  height: 32px;
}

.chat-screen {
  display: flex;
  flex-direction: column;
  min-height: calc(100dvh - 72px);
  min-width: 0;
  overflow-x: hidden;
}

.message-stream {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px 14px calc(40px + env(safe-area-inset-bottom));
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

.message-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: min(100%, 42rem);
}

.message-item.assistant {
  align-self: flex-start;
  align-items: flex-start;
}

.message-item.user {
  align-self: flex-end;
  align-items: flex-end;
  max-width: 100%;
}

.message-bubble {
  width: fit-content;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  border-radius: 20px;
  padding: 10px 12px;
  border: 1px solid rgba(224, 213, 203, 0.88);
  background: rgba(255, 252, 248, 0.94);
  box-shadow: 0 10px 28px rgba(127, 107, 88, 0.05);
}

.message-item.user .message-bubble {
  width: max-content;
  min-width: 64px;
  max-width: 100%;
  border-color: rgba(215, 202, 190, 0.92);
  background: linear-gradient(180deg, #e8ddd2 0%, #e0d2c5 100%);
  box-shadow: 0 10px 24px rgba(136, 114, 93, 0.08);
}

.image-bubble {
  padding: 6px;
  background: rgba(255, 252, 248, 0.98);
  width: fit-content;
  max-width: 168px;
}

.event-bubble {
  min-width: 180px;
  padding: 12px 13px;
  border-color: rgba(210, 201, 191, 0.82);
  border-left: 3px solid rgba(176, 160, 143, 0.58);
  background: rgba(248, 243, 238, 0.72);
  box-shadow: none;
}

.event-compact {
  margin: 0;
  font-size: 12px;
  font-weight: 400;
  color: #7b6d61;
  line-height: 1.45;
  word-break: break-word;
}

.event-summary {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: #7b6d61;
  white-space: pre-wrap;
  word-break: break-word;
}

.event-panel {
  margin-top: 8px;
  border-top: 1px dashed rgba(173, 151, 128, 0.52);
  padding-top: 7px;
}

.event-panel summary {
  list-style: none;
  cursor: pointer;
  margin: 0;
  font-size: 12px;
  color: #7f6b58;
}

.event-panel summary::-webkit-details-marker {
  display: none;
}

.event-details {
  margin: 8px 0 0;
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 9px;
  row-gap: 5px;
}

.event-details dt {
  margin: 0;
  font-size: 11px;
  color: #9a8c80;
  white-space: nowrap;
  font-weight: 400;
}

.event-details dd {
  margin: 0;
  font-size: 11px;
  color: #8a7c6f;
  overflow-wrap: anywhere;
  font-weight: 400;
}

.event-collapsed-toggle {
  margin: 4px 0;
  padding: 4px 8px;
  font-size: 11px;
  line-height: 1.4;
  color: #9a8c80;
  background: rgba(245, 240, 235, 0.5);
  border: 0;
  border-radius: 10px;
  align-self: flex-start;
  cursor: pointer;
}

.event-collapsed-meta {
  color: #a8998d;
  margin-left: 2px;
}

.change-scope-card {
  width: min(100%, 520px);
  margin-top: 6px;
  padding: 10px 12px;
  border: 1px solid rgba(220, 212, 204, 0.9);
  border-radius: 16px;
  background: rgba(250, 247, 244, 0.96);
  box-shadow: 0 4px 12px rgba(120, 102, 84, 0.04);
}

.change-scope-title {
  margin: 0 0 8px;
  font-size: 12px;
  color: #66584d;
}

.change-scope-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.change-scope-item {
  display: block;
  padding: 8px 10px;
  border-radius: 12px;
  border: 1px solid rgba(221, 211, 201, 0.95);
  background: rgba(246, 241, 236, 0.96);
  color: #5b82c9;
  font-size: 13px;
  overflow-wrap: anywhere;
  pointer-events: none;
  cursor: default;
  user-select: text;
}

.message-image {
  display: block;
  width: 156px;
  max-width: 156px;
  max-height: 156px;
  height: auto;
  object-fit: cover;
  border-radius: 10px;
  cursor: zoom-in;
}

.message-text {
  margin: 0;
  white-space: normal;
  overflow-wrap: break-word;
  word-break: break-word;
  line-break: auto;
  font-size: 15px;
  line-height: 1.45;
  color: #3a312b;
  max-width: 100%;
  min-width: 0;
}

.message-item.user .message-text {
  display: block;
  white-space: normal;
  overflow-wrap: break-word;
  word-break: normal;
  max-width: 100%;
}

.message-item.user .markdown-body :deep(p) {
  display: inline;
  margin: 0;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4),
.markdown-body :deep(h5),
.markdown-body :deep(h6) {
  margin: 0 0 6px;
  line-height: 1.35;
  font-weight: 700;
}

.markdown-body :deep(h1) { font-size: 20px; }
.markdown-body :deep(h2) { font-size: 18px; }
.markdown-body :deep(h3) { font-size: 16px; }
.markdown-body :deep(h4),
.markdown-body :deep(h5),
.markdown-body :deep(h6) { font-size: 15px; }

.markdown-body :deep(p) {
  margin: 0 0 4px;
}

.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown-body :deep(code) {
  padding: 1px 6px;
  border-radius: 6px;
  background: rgba(86, 72, 61, 0.1);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 0.92em;
}

.markdown-body :deep(pre) {
  margin: 0 0 6px;
  padding: 10px 11px;
  border-radius: 12px;
  border: 1px solid rgba(207, 192, 179, 0.82);
  background: rgba(248, 243, 238, 0.9);
  overflow-x: auto;
  max-width: 100%;
  box-sizing: border-box;
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
  padding-top: 28px;
}

.markdown-body :deep(pre.code-block .code-lang) {
  position: absolute;
  top: 8px;
  right: 10px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10px;
  line-height: 1.3;
  text-transform: lowercase;
  letter-spacing: 0.01em;
  border: 1px solid rgba(170, 160, 149, 0.42);
  background: rgba(255, 255, 255, 0.76);
  color: #7a6a5c;
}

.markdown-body :deep(pre.code-block.family-sql) {
  border-color: rgba(164, 131, 92, 0.55);
  background: linear-gradient(180deg, rgba(253, 246, 236, 0.92), rgba(246, 238, 226, 0.94));
}

.markdown-body :deep(pre.code-block.family-shell) {
  border-color: rgba(109, 138, 105, 0.58);
  background: linear-gradient(180deg, rgba(237, 247, 239, 0.9), rgba(229, 241, 233, 0.94));
}

.markdown-body :deep(pre.code-block.family-config) {
  border-color: rgba(103, 124, 168, 0.56);
  background: linear-gradient(180deg, rgba(239, 244, 253, 0.92), rgba(231, 238, 250, 0.95));
}

.markdown-body :deep(pre.code-block .hljs) {
  color: #2f2a27;
  background: transparent;
}

.markdown-body :deep(.hljs-comment),
.markdown-body :deep(.hljs-quote) {
  color: #8a7e73;
  font-style: italic;
}

.markdown-body :deep(.hljs-keyword),
.markdown-body :deep(.hljs-selector-tag),
.markdown-body :deep(.hljs-literal),
.markdown-body :deep(.hljs-built_in),
.markdown-body :deep(.hljs-type) {
  color: #a34f18;
  font-weight: 600;
}

.markdown-body :deep(.hljs-string),
.markdown-body :deep(.hljs-title),
.markdown-body :deep(.hljs-name),
.markdown-body :deep(.hljs-section),
.markdown-body :deep(.hljs-attribute),
.markdown-body :deep(.hljs-symbol),
.markdown-body :deep(.hljs-bullet) {
  color: #1f7a43;
}

.markdown-body :deep(.hljs-number),
.markdown-body :deep(.hljs-meta),
.markdown-body :deep(.hljs-variable),
.markdown-body :deep(.hljs-template-variable),
.markdown-body :deep(.hljs-params) {
  color: #4d5ea8;
}

.markdown-body :deep(blockquote) {
  margin: 0 0 6px;
  padding: 6px 10px;
  border-left: 3px solid rgba(170, 150, 130, 0.85);
  background: rgba(248, 241, 235, 0.75);
  border-radius: 0 10px 10px 0;
  color: #5b4f45;
}

.markdown-body :deep(blockquote p) {
  margin: 0;
  line-height: 1.4;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 0 0 6px;
  padding-left: 18px;
}

.markdown-body :deep(li) {
  margin-bottom: 4px;
}

.markdown-body :deep(a) {
  color: #7f5f45;
  text-decoration: underline;
  text-underline-offset: 2px;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.markdown-body :deep(.local-file-ref) {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 8px;
  border: 1px solid rgba(221, 211, 201, 0.95);
  background: rgba(246, 241, 236, 0.96);
  color: #5b82c9;
  text-decoration: none;
  overflow-wrap: anywhere;
  word-break: break-word;
  pointer-events: none;
  cursor: default;
  user-select: text;
}

.markdown-body :deep(img) {
  display: block;
  width: 156px;
  max-width: 156px;
  max-height: 156px;
  height: auto;
  object-fit: cover;
  margin: 6px 0;
  border-radius: 12px;
  border: 1px solid rgba(208, 197, 187, 0.7);
  background: rgba(248, 243, 238, 0.78);
  cursor: zoom-in;
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

.message-process {
  width: 100%;
  max-width: 100%;
  border: 1px solid rgba(223, 214, 206, 0.8);
  border-radius: 16px;
  background: rgba(255, 251, 247, 0.72);
  overflow: hidden;
}

.message-process summary {
  list-style: none;
  padding: 10px 14px;
  color: #8b7f73;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.message-process summary::-webkit-details-marker {
  display: none;
}

.message-process-text {
  margin: 0;
  padding: 0 14px 14px;
  color: #74675b;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.empty-state {
  margin: auto 0;
  padding: 28px 20px;
  border-radius: 20px;
  text-align: center;
  font-size: 14px;
  color: #918173;
  background: rgba(255, 250, 246, 0.72);
  border: 1px solid rgba(225, 214, 204, 0.82);
}

.chat-empty {
  margin-top: 56px;
}

.chat-status {
  margin: 0;
  padding: 0 20px 8px;
  font-size: 12px;
  line-height: 1.45;
  color: #99897c;
}

.process-toggle {
  align-self: flex-start;
  margin: 0 14px 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #8d7d70;
  font-size: 12px;
  line-height: 1.4;
}

.composer {
  position: sticky;
  bottom: 0;
  z-index: 5;
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 12px 14px calc(12px + env(safe-area-inset-bottom) + clamp(0px, var(--chat-keyboard-inset, 0px), 24px));
  background: linear-gradient(180deg, rgba(244, 238, 232, 0) 0%, rgba(244, 238, 232, 0.92) 28%, #f4eee8 100%);
  backdrop-filter: blur(16px);
}

.composer-interrupt {
  flex-shrink: 0;
  min-width: 60px;
  min-height: 48px;
  padding: 0 12px;
  border-radius: 16px;
}

.composer-interrupt:disabled {
  opacity: 0.46;
  box-shadow: none;
}

.composer-input {
  flex: 1;
  min-height: 48px;
  max-height: 160px;
  padding: 13px 16px;
  border: 1px solid rgba(217, 205, 194, 0.92);
  border-radius: 18px;
  background: rgba(255, 251, 248, 0.95);
  color: #3a312b;
  font-size: 16px;
  line-height: 1.55;
  resize: none;
  box-shadow: 0 10px 28px rgba(127, 107, 88, 0.05);
  outline: none;
  -webkit-appearance: none;
}

.composer-input:focus {
  border-color: rgba(186, 168, 152, 0.92);
  box-shadow:
    0 0 0 4px rgba(205, 191, 179, 0.34),
    0 10px 28px rgba(127, 107, 88, 0.06);
}

.composer-input:disabled {
  color: #aa9b8f;
  background: rgba(247, 242, 237, 0.9);
}

.composer-send {
  flex-shrink: 0;
  min-width: 74px;
  min-height: 48px;
  padding: 0 18px;
  border: 0;
  border-radius: 16px;
  background: linear-gradient(180deg, #bfafa0 0%, #ae9d8d 100%);
  color: #fffdfa;
  font-size: 14px;
  font-weight: 600;
  box-shadow: 0 12px 24px rgba(139, 117, 97, 0.16);
  touch-action: manipulation;
}

.composer-send:disabled {
  opacity: 0.46;
  box-shadow: none;
}

</style>
