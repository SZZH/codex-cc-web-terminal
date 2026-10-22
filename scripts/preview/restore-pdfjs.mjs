#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PDFJS_VERSION = "5.4.530";
const archiveUrl = `https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-${PDFJS_VERSION}.tgz`;
const archiveIntegrity = "r1hWsSIGGmyYUAHR26zSXkxYWLXLMd6AwqcaFYG9YUZ0GBf5GvcjJSeo512tabM4GYFhxhl5pMCmPr7Q72Rq2Q==";
export const PDFJS_BUILD_FILES = Object.freeze({
  "pdf.mjs": "3ddcda323544a59d147af4977dbf34cf7e7865595b7cd73e0ec2e31b692113f3",
  "pdf.worker.mjs": "b0c7460ae7664100305310a786ead549c21fd606239bcf05f3c07f388402dc49",
  "pdf.sandbox.mjs": "ba31d2fbd45f78f60ad83e031e9472da71295881982294abac5605cfd26fa873"
});
const files = PDFJS_BUILD_FILES;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function assertViewerVersion(text) {
  const versions = [...text.matchAll(/const viewerVersion\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]);
  if (versions.length !== 1 || versions[0] !== PDFJS_VERSION) throw new Error(`Expected the bundled PDF.js viewer ${PDFJS_VERSION}; update the pinned package before changing versions`);
  return versions[0];
}

export function verifyArchive(bytes) {
  if (createHash("sha512").update(bytes).digest("base64") !== archiveIntegrity) throw new Error("Official pdfjs-dist archive integrity mismatch");
}

function run(command, args, maxBuffer = 8 * 1024 * 1024) {
  const result = spawnSync(command, args, { maxBuffer, timeout: 60_000 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || `${command} failed: ${result.stderr?.toString().slice(0, 300)}`);
  return result.stdout;
}

export async function restorePdfjs(runtimePath) {
  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
  if (runtime.kkVersion !== "5.0.3" || !path.isAbsolute(runtime.jarPath) || !path.isAbsolute(runtime.javaBin)) throw new Error("Expected an absolute kkFileView 5.0.3 runtime");
  const prefix = "BOOT-INF/classes/static/pdfjs";
  assertViewerVersion(run("unzip", ["-p", runtime.jarPath, `${prefix}/web/viewer.mjs`]).toString());
  const directory = path.dirname(runtimePath);
  const archive = path.join(directory, "downloads", `pdfjs-dist-${PDFJS_VERSION}.tgz`);
  fs.mkdirSync(path.dirname(archive), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(archive)) {
    const response = await fetch(archiveUrl, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Pinned pdfjs-dist download failed: ${response.status}`);
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 20 * 1024 * 1024) throw new Error("pdfjs-dist archive exceeds the expected download bound");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    verifyArchive(bytes);
    fs.writeFileSync(archive, bytes, { mode: 0o600 });
  }
  verifyArchive(fs.readFileSync(archive));
  const metadata = JSON.parse(run("tar", ["-xOzf", archive, "package/package.json"]).toString());
  if (metadata.name !== "pdfjs-dist" || metadata.version !== PDFJS_VERSION) throw new Error("Unexpected PDF.js package metadata");
  const assets = new Map();
  // The compatibility build uses the same API/worker version and supports the bundled legacy viewer.
  for (const [name, checksum] of Object.entries(files)) {
    const bytes = run("tar", ["-xOzf", archive, `package/legacy/build/${name}`]);
    if (hash(bytes) !== checksum) throw new Error(`Unexpected PDF.js build file: ${name}`);
    assets.set(name, bytes);
  }
  const entries = run("unzip", ["-Z1", runtime.jarPath]).toString().split("\n");
  if ([...assets].every(([name]) => entries.includes(`${prefix}/build/${name}`) &&
      hash(run("unzip", ["-p", runtime.jarPath, `${prefix}/build/${name}`])) === files[name])) {
    return { changed: false, pdfjsVersion: PDFJS_VERSION, jarPath: runtime.jarPath };
  }
  const stage = fs.mkdtempSync(path.join(directory, ".pdfjs-repair-"));
  const replacement = path.join(path.dirname(runtime.jarPath), `.pdfjs-${process.pid}.jar`);
  const backup = `${runtime.jarPath}.before-pdfjs-${PDFJS_VERSION}`;
  try {
    for (const [name, bytes] of assets) {
      const target = path.join(stage, prefix, "build", name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
    }
    if (!fs.existsSync(backup)) fs.copyFileSync(runtime.jarPath, backup, fs.constants.COPYFILE_FICLONE);
    fs.copyFileSync(runtime.jarPath, replacement, fs.constants.COPYFILE_FICLONE);
    run(path.join(path.dirname(runtime.javaBin), "jar"), ["--update", "--file", replacement, "-C", stage, `${prefix}/build`]);
    for (const [name, checksum] of Object.entries(files)) {
      if (hash(run("unzip", ["-p", replacement, `${prefix}/build/${name}`])) !== checksum) throw new Error(`JAR validation failed for ${name}`);
    }
    fs.renameSync(replacement, runtime.jarPath);
    const report = { changed: true, pdfjsVersion: PDFJS_VERSION, packageUrl: archiveUrl, integrity: `sha512-${archiveIntegrity}`,
      files, jarPath: runtime.jarPath, backup, restartRequired: true };
    fs.writeFileSync(path.join(directory, "pdfjs-repair.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    return report;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(replacement, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--runtime")) throw new Error("Use --runtime /absolute/runtime.json");
  const runtimePath = path.resolve(args[1] || path.join(os.homedir(), ".local/share/codex-cc-web-terminal/preview-runtime/runtime.json"));
  restorePdfjs(runtimePath).then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
