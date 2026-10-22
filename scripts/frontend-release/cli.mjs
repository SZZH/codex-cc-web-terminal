#!/usr/bin/env node
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { createManifest, verifyArtifact } from "./manifest.mjs";
import { activateRelease, currentRelease, listReleases, publishRelease, stageRelease } from "./release.mjs";
import { transformCaddyConfig } from "./caddy.mjs";

const help = `Static frontend release (uses an existing build; never builds or reloads services)
  manifest --source DIR --release ID --output FILE
  verify --source DIR --manifest FILE
  stage|publish --source DIR --manifest FILE --root DIR
  activate|rollback --root DIR --release ID
  status --root DIR
  caddy --config ORIGINAL_JSON --server NAME --upstream DIAL --root SERVER_DIR --manifest FILE --output FILE [--retained FILE]

stage validates and retains artifacts without changing current; publish also activates.
activate/rollback validate a retained release before atomically replacing current.
caddy takes an optional JSON array of retained manifests; include all older manifests
to keep their immutable paths reachable. Its root is the server path, not a local read.
caddy writes a new config and never applies it.
Output files must not exist. No old releases or shared assets are deleted.
`;

function parse(argv) {
  const [command, ...args] = argv;
  if (!command || ["--help", "-h", "help"].includes(command)) return { command: "help", options: {} };
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!/^--[a-z]+$/.test(key) || !args[index + 1] || args[index + 1].startsWith("--") || Object.hasOwn(options, key.slice(2))) throw new Error(`Invalid CLI option: ${key}`);
    options[key.slice(2)] = args[index + 1];
  }
  const allowed = {
    manifest: ["source", "release", "output"], verify: ["source", "manifest"],
    stage: ["source", "manifest", "root"], publish: ["source", "manifest", "root"],
    activate: ["root", "release"], rollback: ["root", "release"], status: ["root"],
    caddy: ["config", "server", "upstream", "root", "manifest", "output"]
  }[command];
  if (!allowed) throw new Error(`Unknown command: ${command}`);
  if (allowed.some((key) => !options[key]) || Object.keys(options).some((key) => !allowed.includes(key) && !(command === "caddy" && key === "retained"))) throw new Error(`Required options for ${command}: ${allowed.map((key) => `--${key}`).join(" ")}`);
  return { command, options };
}

async function writeJson(filename, object) {
  await writeFile(filename, `${JSON.stringify(object, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { output: path.resolve(filename) };
}

async function main() {
  const { command, options } = parse(process.argv.slice(2));
  const json = async (filename) => JSON.parse(await readFile(filename, "utf8"));
  if (command === "help") { process.stdout.write(help); return; }
  let result;
  if (command === "manifest") {
    const relative = path.relative(path.resolve(options.source), path.resolve(options.output));
    if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) throw new Error("Write the manifest outside the source artifact directory");
    const manifest = await createManifest(options.source, options.release);
    result = { ...await writeJson(options.output, manifest), ...manifest, files: manifest.files.length };
  } else if (command === "verify") result = await verifyArtifact(options.source, await json(options.manifest));
  else if (["stage", "publish"].includes(command)) result = await (command === "stage" ? stageRelease : publishRelease)({ ...options, manifest: await json(options.manifest) });
  else if (["activate", "rollback"].includes(command)) result = await activateRelease(options);
  else if (command === "status") result = { current: await currentRelease(options.root), releases: (await listReleases(options.root)).map(({ release, artifactSha256 }) => ({ release, artifactSha256 })) };
  else if (command === "caddy") {
    const output = transformCaddyConfig(await json(options.config), {
      serverName: options.server, upstreamDial: options.upstream, root: options.root,
      manifest: await json(options.manifest), retainedManifests: options.retained ? await json(options.retained) : []
    });
    result = await writeJson(options.output, output);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, command, ...result })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
});
