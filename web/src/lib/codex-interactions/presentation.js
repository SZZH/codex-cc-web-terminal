const ACCESS = { read: "读取", write: "写入", deny: "禁止访问" };
const SPECIAL_PATHS = { root: "根目录", minimal: "最小运行目录", project_roots: "项目目录", tmpdir: "系统临时目录", slash_tmp: "/tmp" };
const compact = (value, limit = 52) => { const text = String(value || "").replace(/\s+/g, " ").trim(); return text.length > limit ? `${text.slice(0, limit)}…` : text; };

export function permissionPathLabel(path) {
  if (typeof path === "string") return path;
  if (path?.type === "path") return path.path;
  if (path?.type === "glob_pattern") return `${path.pattern}（匹配路径）`;
  const special = path?.value || {};
  return [SPECIAL_PATHS[special.kind] || special.path || "特殊目录", special.subpath].filter(Boolean).join(" / ");
}
export function permissionAccessLabel(access) { return ACCESS[access] || "访问"; }
export function decisionPresentation(value) {
  if (typeof value === "string") return { label: ({ accept: "允许本次", acceptForSession: "本会话允许", decline: "拒绝并继续", cancel: "拒绝并停止" })[value],
    detail: value === "acceptForSession" ? "本会话内相同审批范围不再询问" : "" };
  if (value.acceptWithExecpolicyAmendment) return { label: "允许并保存命令规则", detail: `今后允许命令前缀：${value.acceptWithExecpolicyAmendment.execpolicy_amendment.join(" ")}` };
  const rule = value.applyNetworkPolicyAmendment.network_policy_amendment;
  return { label: rule.action === "deny" ? "长期阻止此主机" : "长期允许此主机", detail: `${rule.host} · 保存到网络策略` };
}
export function interactionTitle(interaction) {
  const params = interaction?.params || {};
  switch (interaction?.method) {
    case "item/tool/requestUserInput": return params.questions?.length === 1 ? params.questions[0].question : `${params.questions?.length || 0} 项待确认`;
    case "item/commandExecution/requestApproval": return params.kind === "writeStdin" ? "确认写入终端" : params.networkApprovalContext ? "确认网络访问" : "确认执行命令";
    case "item/fileChange/requestApproval": return "确认文件修改";
    case "item/permissions/requestApproval": return "确认额外权限";
    case "mcpServer/elicitation/request": return params.title || params.serverName || "外部服务确认";
    default: return "待办暂不可用";
  }
}
export function interactionChoiceLabel(interaction) {
  const params = interaction.params || {};
  switch (interaction.method) {
    case "item/tool/requestUserInput": return compact(params.questions?.[0]?.question || "补充信息");
    case "item/commandExecution/requestApproval": return compact(params.networkApprovalContext ? `网络访问 · ${params.networkApprovalContext.host}`
      : `${params.kind === "writeStdin" ? "终端输入" : "执行命令"} · ${params.command || params.reason || "待确认"}`);
    case "item/fileChange/requestApproval": return compact(`文件修改 · ${interaction.item?.changes?.[0]?.path || params.grantRoot || params.reason || "工作区文件"}`);
    case "item/permissions/requestApproval": return compact(`访问授权 · ${params.cwd || params.reason || "额外权限"}`);
    case "mcpServer/elicitation/request": return compact(`${params.serverName || "外部服务"} · ${params.title || params.message || params.description || "待确认"}`);
    default: return "待处理事项";
  }
}
export function fileChangeLabel(change) {
  const kind = typeof change.kind === "string" ? change.kind : change.kind?.type || change.changeType;
  return ({ add: "新增", create: "新增", update: "修改", modify: "修改", delete: "删除", remove: "删除", move: "移动", rename: "重命名" })[kind] || "文件变更";
}
