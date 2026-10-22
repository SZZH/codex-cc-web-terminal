#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const FONT_VERSION = "2.004";
const url = "https://github.com/notofonts/noto-cjk/releases/download/Sans2.004/18_NotoSansSC.zip";
const archiveHash = "4d107c09ada479d3e48b6e78c83835773cbd9214bf6e12cdb7b60f8e068292ec";
const checksums = {
  "NotoSansSC-Regular.otf": "faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9",
  "NotoSansSC-Bold.otf": "c6cb5a93abaa9edc8ee7463b7ebb7f42d618d40e6ed2f7a5371c97b0b64767c0",
  "LICENSE": "6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2"
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function fontDirectory(runtimePath, officeHome) {
  const root = path.dirname(path.resolve(runtimePath));
  if (!path.isAbsolute(officeHome) || /[\r\n\0]/.test(officeHome)) throw new Error("officeHome must be an absolute path");
  const relative = path.relative(root, path.resolve(officeHome));
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("Fonts may only be installed in LibreOffice inside the isolated preview runtime");
  }
  return path.join(path.resolve(officeHome), "Resources/fonts/truetype");
}

export function verifyFontArchive(bytes) {
  if (bytes.length !== 50077940 || hash(bytes) !== archiveHash) throw new Error("Pinned Noto Sans SC 2.004 archive checksum mismatch");
}

export async function installFonts(runtimePath) {
  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
  const root = fs.realpathSync(path.dirname(runtimePath));
  // Resolve existing paths so an application symlink cannot redirect writes to global fonts.
  const destination = fontDirectory(path.join(root, "runtime.json"), fs.realpathSync(runtime.officeHome));
  if (!fs.realpathSync(destination).startsWith(`${root}${path.sep}`)) throw new Error("Font directory escapes the isolated preview runtime");
  const archive = path.join(root, "downloads", "18_NotoSansSC-2.004.zip");
  fs.mkdirSync(path.dirname(archive), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(archive)) {
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`Noto download failed: ${response.status}`);
    const parts = [];
    let size = 0;
    for await (const bytes of response.body) {
      size += bytes.length;
      if (size > 51000000) throw new Error("Noto archive exceeds its pinned download size");
      parts.push(bytes);
    }
    const bytes = Buffer.concat(parts);
    verifyFontArchive(bytes);
    fs.writeFileSync(archive, bytes, { mode: 0o600 });
  }
  verifyFontArchive(fs.readFileSync(archive));
  const assets = Object.entries(checksums).map(([name, expected]) => {
    const result = spawnSync("unzip", ["-p", archive, name], { maxBuffer: 20 * 1024 * 1024, timeout: 20_000 });
    if (result.error || result.status !== 0 || hash(result.stdout) !== expected) throw new Error(`Noto file checksum mismatch: ${name}`);
    return { name: name === "LICENSE" ? "NotoSansSC-OFL.txt" : name, bytes: result.stdout, sha256: expected };
  });
  const changed = [];
  for (const asset of assets) {
    const target = path.join(destination, asset.name);
    if (fs.existsSync(target) && hash(fs.readFileSync(target)) === asset.sha256) continue;
    if (fs.existsSync(target) && !fs.existsSync(`${target}.before-${FONT_VERSION}`)) fs.copyFileSync(target, `${target}.before-${FONT_VERSION}`);
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, asset.bytes, { mode: 0o644 });
    fs.renameSync(temporary, target);
    changed.push(asset.name);
  }
  const report = { version: FONT_VERSION, family: "Noto Sans SC", source: url, archiveSha256: archiveHash, destination,
    changed, files: assets.map(({ name, bytes, sha256 }) => ({ name, size: bytes.length, sha256 })),
    restartRequired: changed.length > 0, note: "Restart the managed preview service and regenerate previously cached PDFs with missing glyphs." };
  fs.writeFileSync(path.join(root, "fonts-installed.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--runtime")) throw new Error("Use --runtime /absolute/runtime.json");
  const runtimePath = path.resolve(args[1] || path.join(os.homedir(), ".local/share/codex-cc-web-terminal/preview-runtime/runtime.json"));
  installFonts(runtimePath).then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
