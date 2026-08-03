/**
 * THE ONE WIRE CALL. Where our code ends and native MCP begins.
 *
 * Everything else in this folder is interpretation and routing that never touches the MCP
 * wire. This is the exception: `invokeComponentAppNative` opens a client and makes a real
 * `tools/call`. From there the server renders, elicits, and its answers resolve the call.
 *
 * Node-MCP rows and path-A workflow apps do NOT come through here — they route in-process
 * via the caller's `api.callService`, because they have a node or a workflow to run. Only a
 * path-B component app, with nothing local to call, rides the wire.
 */
import type { AppInvocationContext, DiscoveredMCP } from "./types.js";

/**
 * NATIVE MCP APP INVOCATION (UNOVERSE_MCP_TEMPLATE_PROTOCOL §3.3 / §4b) — the held
 * slow-call that renders a component app and returns the user's submitted answers to
 * the CALLING model.
 *
 * A bindingless component app has no workflow to fire. Calling it is ONE held
 * `tools/call` to the platform's internal MCP server (`/mcp`): the server registered the
 * app as a tool (mcpServer `listApps()`), renders the component on the caller's live
 * session and ELICITS its declared `outputs` block, then resolves the call with
 * `{ output }`. No polling and no timeout by design — an abandoned form is a tool call
 * that never returns (the SDK's 60s default is lifted to 24h). The answers come back as
 * the tool result so the model continues in-turn.
 *
 * This is the modern replacement for the legacy engine's
 * `MCPInvoker.awaitAppOutputNative`: same native slow-call, but driven from this shared
 * harness (every agent family) using the app id it parsed at mint time — so it needs NO
 * server-side (XState) schema cache.
 */
/** Open an MCP client on the platform's internal `/mcp` — the ONE wire-connect shared by
 *  every native call this harness makes (app invocation, live schema read). */
export async function connectPlatformMcp(
  ctx: Pick<AppInvocationContext, "accessToken" | "baseUrl">,
): Promise<{ client: any; close: () => Promise<void> }> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

  const base = (ctx.baseUrl || process.env.UNOVERSE_SERVICE_URL || "http://localhost:4106").replace(/\/$/, "");
  const accessToken = ctx.accessToken;
  const authFetch = accessToken
    ? async (url: string | URL, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${accessToken}`);
        return fetch(url, { ...init, headers });
      }
    : undefined;

  const client = new Client({ name: "unoverse-agent-mcp", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${base}/mcp`),
    authFetch ? { fetch: authFetch } : undefined,
  );
  await client.connect(transport);
  return { client, close: () => client.close().catch(() => {}) };
}

export async function invokeComponentAppNative(
  toolId: string,
  ctx: AppInvocationContext,
): Promise<{ status: "completed"; output?: Record<string, unknown>; conversationId?: string; action?: string; message?: string }> {
  const { client, close } = await connectPlatformMcp(ctx);
  try {
    const result = (await client.callTool(
      {
        name: toolId,
        arguments: {
          message: ctx.message ?? "",
          ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
          ...(ctx.userId ? { userId: ctx.userId } : {}),
          ...(ctx.chatId ? { chatId: ctx.chatId } : {}),
          ...(ctx.props ? { props: ctx.props } : {}),
          ...(ctx.instanceId ? { instanceId: ctx.instanceId } : {}),
          ...(ctx.fromRow ? { fromRow: true } : {}),
        },
      },
      undefined,
      // A human is completing the wizard — lift the SDK's 60s default to 24h.
      { timeout: 24 * 60 * 60 * 1000 },
    )) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: { output?: Record<string, unknown>; conversationId?: string; action?: string };
    };
    // A handler exception arrives as an isError RESULT, not a rejection — surface it, or a
    // broken run masquerades as "completed with no output".
    if (result.isError) {
      throw new Error(result.content?.find((c) => c.type === "text")?.text || `${toolId} app tool call failed`);
    }
    const output = result.structuredContent?.output;
    const resultText = result.content?.find((c) => c.type === "text")?.text;
    // BRIEFED component result (output carries `rendered`): the TEXT is the instruction
    // channel — the referee's "NOT RENDERED — <violations>" correction or the mirror's
    // "Rendered. The guest now sees this page…" reflection. Pass it through VERBATIM so
    // the standard tool-retry loop can self-correct / refine. The canned profile guidance
    // below is for ELICITATION outputs only — substituting it here hid the referee from
    // the model (observed live: composed args dropped, model told "profile collected").
    if (output && typeof (output as { rendered?: unknown }).rendered === "boolean") {
      return {
        status: "completed",
        output,
        conversationId: result.structuredContent?.conversationId,
        action: result.structuredContent?.action,
        ...(resultText ? { message: resultText } : {}),
      };
    }
    return {
      // The held call RESOLVED — mark it completed so `isTurnEndingHandoff` keeps the
      // conversation going. Without this, a display-only app (no `outputs` block, e.g. a
      // showcase card) returns { app, conversationId } — the fire-and-forget handoff
      // signature — and the loop SILENTLY ENDS THE TURN right after the render (observed
      // live: card streamed in, then no follow-up text, twice).
      status: "completed",
      output,
      conversationId: result.structuredContent?.conversationId,
      action: result.structuredContent?.action,
      // Tell the calling model what the output MEANS and that the task is NOT done yet.
      // Without this the model summarises the answers and stops instead of using them —
      // observed live: it returned a generic reply and never re-searched (iteration with
      // toolCalls:0). The legacy MCPInvoker returned this same guidance; dropping it in the
      // de-fork is why "the model does nothing with the answers". Restores the behaviour.
      ...(output && Object.keys(output).length
        ? {
            message:
              "`output` is the user's complete profile collected by the app — do NOT ask for any of these values again. The user's request is NOT yet fulfilled: any earlier search predates these answers. Search NOW with a query built from this profile and recommend the specific matches you find.",
          }
        : {
            message:
              "The component is now displayed on the user's screen. Continue your answer for the user now — the render is a visual aid, not your reply.",
          }),
    };
  } finally {
    await close();
  }
}

// Memory ingest — every agent family saves completed turns the same way.
