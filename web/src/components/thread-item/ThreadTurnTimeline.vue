<script setup>
import { computed } from "vue";
import { buildThreadViewModel } from "../../lib/thread-view-model.js";
import ThreadTurnCard from "./ThreadTurnCard.vue";

const props = defineProps({
  snapshot: { type: Object, default: null },
  threadViewModel: { type: Object, default: null },
  assistantName: { type: String, default: "Codex" },
  workspaceCwd: { type: String, default: "" },
  canAnswerQuestions: Boolean,
  processExpanded: { type: Object, default: () => ({}) }
});

const emit = defineEmits(["status", "process-toggle", "turn-visibility", "question-answer"]);

const viewModel = computed(() =>
  props.threadViewModel || buildThreadViewModel(props.snapshot || {}, {
    assistantName: props.assistantName
  })
);
const terminalStatuses = new Set(["completed", "failed", "interrupted", "aborted", "cancelled"]);
const workspaceWriteBlocked = computed(() => viewModel.value.turns.some((turn) =>
  !terminalStatuses.has(String(turn.status).trim().toLowerCase())));
</script>

<template>
  <div class="thread-turn-timeline">
    <ThreadTurnCard
      v-for="turn in viewModel.turns"
      :key="turn.id"
      :turn="turn"
      :assistant-name="assistantName"
      :workspace-cwd="workspaceCwd"
      :can-answer-questions="canAnswerQuestions"
      :process-expanded="processExpanded[turn.id]"
      :segment-expanded="processExpanded"
      :interactive-workspace-changes="!workspaceWriteBlocked && (turn.fileChanges || []).length > 0"
      :workspace-write-blocked="workspaceWriteBlocked"
      @status="emit('status', $event)"
      @process-toggle="emit('process-toggle', { turnId: turn.id, ...$event })"
      @turn-visibility="emit('turn-visibility', { turnId: turn.id, visible: $event })"
      @question-answer="emit('question-answer', $event)"
    >
      <template #turn-footer><slot name="turn-footer" :turn-id="turn.id" /></template>
      <template #item-footer="slotProps"><slot name="item-footer" :turn-id="turn.id" v-bind="slotProps" /></template>
    </ThreadTurnCard>
  </div>
</template>
