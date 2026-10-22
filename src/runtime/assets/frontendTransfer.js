import fs from "node:fs";
import path from "node:path";

const fingerprintedName = /-[\w-]{8,}\.[a-z0-9]+$/i;

export function isFingerprintedAsset(filePath, frontendDir) {
  const relative = path.relative(path.join(frontendDir, "assets"), filePath);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
    && fingerprintedName.test(path.basename(filePath));
}

function statFile(filePath) {
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  return stat?.isFile() ? stat : null;
}

function signature(stat) {
  return [stat.size, stat.mtimeMs, stat.ctimeMs].map((value) => value.toString(16)).join("-");
}

export function serveFingerprintedAsset(ctx, runtime, filePath, contentType) {
  const sourceStat = statFile(filePath);
  if (!sourceStat) return false;
  const representations = new Map();
  for (const [encoding, suffix] of [["br", ".br"], ["gzip", ".gz"]]) {
    const encodedPath = `${filePath}${suffix}`;
    const stat = statFile(encodedPath);
    // Sides are written after their source; an updated source invalidates old sides.
    if (stat && stat.mtimeMs >= sourceStat.mtimeMs && stat.ctimeMs >= sourceStat.ctimeMs) {
      representations.set(encoding, { filePath: encodedPath, stat });
    }
  }
  representations.set("identity", { filePath, stat: sourceStat });
  const encoding = ctx.acceptsEncodings(...representations.keys());
  ctx.vary("Accept-Encoding");
  if (!encoding) {
    runtime.json(ctx, 406, { error: "No acceptable content encoding" });
    return true;
  }

  const representation = representations.get(encoding);
  ctx.status = 200;
  ctx.set(runtime.responseHeaders({ "Cache-Control": "public, max-age=31536000, immutable" }));
  ctx.type = contentType;
  ctx.etag = `W/"${encoding}-${signature(sourceStat)}-${signature(representation.stat)}"`;
  ctx.lastModified = new Date(Math.max(sourceStat.mtimeMs, representation.stat.mtimeMs));
  if (encoding !== "identity") ctx.set("Content-Encoding", encoding);
  if (ctx.fresh) {
    ctx.status = 304;
    ctx.body = null;
    return true;
  }
  ctx.body = ctx.method === "HEAD" ? "" : fs.createReadStream(representation.filePath);
  ctx.length = representation.stat.size;
  return true;
}
