<script setup>
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { activityDuration, activityTimestamp, formatActivityDuration } from "../../lib/activity-time.js";

const props = defineProps({ item: { type: Object, required: true } });
const activity = computed(() => props.item.activity || {});
const now = ref(Date.now());
let timer = null;
watch(() => [activity.value.state, activity.value.startedAt], () => {
  clearInterval(timer); timer = null; now.value = Date.now();
  if (activity.value.state === "running" && activityTimestamp(activity.value.startedAt) != null) {
    timer = setInterval(() => { now.value = Date.now(); }, 1000);
  }
}, { immediate: true });
onBeforeUnmount(() => clearInterval(timer));
const elapsed = computed(() => formatActivityDuration(activityDuration(activity.value, now.value)));
const label = computed(() => (activity.value.label || activity.value.agentPath?.split("/").at(-1) || "子智能体").replaceAll("_", " "));
const stateLabel = computed(() => ({ running: "正在运行", completed: "已完成", failed: "失败", interrupted: "已中断", unknown: "状态待确认" })[activity.value.state] || "状态待确认");
const href = computed(() => activity.value.agentThreadId ? `#/chat/history:codex:${encodeURIComponent(activity.value.agentThreadId)}` : "");
</script>

<template>
  <div class="subagent-activity" :data-state="activity.state">
    <span class="subagent-status-mark" aria-hidden="true"></span>
    <a v-if="href" class="subagent-activity-name" :href="href" target="_blank" rel="noopener noreferrer" :title="label" :aria-label="`查看子智能体：${label}`">{{ label }}</a>
    <span v-else class="subagent-activity-name" :title="label">{{ label }}</span>
    <span class="subagent-activity-state">{{ stateLabel }}</span>
    <span v-if="elapsed" class="subagent-activity-duration">{{ elapsed }}</span>
  </div>
</template>

<style scoped>
.subagent-activity { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 36px; padding: 3px 4px; font-size: 13px; color: #81766b; }
.subagent-status-mark { flex: 0 0 12px; width: 12px; height: 12px; border: 1.5px solid #7b9a84; border-radius: 50%; }
.subagent-activity[data-state="running"] .subagent-status-mark { border-color: #c7bdb3; border-top-color: #817468; animation: subagent-spin 1s linear infinite; }
.subagent-activity[data-state="failed"] .subagent-status-mark { border-color: #b45b50; }
.subagent-activity[data-state="unknown"] .subagent-status-mark { border-color: #a6a09a; border-style: dashed; }
.subagent-activity-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #5f574f; text-decoration: none; }
a.subagent-activity-name:hover { text-decoration: underline; text-underline-offset: 3px; }
a.subagent-activity-name:focus-visible { outline: 2px solid #817468; outline-offset: 3px; }
.subagent-activity-state { flex: 0 0 auto; font-size: 12px; }
.subagent-activity-duration { flex: 0 0 auto; margin-left: auto; font-variant-numeric: tabular-nums; font-size: 12px; }
@keyframes subagent-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .subagent-activity[data-state="running"] .subagent-status-mark { animation: none; } }
</style>
