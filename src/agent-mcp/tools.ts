/**
 * MINTING A MODEL TOOL FROM A DISCOVERED APP.
 *
 * One discovered row becomes one tool definition. A path-B component app has no schema on
 * the row at all, so its input schema is read LIVE from the app's own resource at mint time.
 */
import type { AgentToolDef, DiscoveredMCP, AppInvocationContext } from "./types.js";
import { connectPlatformMcp, invokeComponentAppNative } from "./invoke.js";
import { APP_ETIQUETTE } from "./discovery.js";

/** Mint the model-facing tool definition for a discovered MCP. */
export function toolDefFromDiscoveredMCP(mcp: DiscoveredMCP): AgentToolDef {
  const methodDef = mcp.schema?.methods?.[mcp.methodName];
  return {
    name: mcp.methodName,
    description: methodDef?.description || mcp.description || mcp.title,
    parameters: methodDef?.input || { type: "object", properties: { message: { type: "string" } } },
  };
}

/**
 * Mint the model-facing tool definition, pulling a component app's schema LIVE.
 *
 * NATIVE MCP, no copies: a path-B app row carries only its `appUri` — the schema is a
 * `resources/read` of `<appUri>/schema` on the platform server, compiled fresh from the
 * definition at read time. Always current (no reconcile), always in document order (a
 * DB-stored copy can't hold key order), and the same source the server's referee
 * validates against — schema drift is structurally impossible. Non-app tools (and any
 * pull failure) fall back to the synchronous mint.
 */
export async function resolveToolDefNative(
  mcp: DiscoveredMCP,
  ctx: Pick<AppInvocationContext, "accessToken" | "baseUrl">,
): Promise<AgentToolDef> {
  if (!isBindinglessComponentApp(mcp) || !mcp.appUri) return toolDefFromDiscoveredMCP(mcp);
  try {
    const { client, close } = await connectPlatformMcp(ctx);
    try {
      const res = (await client.readResource({ uri: `${mcp.appUri}/schema` })) as {
        contents?: Array<{ text?: string }>;
      };
      const contract = JSON.parse(res.contents?.[0]?.text ?? "{}") as {
        description?: string;
        inputSchema?: Record<string, unknown> | null;
      };
      if (!contract.inputSchema) return toolDefFromDiscoveredMCP(mcp); // not briefed — generic contract
      // A BRIEFED schema carries the composer directive in its top-level description.
      // Models read TOOL descriptions far more reliably than schema descriptions —
      // surface it there too, so the briefed tool self-instructs at both levels.
      const directive = typeof contract.inputSchema.description === "string" ? ` ${contract.inputSchema.description}` : "";
      return {
        name: mcp.methodName,
        description: `${contract.description || mcp.title || mcp.methodName}${directive} ${APP_ETIQUETTE}`,
        parameters: contract.inputSchema,
      };
    } finally {
      await close();
    }
  } catch {
    return toolDefFromDiscoveredMCP(mcp);
  }
}

/**
 * A bindingless component app (path B): a `component` app-tool id and NO workflow. The
 * adapter routes it to `invokeComponentAppNative` (held `/mcp` call) instead of firing.
 */
export function isBindinglessComponentApp(mcp: DiscoveredMCP): boolean {
  return !!mcp.component && !mcp.workflowId;
}

/**
 * The ONE component-app adapter every agent family wires for a discovered bindingless
 * component app (path B). MCP-NATIVE by design: the tool's schema is the instruction
 * channel — for a BRIEFED component it was compiled from the definition's `brief` tags
 * (server briefSchema → registry metadata.inputSchema → the minted tool), so the model
 * hydrates real fields, not a prose protocol. This closure is the composer's APPLY half:
 * every arg beyond `message` IS that hydrated content and forwards as `props`, which the
 * platform MCP server seeds into the rendered component's state. Non-briefed apps carry
 * only `message` — behavior unchanged.
 *
 * Agent families should wire exactly:
 *   `service[methodName] = componentAppInvoker(mcp, identity)`
 * and never hand-roll the arg mapping again.
 */
export function componentAppInvoker(
  mcp: DiscoveredMCP,
  identity: Pick<AppInvocationContext, "conversationId" | "userId" | "chatId" | "accessToken">,
): (input: unknown) => ReturnType<typeof invokeComponentAppNative> {
  const toolId = mcp.component as string;
  return (input: unknown) => {
    const { message, ...hydrated } = (input ?? {}) as Record<string, unknown>;
    return invokeComponentAppNative(toolId, {
      conversationId: identity.conversationId,
      userId: identity.userId,
      accessToken: identity.accessToken,
      chatId: identity.chatId,
      message: typeof message === "string" ? message : "",
      ...(Object.keys(hydrated).length ? { props: hydrated } : {}),
    });
  };
}

/** Context a held app call needs to reach the human on the live session. */
