/** Settle-once. One request, one result. */
import { performApi, performService } from "../runtime/index.js";
import { assertAuthorized } from "../runtime/authorize.js";
import { manifestFor } from "./lookup.js";
import { contextFor } from "./context.js";
import { sessionFor, stateStoreFor } from "./session.js";
import { refireAfterDocMutation } from "./refire.js";
import { toolBridgeFor } from "./toolBridge.js";

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
      // No audio lane on the promise path (a duplex session is always a CallbackNode).
      undefined,
      // The caller's live session, for a node that publishes template data. Assembled here
      // for the same reason as the service channel's: the executor holds the identity and
      // hands it to platform code, never to the manifest.
      sessionFor(executionContext),
    );
    // Outputs go back TOP-LEVEL under __outputs; anything else never reaches a
    // downstream node.
    return { __outputs: outputs };
  }
}
