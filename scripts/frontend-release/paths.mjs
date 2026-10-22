import path from "node:path";
import { constants, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";

export const releaseContract = JSON.parse(readFileSync(new URL("./contract.json", import.meta.url), "utf8"));
const patterns = Object.fromEntries(["release", "segment", "immutable"].map((key) => [key, new RegExp(releaseContract[`${key}Pattern`])]));
const fullMatch = (pattern, value) => pattern.exec(value)?.[0] === value;

export function releaseId(value) {
  if (typeof value !== "string" || !fullMatch(patterns.release, value)) throw new Error("Invalid release ID");
  return value;
}

export function safePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/")
      || value.split("/").some((part) => !fullMatch(patterns.segment, part))) {
    throw new Error(`Unsafe artifact path: ${value}`);
  }
  return value;
}

export function fileMetadata(filename) {
  safePath(filename);
  const encoding = filename.endsWith(".br") ? "br" : filename.endsWith(".gz") ? "gzip" : null;
  const original = encoding ? filename.slice(0, -3) : filename;
  const first = original.split("/")[0].toLowerCase();
  if (releaseContract.privateRoots.includes(first)
      || (original.includes("/") && !releaseContract.publicDirectories.some((folder) => original.startsWith(`${folder}/`)))) {
    throw new Error(`Not a public build artifact: ${filename}`);
  }
  const contentType = releaseContract.contentTypes[path.posix.extname(original).toLowerCase()];
  if (!contentType || (original.toLowerCase().endsWith(".html") && original !== "index.html")) throw new Error(`Unsupported public artifact: ${filename}`);
  const immutable = fullMatch(patterns.immutable, original);
  return { contentType, encoding, immutable };
}

export async function directoryRoot(value, { create = false } = {}) {
  const absolute = path.resolve(value);
  if (create) {
    const created = await mkdir(absolute, { recursive: true, mode: 0o755 });
    if (created) await chmod(absolute, 0o755);
  }
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected real directory: ${absolute}`);
  return realpath(absolute);
}

export async function ensureDirectory(root, relative) {
  safePath(relative);
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    let created = true;
    await mkdir(current, { mode: 0o755 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
      created = false;
    });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe directory: ${current}`);
    if (created) await chmod(current, 0o755);
  }
  return current;
}

export async function readSafeFile(root, relative) {
  safePath(relative);
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are forbidden: ${relative}`);
  }
  const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Not a regular file: ${relative}`);
    return await handle.readFile();
  } finally { await handle.close(); }
}

export async function walkFiles(root, prefix = "") {
  const files = [];
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const relative = safePath(prefix ? `${prefix}/${entry.name}` : entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are forbidden: ${relative}`);
    if (entry.isDirectory()) files.push(...await walkFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Not a regular file: ${relative}`);
  }
  return files;
}
