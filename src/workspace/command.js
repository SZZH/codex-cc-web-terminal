import { CommandError, createCommandRunner } from "../runtime/processes/command.js";

export class WorkspaceCommandError extends CommandError {
  constructor(message, options) {
    super(message, options);
    this.name = "WorkspaceCommandError";
  }
}

export function createWorkspaceCommandRunner({ maxConcurrent, maxQueued, killGraceMs, closeTimeoutMs } = {}) {
  return createCommandRunner({ maxConcurrent, maxQueued, killGraceMs, closeTimeoutMs,
    errorPrefix: "WORKSPACE_COMMAND", ErrorClass: WorkspaceCommandError, commandLabel: "Workspace command" });
}
