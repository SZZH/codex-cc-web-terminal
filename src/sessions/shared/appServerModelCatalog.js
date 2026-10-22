const catalogCache = new WeakMap();
const CATALOG_TTL_MS = 60_000;
const FAILURE_RETRY_MS = 5_000;
const MAX_PAGES = 20;
const MAX_MODELS = 512;
const MAX_FETCH_MS = 10_000;

const text = (value) => String(value ?? "").trim();

function cloneModels(models) {
  return models.map((model) => ({
    ...model,
    ...(Array.isArray(model.supportedReasoningEfforts) ? { supportedReasoningEfforts: [...model.supportedReasoningEfforts] } : {}),
    ...(Array.isArray(model.inputModalities) ? { inputModalities: [...model.inputModalities] } : {})
  }));
}

export function getCachedAppServerModels(bridge) {
  const models = bridge && catalogCache.get(bridge)?.models;
  return models ? cloneModels(models) : null;
}

export function normalizeAppServerModel(model) {
  if (!model || typeof model !== "object" || model.hidden === true || model.visibility === "hidden") return null;
  const value = text(model.model || model.slug || model.id);
  if (!value) return null;
  const efforts = model.supportedReasoningEfforts ?? model.supported_reasoning_efforts ?? model.supported_reasoning_levels;
  const defaultEffort = text(model.defaultReasoningEffort ?? model.default_reasoning_effort ?? model.default_reasoning_level);
  const modalities = model.inputModalities ?? model.input_modalities;
  return {
    value,
    label: text(model.displayName || model.display_name) || value,
    capabilitiesKnown: true,
    ...(Array.isArray(efforts) ? {
      supportedReasoningEfforts: [...new Set(efforts.map((effort) =>
        text(typeof effort === "string" ? effort : effort?.reasoningEffort ?? effort?.reasoning_effort ?? effort?.effort)).filter(Boolean))]
    } : {}),
    ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
    ...(Array.isArray(modalities) ? { inputModalities: [...new Set(modalities.map(text).filter(Boolean))] } : {}),
    ...(typeof model.isDefault === "boolean" ? { isDefault: model.isDefault } : {})
  };
}

function withConfiguredModels(models, configuredModels) {
  const result = cloneModels(models);
  const known = new Set(result.map((model) => model.value));
  for (const configured of configuredModels) {
    const value = text(configured);
    if (!value || known.has(value)) continue;
    known.add(value);
    result.push({ value, label: value, capabilitiesKnown: false, catalogSource: "configured" });
  }
  return result;
}

async function fetchModels(bridge, token) {
  if (typeof bridge.ensureReady === "function") await bridge.ensureReady();
  const models = new Map();
  const cursors = new Set();
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (token.cancelled) throw new Error("App-server model catalog request timed out");
    const response = await bridge.request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) });
    if (token.cancelled) throw new Error("App-server model catalog request timed out");
    if (!Array.isArray(response?.data)) throw new Error("App-server returned an invalid model catalog");
    for (const raw of response.data) {
      const model = normalizeAppServerModel(raw);
      if (model && !models.has(model.value)) models.set(model.value, model);
      if (models.size > MAX_MODELS) throw new Error("App-server model catalog exceeds the supported size");
    }
    const nextCursor = text(response.nextCursor);
    if (!nextCursor) return [...models.values()];
    if (cursors.has(nextCursor)) throw new Error("App-server model catalog repeated a pagination cursor");
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error("App-server model catalog exceeded the pagination limit");
}

async function boundedFetch(bridge, timeoutMs) {
  const token = { cancelled: false };
  let timer;
  try {
    return await Promise.race([
      fetchModels(bridge, token),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          token.cancelled = true;
          reject(new Error("App-server model catalog request timed out"));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function getAppServerModelCatalog({
  bridge,
  enabled = true,
  fallbackModels = [],
  configuredModels = [],
  now = Date.now,
  ttlMs = CATALOG_TTL_MS,
  timeoutMs = MAX_FETCH_MS
} = {}) {
  if (!enabled || !bridge || typeof bridge.request !== "function") {
    return {
      models: withConfiguredModels(fallbackModels, configuredModels),
      status: "fallback",
      refreshing: false,
      source: "local_fallback",
      error: !enabled ? "App-server is disabled" : "App-server model catalog is unavailable",
      updatedAt: null
    };
  }
  let entry = catalogCache.get(bridge);
  if (!entry) {
    entry = { models: null, updatedAt: null, refreshAfter: 0, error: null, pending: null };
    catalogCache.set(bridge, entry);
  }
  if (!entry.pending && now() >= entry.refreshAfter) {
    entry.pending = boundedFetch(bridge, timeoutMs).then((models) => {
      entry.models = models;
      entry.updatedAt = new Date(now()).toISOString();
      entry.refreshAfter = now() + ttlMs;
      entry.error = null;
    }).catch((error) => {
      entry.error = error?.message || "App-server model catalog could not be loaded";
      entry.refreshAfter = now() + FAILURE_RETRY_MS;
    }).finally(() => {
      entry.pending = null;
    });
  }
  if (entry.pending && entry.models === null) await entry.pending;
  const refreshing = Boolean(entry.pending);
  return {
    models: withConfiguredModels(entry.models ?? fallbackModels, configuredModels),
    status: entry.error || refreshing ? (entry.models ? "stale" : "fallback") : "ready",
    refreshing,
    source: entry.models ? "app_server" : "local_fallback",
    error: entry.error,
    updatedAt: entry.updatedAt
  };
}
