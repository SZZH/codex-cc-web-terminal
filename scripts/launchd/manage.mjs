import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, "..", "..");
const templatePath = path.join(__dirname, "com.codex-cc-web-terminal.plist.template");
const label = "com.codex-cc-web-terminal";
const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
const plistPath = path.join(launchAgentsDir, `${label}.plist`);
const nodePath = process.execPath;

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    action: "render",
    output: "",
    overwrite: false
  };

  const args = [...argv];
  if (args[0] && !args[0].startsWith("--")) {
    options.action = args.shift();
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output") {
      options.output = args[index + 1] || options.output;
      index += 1;
      continue;
    }
    if (arg === "--overwrite") {
      options.overwrite = true;
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }

  if (!["render", "install", "uninstall", "list"].includes(options.action)) {
    fail(`Unsupported action: ${options.action}`);
  }

  return options;
}

function renderTemplate() {
  const template = fs.readFileSync(templatePath, "utf8");
  return template
    .replaceAll("__ROOT__", root)
    .replaceAll("__NODE_PATH__", nodePath);
}

function ensureDarwin(action) {
  if (process.platform !== "darwin") {
    fail(`launchd ${action} is only supported on macOS.`);
  }
}

function writeRenderedPlist(targetPath, { overwrite = false } = {}) {
  const outputPath = targetPath || plistPath;
  if (fs.existsSync(outputPath) && !overwrite) {
    fail(`File already exists: ${outputPath}. Re-run with --overwrite to replace it.`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, renderTemplate(), "utf8");
  return outputPath;
}

function runLaunchctl(args, { allowFailure = false } = {}) {
  const result = spawnSync("launchctl", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0 && !allowFailure) {
    const stderr = String(result.stderr || "").trim();
    fail(stderr || `launchctl failed: ${args.join(" ")}`);
  }

  return {
    status: result.status ?? 0,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || "")
  };
}

function handleRender(options) {
  const outputPath = options.output ? path.resolve(options.output) : "";
  if (outputPath) {
    const writtenPath = writeRenderedPlist(outputPath, { overwrite: options.overwrite });
    console.log(`Rendered launchd plist to ${writtenPath}`);
    return;
  }

  process.stdout.write(renderTemplate());
}

function handleInstall(options) {
  ensureDarwin("install");
  const writtenPath = writeRenderedPlist(plistPath, { overwrite: options.overwrite });
  const userDomain = `gui/${process.getuid?.() || ""}`;
  runLaunchctl(["bootstrap", userDomain, writtenPath], { allowFailure: true });
  runLaunchctl(["enable", `${userDomain}/${label}`], { allowFailure: true });
  runLaunchctl(["kickstart", "-k", `${userDomain}/${label}`], { allowFailure: true });
  console.log(`Installed launchd agent at ${writtenPath}`);
}

function handleUninstall() {
  ensureDarwin("uninstall");
  const userDomain = `gui/${process.getuid?.() || ""}`;
  runLaunchctl(["bootout", userDomain, plistPath], { allowFailure: true });
  if (fs.existsSync(plistPath)) {
    fs.unlinkSync(plistPath);
  }
  console.log(`Removed launchd agent ${label}`);
}

function parseLaunchctlList(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length >= 3 && parts[2] === label)
    .map((parts) => ({
      pid: parts[0] === "-" ? null : Number.parseInt(parts[0], 10) || null,
      status: parts[1],
      label: parts[2]
    }));
}

function handleList() {
  ensureDarwin("list");
  const result = runLaunchctl(["list"], { allowFailure: true });
  const matches = parseLaunchctlList(result.stdout);
  const installed = fs.existsSync(plistPath);

  if (!matches.length) {
    console.log(installed ? `Installed plist found at ${plistPath}, but no running ${label} agent is listed.` : `No ${label} launchd agent found.`);
    return;
  }

  for (const item of matches) {
    console.log(`${item.label}\tpid=${item.pid ?? "-"}\tstatus=${item.status}\tplist=${installed ? plistPath : "not-installed"}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.action === "render") {
    handleRender(options);
    return;
  }

  if (options.action === "install") {
    handleInstall(options);
    return;
  }

  if (options.action === "uninstall") {
    handleUninstall();
    return;
  }

  if (options.action === "list") {
    handleList();
  }
}

main();
