import fs from "node:fs";

function reasoningMetadata(model) {
  const supported = model.supported_reasoning_levels ?? model.supportedReasoningEfforts ?? model.supported_reasoning_efforts;
  const defaultEffort = String(model.default_reasoning_level ?? model.defaultReasoningEffort ?? model.default_reasoning_effort ?? "").trim();
  return {
    ...(Array.isArray(supported) ? {
      supportedReasoningEfforts: [...new Set(supported
        .map((level) => String(typeof level === "string" ? level : level?.effort ?? level?.reasoningEffort ?? level?.reasoning_effort ?? "").trim())
        .filter(Boolean))]
    } : {}),
    ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {})
  };
}

export function readCodexModelsFromCache(filePath = "") {
  const targetPath = String(filePath || "").trim();
  if (!targetPath || !fs.existsSync(targetPath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(targetPath, "utf8"));
    const models = Array.isArray(parsed?.models) ? parsed.models : Array.isArray(parsed) ? parsed : [];
    const result = [];
    const seen = new Set();
    for (const model of models) {
      const slug = String(model?.slug || "").trim();
      const label = String(model?.display_name || slug).trim();
      const visibility = String(model?.visibility || "").trim().toLowerCase();
      if (!slug || seen.has(slug) || (visibility && visibility !== "list") || model?.supported_in_api === false) {
        continue;
      }
      seen.add(slug);
      result.push({
        value: slug,
        label: label || slug,
        ...reasoningMetadata(model),
        priority: Number.isFinite(Number(model?.priority)) ? Number(model.priority) : Number.MAX_SAFE_INTEGER
      });
    }
    return result
      .sort((left, right) => left.priority - right.priority || left.label.localeCompare(right.label))
      .map(({ priority, ...model }) => model);
  } catch {
    return [];
  }
}
