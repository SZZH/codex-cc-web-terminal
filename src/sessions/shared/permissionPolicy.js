import path from "node:path";

const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
const text = (value) => String(value ?? "").trim();
const policyType = (value) => text(value).replace(/[-_]/g, "").toLowerCase();

export function parsePermissionPolicy(value) {
  if (typeof value !== "string") return object(value);
  try {
    return object(JSON.parse(value));
  } catch {
    return null;
  }
}

function normalizePolicyPath(value) {
  const entry = object(value);
  if (!entry) return null;
  if (entry.type === "path") {
    if (Object.keys(entry).some((key) => !["type", "path"].includes(key))) return null;
    const target = text(entry.path);
    return path.isAbsolute(target) ? { type: "path", value: path.normalize(target) } : null;
  }
  if (entry.type === "special") {
    if (Object.keys(entry).some((key) => !["type", "value"].includes(key)) || !object(entry.value) ||
      Object.keys(entry.value).some((key) => key !== "kind")) return null;
    const kind = text(entry.value?.kind);
    return ["root", "cwd", "project_roots", "slash_tmp", "tmpdir"].includes(kind)
      ? { type: "special", value: kind } : null;
  }
  return null;
}

function containsPolicyPath(parent, child) {
  if (parent.type === "special" && parent.value === "root") return true;
  if (parent.type !== child.type) return false;
  if (parent.value === child.value) return true;
  if (parent.type !== "path") return false;
  const relative = path.relative(parent.value, child.value);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function coversWorkspace(target, cwd) {
  return target.type === "path" ? containsPolicyPath(target, { type: "path", value: cwd })
    : ["cwd", "project_roots"].includes(target.value);
}

function intersectsWorkspace(target, cwd) {
  if (target.type === "special") return !["slash_tmp", "tmpdir"].includes(target.value);
  const workspace = { type: "path", value: cwd };
  return containsPolicyPath(target, workspace) || containsPolicyPath(workspace, target);
}

function hasExplicitDeny(policy) {
  return ["deny", "denied", "denied_paths", "deniedPaths"].some((key) => {
    const value = policy?.[key];
    return value === true || (Array.isArray(value) ? value.length > 0
      : typeof value === "string" ? Boolean(value.trim()) : object(value) != null && Object.keys(value).length > 0);
  });
}

function managedPermissionMode(policy, cwd) {
  const fileSystem = object(policy.file_system || policy.fileSystem);
  if (!fileSystem || Object.hasOwn(policy, "file_system") && Object.hasOwn(policy, "fileSystem") ||
    hasExplicitDeny(policy) || hasExplicitDeny(fileSystem)) return "default";
  if (Object.keys(policy).some((key) => !["type", "file_system", "fileSystem", "network"].includes(key))) return "default";
  const type = policyType(fileSystem.type);
  if (type === "unrestricted") {
    if (Object.keys(fileSystem).some((key) => !["type", "entries"].includes(key))) return "default";
    if (fileSystem.entries != null && (!Array.isArray(fileSystem.entries) || fileSystem.entries.length)) return "default";
    return policy.network != null && policy.network !== "enabled" ? "default" : "full-access";
  }
  if (type !== "restricted" || !Array.isArray(fileSystem.entries) || !path.isAbsolute(cwd) ||
    !["enabled", "disabled", "restricted"].includes(policy.network) ||
    Object.keys(fileSystem).some((key) => !["type", "entries"].includes(key))) return "default";
  const entries = [];
  for (const entry of fileSystem.entries) {
    if (!object(entry) || Object.keys(entry).some((key) => !["path", "access", "missing_path_behavior"].includes(key)) ||
      (entry.missing_path_behavior != null && entry.missing_path_behavior !== "skip")) return "default";
    const target = normalizePolicyPath(entry?.path);
    const access = text(entry?.access).toLowerCase();
    if (!target || !["read", "write", "none", "deny", "denied"].includes(access)) return "default";
    entries.push({ path: target, access });
  }
  const denied = entries.filter((entry) => ["none", "deny", "denied"].includes(entry.access));
  if (denied.some((entry) => intersectsWorkspace(entry.path, cwd))) return "default";
  return entries.some((entry) => entry.access === "write" && coversWorkspace(entry.path, cwd)) ? "auto-review" : "default";
}

export function permissionModeFromPolicy(value, cwd = "") {
  const policy = parsePermissionPolicy(value);
  if (!policy || hasExplicitDeny(policy)) return "default";
  switch (policyType(policy.type)) {
    case "disabled":
      return Object.keys(policy).every((key) => key === "type") ? "full-access" : "default";
    case "dangerfullaccess":
      return policy.file_system || policy.fileSystem || policy.entries != null ? "default" : "full-access";
    case "workspacewrite":
      return "auto-review";
    case "managed":
      return managedPermissionMode(policy, text(cwd));
    default:
      return "default";
  }
}

function hasRootRead(entries, cwd) {
  const root = path.parse(cwd).root;
  return entries.some((entry) => ["read", "write"].includes(entry.access) &&
    (entry.path?.type === "special" && entry.path.value?.kind === "root" ||
      entry.path?.type === "path" && path.normalize(text(entry.path.path)) === root));
}

function hasNarrowReadRestriction(entries, cwd) {
  const workspace = { type: "path", value: cwd };
  const protectedRoots = [".git", ".agents", ".codex", ".aws"].map((name) => ({ type: "path", value: path.join(cwd, name) }));
  return entries.some((entry) => {
    const target = normalizePolicyPath(entry.path);
    return entry.access === "read" && target?.type === "path" && containsPolicyPath(workspace, target) &&
      !protectedRoots.some((root) => containsPolicyPath(root, target));
  });
}

export function permissionPolicyIsUnsupported(value, { cwd = "" } = {}) {
  const policy = parsePermissionPolicy(value);
  if (!policy || hasExplicitDeny(policy)) return true;
  const type = policyType(policy.type);
  if (type === "disabled") return permissionModeFromPolicy(policy, cwd) !== "full-access";
  if (type !== "managed") {
    if (type === "dangerfullaccess") {
      return permissionModeFromPolicy(policy, cwd) !== "full-access" || policy.network_access === false ||
        policy.networkAccess === false || policy.network != null && policy.network !== "enabled";
    }
    if (type === "workspacewrite") {
      return policy.exclude_slash_tmp === true || policy.excludeSlashTmp === true ||
        policy.exclude_tmpdir_env_var === true || policy.excludeTmpdirEnvVar === true;
    }
    if (type === "readonly") {
      return policy.network_access === false || policy.networkAccess === false ||
        policy.network != null && policy.network !== "enabled" ||
        policy.access != null && policy.access?.type !== "fullAccess";
    }
    return true;
  }
  const mode = permissionModeFromPolicy(policy, cwd);
  if (mode === "full-access") return policy.network !== "enabled";
  const fileSystem = object(policy.file_system || policy.fileSystem);
  const entries = fileSystem?.entries;
  if (policyType(fileSystem?.type) !== "restricted" || !Array.isArray(entries) || !path.isAbsolute(text(cwd)) || !hasRootRead(entries, text(cwd)) ||
    Object.keys(policy).some((key) => !["type", "file_system", "fileSystem", "network"].includes(key)) ||
    Object.keys(fileSystem).some((key) => !["type", "entries"].includes(key)) ||
    entries.some((entry) => !object(entry) || !normalizePolicyPath(entry.path) ||
      !["read", "write"].includes(entry.access) ||
      Object.keys(entry).some((key) => !["path", "access", "missing_path_behavior"].includes(key)) ||
      entry.missing_path_behavior != null && entry.missing_path_behavior !== "skip")) return true;
  if (mode === "auto-review") return hasNarrowReadRestriction(entries, text(cwd));
  return policy.network !== "enabled" || entries.some((entry) => entry.access !== "read");
}

export function permissionModeFromStoredPolicy(value, { cwd = "", approvalPolicy } = {}) {
  const mode = permissionModeFromPolicy(value, cwd);
  if (mode !== "default" || approvalPolicy !== "on-request" || permissionPolicyIsUnsupported(value, { cwd })) return mode;
  const policy = parsePermissionPolicy(value);
  // Only fully understood read-only policies may acquire the manual approval mode.
  if (policyType(policy.type) === "readonly" && (
    Object.keys(policy).some((key) => !["type", "network_access", "networkAccess", "network", "access"].includes(key)) ||
    ["network_access", "networkAccess"].some((key) => Object.hasOwn(policy, key) && policy[key] !== true) ||
    Object.hasOwn(policy, "network") && policy.network !== "enabled" ||
    Object.hasOwn(policy, "access") && (!object(policy.access) || policy.access.type !== "fullAccess" ||
      Object.keys(policy.access).some((key) => key !== "type"))
  )) return mode;
  return "manual-review";
}
