export const TURN_STATUS = Object.freeze({
  IN_PROGRESS: "inProgress",
  COMPLETED: "completed",
  FAILED: "failed",
  ABORTED: "aborted"
});

export const ASSISTANT_LIVE_STATE = Object.freeze({
  IDLE: "idle",
  LIVE_FALLBACK: "live_visible_from_fallback",
  LIVE_PRIMARY: "live_visible_from_primary",
  COMMITTED: "committed",
  FAILED: "failed",
  ABORTED: "aborted"
});

export const THREAD_ITEM_KIND = Object.freeze({
  USER_MESSAGE: "UserMessage",
  HOOK_PROMPT: "HookPrompt",
  AGENT_MESSAGE: "AgentMessage",
  PLAN: "Plan",
  REASONING: "Reasoning",
  COMMAND_EXECUTION: "CommandExecution",
  FILE_CHANGE: "FileChange",
  MCP_TOOL_CALL: "McpToolCall",
  DYNAMIC_TOOL_CALL: "DynamicToolCall",
  COLLAB_AGENT_TOOL_CALL: "CollabAgentToolCall",
  WEB_SEARCH: "WebSearch",
  IMAGE_VIEW: "ImageView",
  IMAGE_GENERATION: "ImageGeneration",
  ENTERED_REVIEW_MODE: "EnteredReviewMode",
  EXITED_REVIEW_MODE: "ExitedReviewMode",
  CONTEXT_COMPACTION: "ContextCompaction",
  UNKNOWN: "Unknown"
});

export const PRIMARY_ITEM_KINDS = new Set([
  THREAD_ITEM_KIND.AGENT_MESSAGE,
  THREAD_ITEM_KIND.PLAN
]);

export const PROCESS_ITEM_KINDS = new Set([
  THREAD_ITEM_KIND.REASONING,
  THREAD_ITEM_KIND.COMMAND_EXECUTION,
  THREAD_ITEM_KIND.FILE_CHANGE,
  THREAD_ITEM_KIND.MCP_TOOL_CALL,
  THREAD_ITEM_KIND.DYNAMIC_TOOL_CALL,
  THREAD_ITEM_KIND.COLLAB_AGENT_TOOL_CALL,
  THREAD_ITEM_KIND.WEB_SEARCH,
  THREAD_ITEM_KIND.IMAGE_VIEW,
  THREAD_ITEM_KIND.IMAGE_GENERATION,
  THREAD_ITEM_KIND.ENTERED_REVIEW_MODE,
  THREAD_ITEM_KIND.EXITED_REVIEW_MODE,
  THREAD_ITEM_KIND.CONTEXT_COMPACTION,
  THREAD_ITEM_KIND.UNKNOWN
]);

export function isPrimaryItemKind(kind) {
  return PRIMARY_ITEM_KINDS.has(kind);
}

export function isProcessItemKind(kind) {
  return PROCESS_ITEM_KINDS.has(kind);
}

export function classifyThreadItemKind(kind) {
  if (kind === THREAD_ITEM_KIND.USER_MESSAGE) {
    return "user";
  }
  if (isPrimaryItemKind(kind)) {
    return "primary";
  }
  if (isProcessItemKind(kind)) {
    return "process";
  }
  return "process";
}
