export const USER_INPUT = "item/tool/requestUserInput";
export const COMMAND_APPROVAL = "item/commandExecution/requestApproval";
export const FILE_APPROVAL = "item/fileChange/requestApproval";
export const PERMISSIONS_APPROVAL = "item/permissions/requestApproval";
export const MCP_ELICITATION = "mcpServer/elicitation/request";
const STRINGS = ["accept", "acceptForSession", "decline", "cancel"];
const objectWith = (value, key) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && Object.hasOwn(value, key);
function validDecision(decision) {
  if (typeof decision === "string") return STRINGS.includes(decision);
  if (objectWith(decision, "acceptWithExecpolicyAmendment") && objectWith(decision.acceptWithExecpolicyAmendment, "execpolicy_amendment")) {
    const command = decision.acceptWithExecpolicyAmendment.execpolicy_amendment;
    return Array.isArray(command) && command.every((part) => typeof part === "string");
  }
  if (!objectWith(decision, "applyNetworkPolicyAmendment") || !objectWith(decision.applyNetworkPolicyAmendment, "network_policy_amendment")) return false;
  const rule = decision.applyNetworkPolicyAmendment.network_policy_amendment;
  return rule && Object.keys(rule).every((key) => ["host", "action"].includes(key)) && typeof rule.host === "string" && ["allow", "deny"].includes(rule.action);
}

export function questionResponse(questions, values = {}) {
  return { answers: Object.fromEntries(questions.map((question) => [question.id,
    { answers: typeof values[question.id] === "string" && values[question.id].trim() ? [values[question.id]] : [] }])) };
}
export function approvalDecisions(interaction) {
  const params = interaction.params;
  const decisions = interaction.method === COMMAND_APPROVAL && Array.isArray(params.availableDecisions)
    ? params.availableDecisions : [...STRINGS,
      ...(params.proposedExecpolicyAmendment ? [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment } }] : []),
      ...(params.proposedNetworkPolicyAmendments || []).map((rule) => ({ applyNetworkPolicyAmendment: { network_policy_amendment: rule } }))];
  return decisions.filter(validDecision).map((value) => ({ value, ...decisionPresentation(value) }));
}
export function permissionChoices(permissions = {}) {
  const rows = [];
  const files = permissions.fileSystem;
  for (const field of ["read", "write", "entries"]) {
    for (const [index, value] of (files?.[field] || []).entries()) rows.push({ id: `fileSystem:${field}:${index}`, group: "fileSystem", field, value,
      fixed: field === "entries" && value.access === "deny",
      label: field === "entries" ? `${permissionAccessLabel(value.access)} · ${permissionPathLabel(value.path)}`
        : `${field === "read" ? "读取" : "写入"} · ${value}` });
  }
  if (typeof permissions.network?.enabled === "boolean") rows.push({ id: "network:enabled", group: "network", field: "enabled",
    value: permissions.network.enabled, label: permissions.network.enabled ? "访问网络" : "禁止网络访问" });
  return rows;
}
export function permissionResponse(permissions, selected = [], scope = "turn", strictAutoReview = false) {
  const grant = {};
  for (const choice of permissionChoices(permissions)) {
    if (choice.fixed || !selected.includes(choice.id)) continue;
    grant[choice.group] ||= {};
    if (choice.group === "network") grant.network.enabled = choice.value;
    else { grant.fileSystem[choice.field] ||= []; grant.fileSystem[choice.field].push(choice.value); }
  }
  if (grant.fileSystem) {
    const denied = (permissions.fileSystem?.entries || []).filter((entry) => entry.access === "deny");
    if (denied.length) grant.fileSystem.entries = [...(grant.fileSystem.entries || []), ...denied];
    if (permissions.fileSystem?.globScanMaxDepth != null) grant.fileSystem.globScanMaxDepth = permissions.fileSystem.globScanMaxDepth;
  }
  return { permissions: grant, scope: scope === "session" ? "session" : "turn", ...(strictAutoReview ? { strictAutoReview: true } : {}) };
}
export function safeElicitationUrl(value) {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : ""; }
  catch { return ""; }
}
import { decisionPresentation, permissionAccessLabel, permissionPathLabel } from "./presentation.js";

