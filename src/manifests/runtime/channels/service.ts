/**
 * THE SERVICE CHANNEL: a method this node offers over a service edge, exposed as MCP.
 *
 * The other of the two ways a node is reached, and they never cross (08-mcp-services.md).
 * Called ad-hoc by an agent rather than run by the graph, and it hands back ONE value rather
 * than emitting on output connectors — which is why the manifest says `returns` and why no
 * events row is involved anywhere in here.
 */
import type { ComposedNode } from "../../compose.js";
import type { RunContext } from "../context.js";
import { evaluate } from "../templating.js";
import { runCalls } from "../http/request.js";
import type { StateStore } from "../state.js";

export async function performService(
  node: ComposedNode,
  method: string,
  params: Record<string, any>,
  ctx: RunContext,
  store?: StateStore,
): Promise<unknown> {
  const spec = node.api?.service?.[method];
  if (!spec) {
    const known = Object.keys(node.api?.service ?? {});
    throw new Error(
      `${node.type} has no service method "${method}"${known.length ? ` — it has ${known.join(", ")}` : " — it has none"}`,
    );
  }

  const scoped: RunContext = { ...ctx, params };

  // Every call settles here, including the last: a method hands back ONE value, so there
  // is no connector for a stream to emit onto.
  const { results, last } = await runCalls(node, spec.calls, scoped, `${node.type}.${method}`, store);

  // `params`, `config` and `user` are in scope so a method can shape its result from what
  // it was asked for and who asked, not only from what came back.
  return evaluate(spec.returns, {
    response: last,
    calls: results,
    params,
    config: ctx.config,
    user: ctx.user,
  });
}
