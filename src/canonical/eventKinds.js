export const CANONICAL_EVENT_KINDS = Object.freeze({
  THREAD_METADATA_UPDATED: "thread.metadata.updated",
  TURN_STARTED: "turn.started",
  TURN_COMPLETED: "turn.completed",
  TURN_FAILED: "turn.failed",
  TURN_INTERRUPTED: "turn.interrupted",
  USER_MESSAGE: "user.message",
  MESSAGE_DELTA: "message.delta",
  MESSAGE_COMPLETED: "message.completed",
  REASONING_DELTA: "reasoning.delta",
  REASONING_COMPLETED: "reasoning.completed",
  TOOL_STARTED: "tool.started",
  TOOL_PROGRESS: "tool.progress",
  TOOL_COMPLETED: "tool.completed",
  TOOL_FAILED: "tool.failed",
  ARTIFACT_CREATED: "artifact.created",
  ARTIFACT_UPDATED: "artifact.updated",
  THREAD_SNAPSHOT: "thread.snapshot"
});

export const CANONICAL_EVENT_KIND_SET = new Set(Object.values(CANONICAL_EVENT_KINDS));
