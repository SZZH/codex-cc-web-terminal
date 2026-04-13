export function installCookieRuntime(runtime) {
  runtime.parseCookies = (req) => {
    const raw = String(req.headers.cookie || "");
    const cookies = {};
    for (const pair of raw.split(/;\s*/)) {
      if (!pair) {
        continue;
      }
      const index = pair.indexOf("=");
      if (index <= 0) {
        continue;
      }
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        // Ignore malformed cookie values rather than failing the whole request.
      }
    }
    return cookies;
  };

  runtime.serializeCookie = (name, value, options = {}) => {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    if (options.maxAge !== undefined) {
      parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
    }
    if (options.httpOnly !== false) {
      parts.push("HttpOnly");
    }
    if (options.sameSite) {
      parts.push(`SameSite=${options.sameSite}`);
    }
    if (options.path) {
      parts.push(`Path=${options.path}`);
    }
    if (options.secure) {
      parts.push("Secure");
    }
    return parts.join("; ");
  };

  runtime.clearAuthCookie = (ctx) => {
    ctx.set(
      "Set-Cookie",
      runtime.serializeCookie(runtime.config.authSessionCookieName, "", {
        maxAge: 0,
        path: "/",
        sameSite: "Lax",
        secure: runtime.config.secureCookies
      })
    );
  };
}
