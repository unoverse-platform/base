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
import { invokeComponentAppNative } from "./invoke.js";
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
 *   2. SHELL-OPEN (fire-and-forget): one empty native call per newly discovered app —
 *      the server renders the page SKELETON immediately, so the guest sees the page
 *      exist seconds in and watches it hydrate, never a blank panel while the model
 *      composes.
 *   3. LEAN: returns the model-facing projection of the rows (full cargo was already
 *      consumed by the card lane and this unlock pass; raw rows cost ~100k tokens).
 * Non-discovery results pass through untouched.
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
  // DRAFT MATERIAL for the shell-open: the search that unlocked the app already
  // returned RANKED, image-carrying content rows for the guest's desire. Their ids
  // ride the shell call so the server can draft every zero-authoring part (hero
  // image, ref-only galleries) IMMEDIATELY — real content on screen seconds in,
  // no waiting on the model's compose. The model's later calls merge over it.
  let draftRefs: string[] = [];
  try {
    const parsed = parseToolResult(resultContent);
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : [];
    draftRefs = rows
      .filter((r: any) => {
        if (r?.object_type === "mcp" || r?.object_type === "skill") return false;
        // LEAN rows (the node's projection) carry `hasImage`; raw rows carry metadata.
        if (r?.hasImage === true) return true;
        const md = r?.metadata ?? {};
        return Boolean(
          (typeof md.primaryImage === "string" && md.primaryImage) ||
            (Array.isArray(md.images) && md.images.length) ||
            r?.object_type === "image",
        );
      })
      .map((r: any) => String(r.universal_id || ""))
      .filter(Boolean)
      .slice(0, 8);
  } catch {}
  for (const mcp of parseDiscoveredMCPs([{ name: toolName, resultContent }])) {
    if (isBindinglessComponentApp(mcp) && mcp.component && !discoveredApps.has(mcp.component)) {
      discoveredApps.add(mcp.component);
      log?.(`🔓 App tool unlocked: ${mcp.component}`);
      if (identity.userId && identity.conversationId) {
        if (draftRefs.length) draftSeededFor(discoveredApps).add(mcp.component);
        invokeComponentAppNative(mcp.component, {
          ...identity,
          message: "",
          ...(draftRefs.length ? { props: { __draftRefs: draftRefs } } : {}),
        }).catch((e: any) => log?.(`shell-open failed for ${mcp.component}: ${e?.message ?? e}`));
      }
      if (onAppUnlocked) await onAppUnlocked(mcp);
    }
  }
  // DRAFT TOP-UP: the UNLOCKING search may carry no image rows (observed live: a
  // hotels-neighborhood discovery — hasImage false across the board), leaving the
  // draft with nothing to paint. Seed it from the FIRST discovery result that DOES
  // carry image rows, whichever search that is. Once per app per run; the server
  // ignores the draft anyway once the model has composed (held page exists).
  if (draftRefs.length && identity.userId && identity.conversationId) {
    const seeded = draftSeededFor(discoveredApps);
    for (const component of discoveredApps) {
      if (seeded.has(component)) continue;
      seeded.add(component);
      log?.(`🎨 Draft top-up for ${component} (${draftRefs.length} image rows)`);
      invokeComponentAppNative(component, { ...identity, message: "", props: { __draftRefs: draftRefs } }).catch(
        (e: any) => log?.(`draft top-up failed for ${component}: ${e?.message ?? e}`),
      );
    }
  }
  return leanToolResultForModel(resultContent);
}

// Which apps already received their draft, per run — keyed off the run's own
// discoveredApps set so no signature changes ripple through the families.
const draftSeededByRun = new WeakMap<Set<string>, Set<string>>();
function draftSeededFor(discoveredApps: Set<string>): Set<string> {
  let s = draftSeededByRun.get(discoveredApps);
  if (!s) {
    s = new Set();
    draftSeededByRun.set(discoveredApps, s);
  }
  return s;
}

/**
 * ASK-INTEGRITY ANCHOR — the guest's faithful ask ALWAYS searches.
 *
 * The query is the ROUTING signal, not just a content search: app rows are indexed
 * on utterance-shaped `whenToUse` text written to meet real asks in embedding space.
 * A compressed ("career goals") or memory-stuffed paraphrase misses that handshake
 * and the wrong app (or none) unlocks — observed live, both directions. Prose asked
 * the model to preserve the ask; this makes it structural: for discovery-tool calls,
 * the turn's raw ask is prepended as the first query and the model's own queries
 * ride alongside as additional angles. The model still decides WHEN to search, which
 * MODE, and what facets to add — only preservation is enforced.
 *
 * Skipped for trivial asks (< 15 chars — "yes", "thanks" would anchor junk).
 */

/**
 * ASK-INTEGRITY ANCHOR — the guest's faithful ask ALWAYS searches.
 *
 * The query is the ROUTING signal, not just a content search: app rows are indexed
 * on utterance-shaped `whenToUse` text written to meet real asks in embedding space.
 * A compressed ("career goals") or memory-stuffed paraphrase misses that handshake
 * and the wrong app (or none) unlocks — observed live, both directions. Prose asked
 * the model to preserve the ask; this makes it structural: for discovery-tool calls,
 * the turn's raw ask is prepended as the first query and the model's own queries
 * ride alongside as additional angles. The model still decides WHEN to search, which
 * MODE, and what facets to add — only preservation is enforced.
 *
 * Skipped for trivial asks (< 15 chars — "yes", "thanks" would anchor junk).
 */
export function anchorSearchArgs(
  toolName: string,
  args: Record<string, unknown>,
  ask: string | undefined,
  log?: (msg: string) => void,
): Record<string, unknown> {
  if (!DISCOVERY_TOOL_NAMES.includes(toolName)) return args;
  const anchor = typeof ask === "string" ? ask.trim() : "";
  if (anchor.length < 15) return args;
  const modelQueries = [
    ...(typeof args?.query === "string" && (args.query as string).trim() ? [(args.query as string).trim()] : []),
    ...(Array.isArray(args?.queries) ? (args.queries as unknown[]).map((q) => String(q ?? "").trim()).filter(Boolean) : []),
  ];
  const lower = anchor.toLowerCase();
  const rest = modelQueries.filter((q) => q.toLowerCase() !== lower);
  if (rest.length === modelQueries.length && modelQueries.some((q) => q.toLowerCase().includes(lower))) {
    return args; // a model query already carries the full ask — nothing to enforce
  }
  const queries = [anchor, ...rest].slice(0, 8);
  if (queries.length !== modelQueries.length || queries[0] !== modelQueries[0]) {
    log?.(`⚓ Ask anchored into ${toolName}: "${anchor.slice(0, 60)}${anchor.length > 60 ? "…" : ""}" + ${rest.length} model angle(s)`);
  }
  const { query: _dropped, ...restArgs } = args;
  return { ...restArgs, queries };
}

/** A neutral function-tool definition; each family maps this to its wire format. */
