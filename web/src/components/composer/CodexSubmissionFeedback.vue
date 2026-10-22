<script setup>
import { computed } from "vue";
import { codexRequestError, codexRequestLabel } from "../../lib/codex-chat-presentation.js";
import { isCodexRequestDismissedMissing } from "../../lib/codex-chat-store.js";

const props = defineProps({ request: { type: Object, default: null }, pending: Boolean, busy: Boolean });
const emit = defineEmits(["restore", "check"]);
const unknown = computed(() => props.request?.state === "unknown");
const dismissed = computed(() => isCodexRequestDismissedMissing(props.request));
const label = computed(() => props.request
  ? dismissed.value ? "发送状态仍未确认" : codexRequestLabel(props.request) : "正在提交…");
const detail = computed(() => {
  if (!props.request) return "";
  if (dismissed.value) return "已解除发送锁定，原消息仍会自动核对；再次发送相同内容可能重复。";
  if (unknown.value) {
    const message = typeof props.request.error === "string" ? props.request.error : props.request.error?.message;
    return `${message || "正在自动核对发送状态。"} 确认前暂不能发送新消息。`;
  }
  return props.request.executionRoute === "desktopQuestion"
    ? `${codexRequestError(props.request)} 可在问题卡片中重新提交。` : codexRequestError(props.request);
});
const missing = computed(() => props.request?.error?.code === "receipt_not_found");
</script>

<template>
  <div v-if="pending || request" class="codex-submission-feedback" :class="{ 'is-failure': request && !unknown }"
    role="status" aria-live="polite" aria-atomic="true" aria-label="消息提交状态" :aria-busy="pending || busy">
    <div class="codex-submission-heading">
      <span class="codex-submission-label">{{ label }}</span>
      <button v-if="request && !unknown && request.executionRoute !== 'desktopQuestion'" type="button" :disabled="busy" :aria-busy="busy"
        aria-label="恢复这条消息到输入框" @click="emit('restore', request.id)">恢复到输入框</button>
      <button v-else-if="unknown && !dismissed" type="button" :disabled="busy" :aria-busy="busy"
        :aria-label="missing ? '核对这条消息并解除发送锁定' : '再次核对这条消息的发送状态'"
        :title="missing ? '再次核对后解除锁定；原消息不会自动重发，再次手动发送可能重复' : '只核对原消息的发送状态'"
        @click="emit('check', request.id)">{{ missing ? '核对并解除锁定' : '再次核对' }}</button>
    </div>
    <div v-if="detail" class="codex-submission-detail" role="region" aria-label="消息提交状态详情" tabindex="0">{{ detail }}</div>
  </div>
</template>

<style scoped>
.codex-submission-feedback { display: grid; gap: 4px; min-width: 0; margin: 0 24px 8px; color: #79634f; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.codex-submission-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 2px 12px; min-width: 0; min-height: 32px; }
.codex-submission-label { flex: 1 1 auto; min-width: 0; font-weight: 600; }
.codex-submission-detail { min-width: 0; max-height: 90px; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; white-space: pre-wrap; }
.is-failure .codex-submission-label, .is-failure .codex-submission-detail { color: #a23535; }
button { flex: 0 1 auto; min-width: 96px; min-height: 32px; max-width: 100%; border: 0; padding: 6px 4px; background: transparent; color: #79634f; font: inherit; line-height: 1.5; text-align: left; text-decoration: underline; text-underline-offset: 3px; overflow-wrap: anywhere; cursor: pointer; }
button:disabled { opacity: .55; cursor: wait; }
button:focus-visible, .codex-submission-detail:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
</style>
