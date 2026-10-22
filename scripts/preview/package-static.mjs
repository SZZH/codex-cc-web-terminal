#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PDFJS_VERSION, PDFJS_BUILD_FILES } from "./restore-pdfjs.mjs";

export const PUBLIC_DIRECTORIES = Object.freeze(["js", "css", "bootstrap", "pdfjs", "fonts"]);
const sourceCommit = "3b82689a676e8a7e7d3ec4cc0c74de0676b0dac9";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const VIEWER_CACHE_VERSION = `${PDFJS_VERSION}-1`;
export const versionViewerReferences = (html) => html.replace(/\b(src|href)="([^"?:]+\.(?:mjs|css))"/g,
  (_, attribute, resource) => `${attribute}="${resource}?v=${VIEWER_CACHE_VERSION}"`);

export function assertPublicPath(relative) {
  if (relative.includes("\\") || path.posix.normalize(relative) !== relative || relative.startsWith("/") ||
      !PUBLIC_DIRECTORIES.includes(relative.split("/")[0]) || relative.split("/").length < 2) {
    throw new Error(`Not an allowed public asset path: ${relative}`);
  }
  return relative;
}

export function packageStatic(runtimePath) {
  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
  if (runtime.kkVersion !== "5.0.3") throw new Error("Only the pinned kkFileView 5.0.3 resources are supported");
  const directory = path.dirname(runtimePath);
  const source = path.resolve(path.dirname(runtime.defaultsPath), "../resources/static");
  const sourceManifest = JSON.parse(fs.readFileSync(path.join(directory, "source-manifest.json"), "utf8"));
  if (sourceManifest.commit !== sourceCommit) throw new Error("Unexpected source manifest commit");
  const trusted = new Map(sourceManifest.files.map((file) => [file.path, file.sha256]));
  const output = fs.mkdtempSync(path.join(directory, ".static-assets-"));
  const files = [];
  const add = (relative, bytes, expected) => {
    assertPublicPath(relative);
    if (!expected || digest(bytes) !== expected) throw new Error(`Source checksum mismatch: ${relative}`);
    if (relative === "pdfjs/web/viewer.html") bytes = Buffer.from(versionViewerReferences(bytes.toString("utf8")));
    const sha256 = digest(bytes);
    const destination = path.join(output, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
    fs.writeFileSync(destination, bytes, { mode: 0o644 });
    files.push({ path: relative, bytes: bytes.length, sha256 });
  };
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(source, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Static asset symlinks are not allowed: ${name}`);
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) add(name, fs.readFileSync(path.join(source, name)), trusted.get(`server/src/main/resources/static/${name}`));
    }
  };
  try {
    for (const name of PUBLIC_DIRECTORIES) if (fs.existsSync(path.join(source, name))) walk(name);
    for (const [name, sha256] of Object.entries(PDFJS_BUILD_FILES)) {
      const relative = `pdfjs/build/${name}`;
      const result = spawnSync("unzip", ["-p", runtime.jarPath, `BOOT-INF/classes/static/${relative}`], { maxBuffer: 8 * 1024 * 1024, timeout: 20_000 });
      if (result.error || result.status !== 0) throw new Error(`Missing patched PDF.js build: ${name}`);
      add(relative, result.stdout, sha256);
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    const manifest = { schemaVersion: 1, kkFileViewVersion: runtime.kkVersion, pdfjsVersion: PDFJS_VERSION, viewerCacheVersion: VIEWER_CACHE_VERSION, sourceCommit,
      directories: PUBLIC_DIRECTORIES.filter((name) => files.some((file) => file.path.startsWith(`${name}/`))), files };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(path.join(output, "manifest.json"), manifestBytes, { mode: 0o644 });
    const archive = path.join(directory, `preview-static-5.0.3-pdfjs-${PDFJS_VERSION}.tar.gz`);
    const result = spawnSync("tar", ["-czf", archive, "-C", output, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" }, encoding: "utf8", timeout: 60_000 });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
    return { archive, archiveBytes: fs.statSync(archive).size, archiveSha256: digest(fs.readFileSync(archive)), manifestSha256: digest(manifestBytes),
      fileCount: files.length, assetBytes: files.reduce((sum, file) => sum + file.bytes, 0), directories: manifest.directories,
      kkFileViewVersion: runtime.kkVersion, pdfjsVersion: PDFJS_VERSION };
  } finally { fs.rmSync(output, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--runtime")) throw new Error("Use --runtime /absolute/runtime.json");
  const runtimePath = path.resolve(args[1] || path.join(os.homedir(), ".local/share/codex-cc-web-terminal/preview-runtime/runtime.json"));
  try { process.stdout.write(`${JSON.stringify(packageStatic(runtimePath), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
