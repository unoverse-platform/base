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
 * looked up by nodeType at execution time rather than closed over at registration
 * (lookup.ts), which is what keeps this at two classes instead of one per manifest. It
 * also means a reload swaps behaviour with no re-registration: the class stays, the
 * data moves.
 *
 * ONE FILE PER JOB:
 *
 *   lookup.ts       how an executor finds its manifest by node type
 *   context.ts      what a MANIFEST may see — and the token it must never see
 *   session.ts      what the executor hands to PLATFORM code (session, state, audio)
 *   toolBridge.ts   the agent harness, bridged into the tool loop
 *   refire.ts       the hybrid contract: a doc mutation re-fires the workflow channel
 *   promise.ts      settle-once
 *   callback.ts     emit-repeatedly
 *
 * `contextFor` is deliberately NOT re-exported here: everything outside this folder
 * receives a RunContext already built, and a second builder is how the token rule would
 * eventually be widened by accident.
 */
import type { ComposedNode } from "../compose.js";
import { ManifestPromiseExecutor } from "./promise.js";
import { ManifestCallbackExecutor } from "./callback.js";

export { setManifestLookup } from "./lookup.js";
export { ManifestPromiseExecutor } from "./promise.js";
export { ManifestCallbackExecutor } from "./callback.js";

/**
 * The class a node of this kind registers.
 *
 * Returns one of the two shared classes. The registry stores the class and
 * constructs it with the node type, so nothing here is per-manifest.
 */
export function executorForKind(kind: ComposedNode["kind"]): any {
  return kind === "CallbackNode" ? ManifestCallbackExecutor : ManifestPromiseExecutor;
}
