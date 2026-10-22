<script setup>
import { computed } from "vue";
import { permissionChoices } from "../../../lib/codex-interactions/responses.js";
import { fileChangeLabel } from "../../../lib/codex-interactions/presentation.js";
const props = defineProps({ interaction: { type: Object, required: true } });
const params = computed(() => props.interaction.params);
const changes = computed(() => props.interaction.item?.changes || props.interaction.item?.presentation?.fileChanges || []);
const additional = computed(() => permissionChoices(params.value.additionalPermissions || {}));
</script>

<template>
  <div class="approval-details">
    <p v-if="params.reason">{{ params.reason }}</p>
    <p v-if="params.networkApprovalContext" class="approval-target">{{ params.networkApprovalContext.host }} <span>· {{ params.networkApprovalContext.protocol }}</span></p>
    <pre v-if="params.command" tabindex="0" :aria-label="params.kind === 'writeStdin' ? '拟写入终端的内容' : '拟执行的命令'">{{ params.command }}</pre>
    <p v-if="params.grantRoot">会话写入范围：{{ params.grantRoot }}</p>
    <ul v-if="additional.length" aria-label="请求的额外权限"><li v-for="choice in additional" :key="choice.id">{{ choice.label }}</li></ul>
    <div v-for="(change, index) in changes" :key="`${change.path}-${index}`" class="approval-change">
      <p>{{ change.path }} · {{ fileChangeLabel(change) }}</p>
      <details v-if="change.diff"><summary>查看修改</summary><pre tabindex="0" :aria-label="`${change.path} 的修改内容`">{{ change.diff }}</pre></details>
    </div>
    <details v-if="params.cwd || params.environmentId" class="approval-context">
      <summary>执行详情</summary>
      <dl><template v-if="params.cwd"><dt>工作目录</dt><dd>{{ params.cwd }}</dd></template>
        <template v-if="params.environmentId"><dt>执行环境</dt><dd>{{ params.environmentId }}</dd></template></dl>
    </details>
  </div>
</template>

<style scoped>
.approval-details { display: grid; gap: 9px; min-width: 0; font-size: 13px; line-height: 1.5; color: #433831; }
.approval-target { font-weight: 500; } .approval-target span { font-weight: 400; color: #7f7165; }
ul { display: grid; gap: 4px; padding: 0 0 0 18px; margin: 0; overflow-wrap: anywhere; }
summary { color: #7f7165; cursor: pointer; font-size: 12px; padding: 3px 0; } details > pre, details > dl { margin-top: 6px; }
p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; } dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 5px 10px; margin: 0; }
dt { color: #7f7165; } dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
pre { margin: 0; min-width: 0; max-width: 100%; padding: 9px; background: #f2ece6; border-radius: 4px; overflow: auto; white-space: pre; font-size: 12px; line-height: 1.5; }
.approval-change { display: grid; gap: 5px; min-width: 0; } :focus-visible { outline: 2px solid #79634f; outline-offset: 2px; }
</style>
