import path from "node:path";
import { createHash } from "node:crypto";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { directoryRoot, fileMetadata, readSafeFile, releaseContract, releaseId, safePath, walkFiles } from "./paths.mjs";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const filesDigest = (files) => sha256(JSON.stringify(files));

export function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== releaseContract.schemaVersion || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error("Invalid release manifest");
  releaseId(manifest.release);
  const seen = new Set();
  for (const file of manifest.files) {
    if (!file || Object.keys(file).length !== releaseContract.fileFields.length || releaseContract.fileFields.some((key) => !Object.hasOwn(file, key))) throw new Error("Invalid manifest file fields");
    safePath(file.path);
    if (seen.has(file.path)) throw new Error(`Duplicate manifest path: ${file.path}`);
    seen.add(file.path);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || typeof file.sha256 !== "string" || file.sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`Invalid checksum metadata: ${file.path}`);
    const expected = fileMetadata(file.path);
    for (const key of ["contentType", "encoding", "immutable"]) {
      if (file[key] !== expected[key]) throw new Error(`Invalid ${key}: ${file.path}`);
    }
  }
  if (!seen.has("index.html")) throw new Error("Missing index.html");
  for (const file of manifest.files.filter((entry) => entry.encoding)) {
    if (!seen.has(file.path.slice(0, -3))) throw new Error(`Missing original for compressed asset: ${file.path}`);
  }
  if (manifest.artifactSha256 !== filesDigest(manifest.files)) throw new Error("Manifest checksum mismatch");
  return manifest;
}

function dependencies(filename, bytes) {
  const text = bytes.toString("utf8");
  const refs = [];
  if (filename.endsWith(".html")) {
    for (const match of text.matchAll(/<(?:script|link|img)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) refs.push(match[1]);
  } else if (filename.endsWith(".css")) {
    for (const match of text.matchAll(/(?:url\(\s*|@import\s+)["']?([^\s"')]+)["']?\s*\)?/g)) refs.push(match[1]);
  } else if (/\.(?:m?js)$/.test(filename)) {
    for (const match of text.matchAll(/\b(?:import|export)\s*(?:[^;"']*?\s+from\s*)?\(?\s*["']([^"']+)["']/g)) refs.push(match[1]);
    for (const match of text.matchAll(/["'](\/?assets\/[^"'\s]+)["']/g)) refs.push(match[1].startsWith("/") ? match[1] : `/${match[1]}`);
  }
  return refs.filter((ref) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref));
}

function verifyContents(manifest, contents) {
  for (const file of manifest.files) {
    const bytes = contents.get(file.path);
    if (file.encoding) {
      const original = contents.get(file.path.slice(0, -3));
      const decode = file.encoding === "br" ? brotliDecompressSync : gunzipSync;
      if (!decode(bytes, { maxOutputLength: Math.max(original.length + 1, 1) }).equals(original)) throw new Error(`Compressed content mismatch: ${file.path}`);
      continue;
    }
    for (const reference of dependencies(file.path, bytes)) {
      const pathname = reference.split(/[?#]/, 1)[0];
      if (!pathname) continue;
      const resolved = path.posix.normalize(pathname.startsWith("/") ? pathname.slice(1) : path.posix.join(path.posix.dirname(file.path), pathname));
      safePath(resolved);
      if (!contents.has(resolved)) throw new Error(`Missing build dependency: ${file.path} -> ${reference}`);
    }
  }
}

export async function createManifest(source, release) {
  const root = await directoryRoot(source);
  const files = [];
  for (const filename of await walkFiles(root)) {
    const bytes = await readSafeFile(root, filename);
    files.push({ path: filename, size: bytes.length, sha256: sha256(bytes), ...fileMetadata(filename) });
  }
  const manifest = { schemaVersion: 1, release: releaseId(release), artifactSha256: filesDigest(files), files };
  await verifyArtifact(root, manifest);
  return manifest;
}

export async function verifyArtifact(source, manifest) {
  validateManifest(manifest);
  const root = await directoryRoot(source);
  const actual = (await walkFiles(root)).sort();
  const expected = manifest.files.map((file) => file.path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Artifact file list differs from manifest");
  const contents = new Map();
  for (const file of manifest.files) {
    const bytes = await readSafeFile(root, file.path);
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new Error(`Artifact checksum mismatch: ${file.path}`);
    contents.set(file.path, bytes);
  }
  verifyContents(manifest, contents);
  return { release: manifest.release, artifactSha256: manifest.artifactSha256, fileCount: expected.length };
}
