<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ChatComposer from "./composer/ChatComposer.vue";
import ChatHeader from "./ChatHeader.vue";
import PixelCompanion from "./PixelCompanion.js";
import ThreadTurnTimeline from "./thread-item/ThreadTurnTimeline.vue";
import { createMessageStreamScroll } from "../lib/message-stream-scroll.js";
import { measureAppViewport } from "../lib/app-viewport.js";
import { PERMISSION_MODE_OPTIONS } from "../lib/composer.js";

const props = defineProps({
  sessionKey: { type: String, default: "" },
  openToken: { type: [String, Number], default: 0 },
  title: { type: String, default: "会话" },
  threadId: { type: String, default: "" },
  expectedThreadId: { type: String, default: "" },
  threadMismatch: { type: Boolean, default: false },
  assistantName: { type: String, default: "Codex" },
  threadSnapshot: { type: Object, default: null },
  threadViewModel: { type: Object, default: null },
  workspaceCwd: { type: String, default: "" },
  draft: { type: String, default: "" },
  composerOptions: { type: Object, required: true },
  models: { type: Array, default: () => [] },
  permissionModeOptions: { type: Array, default: () => PERMISSION_MODE_OPTIONS },
  gitState: { type: Object, required: true },
  providerId: { type: String, default: "codex" },
  canSend: Boolean,
  canInterrupt: Boolean,
  allowFollowups: Boolean,
  canSteer: Boolean,
  runningTask: Boolean,
  followUpMode: { type: String, default: "steer" },
  canAnswerQuestions: Boolean,
  attentionExpanded: Boolean,
  interrupting: Boolean,
  processExpanded: { type: Object, default: () => ({}) },
  loading: Boolean,
  historyLoading: Boolean,
  hasOlder: Boolean,
  loadingOlder: Boolean,
  onReachTop: { type: Function, default: null },
  statusText: { type: String, default: "" }
});

const emit = defineEmits([
  "back",
  "update:draft",
  "submit",
  "interrupt",
  "process-toggle",
  "turn-visibility",
  "question-answer",
  "status",
  "update:composer-options",
  "add-attachments",
  "remove-attachment",
  "retry-attachment",
  "switch-git-branch",
  "create-git-branch",
  "refresh-git"
]);
const messageListEl = ref(null);
const composerRef = ref(null);
const composerHostEl = ref(null);
const statusEl = ref(null);
const keyboardInset = ref(0);
const composerHeight = ref(0);
const statusHeight = ref(0);
let layoutResizeObserver = null;
const streamScroll = createMessageStreamScroll({
  getElement: () => messageListEl.value,
  getContext: () => `${props.sessionKey}::${props.openToken}`,
  getHasOlder: () => props.hasOlder,
  getLoadingOlder: () => props.loadingOlder,
  onReachTop: () => props.onReachTop?.(),
  nextTick
});
const {
  isNearBottom, scrollToBottom, handleStreamScroll, handleStreamWheel,
  handleStreamTouchStart, handleStreamTouchMove, handleStreamTouchEnd,
  handleStreamKeydown, handleStreamPointerDown, handleStreamPointerUp
} = streamScroll;

const chatShellStyle = computed(() => ({
  "--chat-keyboard-inset": `${keyboardInset.value}px`
}));
const messageStreamStyle = computed(() => ({
  "--chat-bottom-space": `${Math.max(56, composerHeight.value + statusHeight.value + 24)}px`
}));
const hasThreadSnapshot = computed(
  () => props.threadSnapshot && Array.isArray(props.threadSnapshot.turns)
);
function resizeComposer(target, { keepBottom = false } = {}) {
  const wasNearBottom = keepBottom && streamScroll.isPinnedToBottom && isNearBottom(messageListEl.value);
  composerRef.value?.resizeComposer?.();
  syncBottomLayoutMetrics();
  if (wasNearBottom) {
    scrollToBottom(true);
  }
}

function syncBottomLayoutMetrics() {
  const composerElement = composerHostEl.value || composerRef.value?.$el || null;
  composerHeight.value = composerElement ? Math.ceil(composerElement.getBoundingClientRect().height) : 0;
  statusHeight.value = statusEl.value ? Math.ceil(statusEl.value.getBoundingClientRect().height) : 0;
}

function settleScrollToBottom(force = false) {
  scrollToBottom(force);
}

function settleInitialScrollToBottom() {
  settleScrollToBottom();
}

function handleProcessToggle(payload) {
  if (payload?.expanded) streamScroll.inspect();
  emit("process-toggle", payload);
}

function syncViewportMetrics() {
  if (typeof window === "undefined") {
    return;
  }

  keyboardInset.value = measureAppViewport(window).keyboardInset;
}

function handleViewportChange() {
  syncViewportMetrics();
  resizeComposer(composerRef.value, { keepBottom: false });
}

function handleWindowResize() {
  syncViewportMetrics();
  resizeComposer(composerRef.value, { keepBottom: false });
}

function observeBottomLayout() {
  layoutResizeObserver?.disconnect();
  if (typeof ResizeObserver === "undefined") {
    return;
  }
  const isCurrent = streamScroll.captureContext();
  layoutResizeObserver = new ResizeObserver(() => {
    if (!isCurrent()) return;
    syncBottomLayoutMetrics();
    if (streamScroll.isPinnedToBottom) scrollToBottom();
  });
  const composerElement = composerHostEl.value || composerRef.value?.$el || null;
  if (composerElement) {
    layoutResizeObserver.observe(composerElement);
  }
  if (statusEl.value) {
    layoutResizeObserver.observe(statusEl.value);
  }
  const timeline = messageListEl.value?.querySelector?.(".thread-turn-timeline");
  if (timeline) layoutResizeObserver.observe(timeline);
  if (messageListEl.value) layoutResizeObserver.observe(messageListEl.value);
}

watch(
  () =>
    hasThreadSnapshot.value
      ? `${props.threadSnapshot?.version || 0}:${props.threadSnapshot?.turns?.length || 0}`
      : "",
  () => {
    if (!hasThreadSnapshot.value) {
      return;
    }
    settleScrollToBottom();
  },
  { flush: "post" }
);

watch(
  () => `${props.sessionKey}::${props.openToken}`,
  () => {
    streamScroll.reset();
    streamScroll.schedule(() => {
      resizeComposer(composerRef.value, { keepBottom: false });
      observeBottomLayout();
      settleInitialScrollToBottom();
    });
  },
  { flush: "post", immediate: true }
);

watch(
  () => props.draft,
  () => {
    streamScroll.schedule(() => resizeComposer(composerRef.value, { keepBottom: true }));
  },
  { flush: "post", immediate: true }
);

onMounted(() => {
  if (typeof window !== "undefined") {
    window.addEventListener("resize", handleWindowResize, { passive: true });
    window.addEventListener("pointerup", handleStreamPointerUp);
    window.addEventListener("pointercancel", handleStreamPointerUp);
    window.visualViewport?.addEventListener("resize", handleViewportChange, { passive: true });
    window.visualViewport?.addEventListener("scroll", handleViewportChange, { passive: true });
  }
  syncViewportMetrics();
  syncBottomLayoutMetrics();
  streamScroll.schedule(() => {
    resizeComposer(composerRef.value, { keepBottom: false });
    observeBottomLayout();
    settleInitialScrollToBottom();
  });
});

onBeforeUnmount(() => {
  streamScroll.dispose();
  if (typeof window !== "undefined") {
    window.removeEventListener("resize", handleWindowResize);
    window.removeEventListener("pointerup", handleStreamPointerUp);
    window.removeEventListener("pointercancel", handleStreamPointerUp);
    window.visualViewport?.removeEventListener("resize", handleViewportChange);
    window.visualViewport?.removeEventListener("scroll", handleViewportChange);
  }
  layoutResizeObserver?.disconnect();
});
</script>

<template>
  <section class="mobile-shell chat-shell" :style="chatShellStyle">
    <ChatHeader :title="title" :cwd="workspaceCwd" @back="emit('back')" />

    <main class="chat-screen" :class="{ 'attention-expanded': attentionExpanded }">
      <section ref="messageListEl" class="message-stream" data-app-scroll :style="messageStreamStyle" tabindex="0" aria-label="聊天记录"
        @scroll="handleStreamScroll" @wheel.passive="handleStreamWheel" @touchstart.passive="handleStreamTouchStart"
        @touchmove.passive="handleStreamTouchMove" @touchend="handleStreamTouchEnd" @touchcancel="handleStreamTouchEnd"
        @keydown="handleStreamKeydown" @pointerdown="handleStreamPointerDown">
        <slot name="history-start" :load-older="() => streamScroll.loadOlder({ manual: true })" />
        <ThreadTurnTimeline
          v-show="!historyLoading"
          :snapshot="threadSnapshot"
          :thread-view-model="threadViewModel"
          :assistant-name="assistantName"
          :workspace-cwd="workspaceCwd"
          :can-answer-questions="canAnswerQuestions"
          :process-expanded="processExpanded"
          @status="emit('status', $event)"
          @process-toggle="handleProcessToggle"
          @turn-visibility="emit('turn-visibility', $event)"
          @question-answer="emit('question-answer', $event)"
        >
          <template #turn-footer="slotProps"><slot name="turn-footer" v-bind="slotProps" /></template>
          <template #item-footer="slotProps"><slot name="item-footer" v-bind="slotProps" /></template>
        </ThreadTurnTimeline>
        <span class="message-bottom-anchor" aria-hidden="true"></span>
      </section>

      <slot name="attention" />
      <div ref="composerHostEl" class="chat-composer-host" data-app-scroll>
        <p v-if="statusText" ref="statusEl" class="chat-status" role="status" aria-live="polite"><PixelCompanion v-if="runningTask" mood="thinking" :size="24" />{{ statusText }}</p>
        <slot name="composer-top" />
        <ChatComposer
          ref="composerRef"
          :draft="draft"
          :composer-options="composerOptions"
          :models="models"
          :permission-mode-options="permissionModeOptions"
          :git-state="gitState"
          :provider-id="providerId"
          :can-send="canSend"
          :can-interrupt="canInterrupt"
          :allow-followups="allowFollowups"
          :can-steer="canSteer"
          :running-task="runningTask"
          :follow-up-mode="followUpMode"
          :interrupting="interrupting"
          :loading="loading"
          @update:draft="emit('update:draft', $event)"
          @submit="emit('submit', $event)"
          @interrupt="emit('interrupt')"
          @status="emit('status', $event)"
          @update:composer-options="emit('update:composer-options', $event)"
          @add-attachments="emit('add-attachments', $event)"
          @remove-attachment="emit('remove-attachment', $event)"
          @retry-attachment="emit('retry-attachment', $event)"
          @switch-git-branch="emit('switch-git-branch', $event)"
          @create-git-branch="emit('create-git-branch', $event)"
          @refresh-git="emit('refresh-git')"
        />
      </div>
    </main>
  </section>
</template>

<style scoped>
.chat-shell {
  height: 100%;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background:
    radial-gradient(circle at top, rgba(255, 255, 255, 0.5), transparent 34%),
    linear-gradient(180deg, rgba(248, 244, 239, 0.98) 0%, rgba(243, 237, 231, 0.95) 100%),
    #f4eee8;
  color: #342d28;
}

.chat-screen {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  overflow-x: hidden;
}

.message-stream {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px 14px var(--chat-bottom-space, calc(40px + env(safe-area-inset-bottom)));
  padding-bottom: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

.chat-composer-host {
  flex: 0 0 auto;
  min-height: 0;
  max-height: 70%;
  overflow-y: auto;
  overflow-x: hidden;
}
.chat-composer-host :deep(.chat-composer-wrap) { position: relative; }

@media (max-width: 640px) {
  /* Keep the mounted composer and drafts while the answer form uses the space. */
  .attention-expanded .chat-composer-host { display: none; }
  .attention-expanded .message-stream { flex-basis: 0; padding-top: 0; }
}

.message-bottom-anchor {
  display: block;
  width: 1px;
  height: 1px;
  flex: 0 0 1px;
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
  overflow-wrap: anywhere;
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
  overflow-wrap: anywhere;
  word-break: break-word;
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
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-word;
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
  overflow-wrap: anywhere;
  word-break: break-word;
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
  overflow-wrap: anywhere;
  word-break: break-word;
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

.turn-thread {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.turn-process-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 6px;
}

.turn-process-item {
  align-self: stretch;
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
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 0 20px 8px;
  font-size: 12px;
  line-height: 1.45;
  color: #99897c;
  overflow-wrap: anywhere;
}

.subagent-panel {
  margin: 0 14px 10px;
  border: 1px solid rgba(220, 211, 201, 0.9);
  border-radius: 18px;
  background: rgba(255, 251, 248, 0.92);
  overflow: hidden;
}

.subagent-panel-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border: 0;
  background: transparent;
  color: #6d6156;
  font-size: 14px;
  text-align: left;
}

.subagent-panel-chevron {
  font-size: 18px;
  line-height: 1;
  transform: rotate(90deg);
  transition: transform 160ms ease;
}

.subagent-panel-chevron.expanded {
  transform: rotate(-90deg);
}

.subagent-panel-list {
  max-height: 180px;
  overflow-y: auto;
  border-top: 1px solid rgba(228, 220, 212, 0.9);
}

.subagent-panel-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-top: 1px solid rgba(244, 238, 233, 0.9);
}

.subagent-panel-item:first-child {
  border-top: 0;
}

.subagent-panel-name {
  min-width: 0;
  color: #433831;
  font-size: 14px;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.subagent-panel-status {
  flex-shrink: 0;
  color: #8d7d70;
  font-size: 12px;
  text-transform: lowercase;
}

.subagent-panel-status[data-status="running"] {
  color: #8b6d34;
}

.subagent-panel-status[data-status="done"] {
  color: #3f7d54;
}

.subagent-panel-status[data-status="failed"] {
  color: #b5483d;
}


</style>
