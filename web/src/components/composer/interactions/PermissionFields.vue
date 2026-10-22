<script setup>
import { computed, useId } from "vue";
import { permissionChoices } from "../../../lib/codex-interactions/responses.js";
const props = defineProps({ permissions: { type: Object, default: () => ({}) }, values: { type: Object, default: () => ({}) }, disabled: Boolean });
const emit = defineEmits(["change"]);
const choices = computed(() => permissionChoices(props.permissions)), scopeId = `permission-scope-${useId()}`;
function toggle(id, checked) {
  const selected = props.values.selected || [];
  emit("change", { selected: checked ? [...new Set([...selected, id])] : selected.filter((value) => value !== id) });
}
</script>

<template>
  <div class="permission-fields">
    <fieldset :disabled="disabled">
      <legend>请求的权限</legend>
      <label v-for="choice in choices" :key="choice.id" class="permission-choice">
        <input type="checkbox" :checked="choice.fixed || values.selected?.includes(choice.id) || false" :disabled="disabled || choice.fixed" @change="!choice.fixed && toggle(choice.id, $event.target.checked)" />
        <span>{{ choice.label }}{{ choice.fixed ? '（固定限制）' : '' }}</span>
      </label>
      <p v-if="!choices.length">未请求额外权限</p>
    </fieldset>
    <details class="permission-advanced">
      <summary>授权范围：{{ values.scope === 'session' ? '整个会话' : '仅当前轮次' }}{{ values.strictAutoReview ? ' · 逐条审查' : '' }}</summary>
      <div class="permission-advanced-body">
        <label :for="scopeId">授权范围</label>
        <select :id="scopeId" :value="values.scope || 'turn'" :disabled="disabled" @change="emit('change', { scope: $event.target.value })">
          <option value="turn">仅当前轮次</option><option value="session">整个会话</option>
        </select>
        <label class="permission-choice"><input type="checkbox" :checked="values.strictAutoReview || false" :disabled="disabled"
          @change="emit('change', { strictAutoReview: $event.target.checked })" /><span>后续命令逐条审查</span></label>
      </div>
    </details>
  </div>
</template>

<style scoped>
.permission-fields { display: grid; gap: 8px; color: #433831; font-size: 13px; line-height: 1.5; min-width: 0; }
fieldset { display: grid; gap: 5px; min-width: 0; border: 0; padding: 0; margin: 0 0 8px; } legend { padding: 0; margin-bottom: 8px; font-weight: 500; }
.permission-choice { display: flex; align-items: flex-start; gap: 9px; min-height: 36px; cursor: pointer; } .permission-choice input { margin: 4px 0; flex: 0 0 auto; accent-color: #79634f; }
.permission-choice span { min-width: 0; overflow-wrap: anywhere; } p { margin: 0; color: #7f7165; }
select { min-height: 40px; width: 100%; min-width: 0; box-sizing: border-box; border: 1px solid #d9cec4; border-radius: 6px; background: #fffcf8; color: #433831; font: inherit; padding: 8px; }
.permission-advanced { min-width: 0; } summary { color: #7f7165; font-size: 12px; padding: 4px 0; cursor: pointer; overflow-wrap: anywhere; }
.permission-advanced-body { display: grid; gap: 8px; padding-top: 6px; }
:focus-visible { outline: 2px solid #79634f; outline-offset: 2px; }
</style>
