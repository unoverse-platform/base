/**
 * WHAT SPATIAL FOUND, AND WHAT IT UNLOCKS.
 *
 * Reading `object_type: "mcp"` rows out of a discovery result and normalising three row
 * kinds into one shape, so a model gets one tool per row regardless of which kind it was.
 * Also the etiquette an interactive app carries, and the anchoring a follow-up search needs.
 */
import type { AgentToolExchange, DiscoveredMCP, AppInvocationContext } from "./types.js";

/** The discovery tools whose results can carry `object_type: "mcp"` rows. */
export const DISCOVERY_TOOL_NAMES: readonly string[] = ["findIntent", "discoverRelated"];

import { parseToolResult } from "./handoff.js";
import { rowComponentsFromResults, renderRowComponents, componentTypeFromAppUri } from "./rowComponents.js";
import { isBindinglessComponentApp } from "./tools.js";
import { leanToolResultForModel } from "./lean.js";

/**
 * Extract discovered MCPs from discovery-tool results (`object_type: "mcp"` rows).
 *
 * Three row kinds, all minted as one model tool:
 *   - node-MCP rows: carry a registered `metadata.schema.methods`.
 *   - Path A — workflow-bound app rows (UNOVERSE_MCP_TEMPLATE_PROTOCOL §4b): no schema —
 *     the app IS the tool, minted from the manifest call contract (name + inputSchema);
 *     calling it fires `workflow@trigger`.
 *   - Path B — bindingless component-app rows (§0.1): an `app` URI but NO workflow. The
 *     app IS the tool; calling it makes the held native `/mcp` call
 *     (`invokeComponentAppNative`) — the SERVER renders the component + elicits, nothing
 *     to fire. Carries `component` (the app-tool id) instead of workflow/trigger.
 *
 * Path B also covers CONTENT-TREE rows (object_type "service"/"need") with an app
 * ATTACHED (`metadata.app: "unoverse://components/<id>"`): a promoted service reacts
 * exactly like a discovered component app — the manifest's `defaultState` decides the
 * render (inline card, focus, …). These rows carry no `metadata.name`, so the tool is
 * minted under the component id and deduped across rows pointing at the same app.
 *
 * App descriptions gain the INTERACTIVE-APP etiquette so the model promotes the UI
 * instead of answering alongside it (observed live: a full interview streamed next to
 * the wizard asking the same questions).
 */
export const APP_ETIQUETTE =
  "INTERACTIVE APP: calling this renders a UI the user " +
  "completes on screen. When you call it, reply with at most ONE short sentence inviting the user to it — " +
  "never answer the request in text alongside it, never list options, never ask questions the app will " +
  "collect. If the result includes `output`, those are the user's complete answers — continue the task " +
  "with them (search if the request needs a lookup) and only then answer. " +
  "If your instructions include background about this user, every text field you compose here is written " +
  "FOR that person — use their name and what you know about them in headlines, intros, and copy; " +
  "generic audience-neutral brochure copy is wrong when you know who is reading.";


export function parseDiscoveredMCPs(calls: AgentToolExchange[]): DiscoveredMCP[] {
  const discovered: DiscoveredMCP[] = [];
  for (const call of calls) {
    if (!DISCOVERY_TOOL_NAMES.includes(call.name)) continue;
    // The spatial search tools return `{ count, results, queryPoint }` — the items live
    // under `.results`. (Some callers/older shapes hand back a bare array.) Accept both,
    // else nothing is ever discovered (the object isn't an array → the loop is skipped).
    const parsed = parseToolResult(call.resultContent);
    const results = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : null;
    if (!results) continue;
    for (const item of results) {
      if (item?.object_type !== "mcp") continue;
      if (item.metadata?.schema?.methods) {
        const methodName = Object.keys(item.metadata.schema.methods)[0];
        if (!methodName) continue;
        discovered.push({
          id: item.id || item.universal_id,
          title: item.title || "",
          description: item.description || "",
          workflowId: item.metadata?.workflowId || item.workflow_id,
          nodeId: item.metadata?.nodeId,
          methodName,
          schema: item.metadata?.schema,
        });
      } else if (item.metadata?.workflow && item.metadata?.trigger) {
        // PATH A — workflow-bound app: calling it fires workflow@trigger.
        const methodName = item.metadata.name;
        if (!methodName) continue;
        const input = item.metadata.inputSchema || { type: "object", properties: { message: { type: "string" } } };
        const appDescription = `${item.description || item.title || methodName} ${APP_ETIQUETTE}`;
        discovered.push({
          id: item.id || item.universal_id,
          title: item.title || "",
          description: appDescription,
          workflowId: item.metadata.workflow || item.workflow_id,
          nodeId: item.metadata.trigger,
          methodName,
          schema: { methods: { [methodName]: { description: appDescription, input } } },
        });
      } else if (item.metadata?.app && !item.metadata?.workflow) {
        // PATH B — bindingless component app: no workflow. Minted like an app tool; the
        // adapter passes `component` to `invokeComponentAppNative` (held native `/mcp`
        // call → the SERVER renders + elicits) instead of firing. The row carries NO
        // schema — the input schema is pulled LIVE from `<appUri>/schema` at mint time
        // (`resolveToolDefNative`); this default is the un-briefed fallback only.
        const methodName = item.metadata.name;
        if (!methodName) continue;
        const input = { type: "object", properties: {} };
        const appDescription = `${item.description || item.title || methodName} ${APP_ETIQUETTE}`;
        discovered.push({
          id: item.id || item.universal_id,
          title: item.title || "",
          description: appDescription,
          workflowId: "",
          nodeId: "",
          methodName,
          component: componentTypeFromAppUri(item.metadata.app),
          appUri: String(item.metadata.app),
          schema: { methods: { [methodName]: { description: appDescription, input } } },
        });
      }
    }
  }
  return discovered;
}

/** A content-tree row's attached card, ready to render — see parseRowComponents. */

/**
 * THE ONE DISCOVERY ABSORBER — what EVERY agent family does with a discovery tool's
 * result, in one place (never re-implemented in an adapter):
 *   1. UNLOCK: each discovered component app's tool joins `discoveredApps` — the set a
 *      native MCP attachment's `toolFilter` reads, so the app appears in the model's
 *      next `tools/list` (spatial selects; MCP serves).
 *   2. LEAN: returns the model-facing projection of the rows (full cargo was already
 *      consumed by the card lane and this unlock pass; raw rows cost ~100k tokens).
 * Non-discovery results pass through untouched.
 *
 * DISCOVERY NEVER CALLS THE APP. Finding a component in search results is not someone
 * asking for it; only the model's own tool call is. Two fire-and-forget calls lived here
 * (a shell-open on unlock, a draft top-up when a later search carried images) to paint a
 * composed page's frame early. Both were `invokeComponentAppNative`, so on an app whose
 * component declares `outputs` each one rendered the component AND opened its own
 * elicitation: observed live 2026-08-10, three renders and three concurrent forms in ONE
 * turn, of which the channel can hold only one (connection.tsx keeps a single pending
 * resolver). Native MCP is one call, one render, one elicitation, answers back to the
 * model (MCP_TEMPLATE_PROTOCOL §3.3). An early frame, if wanted again, cannot be an app
 * invocation.
 *
 * `onAppUnlocked` — fired ONCE per newly-unlocked path-B app, and AWAITED before the lean
 * result returns. A family that mints its own SDK tool per app (rather than exposing them
 * through a native MCP attachment's `toolFilter`) wires the mint here: parsing + dedup stay
 * in this one absorber, and the tool is registered before the model's next turn reads it.
 */
export async function handleDiscoveryResult(
  toolName: string,
  resultContent: string,
  discoveredApps: Set<string>,
  identity: Pick<AppInvocationContext, "conversationId" | "userId" | "chatId" | "accessToken">,
  log?: (msg: string) => void,
  onAppUnlocked?: (mcp: DiscoveredMCP) => Promise<void> | void,
): Promise<string> {
  if (!DISCOVERY_TOOL_NAMES.includes(toolName)) return resultContent;
  for (const mcp of parseDiscoveredMCPs([{ name: toolName, resultContent }])) {
    if (isBindinglessComponentApp(mcp) && mcp.component && !discoveredApps.has(mcp.component)) {
      discoveredApps.add(mcp.component);
      log?.(`🔓 App tool unlocked: ${mcp.component}`);
      if (onAppUnlocked) await onAppUnlocked(mcp);
    }
  }
  return leanToolResultForModel(resultContent);
}

/** A neutral function-tool definition; each family maps this to its wire format. */
