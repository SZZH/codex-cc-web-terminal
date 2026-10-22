<script setup>
import { computed, reactive, useId, watch } from "vue";

const props = defineProps({ question: { type: Object, required: true }, canRespond: { type: Boolean, default: false } });
const emit = defineEmits(["answer"]);
const prefix = useId(), drafts = reactive({}), custom = reactive({});
const pending = computed(() => props.question.status === "pending");
const answered = computed(() => props.question.status === "answered");
const editable = computed(() => pending.value && props.canRespond && !props.question.truncated && !props.question.pendingResponse);
const responseLabel = (state) => ({ sending: "正在提交回答", received: "正在提交回答", dispatching: "正在提交回答",
  queued: "回答已排队", unknown: "回答待确认", accepted: "等待确认", running: "等待确认", completed: "等待确认" })[state] || "回答待确认";
const status = computed(() => pending.value && props.question.pendingResponse ? responseLabel(props.question.responseState) : ({ answered: "已回答", pending: "等待回答", queued: "回答已排队",
  submitting: "正在提交回答", unknown: "回答待确认" })[props.question.status] || "问题记录");
const hasAnswer = (id) => Object.hasOwn(props.question.answers || {}, id);
const responseState = (id) => props.question.pendingResponses?.[id];
const canEdit = (id) => editable.value && !hasAnswer(id) && !responseState(id);
watch(() => props.question.callId, () => {
  for (const key of Object.keys(drafts)) delete drafts[key];
  for (const key of Object.keys(custom)) delete custom[key];
});
function choose(id, answer, other = false) {
  if (!canEdit(id)) return;
  drafts[id] = answer; custom[id] = other;
}
function submit(question, index) {
  const answer = String(drafts[question.id] || "").trim();
  if (canEdit(question.id) && answer) emit("answer", { question: props.question, index, answer });
}
</script>

<template>
  <div v-if="answered" class="thread-question-transcript">
    <p v-for="entry in question.questions" :key="entry.id">{{ entry.title }}</p>
  </div>
  <section v-else class="thread-question" aria-label="问题">
    <header class="thread-question-header"><strong>问题</strong><span>{{ status }}</span></header>
    <form v-for="(entry, index) in question.questions" :key="`${question.callId}-${entry.id}`" class="thread-question-entry"
      @submit.prevent="submit(entry, index)">
      <fieldset>
        <legend>{{ entry.title }}</legend>
        <template v-if="canEdit(entry.id)">
          <label v-for="(option, optionIndex) in entry.options" :key="optionIndex" class="thread-question-option">
            <input type="radio" :name="`${prefix}-${entry.id}`" :checked="!custom[entry.id] && drafts[entry.id] === option"
              :value="option" @change="choose(entry.id, option)" />
            <span>{{ option }}</span>
          </label>
          <label v-if="entry.options.length" class="thread-question-option">
            <input type="radio" :name="`${prefix}-${entry.id}`" :checked="Boolean(custom[entry.id])" @change="choose(entry.id, '', true)" />
            <span>其他回答</span>
          </label>
          <textarea v-if="!entry.options.length || custom[entry.id]" :aria-label="entry.title" rows="2" maxlength="10000"
            placeholder="输入回答…" :value="drafts[entry.id] || ''" @input="choose(entry.id, $event.target.value, true)" />
          <button type="submit" class="thread-question-submit" :disabled="!String(drafts[entry.id] || '').trim()">提交回答</button>
        </template>
        <template v-else>
          <p v-if="!hasAnswer(entry.id) && responseState(entry.id)" class="thread-question-note" role="status">{{ responseLabel(responseState(entry.id)) }}</p>
          <ul v-else-if="!hasAnswer(entry.id) && entry.options.length" class="thread-question-options"><li v-for="(option, optionIndex) in entry.options" :key="optionIndex">{{ option }}</li></ul>
        </template>
      </fieldset>
    </form>
    <p v-if="question.truncated" class="thread-question-note">内容较长，部分已省略，请在桌面端查看完整问题。</p>
    <p v-else-if="pending && !canRespond && !question.pendingResponse" class="thread-question-note" role="status">回答暂不可用</p>
  </section>
</template>

<style scoped>
.thread-question { min-width: 0; color: var(--text, #2f2c28); font-size: 14px; line-height: 1.6; }
.thread-question-transcript p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.thread-question-transcript p + p { margin-top: 10px; }
.thread-question-header { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.thread-question-header strong { font-size: 13px; font-weight: 600; }
.thread-question-header span { margin-left: auto; color: #7f7165; font-size: 12px; }
.thread-question-entry { min-width: 0; margin: 0; }
.thread-question-entry + .thread-question-entry { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line, #e7e1db); }
fieldset { min-width: 0; border: 0; padding: 0; margin: 0; }
legend { padding: 0; margin-bottom: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.thread-question-option { display: flex; align-items: flex-start; gap: 9px; min-height: 44px; padding: 9px 0; cursor: pointer; }
.thread-question-option input { flex: 0 0 auto; margin: 4px 0; accent-color: #79634f; }
.thread-question-option span { min-width: 0; overflow-wrap: anywhere; }
.thread-question-options { margin: 0; padding-left: 20px; color: #60534a; }
.thread-question-options li { padding: 3px 0; overflow-wrap: anywhere; white-space: pre-wrap; }
textarea { display: block; box-sizing: border-box; width: 100%; min-width: 0; min-height: 72px; max-height: 180px; resize: vertical; border: 1px solid var(--line-strong, #d9d0c7); border-radius: 6px; padding: 9px 10px; background: #fffcf8; color: inherit; font: inherit; line-height: 1.5; }
.thread-question-submit { min-height: 44px; margin-top: 10px; border: 1px solid #79634f; border-radius: 6px; background: #79634f; color: #fffcf8; padding: 8px 14px; font: inherit; cursor: pointer; }
.thread-question-submit:disabled { opacity: .5; cursor: default; }
.thread-question-note { margin: 12px 0 0; color: #7f7165; font-size: 12px; }
:focus-visible { outline: 2px solid #79634f; outline-offset: 3px; }
@media (max-width: 480px) { textarea { font-size: 16px; } }
</style>
