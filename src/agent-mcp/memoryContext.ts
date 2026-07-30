/**
 * User-memory context fetch — the READ twin of memoryIngest.ts.
 *
 * Harness-level (model-agnostic): when an agent node's User Memory toggle
 * (config.enableUserMemory) is ON, the harness fetches the user's standing
 * memory block (identity + current state, non-intrusion framing included)
 * from the memory server's GET /context at LOOP START and inlines it into the
 * agent's system context — memory arrives with the agent, never as a
 * model-visible tool call (MEMORY_SPEC.md v3 § Serving: zero-call standing lane).
 *
 * Every agent family calls this once when building its instructions. Soft-fail
 * by design: memory server down / cold / no identity → returns "" and the agent
 * simply starts ungrounded — memory must never block or fail the conversation.
 */

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || "http://localhost:4114";
const CONTEXT_FETCH_TIMEOUT_MS = 3_000;

/**
 * Fetch the user's standing memory block, ready to append to the agent's
 * system context. Resolves identity from the node's execution context; returns
 * "" when the toggle is off, identity is incomplete, or the fetch fails.
 * Never throws.
 */
export async function fetchUserMemoryContext(
  config: { enableUserMemory?: boolean },
  executionContext: any,
  logger: any,
): Promise<string> {
  if (config?.enableUserMemory !== true) return "";

  const pubCtx = executionContext?.publishingContext;
  const userId = pubCtx?.userId;
  const workflowId = executionContext?.workflow?.id;
  if (!userId || !workflowId) {
    logger?.debug?.("[MemoryContext] Skipped — incomplete identity", {
      hasUserId: !!userId,
      hasWorkflowId: !!workflowId,
    });
    return "";
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const accessToken = executionContext?.auth?.accessToken;
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

  try {
    const params = new URLSearchParams({ userId, workflowId });
    const res = await fetch(`${MEMORY_SERVICE_URL}/context?${params}`, {
      headers,
      signal: AbortSignal.timeout(CONTEXT_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger?.warn?.(`[MemoryContext] Fetch rejected: ${res.status}`);
      return "";
    }
    const data = (await res.json()) as { block?: string; count?: number; identity?: string | null };
    const block = typeof data.block === "string" ? data.block : "";
    if (block) {
      logger?.info?.("[MemoryContext] User context injected", {
        hasIdentity: !!data.identity,
        stateLines: data.count ?? 0,
        chars: block.length,
      });
    }
    return block;
  } catch (err: any) {
    logger?.warn?.(`[MemoryContext] Fetch failed (non-blocking): ${err?.message ?? err}`);
    return "";
  }
}

/**
 * THE standard user-memory hydration — the ONE call every agent family makes.
 *
 * When the User Memory toggle is on, the user's context snapshot (identity,
 * verified key facts, open tasks, learned state) is prepended to the USER
 * PROMPT of EVERY request — the input side, not the system prompt: facts that
 * ride with the request get factored into the answer, refresh each turn, and
 * survive previousResponseId resume + prompt caching.
 *
 * Families call `hydratePromptWithUserMemory(config, executionContext, logger,
 * prompt)` and send the result as the user turn. Toggle off / fetch failure →
 * the prompt passes through untouched. Do NOT hand-roll the concatenation in
 * node code — the convention lives here so it cannot drift per family.
 */
export async function hydratePromptWithUserMemory(
  config: { enableUserMemory?: boolean },
  executionContext: any,
  logger: any,
  prompt: string,
): Promise<string> {
  const block = await fetchUserMemoryContext(config, executionContext, logger);
  return block ? `${block}\n\n---\n\n${prompt}` : prompt;
}
