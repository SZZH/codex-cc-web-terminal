<script setup>
import { reactive } from "vue";
import CodexSubmissionFeedback from "./CodexSubmissionFeedback.vue";
import LucideIcon from "../icons/LucideIcon.vue";

const props = defineProps({ messages: { type: Array, default: () => [] }, canGuide: Boolean, guideDisabled: Boolean, runningTask: Boolean,
  actions: { type: Object, default: () => ({}) } });
const emit = defineEmits(["guide", "cancel", "restore", "check"]);
const expanded = reactive(new Set());
const togglePreview = (id) => expanded.has(id) ? expanded.delete(id) : expanded.add(id);
const needsAttention = (message) => ["unknown", "failed", "rejected"].includes(message.state);
const isSubmitting = (message) => ["sending", "dispatching"].includes(message.state);
const guideReason = (message) => Object.keys(message.request?.options || {}).length ? "这条消息将使用新设置开始下一轮回复" : message.state === "queued" ? "请在 Codex 桌面端引导这条排队消息"
  : !props.canGuide ? props.runningTask ? "请在 Codex 桌面端引导当前任务" : "当前没有正在执行的回复"
  : props.guideDisabled ? "正在核对消息状态，稍后可引导" : "";
const guide = (message) => {
  if (!guideReason(message) && !props.actions[`steer:${message.id}`]) emit("guide", message.id);
};
</script>

<template>
  <section v-if="messages.length" class="codex-queued-messages" aria-label="待发送消息">
    <ol class="queue-list" tabindex="0" aria-label="排队消息列表">
      <li v-for="message in messages" :key="message.id" class="queue-message" :data-request-id="message.id">
        <div class="queue-row">
          <LucideIcon name="list-end" class="queue-mark" />
          <button type="button" class="queue-preview" :aria-expanded="expanded.has(message.id)"
            :aria-label="`${expanded.has(message.id) ? '收起' : '查看'}待发送消息：${message.text || '图片'}`" @click="togglePreview(message.id)">
            <img v-if="message.images.length" class="queue-thumbnail" :src="message.images[0].url"
              :alt="message.images[0].name || '排队图片'" loading="lazy" />
            <span class="queue-text">{{ message.text || `${message.images.length} 张图片` }}</span>
          </button>
          <span v-if="isSubmitting(message)" class="queue-pending" role="status">提交中</span>
          <button v-if="['received', 'queued'].includes(message.state)" type="button" class="queue-action"
            :title="guideReason(message) || '将这条消息引导到当前回复'"
            :aria-label="`引导排队消息：${message.text || '图片'}`" :aria-description="guideReason(message) || undefined"
            :disabled="Boolean(guideReason(message)) || Boolean(actions[`steer:${message.id}`])"
            :aria-busy="Boolean(actions[`steer:${message.id}`])" @click="guide(message)">
            <LucideIcon name="corner-up-right" />
            <span>{{ actions[`steer:${message.id}`] ? '提交中' : '引导' }}</span>
          </button>
          <button v-if="message.state === 'queued' || message.state === 'received' && message.request?.executionRoute === 'settingsQueue'" type="button" class="queue-action" title="撤回尚未执行的消息"
            :aria-label="`撤回排队消息：${message.text || '图片'}`"
            :disabled="Boolean(actions[`cancel:${message.id}`])" :aria-busy="Boolean(actions[`cancel:${message.id}`])"
            @click="emit('cancel', message.id)">
            <LucideIcon name="trash-2" />
          </button>
        </div>
        <div v-if="expanded.has(message.id)" class="queue-detail">
          <div v-if="message.images.length" class="queue-images">
            <img v-for="(image, index) in message.images" :key="image.url" :src="image.url"
              :alt="image.name || `排队图片 ${index + 1}`" loading="lazy" />
          </div>
          <p v-if="message.text">{{ message.text }}</p>
        </div>
        <CodexSubmissionFeedback v-if="needsAttention(message)" :request="message.request"
          :busy="Boolean(actions[`restore:${message.id}`] || actions[`dismiss:${message.id}`])"
          @restore="emit('restore', $event)" @check="emit('check', $event)" />
      </li>
    </ol>
  </section>
</template>

<style scoped>
.codex-queued-messages { min-width: 0; margin: 4px 24px -12px; padding: 0 10px 12px; border: 1px solid rgba(192, 175, 160, .38); border-bottom: 0; border-radius: 16px 16px 0 0; background: rgba(255, 253, 250, .6); color: #8a7d72; font-size: 12px; line-height: 1.5; }
.queue-list { max-height: min(210px, 26dvh); overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; margin: 0; padding: 0; list-style: none; scrollbar-width: thin; }
.queue-message { min-width: 0; }
.queue-row { display: flex; align-items: center; gap: 6px; min-height: 44px; }
.queue-message + .queue-message { border-top: 1px solid rgba(122, 103, 85, .16); }
.queue-mark { flex: 0 0 auto; width: 18px; height: 18px; color: #8a7d72; }
.queue-preview { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 4px 0; border: 0; background: transparent; color: #42392f; font: inherit; text-align: left; cursor: pointer; }
.queue-text { min-width: 0; color: #42392f; font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.queue-thumbnail { flex: 0 0 auto; width: 28px; height: 28px; object-fit: cover; border: 1px solid var(--line, #e7e1db); border-radius: 4px; }
.queue-detail { padding: 2px 0 10px 20px; }
.queue-detail p { margin: 0; color: #51473e; font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
.queue-images { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 5px; }
.queue-images img { width: 44px; height: 44px; border-radius: 7px; object-fit: cover; background: #eee8e1; }
.queue-pending { flex: 0 0 auto; min-height: 44px; display: flex; align-items: center; color: #857564; }
.queue-action { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-width: 44px; min-height: 44px; padding: 0 6px; border: 0; border-radius: 8px; background: transparent; color: #807164; font: inherit; cursor: pointer; }
.queue-action svg { width: 18px; height: 18px; }
.queue-action:disabled { opacity: .45; cursor: not-allowed; }
.queue-action[aria-busy="true"] { cursor: wait; }
.queue-action:active { background: rgba(122, 103, 85, .12); }
.queue-action:focus-visible, .queue-preview:focus-visible, .queue-list:focus-visible { outline: 2px solid #79634f; outline-offset: -2px; }
.queue-message :deep(.codex-submission-feedback) { margin: 0 0 10px; }
@media (hover: hover) { .queue-action:hover { background: rgba(122, 103, 85, .08); } }
</style>
