<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import {
  canSendComposerMessage,
  formatComposerContextSummary,
  hasOnlyFileAttachments
} from "../../lib/composer.js";
import AddContentMenu from "./AddContentMenu.vue";
import AttachmentChips from "./AttachmentChips.vue";
import ComposerPopover from "./ComposerPopover.vue";
import ComposerSettings from "./ComposerSettings.vue";
import GitBranchMenu from "./GitBranchMenu.vue";

const MAX_COMPOSER_HEIGHT = 170;

const props = defineProps({
  draft: { type: String, default: "" },
  composerOptions: { type: Object, required: true },
  models: { type: Array, default: () => [] },
  gitState: { type: Object, required: true },
  providerId: { type: String, default: "codex" },
  canSend: Boolean,
  canInterrupt: Boolean,
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
  "switch-git-branch",
  "create-git-branch",
  "status"
]);

const textareaEl = ref(null);
const captureInputEl = ref(null);
const imageInputEl = ref(null);
const fileInputEl = ref(null);
const activePopover = ref("");
const isTouchDevice = ref(false);

const inputLocked = computed(() => Boolean(props.loading || props.canInterrupt));
const primaryActionLabel = computed(() => (inputLocked.value ? "发送中" : "发送"));
const canPrimaryAction = computed(() => props.canSend && !inputLocked.value);
const addDisabled = computed(() => props.loading || props.canInterrupt);
const settingsDisabled = computed(() => props.loading || props.canInterrupt);
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

function togglePopover(name) {
  if ((name === "add" && addDisabled.value) || ((name === "settings" || name === "git") && settingsDisabled.value)) {
    return;
  }
  if (name === "git" && !props.gitState.available) {
    emit("status", "Git 状态暂不可用");
    return;
  }
  if (name === "git" && !props.gitState.isGitRepo) {
    emit("status", "当前目录不是 Git 仓库");
    return;
  }
  activePopover.value = activePopover.value === name ? "" : name;
}

function closePopover() {
  activePopover.value = "";
}

function handleInput(event) {
  emit("update:draft", event.target.value);
  resizeComposer();
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

  if (wantsSubmitShortcut && canPrimaryAction.value && canSendComposerMessage(props.draft, props.composerOptions.attachments || [])) {
    event.preventDefault();
    emit("submit");
  }
}

function handlePrimaryAction() {
  if (!canPrimaryAction.value) {
    return;
  }
  if (onlyFileAttachments.value && !String(props.draft || "").trim()) {
    emit("status", "当前版本文件附件仅保存选择状态，暂不随消息发送。");
    return;
  }
  emit("submit");
}

function triggerInput(inputRef) {
  if (addDisabled.value) {
    return;
  }
  closePopover();
  inputRef.value?.click();
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
  () => props.canInterrupt || props.loading,
  () => {
    if (props.canInterrupt || props.loading) {
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
  activePopover.value = "";
});

defineExpose({
  resizeComposer
});
</script>

<template>
  <div class="chat-composer-wrap">
    <form class="chat-composer" @submit.prevent="handlePrimaryAction">
      <!-- 文件上传入口暂时下线，相关交互保留在代码里方便后续恢复。 -->
      <!--
      <ComposerPopover :open="activePopover === 'add'" title="添加内容" @close="closePopover">
        <AddContentMenu
          @capture-photo="triggerInput(captureInputEl)"
          @upload-images="triggerInput(imageInputEl)"
          @upload-files="triggerInput(fileInputEl)"
          @paste-clipboard="handleClipboardPasteRequest"
        />
      </ComposerPopover>
      -->

      <ComposerPopover :open="activePopover === 'settings'" title="输入设置" @close="closePopover">
        <ComposerSettings
          :models="models"
          :composer-options="composerOptions"
          :git-state="gitState"
          :disabled="settingsDisabled"
          :show-permission-mode="showPermissionMode"
          @select-model="updateComposerOptions({ model: $event })"
          @select-reasoning="updateComposerOptions({ reasoningEffort: $event })"
          @open-git="togglePopover('git')"
        />
      </ComposerPopover>

      <ComposerPopover :open="activePopover === 'git'" title="Git 分支" @close="closePopover">
        <GitBranchMenu
          :git-state="gitState"
          :disabled="settingsDisabled || !gitState.isGitRepo"
          :busy="gitState.loading"
          @select-branch="emit('switch-git-branch', $event)"
          @create-branch="emit('create-git-branch', $event)"
        />
      </ComposerPopover>

      <textarea
        ref="textareaEl"
        :value="draft"
        class="chat-composer-draft"
        rows="1"
        :placeholder="isTouchDevice ? '给 Codex 发消息…' : 'Enter 发送，Shift + Enter 换行'"
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

      <div class="chat-composer-actions">
        <!--
        <button
          class="chat-composer-icon-button"
          type="button"
          aria-label="添加内容"
          :disabled="addDisabled"
          @click="togglePopover('add')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14"></path>
          </svg>
        </button>
        -->

        <button
          class="chat-composer-context-button"
          type="button"
          :disabled="settingsDisabled"
          @click="togglePopover('settings')"
        >
          <span class="chat-composer-context-copy">{{ contextSummary }}</span>
        </button>

        <button
          class="primary-button chat-composer-send"
          type="button"
          aria-label="发送消息"
          :disabled="!canPrimaryAction"
          @click="handlePrimaryAction"
        >
          {{ primaryActionLabel }}
        </button>
      </div>
    </form>

    <!--
    <input
      ref="captureInputEl"
      class="chat-composer-hidden-input"
      type="file"
      accept="image/*"
      capture="environment"
      @change="handleSelectedFiles($event, 'image', 'camera')"
    >
    <input
      ref="imageInputEl"
      class="chat-composer-hidden-input"
      type="file"
      accept="image/*"
      multiple
      @change="handleSelectedFiles($event, 'image', 'upload-image')"
    >
    <input
      ref="fileInputEl"
      class="chat-composer-hidden-input"
      type="file"
      multiple
      @change="handleSelectedFiles($event, 'file', 'upload-file')"
    >
    -->
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

.chat-composer-hidden-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
</style>
