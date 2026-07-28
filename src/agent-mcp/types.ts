/**
 * The shapes the harness passes around. No behaviour, so every other file here can import
 * it without importing anything else.
 */

/**
 * AGENT MCP HARNESS — the model-agnostic half of a conversational agent's tool loop.
 *
 * Every agent family (OpenAI, GLM, Grok, …) shares the SAME platform behavior:
 *   - which spatial-search results become callable tools (node-MCP rows + Unoverse
 *     app rows carrying the manifest call contract),
 *   - how an interactive APP tool presents itself to the model (the etiquette lives
 *     in the tool DESCRIPTION — the only channel that reaches a model for a tool
 *     minted MID-conversation; instructions are built once at loop start),
 *   - when a tool call ENDS the agent's turn (provenance + result shape, never a
 *     hardcoded name list).
 *
 * This module is that behavior, once — `@unoverse-platform/base/agent-mcp`.
 * Agent families keep only their streaming adapters (wire shapes, chunk handling,
 * token accounting) and map their tool-call objects into `AgentToolExchange` to
 * consume it. Fixes land here and reach every family — the previous state
 * (openai-only, GLM unable to discover apps at all, Grok forked) is exactly what
 * this exists to prevent. A conformance guard fails the build if an agent family
 * re-implements this logic instead of importing it.
 *
 * THE ONE-WIRE-CALL RULE — where our code ends and native MCP begins. Everything here
 * is pure interpretation/routing and never touches the MCP wire, EXCEPT
 * `invokeComponentAppNative` — the single function that opens an MCP client and makes a
 * real `tools/call`. From that call onward it is all native MCP (the server renders +
 * elicits; the answers resolve the call). Node-MCP rows and path-A workflow apps route
 * in-process via the caller's `api.callService` because they have a node/workflow to run;
 * only path-B component apps (nothing local to call) ride the wire. Full map:
 * docs/MCP_COMPLETE_GUIDE.md → "where YOUR code ends and native MCP begins".
 */

/** One executed tool call, reduced to what the harness needs: its name and the
 *  raw result content string the model will see. */
export interface AgentToolExchange {
  name: string;
  resultContent: string;
}

/** A spatial-discovered MCP, normalized: node-MCP rows and Unoverse app rows both
 *  come out in this shape, ready to mint as a model tool via `toolDefFromDiscoveredMCP`. */
export interface DiscoveredMCP {
  id: string;
  title: string;
  description: string;
  workflowId: string;
  nodeId: string;
  methodName: string;
  /** Full method schema ({ methods: { [name]: { description, input } } }). */
  schema?: any;
  /**
   * PATH B (UNOVERSE_MCP_TEMPLATE_PROTOCOL §0.1 / §4b): a self-contained component app —
   * an `app` URI but NO workflow. Holds the app-tool id the adapter hands to
   * `invokeComponentAppNative` (the held native `/mcp` call) instead of firing
   * `workflow@trigger`; `workflowId`/`nodeId` are empty. Undefined for node-MCP + path-A apps.
   */
  component?: string;
  /** PATH B: the app's resource URI (`unoverse://components/[<org>/]<name>`) — the ONLY
   *  schema handle. The tool's input schema is read LIVE from `<appUri>/schema` at mint
   *  time (`resolveToolDefNative`); spatial rows carry no schema copy. */
  appUri?: string;
}

/** A neutral function-tool definition; each family maps this to its wire format. */
export interface AgentToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Mint the model-facing tool definition for a discovered MCP. */

/** Context a held app call needs to reach the human on the live session. */
export interface AppInvocationContext {
  /** The caller's stream session — where the wizard renders and elicitation is answered. */
  conversationId?: string;
  userId?: string;
  /** The current TURN id — the component renders in this turn's bubble. */
  chatId?: string;
  /** Seeds the elicitation prompt; the app tool schema requires the field (may be ""). */
  message?: string;
  /** Content-tree app rows: the row's content, seeded as-is into the component's state. */
  props?: Record<string, unknown>;
  /** Content-tree app rows: the ROW id — keys the render `<component>:<instanceId>` so multiple rows sharing a component don't collide. */
  instanceId?: string;
  /** Forwarded as a Bearer token so the internal `/mcp` call rides the gated lane too. */
  accessToken?: string;
  /** Internal MCP base; defaults to UNOVERSE_SERVICE_URL or http://localhost:4106. */
  baseUrl?: string;
}

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

/** A content-tree row's attached card, ready to render — see parseContentCards. */
export interface ContentCard {
  /** The row's identity — dedupe key (one render per row, ever). */
  id: string;
  /** The component app-tool id (`unoverse://components/<id>` → `<id>`). */
  component: string;
  /** The row's content AS-IS — the component's state (binds resolve by name). */
  props: Record<string, unknown>;
}
