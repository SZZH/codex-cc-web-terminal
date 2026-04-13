import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "..", "..", "public");
const webDistDir = path.join(__dirname, "..", "..", "..", "web", "dist");

export function installAssetRuntime(runtime) {
  runtime.serveFile = (ctx, filePath, contentType) => {
    ctx.status = 200;
    ctx.set(runtime.responseHeaders());
    ctx.type = contentType;
    ctx.body = fs.createReadStream(filePath);
  };

  runtime.frontendRootDir = () => webDistDir;

  runtime.resolveAsset = (rootDir, pathname) => {
    const normalizedPath = pathname === "/" ? "/index.html" : pathname;
    const safePath = path.normalize(normalizedPath).replace(/^(\.\.[/\\])+/, "");
    const resolvedPath = path.join(rootDir, safePath);
    if (!resolvedPath.startsWith(rootDir)) {
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
      case ".woff":
        return "font/woff";
      case ".woff2":
        return "font/woff2";
      default:
        return "application/octet-stream";
    }
  };

  runtime.tryServeFrontendAsset = (ctx, pathname) => {
    for (const rootDir of [webDistDir, publicDir]) {
      const filePath = runtime.resolveAsset(rootDir, pathname);
      if (!filePath) {
        continue;
      }
      runtime.serveFile(ctx, filePath, runtime.contentTypeForFile(filePath));
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
