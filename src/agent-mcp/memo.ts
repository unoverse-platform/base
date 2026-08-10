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

/**
 * A CONVERSATION SEARCHES A THING ONCE.
 *
 * `query` and every entry of `queries` is a separate search returning its own rows, so a
 * repeat spends result slots on material the conversation already holds and re-surfaces
 * every app row it surfaced the first time. The tool descriptions ask the model not to
 * repeat; this makes it so, because the descriptions did not hold: observed live
 * 2026-08-10, `discoverRelated` ran the guest's opening sentence, the app it found
 * collected six answers, and the follow-up `findIntent` led with that same sentence
 * again. Six of eleven rows came back answering the question the guest had already moved
 * past, and the app row came with them.
 *
 * ONLY EXACT REPEATS GO, normalized for case and punctuation, and scoped to one
 * conversation. This never invents a query, never reorders, and never empties a search:
 * if every entry is a repeat the args pass through untouched, because "you already
 * searched all of this" is the model's judgement to make, not a reason to send nothing.
 */
const searchedByConversation = new Map<string, Set<string>>();
const SEARCHED_MAX = 500;
const normalizeQuery = (q: string): string => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function dropRepeatedQueries(
  conversationId: string | undefined,
  toolName: string,
  args: unknown,
  log?: (msg: string) => void,
): unknown {
  if (!conversationId || !DISCOVERY_TOOL_NAMES.includes(toolName)) return args;
  const a = args as { query?: unknown; queries?: unknown } | undefined;
  if (!a || typeof a !== "object") return args;

  const single = typeof a.query === "string" && a.query.trim() ? a.query.trim() : "";
  const batch = Array.isArray(a.queries) ? a.queries.map((q) => String(q ?? "").trim()).filter(Boolean) : [];
  if (!single && !batch.length) return args;

  let seen = searchedByConversation.get(conversationId);
  if (!seen) {
    if (searchedByConversation.size >= SEARCHED_MAX) {
      const oldest = searchedByConversation.keys().next().value;
      if (oldest !== undefined) searchedByConversation.delete(oldest);
    }
    seen = new Set();
    searchedByConversation.set(conversationId, seen);
  }

  const isRepeat = (q: string) => seen!.has(normalizeQuery(q));
  const keptSingle = single && !isRepeat(single) ? single : "";
  const keptBatch = batch.filter((q) => !isRepeat(q));
  const dropped = [...(single && !keptSingle ? [single] : []), ...batch.filter((q) => isRepeat(q))];

  // EVERY entry was a repeat: pass through untouched rather than send an empty search.
  if (!keptSingle && !keptBatch.length) {
    log?.(`♻️ ${toolName}: every query already searched this conversation — sent as-is`);
    return args;
  }

  for (const q of [keptSingle, ...keptBatch]) if (q) seen.add(normalizeQuery(q));
  if (!dropped.length) return args;

  log?.(`✂️ ${toolName}: dropped ${dropped.length} already-searched quer${dropped.length === 1 ? "y" : "ies"} — "${dropped[0].slice(0, 60)}${dropped[0].length > 60 ? "…" : ""}"`);
  const next: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  if (keptSingle) next.query = keptSingle;
  else delete next.query;
  if (keptBatch.length) next.queries = keptBatch;
  else delete next.queries;
  return next;
}

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
