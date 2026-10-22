import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isFingerprintedAsset, serveFingerprintedAsset } from "./frontendTransfer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "..", "..", "public");
const webDistDir = path.join(__dirname, "..", "..", "..", "web", "dist");

export function installAssetRuntime(runtime, { frontendDir = webDistDir, fallbackDir = publicDir } = {}) {
  runtime.serveFile = (ctx, filePath, contentType) => {
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      ctx.status = 404;
      ctx.body = "Not found";
      return;
    }
    ctx.status = 200;
    ctx.set(runtime.responseHeaders());
    ctx.type = contentType;
    ctx.body = ctx.method === "HEAD" ? "" : fs.createReadStream(filePath);
    ctx.length = stat.size;
  };

  runtime.frontendRootDir = () => frontendDir;

  runtime.resolveAsset = (rootDir, pathname) => {
    const normalizedPath = pathname === "/" ? "/index.html" : pathname;
    const resolvedPath = path.resolve(rootDir, `.${normalizedPath}`);
    const relative = path.relative(rootDir, resolvedPath);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      return null;
    }
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
      return null;
    }
    return resolvedPath;
  };

  runtime.contentTypeForFile = (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case ".html":
        return "text/html; charset=utf-8";
      case ".js":
        return "application/javascript; charset=utf-8";
      case ".css":
        return "text/css; charset=utf-8";
      case ".json":
        return "application/json; charset=utf-8";
      case ".svg":
        return "image/svg+xml";
      case ".png":
        return "image/png";
      case ".jpg":
      case ".jpeg":
        return "image/jpeg";
      case ".webp":
        return "image/webp";
      case ".gif":
        return "image/gif";
      case ".woff":
        return "font/woff";
      case ".woff2":
        return "font/woff2";
      default:
        return "application/octet-stream";
    }
  };

  runtime.tryServeFrontendAsset = (ctx, pathname) => {
    if (/\.(?:gz|br)$/i.test(pathname)) return false;
    for (const rootDir of [runtime.frontendRootDir(), fallbackDir]) {
      const filePath = runtime.resolveAsset(rootDir, pathname);
      if (!filePath) {
        continue;
      }
      const contentType = runtime.contentTypeForFile(filePath);
      if (rootDir === runtime.frontendRootDir() && isFingerprintedAsset(filePath, rootDir)) {
        if (!serveFingerprintedAsset(ctx, runtime, filePath, contentType)) continue;
      } else {
        runtime.serveFile(ctx, filePath, contentType);
      }
      return true;
    }
    return false;
  };

  runtime.serveFrontendIndex = (ctx) => {
    const filePath = path.join(runtime.frontendRootDir(), "index.html");
    if (!fs.existsSync(filePath)) {
      runtime.json(ctx, 503, { error: "Frontend assets are missing. Run `npm run web:build` first." });
      return;
    }
    runtime.serveFile(ctx, filePath, "text/html; charset=utf-8");
  };
}
