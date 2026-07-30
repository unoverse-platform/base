/**
 * THE MEMORY LANES — the two harness calls every legacy agent made and the manifest
 * executor stopped making, which is how the memory system sat healthy-but-idle after the
 * migration: a running memory server, an empty ingest stream, and toggles that had
 * vanished from the UI because no manifest declared them.
 *
 * Wired at the EXECUTOR, not in any manifest, mirroring how the engine injects the
 * goal-memory toolset from the same flags (PlatformMemoryCore): a node declares
 * `enableUserMemory` / `enableAgentMemory` in its config and the platform does the rest.
 * Both lanes self-gate on the toggle and on identity, so a node without the fields, a
 * bench run, or a headless caller costs nothing.
 *
 * The implementations live in ../../agent-mcp (memoryContext.ts / memoryIngest.ts) —
 * they moved there in the harness extraction and are TRANSCRIBED conventions:
 * hydration prepends the user's context snapshot to the USER PROMPT (never the system
 * prompt — facts that ride the request refresh every turn and survive prompt caching),
 * and ingest saves original input + final answer, never tool chatter.
 */

/** Prepend the user's memory context to config.prompt when the toggle is on. */
export async function hydrateMemory(config: any, executionContext: any): Promise<any> {
  if (config?.enableUserMemory !== true || typeof config?.prompt !== "string") return config;
  try {
    const harness: any = await import("../../agent-mcp/index.js");
    const prompt = await harness.hydratePromptWithUserMemory(config, executionContext, console, config.prompt);
    return prompt === config.prompt ? config : { ...config, prompt };
  } catch (e: any) {
    // Non-blocking, exactly as the legacy hydration was: memory enriches a run, it
    // never gates one.
    console.log(`[manifests] user-memory hydration failed (non-blocking): ${e?.message ?? e}`);
    return config;
  }
}

/**
 * Save the completed turn (original input + final answer) to the memory server.
 * Fire-and-forget; `ingestConversationTurn` itself gates on the toggle and identity.
 * The answer is read off the node's own outputs — `text` is the settled connector on
 * every agent family (the streamed `stream` connector carries the same final value).
 */
export async function ingestMemoryTurn(
  nodeType: string,
  config: any,
  executionContext: any,
  outputs: Record<string, unknown>,
): Promise<void> {
  if (config?.enableUserMemory !== true) return;
  const answer = outputs?.text ?? outputs?.stream ?? outputs?.output;
  if (typeof answer !== "string" || !answer) return;
  try {
    const harness: any = await import("../../agent-mcp/index.js");
    harness.ingestConversationTurn(
      config,
      executionContext,
      { userMessage: String(config?.prompt ?? ""), agentResponse: answer },
      console,
      nodeType,
    );
  } catch (e: any) {
    console.log(`[manifests] memory ingest failed (non-blocking): ${e?.message ?? e}`);
  }
}
