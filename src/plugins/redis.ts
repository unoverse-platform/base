/**
 * Node-meta guard. (Formerly also held the Redis node/credential catalog writers —
 * removed with the catalog repoint: the catalog now lives in the in-memory registry
 * and is pulled by workflow over HTTP, so there is nothing to write to Redis.)
 */

import { boot } from "../boot.js";

/**
 * Meta sync guard — LOUD signal whenever a batch of node defs is registered.
 *
 * `whenToUse` is the field the node ranker (CatalogService / semantic search)
 * embeds; if it's empty the search silently degrades to name+description. A stale
 * build or a freshly imported package that never authored it leaves the meta
 * unsynced with NO error. Call this right after registering a batch (startup,
 * import/update, reload) so a gap is visible at the moment it enters the registry.
 *
 * Returns the missing node types so callers can surface them in an API response too.
 */
export function warnMissingNodeMeta(defs: any[], context: string): { total: number; missing: string[] } {
  const missing = defs
    .filter((d: any) => !d?.whenToUse || !String(d.whenToUse).trim())
    .map((d: any) => d?.type)
    .filter(Boolean);
  // Only the shortfall is worth saying. "All 84 nodes have whenToUse" is the expected
  // state and a line that only ever reports success trains you to skim past it.
  if (missing.length > 0) {
    const named = `${missing.slice(0, 10).join(", ")}${missing.length > 10 ? `, and ${missing.length - 10} more` : ""}`;
    const text =
      `${missing.length} of ${defs.length} nodes have no whenToUse, so catalog ranking is degraded for them: ` +
      `${named}. Author whenToUse on the node, then rebuild and restart.`;
    if (boot.isBooting()) boot.notice("warn", text);
    else console.warn(`[${context}] ${text}`);
  }
  return { total: defs.length, missing };
}
