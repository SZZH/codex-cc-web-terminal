<script setup>
import { computed } from "vue";
import { buildThreadViewModel } from "../../lib/thread-view-model.js";
import ThreadTurnCard from "./ThreadTurnCard.vue";

const props = defineProps({
  snapshot: { type: Object, default: null },
  liveOverlay: { type: Object, default: null },
  assistantName: { type: String, default: "Codex" }
});

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
    />
  </div>
</template>

