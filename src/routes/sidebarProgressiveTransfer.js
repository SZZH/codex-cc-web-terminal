import { PassThrough } from "node:stream";
import { constants, createBrotliCompress, createGzip } from "node:zlib";

const activeTransfers = new WeakMap();

function createEncoder(encoding) {
  if (encoding === "br") return createBrotliCompress({ params: {
    [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
    [constants.BROTLI_PARAM_QUALITY]: 5
  } });
  return encoding === "gzip" ? createGzip() : new PassThrough();
}

function encodeOperation(encoder, operation) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      encoder.off("error", finish);
      encoder.off("close", closed);
      error ? reject(error) : resolve();
    };
    const closed = () => finish(new Error("Sidebar transfer closed"));
    encoder.once("error", finish);
    encoder.once("close", closed);
    try { operation(finish); } catch (error) { finish(error); }
  });
}

export function trySendSidebarProgressiveResponse(ctx, runtime, frames, encoding, { createEncoder: encoderFactory = createEncoder } = {}) {
  const { bootstrapLine, completeLine } = frames;
  const active = activeTransfers.get(runtime) || 0;
  if (active >= 2) return false;
  activeTransfers.set(runtime, active + 1);
  let encoder;
  try {
    encoder = encoderFactory(encoding);
  } catch (error) {
    activeTransfers.set(runtime, active);
    throw error;
  }
  const output = new PassThrough();
  let stopped = false;
  let immediate;
  let resumeTick;
  const stop = (error) => {
    if (stopped) return;
    stopped = true;
    activeTransfers.set(runtime, (activeTransfers.get(runtime) || 1) - 1);
    ctx.req.off("aborted", cancelled);
    ctx.res.off("close", cancelled);
    ctx.res.off("finish", cancelled);
    encoder.off("error", failed);
    output.off("error", cancelled);
    output.off("close", outputClosed);
    clearImmediate(immediate);
    resumeTick?.();
    encoder.unpipe(output);
    encoder.destroy();
    if (error && !ctx.res.headersSent) error.headers = runtime.responseHeaders({ "Cache-Control": "no-store" });
    output.destroy(error);
    if (error && ctx.res.headersSent) ctx.res.destroy();
  };
  const cancelled = () => stop();
  const failed = (error) => stop(error);
  const outputClosed = () => { if (!output.readableEnded) stop(); };
  ctx.req.once("aborted", cancelled);
  ctx.res.once("close", cancelled);
  ctx.res.once("finish", cancelled);
  encoder.on("error", failed);
  output.on("error", cancelled);
  output.once("close", outputClosed);
  encoder.pipe(output);
  ctx.status = 200;
  ctx.type = "application/x-ndjson; charset=utf-8";
  ctx.set("Cache-Control", "private, no-store");
  if (encoding !== "identity") ctx.set("Content-Encoding", encoding);
  ctx.body = output;
  ctx.remove("Content-Length");

  immediate = setImmediate(async () => {
    try {
      if (stopped) return;
      await encodeOperation(encoder, (done) => encoder.write(bootstrapLine, done));
      if (stopped) return;
      if (typeof encoder.flush === "function") {
        await encodeOperation(encoder, (done) => encoder.flush(encoding === "br" ? constants.BROTLI_OPERATION_FLUSH : constants.Z_SYNC_FLUSH, done));
      }
      if (stopped) return;
      await new Promise((resolve) => { resumeTick = resolve; immediate = setImmediate(resolve); });
      resumeTick = null;
      if (stopped) return;
      const complete = Buffer.from(completeLine);
      for (let offset = 0; offset < complete.length && !stopped; offset += 16384) {
        await encodeOperation(encoder, (done) => encoder.write(complete.subarray(offset, offset + 16384), done));
      }
      if (!stopped) encoder.end();
    } catch (error) {
      if (!stopped) stop(error);
    }
  });
  return true;
}
