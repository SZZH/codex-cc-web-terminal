import { defaultWorkspaceService, workspaceErrorResponse } from "../workspace/service.js";
import { parseStatusEntries } from "../workspace/changes.js";

const routes = {
  "GET /api/workspace-changes": (service, input) => service.listWorkspaceChanges(input.cwd, input.options),
  "GET /api/workspace-git": (service, input) => service.listGitBranches(input.cwd),
  "POST /api/workspace-changes/revert": (service, input) => service.revertWorkspaceChanges(input.cwd, input.paths),
  "POST /api/workspace-changes/apply-patch": (service, input) => service.applyPatchWorkspaceChanges(input.cwd, input.files, input.direction),
  "POST /api/workspace-changes/reverse-patch": (service, input) => service.reversePatchWorkspaceChanges(input.cwd, input.files),
  "POST /api/workspace-git/checkout": (service, input) => service.checkoutGitBranch(input.cwd, input.branch),
  "POST /api/workspace-git/branches": (service, input) => service.createGitBranch(input.cwd, input.branch, { checkout: input.checkout !== false, startPoint: input.startPoint })
};

export async function handleWorkspaceChangesRoute(ctx, runtime) {
  const action = routes[ctx.method + " " + ctx.path];
  if (!action) return false;
  if (runtime.forbidCrossOrigin(ctx) || !runtime.requireAuthorized(ctx)) return true;
  try {
    let input;
    if (ctx.method === "GET") {
      const query = new URL(ctx.url, "http://localhost").searchParams;
      const summary = query.get("summary");
      if (summary != null && !["0", "1"].includes(summary)) throw new Error("Invalid change summary option");
      input = { cwd: query.get("cwd"), options: { summary: summary === "1", ...(query.has("path") ? { paths: query.getAll("path") } : {}) } };
    } else input = runtime.parseJson(await runtime.readBody(ctx.req));
    runtime.json(ctx, 200, await action(runtime.workspace || defaultWorkspaceService, input));
  } catch (error) {
    const response = workspaceErrorResponse(error);
    runtime.json(ctx, response.status, response.body);
  }
  return true;
}

export const workspaceChangesInternals = Object.fromEntries([
  "listWorkspaceChanges", "revertWorkspaceChanges", "reversePatchWorkspaceChanges", "applyPatchWorkspaceChanges",
  "listGitBranches", "checkoutGitBranch", "createGitBranch"
].map((name) => [name, (...args) => defaultWorkspaceService[name](...args)]));
workspaceChangesInternals.parseStatusEntries = parseStatusEntries;
