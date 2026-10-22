import { canonical, fields, invalid, object } from "./validation.js";

function subsetArray(value, source) {
  if (!Array.isArray(value) || !Array.isArray(source)) return false;
  const allowed = new Set(source.map((entry) => JSON.stringify(canonical(entry))));
  const selected = value.map((entry) => JSON.stringify(canonical(entry)));
  return selected.every((entry) => allowed.has(entry)) && new Set(selected).size === value.length;
}

function validEntry(entry) {
  if (!object(entry) || !["read", "write", "deny"].includes(entry.access) || !object(entry.path)) return false;
  const value = entry.path;
  if (value.type === "path") return typeof value.path === "string";
  if (value.type === "glob_pattern") return typeof value.pattern === "string";
  if (value.type !== "special" || !object(value.value)) return false;
  const special = value.value;
  if (!["root", "minimal", "project_roots", "tmpdir", "slash_tmp", "unknown"].includes(special.kind)) return false;
  return (special.kind !== "unknown" || typeof special.path === "string") && (special.subpath == null || typeof special.subpath === "string");
}

export function validatePermissions(response, requested) {
  fields(response, ["permissions", "scope", "strictAutoReview"]);
  fields(response.permissions, ["network", "fileSystem"], "Invalid permission grant");
  if (response.scope != null && !["turn", "session"].includes(response.scope)) throw invalid("Invalid permission scope");
  if (response.strictAutoReview != null && typeof response.strictAutoReview !== "boolean") throw invalid("Invalid permission auto review choice");
  const grant = response.permissions;
  if (grant.network != null) {
    fields(grant.network, ["enabled"], "Invalid network permission");
    if (!object(requested?.network) || ![true, false, null, undefined].includes(grant.network.enabled)
      || grant.network.enabled === true && requested.network.enabled !== true) throw invalid("Network permission exceeds the requested permissions");
  }
  if (grant.fileSystem != null) {
    fields(grant.fileSystem, ["read", "write", "entries", "globScanMaxDepth"], "Invalid file system permission");
    const original = requested?.fileSystem;
    if (!object(original)) throw invalid("File permission was not requested");
    for (const name of ["read", "write", "entries"]) {
      if (grant.fileSystem[name] != null && !subsetArray(grant.fileSystem[name], original[name])) throw invalid("File permission exceeds the requested permissions");
      if (grant.fileSystem[name] != null && grant.fileSystem[name].some((entry) => name === "entries" ? !validEntry(entry) : typeof entry !== "string")) throw invalid("Invalid file permission entries");
    }
    const depth = grant.fileSystem.globScanMaxDepth;
    if (depth != null && (!Number.isSafeInteger(depth) || depth < 1 || !Number.isSafeInteger(original.globScanMaxDepth) || depth > original.globScanMaxDepth)) {
      throw invalid("File permission scan depth exceeds the requested permissions");
    }
    // Removing a deny entry from a wider grant can expand access.
    const denied = (original.entries || []).filter((entry) => entry.access === "deny");
    const entries = new Set((grant.fileSystem.entries || []).map((entry) => JSON.stringify(canonical(entry))));
    if (Object.values(grant.fileSystem).some((value) => Array.isArray(value) && value.length)
      && denied.some((entry) => !entries.has(JSON.stringify(canonical(entry))))) {
      throw invalid("File permission grant must preserve requested deny entries");
    }
  }
  return { ...response, scope: response.scope || "turn" };
}
