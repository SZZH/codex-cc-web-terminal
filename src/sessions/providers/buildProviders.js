import path from "node:path";

function quotePosix(value) {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}

function quotePowerShell(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function buildShellCommand(parts, quoteStyle) {
  const values = parts.filter((part) => String(part || "").length > 0);
  if (values.length === 0) {
    return "";
  }

  if (quoteStyle === "powershell") {
    const [command, ...args] = values;
    const quotedArgs = args.map((arg) => quotePowerShell(arg)).join(" ");
    return quotedArgs ? `& ${quotePowerShell(command)} ${quotedArgs}` : `& ${quotePowerShell(command)}`;
  }

  return values.map((part) => quotePosix(part)).join(" ");
}

function commandBaseName(command) {
  return path
    .basename(String(command || ""))
    .replace(/\.(exe|cmd|bat|ps1)$/i, "")
    .trim()
    .toLowerCase();
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim().toLowerCase()))];
}

function uniqueTrimmedStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push(text);
  }
  return result;
}

function selectModel(preferred, fallback) {
  const preferredText = String(preferred || "").trim();
  if (preferredText) {
    return preferredText;
  }
  return String(fallback || "").trim();
}

export function buildProviders(config) {
  const codexBootstrapNames = uniqueStrings(["codex", commandBaseName(config.codexBin)]);
  const ccBootstrapNames = uniqueStrings(["cc", "claude", commandBaseName(config.ccBin)]);
  const codexModelOptions = uniqueTrimmedStrings([config.codexModel, ...(config.codexModels || [])]);
  const ccModelOptions = uniqueTrimmedStrings([config.ccModel, ...(config.ccModels || [])]);
  const codexArgs = ({ resumeSessionId, model }) => {
    const args = [];
    const selectedModel = selectModel(model, config.codexModel);
    if (resumeSessionId) {
      args.push("resume", "--all", resumeSessionId);
    }
    if (selectedModel) {
      args.push("--model", selectedModel);
    }
    if (config.codexProfile) {
      args.push("--profile", config.codexProfile);
    }
    if (config.codexNoAltScreen) {
      args.push("--no-alt-screen");
    }
    if (config.codexFullAccess) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    if (config.codexExtraArgs.length > 0) {
      args.push(...config.codexExtraArgs);
    }
    return args;
  };
  const ccArgs = ({ resumeSessionId, name, model }) => {
    const args = [];
    const selectedModel = selectModel(model, config.ccModel);
    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    } else if (String(name || "").trim()) {
      args.push("--name", String(name).trim());
    }
    if (selectedModel) {
      args.push("--model", selectedModel);
    }
    if (config.ccFullAccess) {
      args.push("--dangerously-skip-permissions");
    }
    if (config.ccExtraArgs.length > 0) {
      args.push(...config.ccExtraArgs);
    }
    return args;
  };

  return [
    {
      id: "codex",
      aliases: ["codex"],
      label: "Codex",
      cliLabel: "Codex CLI",
      historyLabel: "Saved Codex sessions",
      fallbackPrefix: "codex",
      sessionsDir: config.codexSessionsDir,
      bootstrapNames: codexBootstrapNames,
      defaultModel: config.codexModel,
      models: codexModelOptions,
      buildSpawnSpec({ resumeSessionId, model }) {
        return {
          file: config.codexBin,
          args: codexArgs({ resumeSessionId, model })
        };
      },
      buildCommand({ resumeSessionId, model }) {
        const parts = [config.codexBin, ...codexArgs({ resumeSessionId, model })];
        return buildShellCommand(parts, config.shellQuoteStyle);
      }
    },
    {
      id: "cc",
      aliases: ["cc", "claude"],
      label: "Claude",
      cliLabel: "Claude CLI",
      historyLabel: "Saved Claude sessions",
      fallbackPrefix: "cc",
      sessionsDir: config.ccSessionsDir,
      bootstrapNames: ccBootstrapNames,
      defaultModel: config.ccModel,
      models: ccModelOptions,
      buildSpawnSpec({ resumeSessionId, name, model }) {
        return {
          file: config.ccBin,
          args: ccArgs({ resumeSessionId, name, model })
        };
      },
      buildCommand({ resumeSessionId, name, model }) {
        const parts = [config.ccBin, ...ccArgs({ resumeSessionId, name, model })];
        return buildShellCommand(parts, config.shellQuoteStyle);
      }
    }
  ];
}
