import { PassThrough, Readable, pipeline } from "node:stream";
import { createGzip } from "node:zlib";

const MIN_GZIP_BYTES = 8 * 1024;
const CHUNK_SIZE = 16 * 1024;
const activeTransfers = new WeakMap();

function* chunks(serialized) {
  for (let start = 0; start < serialized.length;) {
    let end = Math.min(start + CHUNK_SIZE, serialized.length);
    // Let Node encode whole surrogate pairs even at a chunk boundary.
    const last = serialized.charCodeAt(end - 1);
    if (end < serialized.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    yield serialized.slice(start, end);
    start = end;
  }
}

export function readJsonTransfer(ctx, runtime, { createGzipStream = createGzip } = {}) {
  if (typeof ctx.body !== "string") return;
  if (ctx.res.destroyed || ctx.res.writableEnded) return;
  ctx.vary("Accept-Encoding");
  const encoding = ctx.acceptsEncodings("gzip", "identity");
  const identity = ctx.acceptsEncodings("identity");
  if (!encoding) {
    runtime.json(ctx, 406, { error: "No acceptable content encoding", code: "encoding_not_acceptable" });
    return;
  }
  if (encoding !== "gzip" || (identity && Buffer.byteLength(ctx.body) < MIN_GZIP_BYTES)) return;
  if ((activeTransfers.get(runtime) || 0) >= 2) {
    if (!identity) runtime.json(ctx, 503, { error: "History compression is busy", code: "history_transfer_busy", retryable: true }, { "Retry-After": "1" });
    return;
  }

  activeTransfers.set(runtime, (activeTransfers.get(runtime) || 0) + 1);
  let released = false;
  let cancelled = false;
  let source, compressor, encoded, output;
  const release = () => {
    if (released) return;
    released = true;
    activeTransfers.set(runtime, activeTransfers.get(runtime) - 1);
  };
  const cancel = () => {
    cancelled = true;
    encoded?.unpipe(output);
    for (const stream of [source, compressor, encoded, output]) stream?.destroy();
    release();
  };
  try {
    source = Readable.from(chunks(ctx.body), { objectMode: false, highWaterMark: CHUNK_SIZE });
    compressor = createGzipStream({ level: 1, chunkSize: CHUNK_SIZE, highWaterMark: CHUNK_SIZE });
    encoded = new PassThrough({ highWaterMark: CHUNK_SIZE });
    output = new PassThrough({ highWaterMark: CHUNK_SIZE });
    // Isolate Koa's body from pipeline cancellation errors on a closed response.
    encoded.pipe(output);
    ctx.body = output;
    ctx.remove("Content-Length");
    ctx.set("Content-Encoding", "gzip");
    ctx.res.once("close", cancel);
    pipeline(source, compressor, encoded, (error) => {
      release();
      if (!error || cancelled) return;
      error.headers = runtime.responseHeaders();
      output.destroy(error);
      if (ctx.headerSent) ctx.res.destroy();
    });
  } catch (error) {
    cancel();
    ctx.res.removeListener("close", cancel);
    ctx.remove("Content-Encoding");
    error.status = 500;
    throw error;
  }
}
