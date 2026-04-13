export function installTrustedOriginRuntime(runtime) {
  runtime.isTrustedOrigin = (req) => {
    const origin = String(req.headers.origin || "").trim();
    if (!origin) {
      return true;
    }
    try {
      const originUrl = new URL(origin);
      const hostHeader = String(req.headers.host || "").trim();
      if (originUrl.host === hostHeader) {
        return true;
      }

      const hostName = hostHeader.split(":")[0].toLowerCase();
      const originHostName = originUrl.hostname.toLowerCase();
      const loopbacks = new Set(["127.0.0.1", "localhost", "::1"]);
      if (loopbacks.has(hostName) && loopbacks.has(originHostName)) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  };

  runtime.forbidCrossOrigin = (ctx) => {
    if (runtime.isTrustedOrigin(ctx.req)) {
      return false;
    }
    runtime.json(ctx, 403, { error: "Cross-origin request rejected" });
    return true;
  };
}
