import { normalizePermissionMode } from "./composerOptions.js";

function permissionOptions(session) {
  const permissionMode = normalizePermissionMode(session.permissionMode);
  if (permissionMode === "full-access") {
    return {
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" }
    };
  }
  if (permissionMode === "auto-review") {
    return {
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [session.cwd],
        networkAccess: false
      }
    };
  }
  return {
    sandbox: "read-only",
    approvalPolicy: permissionMode === "manual-review" ? "on-request" : "never",
    approvalsReviewer: "user",
    sandboxPolicy: {
      type: "readOnly",
      access: { type: "fullAccess" },
      networkAccess: true
    }
  };
}

export function buildAppServerThreadOptions(session) {
  const { sandbox, approvalPolicy, approvalsReviewer } = permissionOptions(session);
  return {
    cwd: session.cwd,
    model: session.model || null,
    sandbox,
    approvalPolicy,
    approvalsReviewer,
    persistExtendedHistory: true
  };
}

export function buildAppServerTurnOptions(session) {
  const { sandboxPolicy, approvalPolicy, approvalsReviewer } = permissionOptions(session);
  return {
    model: session.model || null,
    effort: session.reasoningEffort || null,
    sandboxPolicy,
    approvalPolicy,
    approvalsReviewer
  };
}
