<script setup>
import { computed } from "vue";
import { buildThreadViewModel } from "../../lib/thread-view-model.js";
import ThreadTurnCard from "./ThreadTurnCard.vue";

const props = defineProps({
  snapshot: { type: Object, default: null },
  liveOverlay: { type: Object, default: null },
  assistantName: { type: String, default: "Codex" },
  workspaceCwd: { type: String, default: "" }
});

const emit = defineEmits(["status"]);

const viewModel = computed(() =>
  buildThreadViewModel(props.snapshot || {}, {
    assistantName: props.assistantName,
    liveOverlay: props.liveOverlay
  })
);
</script>

<template>
  <div class="thread-turn-timeline">
    <ThreadTurnCard
      v-for="turn in viewModel.turns"
      :key="turn.id"
      :turn="turn"
      :assistant-name="assistantName"
      :workspace-cwd="workspaceCwd"
      :show-workspace-changes="turn.id === viewModel.latestFileChangeTurnId"
      @status="emit('status', $event)"
    />
  </div>
</template>
