<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import ThreadTurnSegment from "./ThreadTurnSegment.vue";
import WorkspaceChangesPanel from "./WorkspaceChangesPanel.vue";
import { formatActivityDuration } from "../../lib/activity-time.js";
import { observeElementVisibility } from "../../lib/element-visibility.js";

const props = defineProps({
  turn: { type: Object, required: true },
  assistantName: { type: String, default: "Codex" },
  workspaceCwd: { type: String, default: "" },
  canAnswerQuestions: Boolean,
  processExpanded: { type: Boolean, default: undefined },
  segmentExpanded: { type: Object, default: () => ({}) },
  interactiveWorkspaceChanges: { type: Boolean, default: false },
  workspaceWriteBlocked: { type: Boolean, default: false }
});

const emit = defineEmits(["status", "process-toggle", "turn-visibility", "question-answer"]);
const cardEl = ref(null);
const terminalStatuses = new Set(["completed", "failed", "interrupted", "aborted", "cancelled"]);
const turnStatus = computed(() => String(props.turn.status || "").trim().toLowerCase());
const showCompletedWorkspace = computed(() => terminalStatuses.has(turnStatus.value));
let stopVisibility = () => {};
onMounted(() => {
  stopVisibility = observeElementVisibility(cardEl.value, (visible) => emit("turn-visibility", visible));
});
onBeforeUnmount(() => { stopVisibility(); emit("turn-visibility", false); });
const errorMessage = computed(() => {
  const error = props.turn?.error;
  return String(typeof error === "string" ? error : error?.message || "").trim();
});

const statusLabel = computed(() => {
  const status = turnStatus.value;
  if (status === "completed") {
    return "已完成";
  }
  if (status === "failed") {
    return "失败";
  }
  if (["aborted", "interrupted", "cancelled"].includes(status)) {
    return "已中断";
  }
  if (status === "unknown") return "状态待确认";
  return "进行中";
});

const isRunningStatus = computed(() => !terminalStatuses.has(turnStatus.value) && turnStatus.value !== "unknown");
</script>

<template>
  <article ref="cardEl" class="thread-turn-card" :data-status="turn.status">
    <ThreadTurnSegment
      v-for="segment in turn.segments"
      :key="segment.id"
      :segment="segment"
      :assistant-name="assistantName"
      :workspace-cwd="workspaceCwd"
      :can-answer-questions="canAnswerQuestions"
      :expanded="segmentExpanded[segment.id] ?? processExpanded"
      @process-toggle="emit('process-toggle', $event)"
      @question-answer="emit('question-answer', $event)"
    >
      <template #item-footer="slotProps"><slot name="item-footer" v-bind="slotProps" /></template>
    </ThreadTurnSegment>

    <slot name="turn-footer" />

    <WorkspaceChangesPanel
      v-if="showCompletedWorkspace && (turn.fileChanges || []).length > 0"
      :cwd="workspaceCwd"
      :files="turn.fileChanges || []"
      :interactive="interactiveWorkspaceChanges"
      :read-only="workspaceWriteBlocked"
      @status="emit('status', $event)"
    />

    <footer class="thread-turn-footer">
      <span class="thread-turn-status" :data-running="isRunningStatus ? 'true' : 'false'">{{ statusLabel }}</span>
      <span v-if="turn.durationMs" class="thread-turn-duration">{{ formatActivityDuration(turn.durationMs) }}</span>
    </footer>
    <p v-if="errorMessage" class="thread-turn-error" role="alert">{{ errorMessage }}</p>
  </article>
</template>

<style scoped>
.thread-turn-error {
  margin: 8px 0 0;
  color: #a23535;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

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
