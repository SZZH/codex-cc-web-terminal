<script setup>
import { ref, watch } from "vue";
import ThreadItemRenderer from "./ThreadItemRenderer.vue";

const props = defineProps({
  segment: { type: Object, required: true },
  assistantName: { type: String, default: "Codex" }
});

const collapsed = ref(Boolean(props.segment?.defaultCollapsed));

watch(
  () => `${props.segment?.id || ""}:${props.segment?.defaultCollapsed ? "1" : "0"}`,
  () => {
    collapsed.value = Boolean(props.segment?.defaultCollapsed);
  },
  { immediate: true }
);
</script>

<template>
  <section class="turn-segment" :class="`turn-segment-${segment.kind}`">
    <div v-if="segment.kind === 'process'" class="turn-process-segment">
      <button
        type="button"
        class="turn-process-toggle"
        @click="collapsed = !collapsed"
      >
        <span>{{ segment.processSummary?.label || `执行过程 ${segment.items.length} 项` }}</span>
        <span class="turn-process-toggle-icon" :class="{ expanded: !collapsed }">›</span>
      </button>

      <div v-if="!collapsed" class="turn-process-items">
        <div class="turn-process-fade turn-process-fade-top" aria-hidden="true"></div>
        <ThreadItemRenderer
          v-for="item in segment.items"
          :key="item.id"
          :item="item"
          :assistant-name="assistantName"
        />
        <div class="turn-process-fade turn-process-fade-bottom" aria-hidden="true"></div>
      </div>
    </div>

    <div v-else class="turn-segment-items">
      <ThreadItemRenderer
        v-for="item in segment.items"
        :key="item.id"
        :item="item"
        :assistant-name="assistantName"
      />
    </div>
  </section>
</template>
