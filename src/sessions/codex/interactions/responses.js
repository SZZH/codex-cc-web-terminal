import { formSupport, validateForm } from "./forms.js";
import { validatePermissions } from "./permissions.js";
import { equal, fields, invalid, object, safeObject } from "./validation.js";

export const INTERACTION_METHODS = new Set(["item/tool/requestUserInput", "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "mcpServer/elicitation/request"]);
const decisions = ["accept", "acceptForSession", "decline", "cancel"];

function validateQuestions(params) {
  if (typeof params.isBlocking !== "boolean" || !Array.isArray(params.questions)) throw invalid("Invalid original interaction questions");
  for (const question of params.questions) {
    if (!object(question) || typeof question.id !== "string" || !question.id || typeof question.header !== "string" || typeof question.question !== "string"
      || question.isOther != null && typeof question.isOther !== "boolean" || question.isSecret != null && typeof question.isSecret !== "boolean") throw invalid("Invalid original interaction question fields");
    if (question.options != null && (!Array.isArray(question.options) || question.options.some((option) => !object(option) || typeof option.label !== "string" || typeof option.description !== "string"))) throw invalid("Invalid original interaction question options");
  }
  if (new Set(params.questions.map((question) => question.id)).size !== params.questions.length) throw invalid("Duplicate original question IDs");
}

export function validateInteractionParams(method, params) {
  safeObject(params);
  if (!object(params) || typeof params.threadId !== "string" || !params.threadId || params.turnId != null && typeof params.turnId !== "string") throw invalid("Invalid original interaction identity");
  if (method !== "mcpServer/elicitation/request" && (typeof params.turnId !== "string" || !params.turnId || typeof params.itemId !== "string" || !params.itemId)) throw invalid("Invalid original interaction item identity");
  if (method.endsWith("requestApproval") && (!Number.isSafeInteger(params.startedAtMs) || params.startedAtMs < 0)) throw invalid("Invalid original approval timestamp");
  if (method === "item/tool/requestUserInput") validateQuestions(params);
  if (method === "item/commandExecution/requestApproval") {
    for (const key of ["command", "cwd", "reason", "approvalId", "environmentId"]) if (params[key] != null && typeof params[key] !== "string") throw invalid("Invalid original command approval fields");
    if (params.kind != null && !["command", "writeStdin"].includes(params.kind)) throw invalid("Invalid original command approval kind");
    if (params.additionalPermissions != null) validatePermissions({ permissions: params.additionalPermissions }, params.additionalPermissions);
    if (params.networkApprovalContext != null && (!object(params.networkApprovalContext) || typeof params.networkApprovalContext.host !== "string" || typeof params.networkApprovalContext.protocol !== "string")) throw invalid("Invalid original network approval context");
    if (params.commandActions != null && (!Array.isArray(params.commandActions) || params.commandActions.some((entry) => !object(entry) || typeof entry.type !== "string" || typeof entry.command !== "string"))) throw invalid("Invalid original command actions");
    if (params.availableDecisions != null) {
      if (!Array.isArray(params.availableDecisions) || !params.availableDecisions.length) throw invalid("Invalid original command decisions");
      for (const decision of params.availableDecisions) commandResponse({ decision }, params);
    }
    if (params.proposedExecpolicyAmendment != null && (!Array.isArray(params.proposedExecpolicyAmendment) || params.proposedExecpolicyAmendment.some((value) => typeof value !== "string"))) throw invalid("Invalid original execution policy proposal");
    if (params.proposedNetworkPolicyAmendments != null && (!Array.isArray(params.proposedNetworkPolicyAmendments) || params.proposedNetworkPolicyAmendments.some((entry) => !object(entry) || typeof entry.host !== "string" || !["allow", "deny"].includes(entry.action)))) throw invalid("Invalid original network policy proposal");
  }
  if (method === "item/fileChange/requestApproval") for (const key of ["reason", "grantRoot"]) if (params[key] != null && typeof params[key] !== "string") throw invalid("Invalid original file approval fields");
  if (method === "item/permissions/requestApproval") {
    if (typeof params.cwd !== "string" || !object(params.permissions)) throw invalid("Invalid original permission request");
    validatePermissions({ permissions: params.permissions }, params.permissions);
  }
  if (method === "mcpServer/elicitation/request") {
    if (typeof params.serverName !== "string" || !params.serverName || typeof params.mode !== "string") throw invalid("Invalid original elicitation request");
    if (["form", "openai/form", "openaiForm"].includes(params.mode) && (typeof params.message !== "string" || !Object.hasOwn(params, "requestedSchema"))) throw invalid("Invalid original elicitation form");
    if (params.mode === "url" && (typeof params.message !== "string" || typeof params.elicitationId !== "string" || typeof params.url !== "string")) throw invalid("Invalid original elicitation URL request");
    if (params.mode === "openai/userVerification" && ["challenge", "title", "description"].some((key) => typeof params[key] !== "string")) throw invalid("Invalid original device verification request");
  }
}

export function capabilityError(method, params) {
  if (method !== "mcpServer/elicitation/request") return null;
  if (params.mode === "openai/userVerification") return { code: "device_verification_unavailable", message: "This browser cannot provide the required device verification proof. Decline or cancel this request." };
  if (["form", "openai/form", "openaiForm"].includes(params.mode)) {
    const reason = formSupport(params.requestedSchema);
    return reason ? { code: "unsupported_interaction_schema", message: reason } : null;
  }
  if (params.mode === "url") {
    try {
      const url = new URL(params.url);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return null;
    } catch { /* Show an explicit unsupported state. */ }
    return { code: "unsafe_elicitation_url", message: "This request does not contain a safe HTTP or HTTPS URL." };
  }
  return { code: "unsupported_elicitation_mode", message: "This elicitation mode cannot be confirmed in this browser." };
}

function commandDecisionKind(decision) {
  if (typeof decision === "string") {
    if (!decisions.includes(decision)) throw invalid("Invalid command decision");
    return "plain";
  }
  if (!object(decision)) throw invalid("Invalid command decision");
  if (Object.hasOwn(decision, "acceptWithExecpolicyAmendment")) {
    fields(decision, ["acceptWithExecpolicyAmendment"]);
    fields(decision.acceptWithExecpolicyAmendment, ["execpolicy_amendment"]);
    const amendment = decision.acceptWithExecpolicyAmendment.execpolicy_amendment;
    if (!Array.isArray(amendment) || !amendment.length || amendment.some((value) => typeof value !== "string")) throw invalid("Invalid execution policy decision");
    return "exec";
  }
  fields(decision, ["applyNetworkPolicyAmendment"]);
  fields(decision.applyNetworkPolicyAmendment, ["network_policy_amendment"]);
  const amendment = decision.applyNetworkPolicyAmendment.network_policy_amendment;
  fields(amendment, ["host", "action"]);
  if (typeof amendment.host !== "string" || !amendment.host.trim() || !["allow", "deny"].includes(amendment.action)) throw invalid("Invalid network policy decision");
  return "network";
}

function commandResponse(response, params) {
  fields(response, ["decision"]);
  const { decision } = response;
  const kind = commandDecisionKind(decision);
  if (params.availableDecisions != null) {
    if (!Array.isArray(params.availableDecisions) || !params.availableDecisions.some((entry) => equal(entry, decision))) throw invalid("This command decision is not available");
    return;
  }
  if (kind === "plain") return;
  if (kind === "exec") {
    if (!Array.isArray(params.proposedExecpolicyAmendment) || !equal(decision.acceptWithExecpolicyAmendment.execpolicy_amendment, params.proposedExecpolicyAmendment)) throw invalid("The command decision invents an execution policy rule");
    return;
  }
  if (!params.proposedNetworkPolicyAmendments?.some((entry) => equal(entry, decision.applyNetworkPolicyAmendment.network_policy_amendment))) throw invalid("The command decision invents a network policy rule");
}

function questionsResponse(response, params) {
  fields(response, ["answers"]);
  const questions = params.questions;
  if (!Array.isArray(questions) || new Set(questions.map((entry) => entry.id)).size !== questions.length) throw invalid("Invalid original interaction questions");
  fields(response.answers, questions.map((entry) => entry.id), "Invalid question answers");
  for (const question of questions) {
    const answer = response.answers[question.id];
    fields(answer, ["answers"], "Missing or invalid question answers");
    if (!Array.isArray(answer.answers) || answer.answers.some((value) => typeof value !== "string")) throw invalid("Question answers must contain strings");
    if (Array.isArray(question.options) && question.options.length && !question.isOther) {
      const allowed = new Set(question.options.map((option) => option.label));
      if (answer.answers.some((value) => !allowed.has(value))) throw invalid("Question answer is not an available option");
    }
  }
}

export function validateInteractionResponse(method, params, response) {
  safeObject(response);
  if (method === "item/commandExecution/requestApproval") commandResponse(response, params);
  else if (method === "item/fileChange/requestApproval") {
    fields(response, ["decision"]);
    if (!decisions.includes(response.decision)) throw invalid("Invalid file change decision");
  } else if (method === "item/permissions/requestApproval") return validatePermissions(response, params.permissions);
  else if (method === "item/tool/requestUserInput") questionsResponse(response, params);
  else if (method === "mcpServer/elicitation/request") {
    fields(response, ["action", "content", "_meta"]);
    if (!["accept", "decline", "cancel"].includes(response.action)) throw invalid("Invalid elicitation action");
    if (response._meta != null) throw invalid("Client elicitation metadata is not supported");
    if (response.action !== "accept") {
      if (response.content != null) throw invalid("Declined or cancelled elicitation cannot contain answers");
    } else {
      const unavailable = capabilityError(method, params);
      if (unavailable) throw invalid(unavailable.message, unavailable.code);
      if (["form", "openai/form", "openaiForm"].includes(params.mode)) validateForm(params.requestedSchema, response.content);
      else if (params.mode === "url" && response.content != null) throw invalid("URL elicitation does not accept form content");
    }
  } else throw invalid("Unsupported user interaction");
  return structuredClone(response);
}
