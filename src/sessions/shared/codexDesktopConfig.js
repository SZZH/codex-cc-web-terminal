import fs from "node:fs";
import path from "node:path";

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

function readJsonFile(filePath = "") {
  try {
    return JSON.parse(readTextFile(filePath) || "{}");
  } catch {
    return {};
  }
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

export function mapCodexDesktopAgentModeToPermissionMode(agentMode = "") {
  const normalized = String(agentMode || "").trim().toLowerCase();
  if (normalized === "full-access") {
    return "full-access";
  }
  if (normalized === "auto" || normalized === "auto-review" || normalized === "guardian-approvals") {
    return "auto-review";
  }
  if (normalized === "default") {
    return "default";
  }
  return "default";
}

function mapPermissionModeToCodexDesktopAgentMode(permissionMode = "") {
  const normalized = String(permissionMode || "").trim().toLowerCase();
  if (normalized === "full-access") {
    return "full-access";
  }
  if (normalized === "auto-review") {
    return "auto";
  }
  return "default";
}

export function readCodexDesktopGlobalState(config = {}) {
  return readJsonFile(config.codexGlobalStatePath);
}

export function readCodexDesktopAgentMode(config = {}) {
  try {
    const globalState = readCodexDesktopGlobalState(config);
    const atomState = ensureObject(globalState?.["electron-persisted-atom-state"]);
    return String(
      ensureObject(atomState?.["agent-mode-by-host-id"])?.local ||
        atomState?.["agent-mode"] ||
        ""
    ).trim().toLowerCase();
  } catch {
    return "";
  }
}

export function readCodexDesktopDefaults(config = {}) {
  const configText = readTextFile(config.codexConfigPath);
  const agentMode = readCodexDesktopAgentMode(config);

  return {
    model: String(readLastTomlScalarValue(configText, "model") || "").trim(),
    reasoningEffort: String(readLastTomlScalarValue(configText, "model_reasoning_effort") || "").trim() || "medium",
    permissionMode: mapCodexDesktopAgentModeToPermissionMode(agentMode)
  };
}

export function writeCodexDesktopPermissionMode(config = {}, permissionMode = "") {
  const targetPath = String(config.codexGlobalStatePath || "").trim();
  if (!targetPath) {
    return;
  }

  const globalState = ensureObject(readCodexDesktopGlobalState(config));
  const atomState = ensureObject(globalState["electron-persisted-atom-state"]);
  const agentModeByHostId = ensureObject(atomState["agent-mode-by-host-id"]);
  const preferredNonFullAccess = ensureObject(atomState["preferred-non-full-access-agent-mode-by-host-id"]);
  const nextAgentMode = mapPermissionModeToCodexDesktopAgentMode(permissionMode);

  agentModeByHostId.local = nextAgentMode;
  if (nextAgentMode === "full-access") {
    atomState["agent-mode"] = "full-access";
  } else {
    preferredNonFullAccess.local = nextAgentMode;
  }

  atomState["agent-mode-by-host-id"] = agentModeByHostId;
  atomState["preferred-non-full-access-agent-mode-by-host-id"] = preferredNonFullAccess;
  globalState["electron-persisted-atom-state"] = atomState;

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(globalState), "utf8");
}
