import fs from "node:fs";

function readTextFile(filePath = "") {
  const targetPath = String(filePath || "").trim();
  if (!targetPath || !fs.existsSync(targetPath)) {
    return "";
  }
  try {
    return fs.readFileSync(targetPath, "utf8");
  } catch {
    return "";
  }
}

function readLastTomlScalarValue(source = "", key = "") {
  const targetKey = String(key || "").trim();
  if (!targetKey) {
    return "";
  }
  let latest = "";
  for (const rawLine of String(source || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!match || match[1] !== targetKey) {
      continue;
    }
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    latest = value;
  }
  return latest;
}

export function readCodexDesktopDefaults(config = {}) {
  const configText = readTextFile(config.codexConfigPath);
  let agentMode = "";
  try {
    const globalState = JSON.parse(readTextFile(config.codexGlobalStatePath) || "{}");
    agentMode = String(globalState?.["agent-mode-by-host-id"]?.local || globalState?.["agent-mode"] || "").trim().toLowerCase();
  } catch {
    agentMode = "";
  }

  const permissionMode =
    agentMode === "full-access"
      ? "full-access"
      : agentMode === "auto-review"
        ? "auto-review"
        : "default";

  return {
    model: String(readLastTomlScalarValue(configText, "model") || "").trim(),
    reasoningEffort: String(readLastTomlScalarValue(configText, "model_reasoning_effort") || "").trim() || "medium",
    permissionMode
  };
}
