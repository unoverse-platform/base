/**
 * The TWO executors every manifest node shares.
 *
 * There are exactly two, not one per node. A node's identity, ports, config and
 * selection text are DATA in the registry; the code that performs it is one of these
 * classes. Which one is decided by `kind`, and the split exists only because the
 * platform genuinely has two execution shapes: settle-once (PromiseNode) and
 * emit-repeatedly (CallbackNode). The registry itself derives executionMode by
 * checking whether the prototype has initializeState, so the shapes cannot be merged.
 *
 * They are STATELESS with respect to which node they are running. The manifest is
 * looked up by nodeType at execution time rather than closed over at registration,
 * which is what keeps this at two classes instead of one per manifest. It also means
 * a reload swaps behaviour with no re-registration: the class stays, the data moves.
 *
 * SLICE 1 (this file) stands nodes up in the catalog with executors that refuse to
 * run. Deliberate: a manifest node should be visible, wireable and inspectable before
 * it is runnable, and a node that silently returns nothing is far worse to debug than
 * one that says exactly what is missing.
 *
 * SLICE 2 fills in the bodies: auth schemes, template resolution into the request,
 * transports, `return` expression mapping, and the tool exchange.
 */
import type { ComposedNode } from "./compose.js";
import { performApi, performService, applyResolvers, emptyContext, makeStateStore, type RunContext, type ToolBridge } from "./runtime/index.js";
import { assertAuthorized } from "./runtime/authorize.js";

/**
 * Build the tool bridge from the platform's own harness.
 *
 * Every MCP judgement lives in ../agent-mcp and is reached from here: what a
 * tool is, what a discovery result unlocks, when a turn ends, how much of a result the
 * model needs. The loop only owns the wire format. That split is what stops each agent
 * family re-making these decisions and drifting apart, which is how GLM and Grok ended
 * up unable to launch spatial apps.
 *
 * Returns null when nothing granted tools, and the node then runs as a single request.
 */
/** Set by the loader so both executors can resolve their manifest by node type. */
let lookup: (type: string) => ComposedNode | undefined = () => undefined;

export function setManifestLookup(fn: (type: string) => ComposedNode | undefined): void {
  lookup = fn;
}

function manifestFor(type: string): ComposedNode {
  const node = lookup(type);
  if (!node) throw new Error(`No manifest loaded for node type "${type}" — it may have been unloaded mid-run.`);
  return node;
}

/**
 * Build what a manifest's templates and expressions may see.
 *
 * `config` arrives ALREADY RESOLVED: the engine runs its template resolver before it
 * calls execute, so {{signal.x}} and {{prompt.y}} an author wrote in a config field are
 * plain text by the time they reach here.
 *
 * `executionContext.auth.accessToken` — the CALLER'S JWT (AUTH_TOKEN_FLOW.md) — is
 * DELIBERATELY WITHHELD, and must stay that way. A code node may reach it because a code
 * node is bounded by provenance; a manifest is data that can arrive by paste or database
 * row. The blast radii are not comparable: a third-party API key reaches that vendor
 * account, while a platform JWT IS the user against our own services, so a pasted
 * manifest could forward it to any host its allowedHosts list allows.
 *
 * `auth.user` — the signed-in person's email, id and name — IS exposed, as `user`. That
 * is not a softening of the rule, it is the rule applied to a different thing: an email
 * authenticates nothing, and it is the join key every CRM, support and account node needs.
 * Withholding it would force those nodes to take identity off the WIRE, which is strictly
 * worse: a caller could then ask for someone else's record. Never widen this to the token.
 *
 * The tool bridge below DOES use the token, and that is not a contradiction: there the
 * platform is calling its own internal /mcp on the user's behalf, rather than data
 * deciding where a secret goes.
 */
function contextFor(node: ComposedNode, inputs: any, config: any, executionContext: any): RunContext {
  const user = executionContext?.auth?.user ?? {};
  return emptyContext({
    config: applyResolvers(config ?? {}, node),
    // The bag holds EVERY credential in the workflow keyed by name. Selecting by name is
    // the manifest's job, which is what stops a node authenticating with a neighbour's
    // apiKey (04-credentials.md).
    credentials: executionContext?.credentials ?? {},
    signal: inputs ?? {},
    services: executionContext?.services ?? {},
    // Picked field by field, never spread: a future field on auth.user must be an explicit
    // decision to expose, not something a manifest silently inherits.
    user: { email: user.email, id: user.id ?? user.sub, name: user.name },
    // The PLATFORM's ids, which is what state keys are built from. Same precedence the
    // retired CRM code used, and it is not interchangeable with user.id above.
    //
    // `conversationId` and `chatId` are here because the AUDIO LANE is keyed by conversation.
    // Their absence was a silent, total failure of the voice node: `runDuplexSession` fell back
    // to the node TYPE as its key, so `setAudioDataHandler` compared the client's real session id
    // against the string "OpenAIRealtimeVoice", dropped every microphone frame, and sent the
    // model's audio to a conversation nobody was listening on. No error anywhere — just silence.
    //
    // Same precedence the retired node used: publishingContext first, then workflow variables.
    scope: {
      userId: executionContext?.publishingContext?.userId ?? executionContext?.workflow?.variables?.userId,
      workflowId: executionContext?.workflowId ?? executionContext?.workflow?.id,
      conversationId:
        executionContext?.publishingContext?.conversationId ?? executionContext?.workflow?.variables?.conversationId,
      chatId: executionContext?.publishingContext?.chatId ?? executionContext?.workflow?.variables?.chatId,
      executionId: executionContext?.executionId,
      // Which INSTANCE on the canvas. The retired Code node fell back to the literal "code" when
      // this was missing, which meant two Code nodes minted the same universal id and the saved
      // context stored them under one key. Passing it through rather than defaulting is what makes
      // that failure impossible instead of merely unlikely.
      nodeId: executionContext?.nodeId,
      /**
       * THE PLATFORM'S OWN API, for a node that calls us rather than a vendor.
       *
       * DERIVED, not configured. A node runs INSIDE the unoverse service, so it is calling itself —
       * asking a developer to supply the platform's own address would be configuration for something
       * the process already knows. `UNOVERSE_RUNTIME_PORT` is the internal listener and is already set
       * in docker-compose; the server reads it the same way (`RUNTIME_PORT`), and already builds its own
       * loopback url as `http://127.0.0.1:${port}` elsewhere.
       *
       * LOOPBACK, not a service name: :4106 is the UNGATED internal listener, published to 127.0.0.1
       * only and never widened. Reaching it from anywhere else would be a mistake, so the address says
       * so.
       *
       * The retired SpatialIngest read UNOVERSE_SERVICE_URL with a `|| "http://localhost:4106"`
       * fallback — a variable that is set NOWHERE in this repo, so the fallback was the whole
       * behaviour. Deriving it removes both the dead variable and the hardcoded string.
       */
      platformUrl: `http://127.0.0.1:${process.env.UNOVERSE_RUNTIME_PORT ?? 4106}`,
    },
  });
}

/**
 * The platform's audio lane, through the same handle a code node already gets.
 *
 * `null` when the platform has no lane, and that is NOT an error: a voice node with nowhere to
 * send audio still holds a valid conversation with the vendor, and its transcripts still reach
 * the workflow over the events table. Only the audio is lost, which is the correct degradation
 * for a headless run.
 */
function audioLaneFor(executionContext: any) {
  return executionContext?.api?.getAudioWebSocketManager?.() ?? null;
}

/** Redis, through the handle the plugin library already provides to a code node. */
function stateStoreFor(executionContext: any) {
  return makeStateStore(executionContext?.api?.getRedisClient?.() ?? null, process.env.REDIS_NAMESPACE);
}

async function toolBridgeFor(executionContext: any): Promise<ToolBridge | undefined> {
  const api = executionContext?.api;
  if (!api?.callService) return undefined;

  const harness: any = await import("../agent-mcp/index.js");

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
      const result = app ? await app(args) : await api.callService(name, args, executionContext);
      return typeof result === "string" ? result : JSON.stringify(result);
    },

    async mintFrom(toolName, resultContent) {
      // Only discovery tools carry mintable rows; the harness owns which those are.
      if (!harness.DISCOVERY_TOOL_NAMES.includes(toolName)) return [];

      const minted: any[] = [];
      for (const mcp of harness.parseDiscoveredMCPs([{ name: toolName, resultContent }])) {
        if (harness.isBindinglessComponentApp(mcp)) {
          // The app's input schema is read LIVE from its URI at mint time; spatial rows
          // carry no schema copy. For a BRIEFED component that schema is the instruction
          // channel, so the model hydrates real fields instead of following prose.
          const def = await harness.resolveToolDefNative(mcp, { accessToken: identity.accessToken });
          appInvokers.set(def.name, harness.componentAppInvoker(mcp, identity));
          minted.push({ name: def.name, description: def.description, parameters: def.parameters });
        } else {
          const def = harness.toolDefFromDiscoveredMCP(mcp);
          minted.push({ name: def.name, description: def.description, parameters: def.parameters });
        }
      }
      return minted;
    },

    endsTurn(calls) {
      return harness.isTurnEndingHandoff(calls, core);
    },

    lean(resultContent) {
      return harness.leanToolResultForModel(resultContent);
    },
  };
}

/** Settle-once. One request, one result. */
export class ManifestPromiseExecutor {
  logger: any = console;
  constructor(readonly nodeType: string) {}


  /**
   * The SERVICE channel: a method another node called over a service edge.
   *
   * Independent of the workflow channel. A service call returns a value to the caller
   * and does NOT fire this node's output connectors; a graph trigger fires the outputs
   * and does not answer a caller. The two never cross (08-mcp-services.md).
   */
  async handleServiceCall(method: string, params: any, config: any, executionContext: any): Promise<unknown> {
    const node = manifestFor(this.nodeType);
    // The service channel is gated too, and it is the one that would be missed. A node
    // reached over a service edge never fires its own connectors, so it is easy to think of
    // as an internal detail of the caller. It is not: it runs this node's calls with this
    // node's credentials, and leaving it open would make a service edge the way around a
    // role rather than a way to reuse a capability.
    assertAuthorized(node, executionContext, config);
    return performService(node, method, params ?? {}, contextFor(node, {}, config, executionContext), stateStoreFor(executionContext));
  }

  async execute(inputs: any, config: any, executionContext: any): Promise<{ __outputs: Record<string, unknown> }> {
    const node = manifestFor(this.nodeType);
    // BEFORE anything is built or sent, so a refused run costs no vendor request, no token,
    // and no side effect. Authorization that runs after the call has gone out is an audit
    // log, not a gate.
    assertAuthorized(node, executionContext, config);
    const { outputs } = await performApi(
      node,
      contextFor(node, inputs, config, executionContext),
      () => {},
      node.api?.toolExchange ? await toolBridgeFor(executionContext) : undefined,
      stateStoreFor(executionContext),
    );
    // Outputs go back TOP-LEVEL under __outputs; anything else never reaches a
    // downstream node.
    return { __outputs: outputs };
  }
}

/** Emit-repeatedly. Streaming, iteration, or a tool exchange. */
export class ManifestCallbackExecutor {
  logger: any = console;
  executionContext: any = null;
  constructor(readonly nodeType: string) {}


  /**
   * The SERVICE channel: a method another node called over a service edge.
   *
   * Independent of the workflow channel. A service call returns a value to the caller
   * and does NOT fire this node's output connectors; a graph trigger fires the outputs
   * and does not answer a caller. The two never cross (08-mcp-services.md).
   */
  async handleServiceCall(method: string, params: any, config: any, executionContext: any): Promise<unknown> {
    const node = manifestFor(this.nodeType);
    // The service channel is gated too, and it is the one that would be missed. A node
    // reached over a service edge never fires its own connectors, so it is easy to think of
    // as an internal detail of the caller. It is not: it runs this node's calls with this
    // node's credentials, and leaving it open would make a service edge the way around a
    // role rather than a way to reuse a capability.
    assertAuthorized(node, executionContext, config);
    return performService(node, method, params ?? {}, contextFor(node, {}, config, executionContext), stateStoreFor(executionContext));
  }

  /** Presence of this method is what makes the registry record executionMode "generator". */
  initializeState(): Record<string, unknown> {
    return { emitted: 0 };
  }

  /**
   * emit() sends outputs, the RETURN VALUE signals completion. They are separate
   * channels: returning the outputs instead of emitting them loses them, and omitting
   * isComplete leaks the actor and can hang the workflow.
   */
  async handleEvent(
    event: { type: string; inputs?: any; config?: any },
    state: Record<string, unknown>,
    emit: (output: any) => void,
    executionContext?: any,
  ): Promise<Record<string, unknown>> {
    const node = manifestFor(this.nodeType);
    // Same gate on the streaming path. `this.executionContext` is the fallback the callback
    // channel already uses, so the identity checked here is the identity the run carries.
    assertAuthorized(node, executionContext ?? this.executionContext, event.config);
    const ctx = contextFor(node, event.inputs, event.config, executionContext ?? this.executionContext);

    let emitted = 0;
    const { outputs } = await performApi(
      node,
      ctx,
      (e) => {
        emitted++;
        emit({ __outputs: { [e.emit]: e.value } });
      },
      node.api?.toolExchange ? await toolBridgeFor(executionContext ?? this.executionContext) : undefined,
      stateStoreFor(executionContext ?? this.executionContext),
      // Only this executor gets the lane. A duplex session is always a CallbackNode, so a
      // PromiseNode has no use for it and should not be handed one.
      audioLaneFor(executionContext ?? this.executionContext),
    );

    // The settled result: whatever `finalize` produced, plus any connector the stream
    // never touched. Emitting the last streamed value again would double it.
    const streamed = new Set(node.api?.response?.events?.map((r: any) => r.emit) ?? []);
    const settled = Object.fromEntries(Object.entries(outputs).filter(([k]) => !streamed.has(k)));
    if (Object.keys(settled).length) emit({ __outputs: settled });

    return { ...state, emitted, isComplete: true };
  }
}

/**
 * The class a node of this kind registers.
 *
 * Returns one of the two shared classes. The registry stores the class and
 * constructs it with the node type, so nothing here is per-manifest.
 */
export function executorForKind(kind: ComposedNode["kind"]): any {
  return kind === "CallbackNode" ? ManifestCallbackExecutor : ManifestPromiseExecutor;
}
