import { readFile } from "node:fs/promises";

const cache = new WeakMap();
const CACHE_MS = 5_000;
const READ_TIMEOUT_MS = 3_000;
const normalize = (value) => value === "queue" ? "queue" : ["steer", "interrupt"].includes(value) ? "steer" : null;

// This fallback reads only the desktop scalar. Skip comments and multiline strings
// so examples in instructions and settings in other TOML tables cannot select it.
function scalarLine(line, state) {
  const continued = Boolean(state.multiline);
  let quote = "";
  let result = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (state.multiline) {
      if (state.multiline === '"""' && char === "\\") { index += 1; continue; }
      if (line.startsWith(state.multiline, index)) { state.multiline = ""; index += 2; }
      continue;
    }
    if (quote) {
      result += char;
      if (quote === '"' && char === "\\") { result += line[++index] || ""; continue; }
      if (char === quote) quote = "";
      continue;
    }
    if (char === "#") break;
    if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
      state.multiline = line.slice(index, index + 3);
      result += state.multiline;
      index += 2;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    result += char;
  }
  return continued ? "" : result.trim();
}

function desktopScalar(source) {
  let section = "root";
  let value = null;
  const state = { multiline: "" };
  for (const rawLine of source.split(/\r?\n/)) {
    const line = scalarLine(rawLine, state);
    if (!line) continue;
    if (line.startsWith("[")) {
      section = /^\[\s*(?:desktop|"desktop"|'desktop')\s*\]$/.test(line) ? "desktop" : "other";
      continue;
    }
    const match = section === "desktop"
      ? /^(?:followUpQueueMode|"followUpQueueMode"|'followUpQueueMode')\s*=\s*(["'])(queue|steer|interrupt)\1$/.exec(line)
      : section === "root"
        ? /^(?:desktop|"desktop"|'desktop')\s*\.\s*(?:followUpQueueMode|"followUpQueueMode"|'followUpQueueMode')\s*=\s*(["'])(queue|steer|interrupt)\1$/.exec(line)
        : null;
    if (match) value = normalize(match[2]);
  }
  return value;
}

async function fallbackMode(config) {
  try {
    const mode = desktopScalar(await readFile(config.codexConfigPath, "utf8"));
    if (mode) return mode;
  } catch { /* Missing or unreadable local settings use the desktop initialization value. */ }
  try {
    const state = JSON.parse(await readFile(config.codexGlobalStatePath, "utf8"));
    return normalize(state?.["electron-initial-follow-up-queue-mode"]) || "steer";
  } catch { return "steer"; }
}

function connected(bridge) {
  return bridge?.connected === true && bridge.initialized === true && typeof bridge.request === "function"
    && (bridge.ws?.readyState == null || bridge.ws.readyState === 1);
}

async function readEffectiveMode(bridge, cwd) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => bridge.request("config/read", {
        includeLayers: false, ...(cwd ? { cwd } : {})
      }, { signal: controller.signal })).then((response) => normalize(response?.config?.desktop?.followUpQueueMode)),
      new Promise((resolve) => {
        timer = setTimeout(() => { resolve(null); controller.abort(); }, READ_TIMEOUT_MS);
      })
    ]);
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/** Read the desktop preference without starting a connection or retaining configuration contents. */
export async function readCodexFollowUpQueueMode({ config = {}, bridge, cwd = "" } = {}) {
  if (config.codexAppServerEnabled === false || !connected(bridge)) return fallbackMode(config);
  let entries = cache.get(bridge);
  if (!entries || entries.generation !== bridge.connectionGeneration || entries.socket !== bridge.ws) {
    entries = { generation: bridge.connectionGeneration, socket: bridge.ws, byCwd: new Map() };
    cache.set(bridge, entries);
  }
  const key = String(cwd || "").trim();
  let entry = entries.byCwd.get(key);
  if (!entry || !entry.pending && Date.now() >= entry.expiresAt) {
    entry = { mode: null, expiresAt: 0, pending: null };
    entries.byCwd.set(key, entry);
    entry.pending = readEffectiveMode(bridge, key).then((mode) => {
      entry.mode = mode;
      entry.expiresAt = Date.now() + CACHE_MS;
    }).finally(() => { entry.pending = null; });
  }
  await entry.pending;
  if (!connected(bridge) || entries.generation !== bridge.connectionGeneration || entries.socket !== bridge.ws) {
    return fallbackMode(config);
  }
  return entry.mode || fallbackMode(config);
}
