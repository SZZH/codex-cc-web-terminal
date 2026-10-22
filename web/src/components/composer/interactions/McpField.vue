<script setup>
import { computed, useId } from "vue";
const props = defineProps({ field: { type: Object, required: true }, value: { default: undefined }, disabled: Boolean });
const emit = defineEmits(["change"]);
const id = `mcp-field-${useId()}`;
const inputType = computed(() => ["number", "integer"].includes(props.field.type) ? "number"
  : props.field.format === "email" ? "email" : props.field.format === "date" ? "date" : props.field.format === "date-time" ? "datetime-local" : "text");
function toggle(value, checked) {
  const selected = Array.isArray(props.value) ? props.value : [];
  const next = checked ? [...new Set([...selected, value])] : selected.filter((entry) => entry !== value);
  emit("change", !next.length && !props.field.required && props.field.default == null ? undefined : next);
}
const selectedOption = computed(() => {
  const index = props.field.options?.findIndex((option) => option.value === props.value) ?? -1;
  return index >= 0 ? `option-${index}` : "";
});
function selectOption(event) {
  const index = props.field.options.findIndex((option, index) => `option-${index}` === event.target.value);
  emit("change", index < 0 ? undefined : props.field.options[index].value);
}
</script>

<template>
  <fieldset v-if="field.type === 'array'" class="mcp-field" :disabled="disabled">
    <legend>{{ field.label }}<span v-if="field.required"> *</span></legend>
    <p v-if="field.description">{{ field.description }}</p>
    <label v-for="option in field.options" :key="option.value" class="mcp-check">
      <input type="checkbox" :value="option.value" :checked="Array.isArray(value) && value.includes(option.value)"
        @change="toggle(option.value, $event.target.checked)" /> <span>{{ option.label }}</span>
    </label>
  </fieldset>
  <div v-else class="mcp-field">
    <label :for="id">{{ field.label }}<span v-if="field.required"> *</span></label>
    <p v-if="field.description" :id="`${id}-description`">{{ field.description }}</p>
    <select v-if="field.options" :id="id" :value="selectedOption" :disabled="disabled" :required="field.required"
      :aria-describedby="field.description ? `${id}-description` : undefined" @change="selectOption">
      <option value="">请选择</option><option v-for="(option, index) in field.options" :key="option.value" :value="`option-${index}`">{{ option.label || '空值' }}</option>
    </select>
    <label v-else-if="field.type === 'boolean'" class="mcp-check">
      <input :id="id" type="checkbox" :checked="value === true" :disabled="disabled" @change="emit('change', $event.target.checked)" />
      <span>{{ value === true ? '是' : '否' }}</span>
    </label>
    <input v-else :id="id" :type="inputType" :value="value ?? ''" :disabled="disabled" :required="field.required && (field.type !== 'string' || field.minLength > 0 || Boolean(field.format))"
      :min="field.minimum ?? undefined" :max="field.maximum ?? undefined" :step="field.type === 'integer' ? 1 : field.type === 'number' ? 'any' : undefined"
      :minlength="field.minLength ?? undefined" :maxlength="field.maxLength ?? undefined" :aria-describedby="field.description ? `${id}-description` : undefined"
      @input="emit('change', $event.target.value)" />
  </div>
</template>

<style scoped>
.mcp-field { display: grid; gap: 7px; min-width: 0; border: 0; padding: 0; margin: 0; font-size: 13px; line-height: 1.5; }
label, legend { color: #433831; overflow-wrap: anywhere; } legend { margin-bottom: 7px; padding: 0; }
p { margin: 0; color: #7f7165; font-size: 12px; overflow-wrap: anywhere; }
input:not([type="checkbox"]), select { width: 100%; min-width: 0; min-height: 40px; box-sizing: border-box; border: 1px solid #d9cec4; border-radius: 6px; background: #fffcf8; color: #433831; padding: 8px; font: inherit; }
.mcp-check { display: flex; align-items: flex-start; gap: 9px; min-height: 34px; cursor: pointer; }
.mcp-check input { margin: 4px 0; accent-color: #79634f; } .mcp-check span { min-width: 0; }
:focus-visible { outline: 2px solid #79634f; outline-offset: 2px; }
</style>
