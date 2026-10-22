import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseDotEnv } from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, "..");
const logsDir = path.join(root, "logs");
const pm2Script = path.join(root, "node_modules", "pm2", "bin", "pm2");
const ecosystemFile = path.join(root, "ecosystem.config.cjs");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const appNames = {
  prod: "codex-cc-web-terminal",
  dev: "codex-cc-web-terminal-dev"
};
const managedAppSet = new Set(Object.values(appNames));

function fail(message) {
  throw new Error(message);
}

function localEnvPort() {
  try { return parseDotEnv(fs.readFileSync(path.join(root, ".env"))).PORT; }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

export function resolveHealthPort({ cliPort, envPort, filePort } = {}) {
  const configured = [cliPort, envPort, filePort].find((value) => value !== undefined && String(value).trim() !== "");
  if (configured === undefined) return 3210;
  const port = Number(configured);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`Invalid health port: ${configured}`);
  return port;
}

export function parseArgs(argv, { envPort = process.env.PORT, filePort } = {}) {
  const options = {
    action: "status",
    mode: "prod",
    healthPort: undefined,
    healthTimeoutSeconds: 30,
    logLines: 120,
    forceStart: false,
    json: false
  };

  const args = [...argv];
  if (args[0] && !args[0].startsWith("--")) {
    options.action = args.shift();
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--mode") {
      options.mode = args[index + 1] || options.mode;
      index += 1;
      continue;
    }
    if (arg === "--health-port") {
      if (!args[index + 1]) fail("Missing value for --health-port");
      options.healthPort = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--health-timeout-seconds") {
      options.healthTimeoutSeconds =
        Number.parseInt(args[index + 1] || "", 10) || options.healthTimeoutSeconds;
      index += 1;
      continue;
    }
    if (arg === "--log-lines") {
      options.logLines = Number.parseInt(args[index + 1] || "", 10) || options.logLines;
      index += 1;
      continue;
    }
    if (arg === "--force-start") {
      options.forceStart = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }

  if (!["start", "restart", "stop", "status", "logs", "resurrect", "list"].includes(options.action)) {
    fail(`Unsupported action: ${options.action}`);
  }

  if (!["dev", "prod"].includes(options.mode)) {
    fail(`Unsupported mode: ${options.mode}`);
  }

  if (["start", "restart", "status"].includes(options.action)) {
    options.healthPort = resolveHealthPort({ cliPort: options.healthPort, envPort,
      filePort: filePort === undefined ? localEnvPort() : filePort });
  }
  return options;
}

function ensurePm2Installed() {
  if (!fs.existsSync(pm2Script)) {
    fail(`pm2 is not installed. Run npm install first. Missing: ${pm2Script}`);
  }
}

function ensureLogsDir() {
  fs.mkdirSync(logsDir, { recursive: true });
}

function runPm2(args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [pm2Script, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0 && !allowFailure) {
    const stderr = String(result.stderr || "").trim();
    fail(stderr || `pm2 command failed: ${args.join(" ")}`);
  }

  return {
    status: result.status ?? 0,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || "")
  };
}

function getAppName(mode) {
  return appNames[mode] || appNames.prod;
}

function buildFrontend() {
  const packageJsonPath = path.join(root, "package.json");
  let scripts = {};
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    scripts = packageJson?.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts : {};
  } catch {
    scripts = {};
  }

  if (!scripts["web:build"]) {
    console.log('Skipping frontend build: missing "web:build" script in package.json.');
    return;
  }

  const result = spawnSync(npmCommand, ["run", "web:build"], {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    fail("Frontend build failed.");
  }
}

export function matchesManagedHealth(payload, app) {
  return payload?.ok === true && payload.service === "codex-cc-web-terminal" &&
    payload.shuttingDown === false && Number.isInteger(app?.pid) && app.pid > 0 &&
    app.pm2_env?.status === "online" && payload.pid === app.pid;
}

export async function waitForHealth(port, timeoutSeconds, getManagedApp) {
  const url = `http://127.0.0.1:${port}/api/health`;
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const body = await response.text();
        if (matchesManagedHealth(JSON.parse(body), getManagedApp())) return body;
      }
    } catch {
      // Keep polling until timeout.
    }

    await new Promise((resolve) => setTimeout(resolve, 700));
  }

  fail(`Health check did not pass within ${timeoutSeconds} seconds at ${url}`);
}

function readPm2Apps() {
  const result = runPm2(["jlist"], { capture: true, allowFailure: true });
  if (!result.stdout.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getManagedApps() {
  return readPm2Apps()
    .filter((app) => managedAppSet.has(String(app?.name || "")))
    .map((app) => ({
      name: String(app?.name || ""),
      pid: app?.pid ?? null,
      status: String(app?.pm2_env?.status || ""),
      restarts: Number(app?.pm2_env?.restart_time || 0),
      uptime: app?.pm2_env?.pm_uptime ?? null,
      watching: Boolean(app?.pm2_env?.watch),
      mode: String(app?.pm2_env?.exec_mode || "")
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function handleStartLike(action, options) {
  ensureLogsDir();
  buildFrontend();
  const appName = getAppName(options.mode);
  runPm2(["startOrReload", ecosystemFile, "--only", appName, "--update-env"]);
  const health = await waitForHealth(options.healthPort, options.healthTimeoutSeconds,
    () => readPm2Apps().find((app) => app?.name === appName));
  console.log(`Service ${action === "restart" ? "restarted" : "started"} successfully.`);
  process.stdout.write(health.endsWith("\n") ? health : `${health}\n`);
  runPm2(["status"]);
}

async function handleStatus(options) {
  runPm2(["status"]);
  try {
    const appName = getAppName(options.mode);
    const health = await waitForHealth(options.healthPort, 3,
      () => readPm2Apps().find((app) => app?.name === appName));
    process.stdout.write(health.endsWith("\n") ? health : `${health}\n`);
  } catch {
    console.log(`Managed service health was not verified on port ${options.healthPort}.`);
  }
}

function handleStop() {
  runPm2(["delete", appNames.prod, appNames.dev], { allowFailure: true });
  console.log("Service stopped.");
}

function handleLogs(options) {
  const appName = getAppName(options.mode);
  runPm2(["logs", appName, "--lines", String(options.logLines)]);
}

function handleResurrect(options) {
  ensureLogsDir();
  buildFrontend();
  runPm2(["ping"], { allowFailure: true });
  runPm2(["resurrect"], { allowFailure: true });

  const appName = getAppName(options.mode);
  const target = readPm2Apps().find((app) => app?.name === appName);
  if (!target || options.forceStart) {
    runPm2(["startOrReload", ecosystemFile, "--only", appName, "--update-env"]);
  }

  runPm2(["save"], { allowFailure: true });
}

function handleList(options) {
  const apps = getManagedApps();
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ apps }, null, 2)}\n`);
    return;
  }

  if (apps.length === 0) {
    console.log("No codex-cc-web-terminal PM2 apps found.");
    return;
  }

  for (const app of apps) {
    console.log(
      `${app.name}\tstatus=${app.status || "unknown"}\tpid=${app.pid ?? "-"}\trestarts=${app.restarts}\tmode=${app.mode || "-"}`
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  ensurePm2Installed();

  if (options.action === "start" || options.action === "restart") {
    await handleStartLike(options.action, options);
    return;
  }

  if (options.action === "stop") {
    handleStop();
    return;
  }

  if (options.action === "status") {
    await handleStatus(options);
    return;
  }

  if (options.action === "logs") {
    handleLogs(options);
    return;
  }

  if (options.action === "list") {
    handleList(options);
    return;
  }

  if (options.action === "resurrect") {
    handleResurrect(options);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) await main();
