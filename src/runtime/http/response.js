export function installResponseRuntime(runtime) {
  runtime.nowMs = () => Date.now();
  runtime.responseHeaders = (extraHeaders = {}) => ({
    "Cache-Control": "no-store",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...extraHeaders
  });
  runtime.json = (ctx, statusCode, payload, extraHeaders = {}) => {
    ctx.status = statusCode;
    ctx.set(runtime.responseHeaders(extraHeaders));
    ctx.type = "application/json; charset=utf-8";
    ctx.body = `${JSON.stringify(payload)}\n`;
  };
  runtime.unauthorized = (ctx) => {
    runtime.json(ctx, 401, { error: "Unauthorized" });
  };
}
