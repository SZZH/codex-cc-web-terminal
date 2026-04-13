import path from "node:path";

export function installVendorAssetRuntime(runtime) {
  runtime.routeVendor = (ctx, pathname) => {
    const vendorMap = {
      "/vendor/xterm.css": path.join(process.cwd(), "node_modules", "xterm", "css", "xterm.css"),
      "/vendor/xterm.js": path.join(process.cwd(), "node_modules", "xterm", "lib", "xterm.js"),
      "/vendor/xterm-addon-fit.js": path.join(
        process.cwd(),
        "node_modules",
        "@xterm",
        "addon-fit",
        "lib",
        "addon-fit.js"
      ),
      "/vendor/vue.js": path.join(process.cwd(), "node_modules", "vue", "dist", "vue.global.prod.js")
    };

    const filePath = vendorMap[pathname];
    if (!filePath) {
      return false;
    }

    const contentType = pathname.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8";
    runtime.serveFile(ctx, filePath, contentType);
    return true;
  };
}
