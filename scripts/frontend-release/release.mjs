import path from "node:path";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { directoryRoot, ensureDirectory, readSafeFile, releaseId } from "./paths.mjs";
import { sha256, validateManifest, verifyArtifact } from "./manifest.mjs";

async function exists(filename) {
  try { return await lstat(filename); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function withLock(rootPath, action) {
  const root = await directoryRoot(rootPath, { create: true });
  const lock = path.join(root, ".publish-lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("Release operation already locked; inspect an interrupted operation before removing .publish-lock");
    throw error;
  }
  try { return await action(root); }
  finally { await rm(lock, { recursive: true }); }
}

async function verifyShared(root, manifest) {
  for (const file of manifest.files.filter((entry) => entry.immutable)) {
    const bytes = await readSafeFile(root, `shared/files/${file.path}`);
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new Error(`Shared immutable checksum mismatch: ${file.path}`);
  }
}

export async function readRelease(rootPath, release) {
  const root = await directoryRoot(rootPath);
  const manifest = validateManifest(JSON.parse(await readSafeFile(root, `releases/${releaseId(release)}/manifest.json`)));
  if (manifest.release !== release) throw new Error("Release directory and manifest ID differ");
  return manifest;
}

export async function listReleases(rootPath) {
  const root = await directoryRoot(rootPath);
  const releasesDir = path.join(root, "releases");
  if (!await exists(releasesDir)) return [];
  await directoryRoot(releasesDir);
  const manifests = [];
  for (const name of (await readdir(releasesDir)).sort()) manifests.push(await readRelease(root, name));
  return manifests;
}

export async function currentRelease(rootPath) {
  const root = await directoryRoot(rootPath);
  const current = path.join(root, "current");
  const stat = await exists(current);
  if (!stat) return null;
  if (!stat.isSymbolicLink()) throw new Error("current must be a release symlink");
  const target = await readlink(current);
  if (!/^releases\/[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(target)) throw new Error("Unsafe current release pointer");
  return releaseId(target.slice("releases/".length));
}

async function stage(root, source, manifest) {
  await verifyArtifact(source, manifest);
  await ensureDirectory(root, "releases");
  await ensureDirectory(root, "staging");
  await ensureDirectory(root, "shared/files");
  const releaseDir = path.join(root, "releases", manifest.release);
  if (await exists(releaseDir)) {
    const previous = await readRelease(root, manifest.release);
    if (previous.artifactSha256 !== manifest.artifactSha256) throw new Error(`Release ID already contains different artifacts: ${manifest.release}`);
    await verifyArtifact(path.join(releaseDir, "files"), manifest);
    await verifyShared(root, manifest);
    return { release: manifest.release, reused: true };
  }
  const relative = `staging/${manifest.release}-${randomUUID()}`;
  const staging = await ensureDirectory(root, relative);
  await ensureDirectory(staging, "files");
  try {
    for (const file of manifest.files) {
      const parent = path.posix.dirname(file.path);
      if (parent !== ".") await ensureDirectory(staging, `files/${parent}`);
      const bytes = await readSafeFile(await directoryRoot(source), file.path);
      await writeFile(path.join(staging, "files", file.path), bytes, { flag: "wx", mode: 0o644 });
      await chmod(path.join(staging, "files", file.path), 0o644);
    }
    await verifyArtifact(path.join(staging, "files"), manifest);
    for (const file of manifest.files.filter((entry) => entry.immutable)) {
      const parent = path.posix.dirname(file.path);
      await ensureDirectory(root, `shared/files/${parent}`);
      const destination = path.join(root, "shared/files", file.path);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await copyFile(path.join(staging, "files", file.path), temporary, constants.COPYFILE_EXCL);
        try { await link(temporary, destination); }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          const existing = await readSafeFile(root, `shared/files/${file.path}`);
          if (existing.length !== file.size || sha256(existing) !== file.sha256) throw new Error(`Immutable asset conflict: ${file.path}`);
        }
      } finally { await rm(temporary, { force: true }); }
    }
    await verifyShared(root, manifest);
    await writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    await rename(staging, releaseDir);
    return { release: manifest.release, reused: false };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

async function activate(root, release) {
  const manifest = await readRelease(root, release);
  await verifyArtifact(path.join(root, "releases", release, "files"), manifest);
  await verifyShared(root, manifest);
  const previousRelease = await currentRelease(root);
  const temporary = path.join(root, `.current-${randomUUID()}`);
  try {
    await symlink(`releases/${release}`, temporary);
    await rename(temporary, path.join(root, "current"));
  } finally { await rm(temporary, { force: true }); }
  return { release, previousRelease, artifactSha256: manifest.artifactSha256 };
}

export async function stageRelease({ root, source, manifest }) {
  return withLock(root, (resolved) => stage(resolved, source, manifest));
}

export async function activateRelease({ root, release }) {
  return withLock(root, (resolved) => activate(resolved, releaseId(release)));
}

export async function publishRelease({ root, source, manifest }) {
  return withLock(root, async (resolved) => {
    await stage(resolved, source, manifest);
    return activate(resolved, manifest.release);
  });
}
