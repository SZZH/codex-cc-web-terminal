<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, useId, watch } from "vue";
import PixelCompanion from "../PixelCompanion.js";
import ThreadQuestionCard from "../thread-item/ThreadQuestionCard.vue";
import CodexInteractionPanel from "./interactions/CodexInteractionPanel.vue";
import { unansweredQuestionEntries } from "../../lib/codex-question-dock.js";

const props = defineProps({ questions: { type: Array, default: () => [] }, canRespond: Boolean,
  interactionState: { type: Object, required: true } });
const emit = defineEmits(["answer", "draft", "respond", "check", "refresh", "expanded"]);
const expanded = ref(true), toggle = ref(null), dismissed = reactive(new Set()), cards = new Map(), contentId = useId();
const visibleInteraction = (row) => row && row.status !== "resolved" && !dismissed.has(row.id) &&
  !(row.status === "unavailable" && ["turn_completed", "thread_closed"].includes(row.error?.code));
const interactions = computed(() => props.interactionState.order.map((id) => props.interactionState.interactions[id])
  .filter(visibleInteraction));
const panelState = computed(() => ({ ...props.interactionState,
  order: interactions.value.map((row) => row.id) }));
const needsResponse = (row) => row.status === "pending" && !props.interactionState.actions[row.id];
const remaining = computed(() => props.questions.flatMap((question) => unansweredQuestionEntries(question)
  .map((entry) => ({ key: `${question.callId}:${entry.id}`, pending: question.pendingResponses?.[entry.id] }))));
const waitingKeys = computed(() => [...remaining.value.filter((entry) => !entry.pending).map((entry) => entry.key),
  ...interactions.value.filter(needsResponse).map((row) => row.id)]);
const questionCount = computed(() => remaining.value.filter((entry) => !entry.pending).length + interactions.value
  .filter((row) => row.method === "item/tool/requestUserInput" && needsResponse(row))
  .reduce((sum, row) => sum + (row.params.questions?.length || 1), 0));
const count = computed(() => remaining.value.length + interactions.value.length);
watch(() => Boolean((count.value || props.interactionState.error) && expanded.value),
  (value) => emit("expanded", value), { immediate: true });
onBeforeUnmount(() => emit("expanded", false));
const title = computed(() => questionCount.value ? `${questionCount.value} 个问题等你回答`
  : waitingKeys.value.length ? "Codex 等待你的确认" : "提问状态待核对");
watch(waitingKeys, (keys, previous = []) => {
  if (keys.some((key) => !previous.includes(key))) expanded.value = true;
}, { immediate: true });
async function open(callId) {
  expanded.value = true;
  await nextTick();
  cards.get(callId)?.scrollIntoView?.({ block: "nearest" });
  cards.get(callId)?.querySelector?.("input, textarea, button")?.focus({ preventScroll: true });
}
function collapse() { expanded.value = false; toggle.value?.focus({ preventScroll: true }); }
defineExpose({ open });
</script>

<template>
  <section v-if="count || interactionState.error" class="codex-question-dock" aria-label="Codex 悬浮提问">
    <button ref="toggle" type="button" class="question-dock-toggle" :aria-expanded="expanded" :aria-controls="contentId"
      :aria-label="expanded ? '收起提问' : '展开提问'" @click="expanded = !expanded">
      <PixelCompanion mood="waiting" :size="24" />
      <span class="question-dock-summary" role="status" aria-live="polite"><strong>{{ title }}</strong></span>
      <span class="question-dock-action" aria-hidden="true">{{ expanded ? '返回聊天' : '回答' }}</span>
      <span class="question-dock-chevron" aria-hidden="true">{{ expanded ? '⌄' : '⌃' }}</span>
    </button>
    <div v-show="expanded" :id="contentId" class="question-dock-body" data-app-scroll @keydown.esc.stop="collapse">
      <CodexInteractionPanel :state="panelState" embedded @dismiss="dismissed.add($event)"
        @draft="emit('draft', $event)" @respond="emit('respond', $event)"
        @check="emit('check', $event)" @refresh="emit('refresh')" />
      <div v-for="question in questions" :key="question.callId" :ref="(element) => element ? cards.set(question.callId, element) : cards.delete(question.callId)"
        class="question-dock-card">
        <ThreadQuestionCard :question="question" :can-respond="canRespond && question.canRespond !== false" floating
          @answer="emit('answer', $event)" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.codex-question-dock { position: relative; z-index: 2; flex: 0 1 auto; display: flex; flex-direction: column; min-height: 44px; max-height: min(60dvh, 560px); min-width: 0; margin: 0 20px 8px; border: 1px solid #cbb7a3; border-radius: 12px; background: #fffcf8; color: #433831; box-shadow: 0 -4px 18px #66503c0d; overflow: hidden; }
.question-dock-toggle { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; width: 100%; min-height: 44px; padding: 6px 10px; border: 0; background: #f1e7dc; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.question-dock-summary { flex: 1; min-width: 0; }
.question-dock-summary strong { font-size: 13px; font-weight: 600; }
.question-dock-action { flex: 0 0 auto; font-size: 12px; color: #7f7165; }
.question-dock-chevron { font-size: 20px; padding: 0 4px; }
.question-dock-body { min-height: 0; overflow: auto; overscroll-behavior: contain; border-top: 1px solid #e3d5c6; }
.question-dock-card { padding: 8px 12px; }
.question-dock-card + .question-dock-card { border-top: 1px solid #e3d5c6; }
.question-dock-body :deep(.codex-interaction-panel) { margin: 0; border: 0; border-radius: 0; overflow: visible; }
.question-dock-body :deep(.interaction-body) { max-height: none; overflow: visible; }
.question-dock-body :deep(.interaction-actions) { position: sticky; bottom: 0; z-index: 1; }
.question-dock-toggle:focus-visible { outline: 2px solid #79634f; outline-offset: -3px; }
@media (max-width: 640px) {
  .codex-question-dock { max-height: calc(100% - 8px); margin: 0 8px calc(8px + env(safe-area-inset-bottom)); }
  .question-dock-card { padding: 8px 10px; }
}
</style>
