import path from "node:path";
import { validateManifest } from "./manifest.mjs";

function absoluteDirectory(value) {
  if (typeof value !== "string" || !path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
      || /[{}\r\n\0\\]/.test(value)) throw new Error("Static root must be a normalized absolute POSIX path without placeholders");
  return value;
}

function walkHandlers(routes, visit) {
  for (const route of routes ?? []) {
    for (const [index, handler] of (route.handle ?? []).entries()) {
      visit(handler, route.handle, index);
      if (handler.handler === "subroute") walkHandlers(handler.routes, visit);
    }
  }
}

function staticHeaders(contentType, immutable = false) {
  return {
    "Cache-Control": [immutable ? "public, max-age=31536000, immutable" : "no-store"],
    "Content-Type": [contentType],
    "Referrer-Policy": ["same-origin"],
    "X-Content-Type-Options": ["nosniff"],
    "X-Frame-Options": ["DENY"]
  };
}

function fileRoute(paths, directory, contentType, immutable, { index = false } = {}) {
  return {
    match: [{ method: ["GET", "HEAD"], path: paths }],
    handle: [
      { handler: "headers", response: { set: staticHeaders(contentType, immutable), add: { Vary: ["Accept-Encoding"] } } },
      ...(index ? [{ handler: "rewrite", uri: "/index.html" }] : []),
      { handler: "file_server", root: directory, index_names: [], canonical_uris: false,
        precompressed: { br: {}, gzip: {} }, precompressed_order: ["br", "gzip"] }
    ],
    terminal: true
  };
}

// The input is the saved original configuration, never a live admin API result.
// This function produces data only: callers own validation and their dedicated service reload.
export function transformCaddyConfig(config, { serverName, upstreamDial, root, manifest, retainedManifests = [] }) {
  if (!serverName || !upstreamDial || typeof serverName !== "string" || typeof upstreamDial !== "string") throw new Error("Explicit serverName and upstreamDial are required");
  const staticRoot = absoluteDirectory(root);
  validateManifest(manifest);
  retainedManifests.forEach(validateManifest);
  const output = structuredClone(config);
  if (!Object.hasOwn(output.apps?.http?.servers ?? {}, serverName)) throw new Error(`Caddy server not found: ${serverName}`);
  const server = output.apps.http.servers[serverName];
  const matches = [];
  walkHandlers(server.routes, (handler, handles, index) => {
    if (handler.handler === "file_server" && ["/current/files", "/shared/files"].some((suffix) => handler.root === `${staticRoot}${suffix}`)) {
      throw new Error("Static release routes already present; transform the saved original Caddy configuration");
    }
    if (handler.handler === "reverse_proxy" && handler.upstreams?.some((upstream) => upstream.dial === upstreamDial)) matches.push({ handler, handles, index });
  });
  if (matches.length !== 1) throw new Error(`Expected one matching reverse proxy in ${serverName}; found ${matches.length}`);
  const { handler, handles, index } = matches[0];
  if (handler.upstreams.length !== 1 || handler.upstreams[0].dial !== upstreamDial) throw new Error("Target proxy must have exactly the explicitly selected upstream");

  const immutableFiles = new Map();
  const mutableFiles = new Map();
  for (const release of [...retainedManifests, manifest]) {
    for (const file of release.files.filter((entry) => !entry.encoding && entry.path !== "index.html")) {
      if (!file.immutable) { mutableFiles.set(file.path, file); continue; }
      const existing = immutableFiles.get(file.path);
      if (existing && existing.sha256 !== file.sha256) throw new Error(`Conflicting retained immutable path: ${file.path}`);
      immutableFiles.set(file.path, file);
    }
  }
  const routes = [fileRoute(["/", "/index.html"], `${staticRoot}/current/files`, "text/html; charset=utf-8", false, { index: true })];
  const groups = new Map();
  // Retained public names also permit a pointer-only rollback to earlier HTML.
  const publicFiles = [...immutableFiles.values(), ...mutableFiles.values()];
  for (const file of publicFiles) {
    const key = `${file.immutable}:${file.contentType}`;
    if (!groups.has(key)) groups.set(key, { file, paths: [] });
    groups.get(key).paths.push(`/${file.path}`);
  }
  for (const { file, paths } of groups.values()) routes.push(fileRoute(paths.sort(), `${staticRoot}/${file.immutable ? "shared" : "current"}/files`, file.contentType, file.immutable));
  routes.push({
    match: [{ path: ["/", "/index.html", "/assets", "/assets/*", "/licenses", "/licenses/*", ...publicFiles.map((file) => `/${file.path}`)] }],
    handle: [{ handler: "static_response", status_code: 404, headers: staticHeaders("text/plain; charset=utf-8"), body: "Not found" }],
    terminal: true
  });
  routes.push({ handle: [handler] });
  handles[index] = { handler: "subroute", routes };
  return output;
}
