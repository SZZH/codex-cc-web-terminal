import fs from "node:fs";
import path from "node:path";
import { permissionModeFromStoredPolicy, permissionPolicyIsUnsupported } from "./permissionPolicy.js";

const COMPOSER_CONTEXT_CACHE_LIMIT = 512;
const composerContextCache = new Map();

function fileSignature(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function copyContext(context) {
  return context ? { ...context } : null;
}

export function parseHistoricalThreadComposerContext(filePath = "") {
  const requestedPath = String(filePath || "").trim();
  if (!requestedPath) {
    return null;
  }
  const targetPath = path.resolve(requestedPath);
  try {
    const stat = fs.statSync(targetPath, { bigint: true });
    if (!stat.isFile()) {
      composerContextCache.delete(targetPath);
      return null;
    }
    const signature = fileSignature(stat);
    const cached = composerContextCache.get(targetPath);
    if (cached?.signature === signature) {
      composerContextCache.delete(targetPath);
      composerContextCache.set(targetPath, cached);
      return copyContext(cached.context);
    }
    composerContextCache.delete(targetPath);

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
      latest = {
        cwd: String(payload?.cwd || "").trim(),
        model: String(payload?.model || "").trim(),
        reasoningEffort:
          String(payload?.collaboration_mode?.settings?.reasoning_effort || payload?.effort || "").trim() || "",
        permissionMode: permissionModeFromStoredPolicy(payload.sandbox_policy, { cwd: payload.cwd, approvalPolicy: payload.approval_policy }),
        ...(permissionPolicyIsUnsupported(payload.sandbox_policy, { cwd: payload.cwd }) ? { permissionPolicyUnsupported: true } : {})
      };
    }
    // Active transcripts may grow while being read; only retain a stable read.
    if (fileSignature(fs.statSync(targetPath, { bigint: true })) === signature) {
      composerContextCache.set(targetPath, { signature, context: latest });
      if (composerContextCache.size > COMPOSER_CONTEXT_CACHE_LIMIT) {
        composerContextCache.delete(composerContextCache.keys().next().value);
      }
    }
    return copyContext(latest);
  } catch {
    composerContextCache.delete(targetPath);
    return null;
  }
}
