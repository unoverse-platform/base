/**
 * SEARCH ONCE PER CONVERSATION.
 *
 * Spatial's answer for a query does not change within a conversation, but a grounded model
 * re-retrieves its sources before writing each section. That is rational under "verbatim
 * content only" pressure, and it was observed live: the same venue searched four times in
 * one page build. So repeats are made FREE rather than forbidden.
 */
import { DISCOVERY_TOOL_NAMES } from "./discovery.js";


/**
 * SEARCH ONCE PER CONVERSATION: spatial's answer for a query does not change within a
 * conversation, but a grounded model re-retrieves its sources before writing each
 * section (rational under "verbatim content only" pressure — observed live: the same
 * venue searched 4× in one page build). So repeats are made FREE instead of forbidden:
 * the first run of a query is stored per conversation and every repeat — case,
 * punctuation and ™-insensitive — is served from the store with no spatial trip.
 * Non-discovery tools and query-less calls pass straight through.
 */
const searchMemo = new Map<string, unknown>();
const SEARCH_MEMO_MAX = 500;

export async function searchOncePerConversation(
  conversationId: string | undefined,
  toolName: string,
  args: unknown,
  run: () => Promise<unknown>,
  log?: (msg: string) => void,
): Promise<unknown> {
  const a = args as { query?: unknown; queries?: unknown } | undefined;
  const norm = (q: string): string => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  // Signature covers BOTH calling forms: single `query`, or a `queries` batch
  // (order-insensitive — the same set of angles is the same search).
  const batch = Array.isArray(a?.queries) ? (a!.queries as unknown[]).map((q) => String(q ?? "")).filter(Boolean) : [];
  const signature =
    typeof a?.query === "string" && a.query.trim()
      ? norm(a.query)
      : batch.length
        ? batch.map(norm).sort().join(" | ")
        : "";
  if (!conversationId || !signature || !DISCOVERY_TOOL_NAMES.includes(toolName)) {
    return run();
  }
  const key = `${conversationId}:${toolName}:${signature}`;
  if (searchMemo.has(key)) {
    log?.(`♻️ ${toolName} repeat served from conversation store: "${signature.slice(0, 80)}"`);
    return searchMemo.get(key);
  }
  const result = await run();
  if (searchMemo.size >= SEARCH_MEMO_MAX) {
    const oldest = searchMemo.keys().next().value;
    if (oldest !== undefined) searchMemo.delete(oldest);
  }
  searchMemo.set(key, result);
  return result;
}
