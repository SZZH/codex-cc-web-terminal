import fs from "node:fs";
import { execFileSync } from "node:child_process";

import {
  normalizeCodexComposerPatch,
  normalizePermissionMode
} from "../shared/composerOptions.js";
import { permissionModeFromStoredPolicy, permissionPolicyIsUnsupported } from "../shared/permissionPolicy.js";

function readSqliteJson(dbPath, sql) {
  const output = execFileSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 3000
  });
  const text = String(output || "").trim();
  return text ? JSON.parse(text) : [];
}

function execSqlite(dbPath, sql) {
  execFileSync("sqlite3", [dbPath, sql], {
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 3000
  });
}

function sqlString(value = "") {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function toEffectivePermissionMode(requestedMode) {
  const normalized = normalizePermissionMode(requestedMode);
  if (normalized !== "default") {
    return normalized;
  }
  return "default";
}

function mapPermissionColumns(permissionMode) {
  const effectiveMode = toEffectivePermissionMode(permissionMode);
  if (effectiveMode === "full-access") {
    return {
      sandboxPolicy: JSON.stringify({ type: "danger-full-access" }),
      approvalMode: "never"
    };
  }
  if (effectiveMode === "auto-review") {
    return {
      sandboxPolicy: JSON.stringify({ type: "workspace-write" }),
      approvalMode: "on-request"
    };
  }
  return {
    sandboxPolicy: JSON.stringify({ type: "read-only", network_access: true }),
    approvalMode: effectiveMode === "manual-review" ? "on-request" : "never"
  };
}

function normalizeThreadRow(row = {}) {
  if (!row || !String(row.id || "").trim()) {
    return null;
  }
  return {
    threadId: String(row.id || "").trim(),
    cwd: String(row.cwd || "").trim(),
    model: String(row.model || "").trim(),
    reasoningEffort: String(row.reasoning_effort || "").trim(),
    permissionMode: permissionModeFromStoredPolicy(row.sandbox_policy, { cwd: row.cwd, approvalPolicy: row.approval_mode }),
    ...(permissionPolicyIsUnsupported(row.sandbox_policy, { cwd: row.cwd }) ? { permissionPolicyUnsupported: true } : {}),
    gitBranch: String(row.git_branch || "").trim(),
    updatedAtMs: Number(row.updated_at_ms || 0) || 0
  };
}

export class CodexThreadStateStore {
  constructor(config = {}) {
    this.config = config;
    this.dbPath = String(config.codexStateDbPath || "").trim();
  }

  isAvailable() {
    return Boolean(this.dbPath) && fs.existsSync(this.dbPath);
  }

  getThreadComposerState(threadId) {
    const targetThreadId = String(threadId || "").trim();
    if (!targetThreadId || !this.isAvailable()) {
      return null;
    }
    try {
      const rows = readSqliteJson(
        this.dbPath,
        [
          "select",
          "id, cwd, model, reasoning_effort, sandbox_policy, approval_mode, git_branch, updated_at_ms",
          "from threads",
          `where id = ${sqlString(targetThreadId)}`,
          "limit 1"
        ].join(" ")
      );
      return normalizeThreadRow(rows[0]);
    } catch {
      return null;
    }
  }

  patchThreadComposerState(threadId, patch = {}, { models = [] } = {}) {
    const targetThreadId = String(threadId || "").trim();
    if (!targetThreadId || !this.isAvailable()) {
      return null;
    }

    const current = this.getThreadComposerState(targetThreadId);
    if (!current) {
      return null;
    }

    const composerPatch = normalizeCodexComposerPatch(patch, current, models);
    const updates = [];

    if (Object.prototype.hasOwnProperty.call(composerPatch, "model") && composerPatch.model) {
      updates.push(`model = ${sqlString(composerPatch.model)}`);
    }
    if (Object.prototype.hasOwnProperty.call(composerPatch, "reasoningEffort")) {
      updates.push(`reasoning_effort = ${sqlString(composerPatch.reasoningEffort)}`);
    }
    if (Object.prototype.hasOwnProperty.call(composerPatch, "permissionMode")) {
      const permissionColumns = mapPermissionColumns(composerPatch.permissionMode);
      updates.push(`sandbox_policy = ${sqlString(permissionColumns.sandboxPolicy)}`);
      updates.push(`approval_mode = ${sqlString(permissionColumns.approvalMode)}`);
    }

    if (Object.prototype.hasOwnProperty.call(patch, "gitBranch")) {
      updates.push(`git_branch = ${sqlString(String(patch.gitBranch || "").trim())}`);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "cwd")) {
      const cwd = String(patch.cwd || "").trim();
      if (cwd) {
        updates.push(`cwd = ${sqlString(cwd)}`);
      }
    }

    if (!updates.length) {
      return current;
    }

    updates.push("updated_at = CAST(strftime('%s','now') AS INTEGER)");
    updates.push("updated_at_ms = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)");

    execSqlite(
      this.dbPath,
      `update threads set ${updates.join(", ")} where id = ${sqlString(targetThreadId)}`
    );
    return this.getThreadComposerState(targetThreadId);
  }

}
