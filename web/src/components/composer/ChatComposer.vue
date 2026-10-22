<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";

import {
  PERMISSION_MODE_OPTIONS,
  canSendComposerMessage,
  formatComposerContextSummary,
  hasOnlyFileAttachments
} from "../../lib/composer.js";
import AttachmentChips from "./AttachmentChips.vue";
import ComposerPopover from "./ComposerPopover.vue";
import ComposerSettings from "./ComposerSettings.vue";
import ComposerSendActions from "./ComposerSendActions.vue";

const MAX_COMPOSER_HEIGHT = 170;

const props = defineProps({
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
  interrupting: Boolean,
  loading: Boolean
});

const emit = defineEmits([
  "update:draft",
  "submit",
  "interrupt",
  "update:composer-options",
  "add-attachments",
  "remove-attachment",
  "retry-attachment",
  "refresh-git",
  "status"
]);

const textareaEl = ref(null);
const composerEl = ref(null);
const captureInputEl = ref(null);
const imageInputEl = ref(null);
const activePopover = ref("");
const isTouchDevice = ref(false);
const settingsDialogId = `composer-settings-${useId()}`;
let popoverRevision = 0;

const inputLocked = computed(() => Boolean(props.loading || (props.canInterrupt && !props.allowFollowups)));
const followupRunning = computed(() => props.runningTask || props.canInterrupt);
const hasDraftInput = computed(() => Boolean(String(props.draft || "").trim()) || Boolean(props.composerOptions.attachments?.length));
const defaultSubmitMode = computed(() => followupRunning.value && props.followUpMode !== "queue" ? "steer" : "queue");
const primaryActionLabel = computed(() => props.canInterrupt ? props.allowFollowups ? "加入队列" : "停止生成" : "发送消息");
const canPrimaryAction = computed(() => (!props.allowFollowups && props.canInterrupt) || (props.canSend && !inputLocked.value));
const addDisabled = computed(() => inputLocked.value);
const settingsDisabled = computed(() => props.loading);
const showPermissionMode = computed(() => String(props.providerId || "").trim().toLowerCase() === "codex");
const contextSummary = computed(() => formatComposerContextSummary(props.composerOptions, props.models));
const onlyFileAttachments = computed(() => hasOnlyFileAttachments(props.composerOptions.attachments || []));

function resizeComposer() {
  const el = textareaEl.value;
  if (!el) {
    return;
  }
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
  el.style.overflowY = el.scrollHeight > MAX_COMPOSER_HEIGHT ? "auto" : "hidden";
}

function updateComposerOptions(patch) {
  emit("update:composer-options", patch);
}

async function togglePopover(name) {
  if ((name === "add" && addDisabled.value) || (name === "settings" && settingsDisabled.value)) {
    return;
  }
  if (activePopover.value === name) { closePopover(); return; }
  const version = ++popoverRevision;
  if (activePopover.value) {
    activePopover.value = "";
    await nextTick();
    if (version !== popoverRevision || settingsDisabled.value) return;
  }
  activePopover.value = name;
}

function closePopover() {
  popoverRevision += 1;
  activePopover.value = "";
}

function focusComposer() {
  const target = !inputLocked.value ? textareaEl.value : composerEl.value;
  target?.focus?.({ preventScroll: true });
}

function handleInput(event) {
  emit("update:draft", event.target.value);
  resizeComposer();
}

function handleComposerKeydown(event) {
  if (event.isComposing || event.keyCode === 229) {
    return;
  }

  if (props.allowFollowups && event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
    if (props.canSend && !inputLocked.value) {
      event.preventDefault(); emit("submit", { mode: followupRunning.value ? "steer" : "queue" });
    }
    return;
  }

  const wantsSubmitShortcut =
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !isTouchDevice.value;

  if (wantsSubmitShortcut && !inputLocked.value && canPrimaryAction.value && canSendComposerMessage(props.draft, props.composerOptions.attachments || [])) {
    event.preventDefault();
    emit("submit", props.allowFollowups ? { mode: defaultSubmitMode.value } : undefined);
  }
}

function handlePrimaryAction(selection) {
  if (props.canInterrupt && !props.allowFollowups) {
    emit("interrupt");
    return;
  }
  if (!canPrimaryAction.value) {
    return;
  }
  if (onlyFileAttachments.value && !String(props.draft || "").trim()) {
    emit("status", "当前版本文件附件仅保存选择状态，暂不随消息发送。");
    return;
  }
  emit("submit", props.allowFollowups ? { mode: selection?.mode || defaultSubmitMode.value } : undefined);
}

function triggerInput(inputRef) {
  if (addDisabled.value) {
    return;
  }
  closePopover();
  (inputRef?.value || inputRef)?.click();
}

function handleSelectedFiles(event, kindHint, source) {
  const files = [...(event?.target?.files || [])];
  if (files.length) {
    emit("add-attachments", { files, kindHint, source });
  }
  if (event?.target) {
    event.target.value = "";
  }
}

function handleTextareaPaste(event) {
  if (addDisabled.value) return;
  const items = [...(event.clipboardData?.items || [])];
  const files = items
    .filter((item) => item.kind === "file" && String(item.type || "").startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);

  if (!files.length) {
    return;
  }

  event.preventDefault();
  emit("add-attachments", { files, kindHint: "image", source: "clipboard" });
}

async function handleClipboardPasteRequest() {
  closePopover();
  if (!navigator?.clipboard?.read) {
    emit("status", "当前浏览器暂不支持直接读取剪贴板图片。");
    return;
  }

  try {
    const clipboardItems = await navigator.clipboard.read();
    const files = [];
    for (const item of clipboardItems) {
      const imageType = item.types.find((type) => String(type || "").startsWith("image/"));
      if (!imageType) {
        continue;
      }
      const blob = await item.getType(imageType);
      files.push(new File([blob], `clipboard-image-${Date.now()}.png`, { type: blob.type || imageType }));
    }

    if (!files.length) {
      emit("status", "剪贴板里没有可用的图片。");
      return;
    }
    emit("add-attachments", { files, kindHint: "image", source: "clipboard" });
  } catch (error) {
    emit("status", error?.message || "读取剪贴板图片失败。");
  }
}

watch(
  () => props.draft,
  () => nextTick(resizeComposer),
  { flush: "post", immediate: true }
);

watch(
  () => props.loading,
  () => {
    if (props.loading) {
      closePopover();
    }
  }
);

onMounted(() => {
  if (typeof window !== "undefined") {
    isTouchDevice.value =
      window.matchMedia?.("(pointer: coarse)").matches ||
      navigator.maxTouchPoints > 0;
  }
  resizeComposer();
});

onBeforeUnmount(() => {
  closePopover();
});

defineExpose({
  resizeComposer
});
</script>

<template>
  <div ref="composerEl" class="chat-composer-wrap" tabindex="-1">
    <form class="chat-composer" @submit.prevent="handlePrimaryAction">
      <ComposerPopover :id="settingsDialogId" :open="activePopover === 'settings'" title="输入设置" :fallback-focus="focusComposer" @close="closePopover">
        <ComposerSettings
          :models="models"
          :permission-mode-options="permissionModeOptions"
          :composer-options="composerOptions"
          :git-state="gitState"
          :disabled="settingsDisabled"
          :show-permission-mode="showPermissionMode"
          @select-model="updateComposerOptions({ model: $event })"
          @select-reasoning="updateComposerOptions({ reasoningEffort: $event })"
          @select-permission="updateComposerOptions({ permissionMode: $event })"
          @refresh-git="emit('refresh-git')"
        />
      </ComposerPopover>

      <textarea
        ref="textareaEl"
        :value="draft"
        class="chat-composer-draft"
        aria-label="消息输入框"
        rows="1"
        :placeholder="allowFollowups && followupRunning ? '补充消息…' : isTouchDevice ? '给 Codex 发消息…' : 'Enter 发送，Shift + Enter 换行'"
        :disabled="inputLocked"
        :enterkeyhint="isTouchDevice ? 'enter' : 'send'"
        @input="handleInput"
        @keydown="handleComposerKeydown"
        @paste="handleTextareaPaste"
      ></textarea>

      <AttachmentChips
        :attachments="composerOptions.attachments || []"
        :disabled="inputLocked"
        @remove="emit('remove-attachment', $event)"
        @retry="emit('retry-attachment', $event)"
      />

      <p v-if="allowFollowups && followupRunning && hasDraftInput" class="composer-followup-note" role="status">{{ defaultSubmitMode === 'queue' ? '加入队列 · 当前回复结束后发送' : '立即引导 · 补充给当前回复' }}</p>
      <div class="chat-composer-actions">
        <button
          class="chat-composer-icon-button"
          type="button"
          aria-label="添加图片"
          title="添加图片"
          :disabled="addDisabled"
          @click="triggerInput(imageInputEl)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14"></path>
          </svg>
        </button>
        <button
          v-if="isTouchDevice"
          class="chat-composer-icon-button"
          type="button"
          aria-label="拍照"
          title="拍照"
          :disabled="addDisabled"
          @click="triggerInput(captureInputEl)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h3l2-3h4l2 3h3v13H5z"></path><circle cx="12" cy="13" r="3"></circle></svg>
        </button>

        <button
          class="chat-composer-context-button"
          aria-label="输入设置：模型、思考强度、权限与分支"
          title="输入设置"
          type="button"
          aria-haspopup="dialog"
          :aria-expanded="Boolean(activePopover)"
          :aria-controls="activePopover === 'git' ? gitDialogId : settingsDialogId"
          :disabled="settingsDisabled"
          @click="togglePopover('settings')"
        >
          <span class="chat-composer-context-copy">{{ contextSummary }}</span>
          <svg class="chat-context-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
        </button>

        <ComposerSendActions v-if="allowFollowups" :running-task="followupRunning" :follow-up-mode="followUpMode"
          :has-input="hasDraftInput" :can-interrupt="canInterrupt" :disabled="!canPrimaryAction" :fallback-focus="focusComposer"
          :can-steer="canSteer" :interrupting="interrupting" @interrupt="emit('interrupt')"
          @submit="handlePrimaryAction" />
        <button
          v-else
          class="primary-button chat-composer-send"
          type="button"
          :aria-label="primaryActionLabel"
          :title="primaryActionLabel"
          :disabled="!canPrimaryAction"
          @click="handlePrimaryAction"
        >
          <span v-if="canInterrupt && !allowFollowups" class="chat-composer-stop" aria-hidden="true"></span>
          <template v-else>发送</template>
        </button>
      </div>
    </form>

    <input
      ref="captureInputEl"
      class="chat-composer-hidden-input"
      type="file"
      tabindex="-1"
      aria-hidden="true"
      accept="image/*"
      capture="environment"
      @change="handleSelectedFiles($event, 'image', 'camera')"
    >
    <input
      ref="imageInputEl"
      class="chat-composer-hidden-input"
      type="file"
      tabindex="-1"
      aria-hidden="true"
      accept="image/*"
      multiple
      @change="handleSelectedFiles($event, 'image', 'upload-image')"
    >
  </div>
</template>

<style scoped>
.chat-composer-wrap {
  position: sticky;
  bottom: 0;
  z-index: 5;
  width: 100%;
  min-width: 0;
  padding: 0px 12px calc(12px + env(safe-area-inset-bottom) + clamp(0px, var(--chat-keyboard-inset, 0px), 24px));
}

.chat-composer {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  position: relative;
  border: 1px solid rgba(219, 207, 197, 0.78);
  border-radius: 20px;
  background: linear-gradient(180deg, rgba(255, 253, 250, 0.98), rgba(253, 248, 244, 0.96));
  box-shadow:
    0 18px 42px rgba(113, 91, 72, 0.12),
    0 1px 0 rgba(255, 255, 255, 0.9) inset;
  overflow: hidden;
}

.chat-composer-draft {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 48px;
  max-height: 170px;
  padding: 12px 15px 10px;
  border: 0;
  outline: 0;
  resize: none;
  background: transparent;
  color: #372f29;
  font-size: 16px;
  line-height: 1.5;
}

.chat-composer-draft:disabled {
  color: #aa9b8f;
}

.chat-composer:focus-within { border-color: #ad9985; box-shadow: 0 0 0 2px #b6a08b26, 0 10px 30px #715b4810; }
.chat-composer-icon-button:focus-visible, .chat-composer-context-button:focus-visible { outline: 2px solid #8b7f73; outline-offset: -2px; }

.composer-followup-note { margin: 0; padding: 0 15px 8px; color: #8b7f73; font-size: 11px; line-height: 1.5; }

.chat-composer-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 7px;
  border-top: 1px solid rgba(230, 221, 212, 0.58);
  background: rgba(249, 245, 241, 0.68);
  border-bottom-left-radius: 20px;
  border-bottom-right-radius: 20px;
}

.chat-composer-icon-button {
  flex: 0 0 auto;
  width: 36px;
  height: 36px;
  display: inline-grid;
  place-items: center;
  border: 0;
  border-radius: 13px;
  background: transparent;
  color: #75685f;
  padding: 0;
}

.chat-composer-icon-button:disabled,
.chat-composer-context-button:disabled,
.chat-composer-send:disabled {
  opacity: 0.46;
  cursor: default;
}

.chat-composer-icon-button svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.chat-composer-context-button {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 0;
  min-width: 0;
  min-height: 36px;
  padding: 0 12px;
  border: 0;
  border-radius: 999px;
  background: rgba(241, 235, 229, 0.78);
  color: #5e5249;
  text-align: left;
  overflow: hidden;
}

.chat-context-chevron { width: 14px; height: 14px; flex: 0 0 auto; fill: none; stroke: #8b7f73; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }

.chat-composer-context-copy {
  display: block;
  width: 100%;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
  line-height: 1.35;
}

.chat-composer-send {
  flex: 0 0 auto;
  width: auto;
  min-width: 74px;
  min-height: 36px;
  margin-top: 0;
  padding: 0 18px;
  border-radius: 999px;
  touch-action: manipulation;
}

.chat-composer-stop {
  display: inline-block;
  width: 12px;
  height: 12px;
  background: currentColor;
  border-radius: 2px;
}

.chat-composer-hidden-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
@media (pointer: coarse) {
  .chat-composer-icon-button { width: 44px; height: 44px; }
  .chat-composer-context-button { min-height: 44px; }
}
</style>
