import fs from "node:fs";
import { execFileSync } from "node:child_process";

import { readCodexDesktopDefaults } from "../shared/codexDesktopConfig.js";
import {
  extractComposerOptionOverrides,
  normalizePermissionMode
} from "../shared/composerOptions.js";

function readSqliteJson(dbPath, sql) {
  const output = execFileSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  const text = String(output || "").trim();
  return text ? JSON.parse(text) : [];
}

function execSqlite(dbPath, sql) {
  execFileSync("sqlite3", [dbPath, sql], {
    stdio: ["ignore", "ignore", "ignore"]
  });
}

function sqlString(value = "") {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function mapPermissionModeFromRow(row = {}) {
  const sandboxType = String(row?.sandbox_policy_type || row?.sandbox_policy?.type || "").trim().toLowerCase();
  const approvalMode = String(row?.approval_mode || "").trim().toLowerCase();
  if (sandboxType === "danger-full-access" || approvalMode === "never") {
    return "full-access";
  }
  if (approvalMode === "on-request" || approvalMode === "untrusted") {
    return "auto-review";
  }
  return "default";
}

function toEffectivePermissionMode(requestedMode, config) {
  const normalized = normalizePermissionMode(requestedMode);
  if (normalized !== "default") {
    return normalized;
  }
  return readCodexDesktopDefaults(config).permissionMode || "default";
}

function mapPermissionColumns(permissionMode, config) {
  const effectiveMode = toEffectivePermissionMode(permissionMode, config);
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
    sandboxPolicy: JSON.stringify({ type: "read-only" }),
    approvalMode: "default"
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
    permissionMode: mapPermissionModeFromRow(row),
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
          "id, cwd, model, reasoning_effort, sandbox_policy, approval_mode, git_branch, updated_at_ms,",
          "json_extract(sandbox_policy, '$.type') as sandbox_policy_type",
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

  patchThreadComposerState(threadId, patch = {}) {
    const targetThreadId = String(threadId || "").trim();
    if (!targetThreadId || !this.isAvailable()) {
      return null;
    }

    const current = this.getThreadComposerState(targetThreadId);
    if (!current) {
      return null;
    }

    const composerPatch = extractComposerOptionOverrides(patch);
    const updates = [];

    if (Object.prototype.hasOwnProperty.call(composerPatch, "model") && composerPatch.model) {
      updates.push(`model = ${sqlString(composerPatch.model)}`);
    }
    if (Object.prototype.hasOwnProperty.call(composerPatch, "reasoningEffort")) {
      updates.push(`reasoning_effort = ${sqlString(composerPatch.reasoningEffort)}`);
    }
    if (Object.prototype.hasOwnProperty.call(composerPatch, "permissionMode")) {
      const permissionColumns = mapPermissionColumns(composerPatch.permissionMode, this.config);
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
