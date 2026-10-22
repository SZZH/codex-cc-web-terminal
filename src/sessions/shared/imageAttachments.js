import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGES_PER_INPUT = 6;

const IMAGE_EXTENSIONS = Object.freeze({ "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" });
const IMAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function attachmentError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function detectImageType(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.toString("ascii", 12, 16) === "IHDR") {
    return "image/png";
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 12 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) {
    return "image/gif";
  }
  if (buffer.length >= 16 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(buffer.toString("ascii", 12, 16))) {
    return "image/webp";
  }
  return "";
}

export function readImageUpload(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const fail = (error) => {
      cleanup();
      chunks.length = 0;
      req.resume();
      reject(error);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) {
        fail(attachmentError("Image exceeds the 20 MiB limit.", 413));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error) => fail(error);
    const onAborted = () => fail(attachmentError("Image upload was interrupted."));
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}

function imageDirectory(config) {
  return path.resolve(config.dataDir, "uploads", "images");
}

export function normalizeImageAttachmentReferences(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length > MAX_IMAGES_PER_INPUT) {
    throw attachmentError(`Each message supports at most ${MAX_IMAGES_PER_INPUT} image attachments.`);
  }
  return attachments.map((attachment) => {
    const id = typeof attachment?.id === "string" ? attachment.id : "";
    if (!IMAGE_ID_PATTERN.test(id) || Object.keys(attachment).some((key) => key !== "id")) {
      throw attachmentError("Image attachments must reference an uploaded image ID only.");
    }
    return { id };
  });
}

export function saveUploadedImage(config, buffer, { type = "", name = "image" } = {}) {
  const contentType = String(type).split(";", 1)[0].trim().toLowerCase();
  if (!IMAGE_EXTENSIONS[contentType] || detectImageType(buffer) !== contentType) {
    throw attachmentError("Image content must match PNG, JPEG, WebP or GIF Content-Type.", 415);
  }
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
    throw attachmentError("Image exceeds the 20 MiB limit.", 413);
  }
  const id = crypto.randomUUID();
  const directory = imageDirectory(config);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filePath = path.join(directory, `${id}${IMAGE_EXTENSIONS[contentType]}`);
  const attachment = {
    id,
    url: `/api/attachments/images/${id}`,
    name: String(name || "image").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 255) || "image",
    type: contentType,
    size: buffer.length
  };
  fs.writeFileSync(filePath, buffer, { flag: "wx", mode: 0o600 });
  try {
    fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify(attachment), { flag: "wx", mode: 0o600 });
  } catch (error) {
    fs.unlinkSync(filePath);
    throw error;
  }
  return attachment;
}

export function readUploadedImage(config, id) {
  normalizeImageAttachmentReferences([{ id }]);
  try {
    const directory = imageDirectory(config);
    const metadataPath = path.join(directory, `${id}.json`);
    if (!fs.lstatSync(metadataPath).isFile() || fs.lstatSync(metadataPath).isSymbolicLink()) {
      throw new Error("Invalid image metadata");
    }
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    if (metadata.id !== id || !IMAGE_EXTENSIONS[metadata.type]) {
      throw new Error("Invalid image metadata");
    }
    const filePath = path.join(directory, `${id}${IMAGE_EXTENSIONS[metadata.type]}`);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== metadata.size || stat.size > MAX_IMAGE_BYTES) {
      throw new Error("Invalid image file");
    }
    const fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(32);
    let bytesRead;
    try {
      bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (detectImageType(header.subarray(0, bytesRead)) !== metadata.type) {
      throw new Error("Invalid image content");
    }
    return { ...metadata, url: `/api/attachments/images/${id}`, path: filePath };
  } catch {
    throw attachmentError("Uploaded image not found or no longer valid. Upload the image again.", 404);
  }
}

export function resolveImageAttachments(config, attachments = []) {
  return normalizeImageAttachmentReferences(attachments).map(({ id }) => readUploadedImage(config, id));
}

export function normalizeRunnerInput(input = "", images = []) {
  const structured = input && typeof input === "object";
  const rawText = String(structured ? input.text ?? "" : input ?? "");
  return {
    text: rawText,
    images: structured && Array.isArray(input.images) ? input.images : images
  };
}
