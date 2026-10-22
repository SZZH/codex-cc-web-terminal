import { createHash } from "node:crypto";
import { isDeepStrictEqual, promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import { buildSidebarProgressiveFrames } from "./sidebarProgressiveFrames.js";
import { trySendSidebarProgressiveResponse } from "./sidebarProgressiveTransfer.js";

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);
const latestResponses = new WeakMap();

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function buildCompactSidebarPayload(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.sessions) || !Array.isArray(payload.projectGroups)
    || Object.hasOwn(payload, "sidebarFormat")) return payload;

  const sessionsById = new Map();
  for (const session of payload.sessions) {
    if (!isRecord(session) || typeof session.id !== "string" || !session.id.trim() || sessionsById.has(session.id)) return payload;
    sessionsById.set(session.id, session);
  }

  const projectGroups = [];
  for (const group of payload.projectGroups) {
    if (!isRecord(group) || !Array.isArray(group.sessions) || Object.hasOwn(group, "sessionIds")) return payload;
    const sessionIds = [];
    for (const session of group.sessions) {
      const canonical = sessionsById.get(session?.id);
      // Legacy sources can contain different versions of the same ID across groups.
      if (!canonical || !isDeepStrictEqual(session, canonical)) return payload;
      sessionIds.push(session.id);
    }
    const { sessions, ...metadata } = group;
    projectGroups.push({ ...metadata, sessionIds });
  }
  return { ...payload, sidebarFormat: "compact-v1", projectGroups };
}

function preferredEncoding(ctx) {
  const encodings = ["br", "gzip", "identity"];
  const header = ctx.get("Accept-Encoding");
  if (!header) return ctx.acceptsEncodings(...encodings);
  const priority = (entry) => {
    const index = encodings.indexOf(entry.split(";", 1)[0].trim());
    return index < 0 ? encodings.length : index;
  };
  // Koa's parser breaks quality ties by header order and recognizes lowercase q.
  const normalized = header.toLowerCase().split(",").sort((a, b) => priority(a) - priority(b)).join(",");
  const accept = new ctx.accept.constructor({ headers: { "accept-encoding": normalized } });
  return accept.encodings(...encodings);
}

function matchesEtag(header, etag) {
  const opaqueTag = etag.replace(/^W\//, "");
  return String(header || "").split(",").some((value) => {
    const tag = value.trim();
    return tag === "*" || tag.replace(/^W\//, "") === opaqueTag;
  });
}

export async function sendSidebarResponse(ctx, runtime, payload, { compact = false, progressive = false } = {}) {
  ctx.vary("Accept-Encoding");
  const encoding = preferredEncoding(ctx);
  if (!encoding) {
    runtime.json(ctx, 406, { error: "No acceptable content encoding" });
    return;
  }
  const representation = compact ? buildCompactSidebarPayload(payload) : payload;
  const serialized = `${JSON.stringify(representation)}\n`;
  let cached = latestResponses.get(runtime);
  if (!cached || cached.serialized !== serialized) {
    cached = { serialized, etag: `W/"${createHash("sha256").update(serialized).digest("base64url")}"`, compressed: new Map() };
    latestResponses.set(runtime, cached);
  }

  ctx.set(runtime.responseHeaders({ "Cache-Control": "private, no-cache", ETag: cached.etag }));
  if (matchesEtag(ctx.get("If-None-Match"), cached.etag)) {
    ctx.status = 304;
    ctx.body = null;
    return;
  }

  if (compact && progressive) {
    const frames = buildSidebarProgressiveFrames(representation, serialized);
    if (frames && trySendSidebarProgressiveResponse(ctx, runtime, frames, encoding)) return;
  }

  ctx.status = 200;
  ctx.type = "application/json; charset=utf-8";
  if (encoding !== "identity") {
    if (!cached.compressed.has(encoding)) {
      const compressed = encoding === "br" ? brotliAsync(serialized, { params: {
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_QUALITY]: 5
      } }) : gzipAsync(serialized);
      cached.compressed.set(encoding, compressed.catch((error) => {
        cached.compressed.delete(encoding);
        throw error;
      }));
    }
    ctx.body = await cached.compressed.get(encoding);
    ctx.set("Content-Encoding", encoding);
    return;
  }
  ctx.body = cached.serialized;
}
