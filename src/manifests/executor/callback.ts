/** Emit-repeatedly. Streaming, iteration, or a tool exchange. */
import { performApi, performService } from "../runtime/index.js";
import { assertAuthorized } from "../runtime/authorize.js";
import { manifestFor } from "./lookup.js";
import { contextFor } from "./context.js";
import { sessionFor, stateStoreFor, audioLaneFor } from "./session.js";
import { refireAfterDocMutation } from "./refire.js";
import { toolBridgeFor } from "./toolBridge.js";
import { hydrateMemory, ingestMemoryTurn } from "./memory.js";

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
    const result = await performService(
      node,
      method,
      params ?? {},
      contextFor(node, {}, config, executionContext),
      stateStoreFor(executionContext),
      // The caller's live session, for a method that renders content cards. Assembled HERE
      // because the token is deliberately absent from the manifest's context and must stay
      // that way: the executor holds it and hands it to platform code, never to the manifest.
      sessionFor(executionContext),
    );
    await refireAfterDocMutation(node, method, config, executionContext);
    return result;
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
    // The USER-MEMORY lane, before the run: when the node's config declares the toggle,
    // the person's context snapshot rides the prompt (memory.ts — the executor's job,
    // never a manifest's). No toggle, no prompt, headless → passes through untouched.
    const hydratedConfig = await hydrateMemory(event.config, executionContext ?? this.executionContext);
    const ctx = contextFor(node, event.inputs, hydratedConfig, executionContext ?? this.executionContext);

    let emitted = 0;
    const { outputs } = await performApi(
      node,
      ctx,
      (e) => {
        // A `send` row addresses another NODE, not one of this node's connectors, so it never
        // becomes an output and never counts as one. It is delivered after the run, at the
        // executor boundary, which is the only layer holding the execution context.
        if (!e.emit) return;
        emitted++;
        emit({ __outputs: { [e.emit]: e.value } });
      },
      node.api?.toolExchange ? await toolBridgeFor(executionContext ?? this.executionContext) : undefined,
      stateStoreFor(executionContext ?? this.executionContext),
      // Only this executor gets the lane. A duplex session is always a CallbackNode, so a
      // PromiseNode has no use for it and should not be handed one.
      audioLaneFor(executionContext ?? this.executionContext),
      // The caller's live session, for a node that publishes template data — assembled by
      // the executor and never seen by the manifest, exactly as on the promise path.
      sessionFor(executionContext ?? this.executionContext),
    );

    // The settled result: whatever `finalize` produced, plus any connector the stream
    // never touched. Emitting the last streamed value again would double it.
    const streamed = new Set(node.api?.response?.events?.map((r: any) => r.emit) ?? []);
    const settled = Object.fromEntries(Object.entries(outputs).filter(([k]) => !streamed.has(k)));
    if (Object.keys(settled).length) emit({ __outputs: settled });

    // The turn complete — original input + final answer to user memory (fire-and-forget,
    // self-gating on the toggle; the ORIGINAL prompt, not the hydrated one, because the
    // memory block prepended above must not be re-ingested as something the user said).
    await ingestMemoryTurn(node.type, event.config, executionContext ?? this.executionContext, outputs);

    return { ...state, emitted, isComplete: true };
  }
}
