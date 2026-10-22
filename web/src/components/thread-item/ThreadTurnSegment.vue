<script setup>
import { ref, watch } from "vue";
import ThreadItemRenderer from "./ThreadItemRenderer.vue";
import ThreadSubagentActivity from "./ThreadSubagentActivity.vue";

const props = defineProps({
  segment: { type: Object, required: true },
  assistantName: { type: String, default: "Codex" },
  workspaceCwd: { type: String, default: "" },
  canAnswerQuestions: Boolean,
  expanded: { type: Boolean, default: undefined }
});
const emit = defineEmits(["process-toggle", "question-answer"]);

const collapsed = ref(Boolean(props.segment?.defaultCollapsed));

watch(
  () => `${props.segment?.id || ""}:${props.segment?.defaultCollapsed ? "1" : "0"}`,
  () => {
    collapsed.value = typeof props.expanded === "boolean" ? !props.expanded : Boolean(props.segment?.defaultCollapsed);
  },
  { immediate: true }
);
watch(() => props.expanded, (expanded) => { if (typeof expanded === "boolean") collapsed.value = !expanded; });
function toggleProcess() {
  collapsed.value = !collapsed.value;
  emit("process-toggle", { segmentId: props.segment.id, expanded: !collapsed.value });
}
</script>

<template>
  <section class="turn-segment" :class="`turn-segment-${segment.kind}`">
    <div v-if="segment.kind === 'process'" class="turn-process-segment">
      <button
        type="button"
        class="turn-process-toggle"
        :data-thread-item-id="segment.items?.length ? `process:${segment.items.at(-1).id}` : undefined"
        :aria-expanded="!collapsed"
        :aria-controls="`${segment.id}-details`"
        :title="segment.processSummary?.label"
        @click="toggleProcess"
      >
        <span class="turn-process-state" :data-running="segment.processSummary?.running ? 'true' : 'false'" aria-hidden="true"></span>
        <span class="turn-process-label">{{ segment.processSummary?.compactLabel || '执行记录' }}</span>
        <span class="turn-process-toggle-icon" :class="{ expanded: !collapsed }" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>

      <div v-if="!collapsed && (segment.visibleItems || segment.items || []).length" :id="`${segment.id}-details`" class="turn-process-items">
        <template v-for="item in segment.visibleItems || segment.items" :key="item.id">
          <ThreadItemRenderer :item="item" :assistant-name="assistantName" :workspace-cwd="workspaceCwd" compact-process
            :can-answer-questions="canAnswerQuestions" @question-answer="emit('question-answer', $event)" />
          <slot name="item-footer" :item="item" />
        </template>
      </div>
      <p v-else-if="!collapsed" class="turn-process-empty">命令已完成，没有额外输出。</p>
    </div>

    <div v-else-if="segment.kind === 'activity'" class="turn-subagent-activities">
      <ThreadSubagentActivity v-for="item in segment.items" :key="item.id" :item="item" :data-thread-item-id="item.id" />
    </div>

    <div v-else class="turn-segment-items">
      <template v-for="item in segment.items" :key="item.id">
        <ThreadItemRenderer :item="item" :assistant-name="assistantName" :workspace-cwd="workspaceCwd"
          :can-answer-questions="canAnswerQuestions" @question-answer="emit('question-answer', $event)" />
        <slot name="item-footer" :item="item" />
      </template>
    </div>
  </section>
</template>
