<script setup>
import { computed } from "vue";
import ThreadTurnSegment from "./ThreadTurnSegment.vue";

const props = defineProps({
  turn: { type: Object, required: true },
  assistantName: { type: String, default: "Codex" }
});

const statusLabel = computed(() => {
  const status = String(props.turn?.status || "").trim().toLowerCase();
  if (status === "completed") {
    return "已完成";
  }
  if (status === "failed") {
    return "失败";
  }
  if (status === "aborted") {
    return "已中断";
  }
  return "进行中";
});
</script>

<template>
  <article class="thread-turn-card" :data-status="turn.status">
    <ThreadTurnSegment
      v-for="segment in turn.segments"
      :key="segment.id"
      :segment="segment"
      :assistant-name="assistantName"
    />

    <footer class="thread-turn-footer">
      <span class="thread-turn-status">{{ statusLabel }}</span>
      <span v-if="turn.durationMs" class="thread-turn-duration">{{ Math.round(turn.durationMs / 1000) }}s</span>
    </footer>
  </article>
</template>

