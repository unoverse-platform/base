/**
 * AGENT MCP HARNESS — the model-agnostic half of a conversational agent's tool loop.
 *
 * Every agent family (OpenAI, GLM, Grok, …) shares the SAME platform behaviour: which
 * spatial-search results become callable tools, how an interactive app presents itself to
 * the model, and when a tool call ENDS the agent's turn. This folder is that behaviour,
 * once. Agent families keep only their streaming adapters — wire shapes, chunk handling,
 * token accounting — and map their tool-call objects into `AgentToolExchange` to consume it.
 *
 * Fixes land here and reach every family. The state this exists to prevent was real:
 * OpenAI-only, GLM unable to discover apps at all, Grok forked. A conformance guard fails
 * the build if a family re-implements any of it.
 *
 * THIS FILE IS THE PUBLIC SURFACE and nothing else. The harness was one 823-line module;
 * it is now split by JOB, the same way `manifests/runtime/` is, so a reader looking for how
 * a turn ends is not scrolling past row-component rendering to find it.
 *
 *   types       the shapes, no behaviour
 *   memo        search once per conversation
 *   handoff     does this call end the turn?
 *   discovery   what spatial found, and what it unlocks
 *   rowComponents  rows that name a component, rendered rather than described
 *   lean        projecting a result down to what the model needs
 *   tools       minting a model tool from a discovered app
 *   invoke      THE ONE WIRE CALL, where our code ends and native MCP begins
 *   memory*     conversation ingest and user-memory hydration
 */

export type {
  AgentToolExchange,
  DiscoveredMCP,
  RowComponent,
  AgentToolDef,
  AppInvocationContext,
} from "./types.js";

export { DISCOVERY_TOOL_NAMES, parseDiscoveredMCPs, handleDiscoveryResult } from "./discovery.js";
export { searchOncePerConversation } from "./memo.js";
export { parseToolResult, hasDynamicHandoff, isTurnEndingHandoff } from "./handoff.js";
export { rowComponentsFromResults, renderRowComponents } from "./rowComponents.js";
export { leanToolResultForModel } from "./lean.js";
export { toolDefFromDiscoveredMCP, resolveToolDefNative, isBindinglessComponentApp, componentAppInvoker } from "./tools.js";
export { invokeComponentAppNative } from "./invoke.js";

export { ingestConversationTurn, type ConversationTurn } from "./memoryIngest.js";
export { fetchUserMemoryContext, hydratePromptWithUserMemory } from "./memoryContext.js";
