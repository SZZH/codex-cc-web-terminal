/** The parent V2 route owns authentication, origin checks and error adaptation. */
export async function handleCodexInteractionRoute({ ctx, runtime, service, parts }) {
  const [threadId, resource, id, action] = parts;
  if (resource !== "interactions") return null;
  const interactions = service.interactions;
  if (!interactions) throw Object.assign(new Error("Codex user interactions are unavailable"), { status: 503 });
  if (parts.length === 2 && ctx.method === "GET") return interactions.list(threadId);
  if (parts.length === 3 && ctx.method === "GET") return interactions.get(threadId, id);
  if (parts.length === 4 && action === "respond" && ctx.method === "POST") {
    return interactions.respond(threadId, id, runtime.parseJson(await runtime.readBody(ctx.req)));
  }
  throw Object.assign(new Error("Interaction route not found"), { status: 404 });
}
