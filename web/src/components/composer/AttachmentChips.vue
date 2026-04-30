<script setup>
const props = defineProps({
  attachments: { type: Array, default: () => [] },
  disabled: Boolean
});

const emit = defineEmits(["remove", "retry"]);

function iconForAttachment(attachment = {}) {
  return attachment.kind === "image" ? "🖼" : "📄";
}
</script>

<template>
  <div v-if="attachments.length" class="attachments">
    <span v-for="attachment in attachments" :key="attachment.id" class="chip" :data-status="attachment.status || 'pending'">
      <span class="chip-icon" aria-hidden="true">{{ iconForAttachment(attachment) }}</span>
      <span class="chip-name">{{ attachment.name }}</span>
      <button
        v-if="attachment.status === 'failed'"
        type="button"
        class="chip-remove"
        :disabled="disabled"
        :aria-label="`重试 ${attachment.name}`"
        @click="emit('retry', attachment.id)"
      >↻</button>
      <button
        v-else
        type="button"
        class="chip-remove"
        :disabled="disabled"
        :aria-label="`移除 ${attachment.name}`"
        @click="emit('remove', attachment.id)"
      >×</button>
    </span>
  </div>
</template>

<style scoped>
.attachments {
  display: flex;
  gap: 6px;
  padding: 0 9px 8px;
  overflow-x: auto;
}

.chip {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 136px;
  height: 29px;
  padding: 0 6px 0 8px;
  border: 1px solid rgba(218, 207, 197, 0.72);
  border-radius: 999px;
  background: rgba(241, 235, 229, 0.72);
  color: #5e5249;
  font-size: 12px;
}

.chip[data-status="failed"] {
  border-color: rgba(214, 79, 79, 0.4);
  background: rgba(255, 239, 239, 0.86);
  color: #a33c3c;
}

.chip-name {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chip-remove {
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: 99px;
  background: rgba(223, 213, 204, 0.72);
  color: #76685e;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}

.chip-icon {
  flex: 0 0 auto;
}
</style>
