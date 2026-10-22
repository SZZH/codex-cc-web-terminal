<script setup>
import McpField from "./McpField.vue";
defineProps({ fields: { type: Array, default: () => [] }, values: { type: Object, default: () => ({}) }, disabled: Boolean });
const emit = defineEmits(["change"]);
</script>

<template>
  <div class="mcp-fields"><McpField v-for="field in fields" :key="field.id" :field="field" :value="values[field.id]"
    :disabled="disabled" @change="emit('change', field.id, $event)" /></div>
</template>

<style scoped>
.mcp-fields { display: grid; gap: 16px; min-width: 0; }
</style>
