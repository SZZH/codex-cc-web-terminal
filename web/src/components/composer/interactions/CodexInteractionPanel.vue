<script setup>
import { computed, ref, watch } from "vue";
import PixelCompanion from "../../PixelCompanion.js";
import QuestionFields from "./QuestionFields.vue";
import ApprovalDetails from "./ApprovalDetails.vue";
import ApprovalActions from "./ApprovalActions.vue";
import PermissionFields from "./PermissionFields.vue";
import McpFormFields from "./McpFormFields.vue";
import { USER_INPUT, COMMAND_APPROVAL, FILE_APPROVAL, PERMISSIONS_APPROVAL, MCP_ELICITATION,
  questionResponse, approvalDecisions, permissionResponse, safeElicitationUrl } from "../../../lib/codex-interactions/responses.js";
import { describeMcpForm, initialMcpValues, buildMcpFormResponse } from "../../../lib/codex-interactions/form.js";
import { interactionTitle, interactionChoiceLabel } from "../../../lib/codex-interactions/presentation.js";

const props = defineProps({ state: { type: Object, required: true } });
const emit = defineEmits(["respond", "draft", "check", "refresh"]);
const activeId = ref(""), validationError = ref(""), dismissed = ref([]);
const rows = computed(() => {
  return props.state.order.map((id) => props.state.interactions[id]).filter((row) => row && row.status !== "resolved" && !dismissed.value.includes(row.id));
});
const interaction = computed(() => props.state.interactions[activeId.value]);
const terminal = computed(() => interaction.value?.status === "unavailable");
const draft = computed(() => props.state.drafts[activeId.value] || {});
const busy = computed(() => Boolean(props.state.actions[activeId.value]));
const disabled = computed(() => !props.state.ready || interaction.value?.status !== "pending" || busy.value);
const params = computed(() => interaction.value?.params || {});
const capabilityError = computed(() => ({
  unsupported_interaction_schema: "此表单需要当前网页尚不支持的结构校验，请拒绝或取消请求。",
  device_verification_unavailable: "当前网页无法提供所需的设备验证证明。",
  unsafe_elicitation_url: "此请求的链接无法安全打开。",
  unsupported_elicitation_mode: "当前网页无法确认此交互类型。"
})[interaction.value?.error?.code] || "");
const form = computed(() => capabilityError.value ? { supported: false, fields: [], reason: capabilityError.value } : describeMcpForm(params.value));
const formValues = computed(() => ({ ...initialMcpValues(form.value.fields), ...draft.value.mcp }));
const decisions = computed(() => interaction.value ? approvalDecisions(interaction.value) : []);
const safeUrl = computed(() => safeElicitationUrl(params.value.url));
const hasAnswer = computed(() => (params.value.questions || []).some((question) => typeof draft.value.answers?.[question.id] === "string" && draft.value.answers[question.id].trim()));
const title = computed(() => interactionTitle(interaction.value));
const status = computed(() => props.state.actions[activeId.value]?.status === "unknown" ? "响应待核对"
  : props.state.actions[activeId.value]?.status === "submitting" ? "正在提交"
    : ({ submitting: "正在提交", submitted: "已提交，等待确认", unknown: "响应待核对" })[interaction.value?.status]);
const canCheck = computed(() => props.state.actions[activeId.value]?.status === "unknown" || ["submitting", "submitted", "unknown"].includes(interaction.value?.status));
const error = computed(() => {
  const message = validationError.value || props.state.responseErrors[activeId.value] || (capabilityError.value ? "" : interaction.value?.error?.message) || "";
  return canCheck.value && /响应状态|响应未确认|正在核对原交互/.test(message) ? "" : message;
});
watch(() => rows.value.map((row) => `${row.id}:${row.status}`).join("|"), () => {
  if (!rows.value.some((row) => row.id === activeId.value)) activeId.value = rows.value.find((row) => row.status === "pending")?.id || rows.value[0]?.id || "";
}, { immediate: true });
watch(() => `${activeId.value}:${interaction.value?.status}`, () => { validationError.value = ""; });

function updateDraft(patch) { if (!disabled.value) emit("draft", { id: activeId.value, patch }); }
function respond(response) { if (!disabled.value && !(response.action === "accept" && capabilityError.value)) { validationError.value = ""; emit("respond", { id: activeId.value, response }); } }
function submit() {
  if (disabled.value) return;
  try {
    if (interaction.value.method === USER_INPUT && hasAnswer.value) respond(questionResponse(params.value.questions || [], draft.value.answers));
    else if (interaction.value.method === PERMISSIONS_APPROVAL) respond(permissionResponse(params.value.permissions || {}, draft.value.selected, draft.value.scope, draft.value.strictAutoReview));
    else if (interaction.value.method === MCP_ELICITATION && form.value.supported) respond(buildMcpFormResponse(form.value.fields, formValues.value));
  } catch (failure) { validationError.value = failure.message; }
}
function openUrl(event) {
  if (disabled.value || !safeUrl.value) { event.preventDefault(); return; }
  updateDraft({ urlOpened: true });
}
</script>

<template>
  <section v-if="rows.length || state.error" class="codex-interaction-panel" aria-label="Codex 交互待办">
    <header class="interaction-header">
      <PixelCompanion :size="28" :mood="busy ? 'loading' : terminal || state.error ? 'error' : 'waiting'" />
      <h2>{{ terminal ? '请求已失效' : title }}</h2><span v-if="status" class="interaction-status" role="status" aria-live="polite">{{ status }}</span>
      <button v-if="terminal" type="button" class="interaction-close" aria-label="关闭失效交互" title="关闭失效交互" @click="dismissed.push(activeId)">×</button>
      <select v-if="rows.length > 1" :value="activeId" aria-label="选择交互待办" @change="activeId = $event.target.value">
        <option v-for="row in rows" :key="row.id" :value="row.id">{{ interactionChoiceLabel(row) }}</option>
      </select>
    </header>
    <p v-if="state.error" class="interaction-read-error" role="status">{{ state.error }}</p>
    <p v-if="terminal" class="interaction-note interaction-unavailable" role="status">原请求已失效，无法继续处理。</p>
    <form v-if="interaction && !terminal" class="interaction-form" @submit.prevent="submit">
      <div v-if="interaction.method !== USER_INPUT || !canCheck" class="interaction-body" tabindex="0" :aria-label="title">
        <QuestionFields v-if="interaction.method === USER_INPUT && !canCheck" :key="interaction.id" :questions="params.questions || []" :hide-question="params.questions?.length === 1"
          :values="draft.answers || {}" :disabled="disabled" @change="(id, value) => updateDraft({ answers: { ...draft.answers, [id]: value } })" />
        <template v-else-if="[COMMAND_APPROVAL, FILE_APPROVAL, PERMISSIONS_APPROVAL].includes(interaction.method)">
          <ApprovalDetails :interaction="interaction" />
          <PermissionFields v-if="interaction.method === PERMISSIONS_APPROVAL" :permissions="params.permissions || {}" :values="draft"
            :disabled="disabled" @change="updateDraft" />
          <p v-if="!decisions.length && interaction.method !== PERMISSIONS_APPROVAL" class="interaction-note">此请求未提供网页可用的审批决策。</p>
        </template>
        <template v-else-if="interaction.method === MCP_ELICITATION">
          <p v-if="(params.message || params.description) && (params.message || params.description) !== title" class="interaction-message">{{ params.message || params.description }}</p>
          <template v-if="params.mode === 'url'">
            <a v-if="safeUrl && !capabilityError" :href="safeUrl" target="_blank" rel="noopener noreferrer" :aria-disabled="disabled" @click="openUrl">{{ safeUrl }}</a>
            <p v-else class="interaction-note">此链接无法安全打开，请拒绝或取消请求。</p>
          </template>
          <p v-else-if="params.mode === 'openai/userVerification'" class="interaction-note">此请求需要设备身份验证，当前网页无法提供所需证明。请在支持设备验证的客户端处理，或拒绝、取消本次请求。</p>
          <McpFormFields v-else-if="form.supported && !canCheck" :key="interaction.id" :fields="form.fields" :values="formValues" :disabled="disabled"
            @change="(id, value) => updateDraft({ mcp: { ...draft.mcp, [id]: value } })" />
          <p v-else-if="!form.supported" class="interaction-note">{{ form.reason }}</p>
        </template>
        <p v-else-if="interaction.method !== USER_INPUT" class="interaction-note">当前网页无法处理此交互类型。</p>
      </div>
      <p v-if="error" class="interaction-error" role="alert">{{ error }}</p>
      <footer class="interaction-actions" :aria-busy="props.state.actions[activeId]?.status === 'submitting'">
        <template v-if="!disabled">
          <template v-if="interaction.method === USER_INPUT">
            <button type="submit" class="interaction-primary" :disabled="!hasAnswer">提交回答</button>
            <button type="button" @click="respond(questionResponse(params.questions || []))">全部跳过</button>
          </template>
          <ApprovalActions v-else-if="[COMMAND_APPROVAL, FILE_APPROVAL].includes(interaction.method)" :decisions="decisions" @choose="respond({ decision: $event })" />
          <template v-else-if="interaction.method === PERMISSIONS_APPROVAL">
            <button type="submit" class="interaction-primary" :disabled="!draft.selected?.length">授予所选权限</button>
            <button type="button" @click="respond({ permissions: {}, scope: 'turn' })">拒绝额外权限</button>
          </template>
          <template v-else-if="interaction.method === MCP_ELICITATION">
            <button v-if="form.supported" type="submit" class="interaction-primary">确认提交</button>
            <button v-else-if="params.mode === 'url' && safeUrl && !capabilityError" type="button" class="interaction-primary" :disabled="!draft.urlOpened" @click="respond({ action: 'accept' })">已完成外部确认</button>
            <button type="button" @click="respond({ action: 'decline' })">拒绝</button>
            <details v-if="form.supported || params.mode === 'url' && safeUrl && !capabilityError" class="interaction-more">
              <summary>更多选项</summary><button type="button" @click="respond({ action: 'cancel' })">取消请求</button>
            </details>
            <button v-else type="button" @click="respond({ action: 'cancel' })">取消请求</button>
          </template>
        </template>
        <button v-if="canCheck" type="button" @click="emit('check', activeId)">核对响应状态</button>
      </footer>
    </form>
    <div v-if="state.error" class="interaction-actions"><button type="button" :disabled="state.loading" @click="emit('refresh')">重试读取交互</button></div>
  </section>
</template>

<style scoped>
.codex-interaction-panel { display: flex; flex-direction: column; min-width: 0; margin: 0 20px 10px; border: 1px solid #d9cec4; border-radius: 8px; background: #fffcf8; color: #433831; font-size: 13px; line-height: 1.5; overflow: hidden; }
.interaction-header { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 12px; min-width: 0; padding: 10px 12px; border-bottom: 1px solid #e8ded4; }
h2 { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 13px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.interaction-status { color: #7f7165; font-size: 12px; } .interaction-header select { min-width: 0; max-width: 100%; min-height: 32px; color: #60534a; background: transparent; border: 1px solid #d9cec4; border-radius: 4px; font: inherit; }
.interaction-header select { flex: 1 1 100%; margin-top: 3px; }
.interaction-header .interaction-close { flex: 0 0 32px; min-height: 32px; height: 32px; padding: 0; border: 0; text-align: center; font-size: 20px; }
.interaction-form { display: flex; flex-direction: column; min-height: 0; min-width: 0; margin: 0; }
.interaction-body { display: grid; gap: 13px; min-width: 0; max-height: min(32dvh, 300px); overflow: auto; overscroll-behavior: contain; padding: 12px; }
.interaction-message, .interaction-note { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; } .interaction-note { color: #7f7165; }
.interaction-unavailable { padding: 8px 12px; font-size: 12px; }
a { color: #79634f; overflow-wrap: anywhere; } .interaction-read-error, .interaction-error { margin: 0; padding: 8px 12px; color: #a23535; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.interaction-actions { display: flex; flex-wrap: wrap; flex: 0 0 auto; gap: 6px 8px; padding: 9px 12px; border-top: 1px solid #e8ded4; background: #fffcf8; min-width: 0; }
button { min-height: 40px; min-width: 0; max-width: 100%; padding: 7px 10px; border: 1px solid #d9cec4; border-radius: 6px; background: transparent; color: #60534a; font: inherit; line-height: 1.5; text-align: left; overflow-wrap: anywhere; cursor: pointer; }
.interaction-primary { color: #fffcf8; background: #79634f; border-color: #79634f; } button:disabled { opacity: .55; cursor: wait; }
.interaction-more { flex: 1 1 100%; min-width: 0; } .interaction-more summary { width: fit-content; padding: 3px 0; font-size: 12px; color: #7f7165; cursor: pointer; } .interaction-more button { margin-top: 4px; }
:focus-visible { outline: 2px solid #79634f; outline-offset: 2px; }
@media (max-width: 480px) { .codex-interaction-panel { margin-inline: 12px; } .interaction-body { max-height: min(28dvh, 230px); padding: 10px; } .interaction-actions { padding: 8px 10px; } button { min-height: 44px; } }
</style>
