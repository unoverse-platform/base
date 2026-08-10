/**
 * Build the tool bridge from the platform's own harness.
 *
 * Every MCP judgement lives in ../../agent-mcp and is reached from here: what a
 * tool is, what a discovery result unlocks, when a turn ends, how much of a result the
 * model needs. The loop only owns the wire format. That split is what stops each agent
 * family re-making these decisions and drifting apart, which is how GLM and Grok ended
 * up unable to launch spatial apps.
 *
 * Returns undefined when nothing granted tools, and the node then runs as a single request.
 */
import type { ToolBridge } from "../runtime/index.js";

export async function toolBridgeFor(executionContext: any): Promise<ToolBridge | undefined> {
  const api = executionContext?.api;
  if (!api?.callService) return undefined;

  const harness: any = await import("../../agent-mcp/index.js");

  let schema: any;
  try {
    schema = await api.callService("getSchema", {}, executionContext);
  } catch {
    return undefined; // no MCP provider wired
  }
  if (!schema?.methods) return undefined;

  const core = new Set<string>(Object.keys(schema.methods));

  // Identity for a HELD app call: it renders on the caller's live session and elicits
  // from that human, so it needs the conversation, the turn, and the caller's token.
  // Using auth HERE is correct and different from exposing it to a manifest: this is the
  // platform calling its own internal /mcp on the user's behalf, not data deciding where
  // a secret goes.
  const pub = executionContext?.publishingContext;
  const identity = {
    conversationId: pub?.conversationId,
    userId: pub?.userId,
    chatId: pub?.chatId,
    accessToken: executionContext?.auth?.accessToken,
  };

  /**
   * Discovered PATH-B component apps, by tool name.
   *
   * These are NOT ordinary service calls. UNOVERSE_MCP_TEMPLATE_PROTOCOL §3.3/§4b: a
   * bindingless component app is invoked through the held `/mcp` call so the server
   * renders it, elicits from the user, and returns their answers AND the
   * post-elicitation guidance to the model. Routing one through callService instead
   * would silently drop elicitation — the app would render and the model would never
   * learn what the human said.
   */
  const appInvokers = new Map<string, (input: unknown) => Promise<unknown>>();

  /**
   * Which apps this run has already unlocked, by component name.
   *
   * The harness keys the shell-open off this set: an app opens its page ONCE per run, and a
   * later search that surfaces the same row again must not fire a second skeleton over a page
   * the guest is already reading. Owned per bridge, so two agents in one workflow do not
   * share each other's unlocks.
   */
  const discoveredApps = new Set<string>();

  const stringify = (r: unknown): string => (typeof r === "string" ? r : JSON.stringify(r));

  return {
    async discover() {
      return Object.entries<any>(schema.methods).map(([name, m]) => ({
        name,
        description: m.description || `Execute ${name}`,
        parameters: m.input || { type: "object", properties: {} },
      }));
    },

    async call(name, args) {
      const app = appInvokers.get(name);
      if (app) return stringify(await app(args));
      // A CONVERSATION SEARCHES A THING ONCE. Exact repeats are removed here rather than
      // asked for in the tool description, because asking did not hold. Discovery tools
      // only, exact matches only, and never down to an empty search.
      const sent = harness.dropRepeatedQueries(identity.conversationId, name, args, (m: string) =>
        console.log(`[manifests] ${m}`),
      );
      return stringify(await api.callService(name, sent, executionContext));
    },

    /**
     * THE HARNESS'S OWN ABSORBER, called once — which is what every legacy agent did
     * (`runOpenAIAgent.ts:580`) and what this bridge stopped doing.
     *
     * It was re-implemented here as two halves, a mint and a lean, and the step BETWEEN them
     * was simply absent: the shell-open. `handleDiscoveryResult` says so at the top of itself
     * — "never re-implemented in an adapter" — and the reason is this exact failure. Nothing
     * errored. The tool was minted, the model answered, and the page never appeared until the
     * model composed it, with none of the `__draftRefs` that let the server paint the hero
     * and galleries from the rows the search had already returned.
     *
     * `onAppUnlocked` is where the mint goes now: the harness decides WHEN an app is newly
     * unlocked, and this decides what a tool looks like to the model. Awaited, so the tool is
     * registered before the model's next turn reads it.
     */
    async absorb(toolName, resultContent) {
      const minted: any[] = [];
      const content = await harness.handleDiscoveryResult(
        toolName,
        resultContent,
        discoveredApps,
        identity,
        (m: string) => console.log(`[manifests] ${m}`),
        async (mcp: any) => {
          // The app's input schema is read LIVE from its URI at mint time; spatial rows
          // carry no schema copy. For a BRIEFED component that schema is the instruction
          // channel, so the model hydrates real fields instead of following prose.
          const def = await harness.resolveToolDefNative(mcp, { accessToken: identity.accessToken });
          appInvokers.set(def.name, harness.componentAppInvoker(mcp, identity));
          minted.push({ name: def.name, description: def.description, parameters: def.parameters });
        },
      );

      /**
       * PATH-A apps, minted here because the absorber's callback does not cover them.
       *
       * `onAppUnlocked` fires only for a bindingless PATH-B component app — the kind that
       * needs a shell-open and a live schema read. A workflow-bound app carries its contract
       * on the row and needs neither, so the harness has nothing to unlock and never calls
       * back. It still has to become a tool, which is what this does.
       *
       * Deduped downstream by tool name, so re-minting on a later search is harmless.
       */
      if (harness.DISCOVERY_TOOL_NAMES.includes(toolName))
        for (const mcp of harness.parseDiscoveredMCPs([{ name: toolName, resultContent }]))
          if (!harness.isBindinglessComponentApp(mcp)) {
            const def = harness.toolDefFromDiscoveredMCP(mcp);
            minted.push({ name: def.name, description: def.description, parameters: def.parameters });
          }

      return { content, minted };
    },

    endsTurn(calls) {
      return harness.isTurnEndingHandoff(calls, core);
    },
  };
}
