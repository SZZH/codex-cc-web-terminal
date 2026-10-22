<script setup>
import { computed } from "vue";
const props = defineProps({ decisions: { type: Array, default: () => [] } });
const emit = defineEmits(["choose"]);
const rejection = computed(() => props.decisions.find((decision) => decision.value === "decline") || props.decisions.find((decision) => decision.value === "cancel"));
const primary = computed(() => props.decisions.filter((decision) => decision.value === "accept" || decision === rejection.value));
const advanced = computed(() => props.decisions.filter((decision) => !primary.value.includes(decision)));
</script>

<template>
  <div class="approval-actions">
    <div class="approval-primary-actions">
      <button v-for="(decision, index) in primary" :key="index" type="button" :class="{ 'is-primary': decision.value === 'accept' }"
        @click="emit('choose', decision.value)">{{ decision.label }}</button>
    </div>
    <details v-if="advanced.length" class="approval-advanced">
      <summary>更多选项</summary>
      <div class="approval-advanced-options">
        <button v-for="(decision, index) in advanced" :key="index" type="button" @click="emit('choose', decision.value)">
          <span>{{ decision.label }}</span><small v-if="decision.detail">{{ decision.detail }}</small>
        </button>
      </div>
    </details>
  </div>
</template>

<style scoped>
.approval-actions { display: grid; gap: 6px; width: 100%; min-width: 0; }
.approval-primary-actions { display: flex; flex-wrap: wrap; gap: 8px; }
button { min-width: 0; max-width: 100%; min-height: 40px; padding: 7px 11px; border: 1px solid #d9cec4; border-radius: 6px; background: transparent; color: #60534a; font: inherit; line-height: 1.5; text-align: left; overflow-wrap: anywhere; cursor: pointer; }
.is-primary { color: #fffcf8; background: #79634f; border-color: #79634f; }
summary { width: fit-content; padding: 3px 0; color: #7f7165; font-size: 12px; cursor: pointer; }
.approval-advanced-options { display: grid; gap: 3px; max-height: min(24dvh, 180px); overflow-y: auto; overscroll-behavior: contain; margin-top: 4px; }
.approval-advanced-options button { border: 0; border-radius: 4px; padding: 8px 6px; }
.approval-advanced-options button:hover { background: #f2ece6; }
small { display: block; color: #7f7165; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
:focus-visible { outline: 2px solid #79634f; outline-offset: 2px; }
@media (max-width: 480px) { button { min-height: 44px; } }
</style>
