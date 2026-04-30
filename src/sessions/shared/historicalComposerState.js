import fs from "node:fs";

export function parseHistoricalThreadComposerContext(filePath = "") {
  const targetPath = String(filePath || "").trim();
  if (!targetPath || !fs.existsSync(targetPath)) {
    return null;
  }
  try {
    let latest = null;
    const lines = fs.readFileSync(targetPath, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.type !== "turn_context") {
        continue;
      }
      const payload = record?.payload || {};
      const sandboxType = String(payload?.sandbox_policy?.type || "").trim().toLowerCase();
      const approvalPolicy = String(payload?.approval_policy || "").trim().toLowerCase();
      latest = {
        cwd: String(payload?.cwd || "").trim(),
        model: String(payload?.model || "").trim(),
        reasoningEffort:
          String(payload?.collaboration_mode?.settings?.reasoning_effort || payload?.effort || "").trim() || "",
        permissionMode:
          sandboxType === "danger-full-access" || approvalPolicy === "never"
            ? "full-access"
            : approvalPolicy === "on-request" || approvalPolicy === "untrusted"
              ? "auto-review"
              : "default"
      };
    }
    return latest;
  } catch {
    return null;
  }
}
