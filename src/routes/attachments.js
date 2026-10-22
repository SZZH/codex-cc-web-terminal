import fs from "node:fs";

import { MAX_IMAGE_BYTES, readImageUpload, readUploadedImage, saveUploadedImage } from "../sessions/shared/imageAttachments.js";

export async function handleAttachmentRoute(ctx, runtime) {
  const prefix = "/api/attachments/images";
  if (ctx.path !== prefix && !ctx.path.startsWith(`${prefix}/`)) {
    return false;
  }
  if (!runtime.requireAuthorized(ctx)) {
    return true;
  }
  if (ctx.path === prefix && ctx.method === "POST") {
    if (runtime.forbidCrossOrigin(ctx)) {
      return true;
    }
    try {
      const length = Number(ctx.get("content-length"));
      if (length > MAX_IMAGE_BYTES) {
        ctx.req.resume();
        runtime.json(ctx, 413, { error: "Image exceeds the 20 MiB limit." });
        return true;
      }
      const buffer = await readImageUpload(ctx.req);
      const attachment = saveUploadedImage(runtime.config, buffer, {
        type: ctx.get("content-type"),
        name: decodeURIComponent(ctx.get("x-file-name") || "image")
      });
      runtime.json(ctx, 201, { attachment });
    } catch (error) {
      runtime.json(ctx, error.statusCode || 400, { error: error?.message || String(error) });
    }
    return true;
  }
  if (ctx.method === "GET" && ctx.path.startsWith(`${prefix}/`)) {
    try {
      const image = readUploadedImage(runtime.config, ctx.path.slice(prefix.length + 1));
      ctx.status = 200;
      ctx.type = image.type;
      ctx.length = image.size;
      ctx.set("Content-Disposition", `inline; filename="${image.id}"`);
      ctx.body = fs.createReadStream(image.path);
    } catch (error) {
      runtime.json(ctx, error.statusCode || 400, { error: error?.message || String(error) });
    }
    return true;
  }
  runtime.json(ctx, 404, { error: "Not Found" });
  return true;
}
