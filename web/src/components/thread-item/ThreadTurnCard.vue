<script setup>
import { computed } from "vue";
import ThreadTurnSegment from "./ThreadTurnSegment.vue";
import WorkspaceChangesPanel from "./WorkspaceChangesPanel.vue";

const props = defineProps({
  turn: { type: Object, required: true },
  assistantName: { type: String, default: "Codex" },
  workspaceCwd: { type: String, default: "" },
  showWorkspaceChanges: { type: Boolean, default: false },
  interactiveWorkspaceChanges: { type: Boolean, default: false }
});

const emit = defineEmits(["status"]);

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

const isRunningStatus = computed(() => {
  const status = String(props.turn?.status || "").trim().toLowerCase();
  return !["completed", "failed", "aborted"].includes(status);
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

    <WorkspaceChangesPanel
      v-if="showWorkspaceChanges || (turn.fileChanges || []).length"
      :cwd="workspaceCwd"
      :files="turn.fileChanges || []"
      :interactive="interactiveWorkspaceChanges"
      @status="emit('status', $event)"
    />

    <footer class="thread-turn-footer">
      <span class="thread-turn-status" :data-running="isRunningStatus ? 'true' : 'false'">{{ statusLabel }}</span>
      <span v-if="turn.durationMs" class="thread-turn-duration">{{ Math.round(turn.durationMs / 1000) }}s</span>
    </footer>
  </article>
</template>

<style scoped>
.thread-turn-status[data-running="true"] {
  display: inline-block;
  color: rgba(112, 92, 72, 0.88);
  background: linear-gradient(
    90deg,
    rgba(160, 139, 118, 0.42) 0%,
    rgba(92, 74, 57, 0.96) 50%,
    rgba(160, 139, 118, 0.42) 100%
  );
  background-size: 220% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: thread-turn-running-glow 1.6s linear infinite;
}

@keyframes thread-turn-running-glow {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -20% 0;
  }
}
</style>
