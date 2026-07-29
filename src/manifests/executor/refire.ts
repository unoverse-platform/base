/**
 * THE HYBRID CONTRACT (Pattern C, 08-mcp-services.md): a service method that MUTATED the
 * node's document re-fires the WORKFLOW channel, so a downstream renderer receives the
 * fresh markdown without the agent doing anything. Read methods must not re-fire — the
 * retired SmartDocument learned that live, when every outline() re-emitted the whole
 * document and flooded the renderer.
 *
 * Detection is by the method's own call list naming a mutating docstore op, so the manifest
 * cannot promise the contract and forget it: declaring the op IS declaring the re-fire.
 *
 * `executeNodeWithRouting` is the engine's own bridge (NodeExecutionUtils), reached through
 * the plugin api exactly as the retired executor reached it via getPlatform(). Absent
 * (tests, headless) the mutation still returns to the caller — the render is a side channel
 * and failures here are logged, never thrown, exactly as the retired node treated them.
 */
import { performApi, MUTATING_DOC_OPS } from "../runtime/index.js";
import { contextFor } from "./context.js";
import { stateStoreFor } from "./session.js";

export async function refireAfterDocMutation(node: any, method: string, config: any, executionContext: any): Promise<void> {
  const calls = node.api?.service?.[method]?.calls ?? [];
  if (!calls.some((c: any) => c.docstore && MUTATING_DOC_OPS.has(String(c.docstore)))) return;
  const route = executionContext?.api?.executeNodeWithRouting;
  if (typeof route !== "function") return;
  const run = async (_inputs: any, cfg: any, ec: any) => {
    const { outputs } = await performApi(node, contextFor(node, {}, cfg, ec), () => {}, undefined, stateStoreFor(ec));
    return { __outputs: outputs };
  };
  try {
    await route(run, {}, config, executionContext);
  } catch (e: any) {
    console.log(`[manifests] ${node.type}: post-mutation re-fire failed — ${e?.message ?? e}`);
  }
}
