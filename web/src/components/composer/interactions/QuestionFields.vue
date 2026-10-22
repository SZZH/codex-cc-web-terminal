<script setup>
import { reactive, useId } from "vue";
const props = defineProps({ questions: { type: Array, default: () => [] }, values: { type: Object, default: () => ({}) }, disabled: Boolean, hideQuestion: Boolean });
const emit = defineEmits(["change"]);
const prefix = useId(), other = reactive({});
const custom = (question) => other[question.id] || props.values[question.id] && !question.options?.some((option) => option.label === props.values[question.id]);
function choose(question, value) { other[question.id] = false; emit("change", question.id, value); }
function chooseOther(question) { other[question.id] = true; emit("change", question.id, ""); }
</script>

<template>
  <div class="interaction-questions">
    <fieldset v-for="question in questions" :key="question.id" :disabled="disabled" class="interaction-question">
      <legend :class="{ 'sr-only': hideQuestion }">{{ question.question }}</legend>
      <template v-if="question.options?.length && !question.isSecret">
        <label v-for="option in question.options" :key="option.label" class="question-option">
          <input type="radio" :name="`${prefix}-${question.id}`" :value="option.label"
            :checked="!custom(question) && values[question.id] === option.label" @change="choose(question, option.label)" />
          <span><strong>{{ option.label }}</strong><small>{{ option.description }}</small></span>
        </label>
        <label v-if="question.isOther" class="question-option">
          <input type="radio" :name="`${prefix}-${question.id}`" :checked="Boolean(custom(question))" @change="chooseOther(question)" />
          <span>其他</span>
        </label>
      </template>
      <input v-if="question.isSecret" type="password" :aria-label="question.question" autocomplete="off" autocorrect="off" spellcheck="false"
        :value="values[question.id] || ''" @input="emit('change', question.id, $event.target.value)" />
      <textarea v-else-if="!question.options?.length || question.isOther && custom(question)" :aria-label="question.question" rows="3"
        :value="values[question.id] || ''" @input="emit('change', question.id, $event.target.value)" />
      <button v-if="values[question.id]" type="button" class="question-skip" @click="choose(question, '')">跳过此题</button>
    </fieldset>
  </div>
</template>

<style scoped>
.interaction-questions { display: grid; gap: 16px; min-width: 0; }
.interaction-question { border: 0; padding: 0; margin: 0; min-width: 0; display: grid; gap: 8px; }
legend { display: grid; gap: 4px; padding: 0; margin-bottom: 8px; color: #433831; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.question-option { display: flex; align-items: flex-start; gap: 9px; min-height: 36px; padding: 5px 0; cursor: pointer; }
.question-option input { flex: 0 0 auto; margin: 3px 0; accent-color: #79634f; }
.question-option span { min-width: 0; overflow-wrap: anywhere; }
strong { display: block; font-size: 13px; font-weight: 500; } small { display: block; color: #7f7165; font-size: 12px; line-height: 1.5; }
textarea, input[type="password"] { box-sizing: border-box; width: 100%; min-width: 0; border: 1px solid #d9cec4; border-radius: 6px; background: #fffcf8; color: #433831; font: inherit; padding: 9px; line-height: 1.5; }
textarea { resize: vertical; min-height: 70px; max-height: 160px; }
.question-skip { justify-self: start; min-height: 32px; padding: 4px 0; background: transparent; border: 0; color: #79634f; font: inherit; text-decoration: underline; cursor: pointer; }
:focus-visible { outline: 2px solid #79634f; outline-offset: 2px; }
</style>
