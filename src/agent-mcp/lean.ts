/**
 * PROJECTING A RESULT DOWN TO WHAT THE MODEL NEEDS.
 *
 * A search result carries far more than the model can use, and everything it does not use
 * is context it pays for. The full rows are still used for minting tools; this is only what
 * goes back into the conversation.
 */

// Model-usable metadata fields — everything the calling LLM has ever actually used from
// a search row. The RAW rows (full bodyCopy markdown, openGraph, jsonLd, questions,
// crawl bookkeeping) are for the SERVER side — the card lane and app mint consume them
// BEFORE this projection is applied — and were costing ~100k tokens per search in the
// model's thread (observed live: context-window overflow on the first refinement turn).
const MODEL_METADATA_FIELDS = [
  "title",
  "tagline",
  "shortDescription",
  "introParagraph",
  "callToAction",
  // NO raw image URLs (primaryImage/images): with ref-hydration the model references a
  // row by universal_id and the SERVER fills the bytes — `hasImage` is all it needs.
  "app",
  /**
   * A NEED's one editorial field: the short verb its page leads with ("Advance Career",
   * "Explore Jobs", "Check Requirements"). Needs are extracted rather than authored, so they
   * carry none of the five fields above and reached the model with no metadata at all.
   *
   * Here AND in the node's own keep-list, because this projection runs second and drops
   * whatever it does not name: either half alone is a no-op. `questions` was considered and
   * left out — four sentences a row is the cost this projection exists to avoid.
   */
  "action",
  "name",
  "kind",
  "org",
  "category",
  "whenToUse",
  "section",
] as const;

/**
 * LEAN RESULT FOR THE MODEL: project a search-shaped tool result down to the fields the
 * calling LLM actually uses (title/description/needs/URL/real image URLs/similarity —
 * and for app rows the discovery meta; the app's input schema already rides the MINTED
 * TOOL, never re-sent here). Non-search results pass through untouched. Applied AFTER
 * card rendering and app discovery, which need the full rows.
 */
export function leanToolResultForModel(resultContent: string): string {
  try {
    const parsed = JSON.parse(resultContent);
    if (!parsed || !Array.isArray(parsed.results)) return resultContent;
    const lean = {
      count: parsed.count,
      results: parsed.results.map((r: Record<string, any>) => {
        const m = (r.metadata ?? {}) as Record<string, unknown>;
        const meta: Record<string, unknown> = {};
        for (const k of MODEL_METADATA_FIELDS) if (m[k] !== undefined) meta[k] = m[k];
        // hasImage: precomputed by the node's projection, else derived — the model's
        // signal that this row can serve as an image REF (it never sees the URL).
        const hasImage =
          r.hasImage ??
          Boolean(
            (typeof m.primaryImage === "string" && m.primaryImage) ||
              (Array.isArray(m.images) && m.images.length) ||
              r.object_type === "image",
          );
        return {
          // The row's HANDLE — hydration refs and follow-up lookups address by this.
          universal_id: r.universal_id,
          title: r.title,
          description: r.description,
          ...(r.key_need ? { key_need: r.key_need } : {}),
          object_type: r.object_type,
          // One relevance number per mode: similarity (intent) or distance (discovery).
          ...(typeof r.similarity === "number" ? { similarity: r.similarity } : {}),
          ...(typeof r.distance === "number" ? { distance: r.distance } : {}),
          source_url: r.source_url,
          hasImage,
          ...(Object.keys(meta).length ? { metadata: meta } : {}),
        };
      }),
    };
    return JSON.stringify(lean);
  } catch {
    return resultContent;
  }
}

/**
 * THE ONE DISCOVERY ABSORBER — what EVERY agent family does with a discovery tool's
 * result, in one place (never re-implemented in an adapter):
 *   1. UNLOCK: each discovered component app's tool joins `discoveredApps` — the set a
 *      native MCP attachment's `toolFilter` reads, so the app appears in the model's
 *      next `tools/list` (spatial selects; MCP serves).
 *   2. SHELL-OPEN (fire-and-forget): one empty native call per newly discovered app —
 *      the server renders the page SKELETON immediately, so the guest sees the page
 *      exist seconds in and watches it hydrate, never a blank panel while the model
 *      composes.
 *   3. LEAN: returns the model-facing projection of the rows (full cargo was already
 *      consumed by the card lane and this unlock pass; raw rows cost ~100k tokens).
 * Non-discovery results pass through untouched.
 *
 * `onAppUnlocked` — fired ONCE per newly-unlocked path-B app, and AWAITED before the lean
 * result returns. A family that mints its own SDK tool per app (rather than exposing them
 * through a native MCP attachment's `toolFilter`) wires the mint here: parsing + dedup stay
 * in this one absorber, and the tool is registered before the model's next turn reads it.
 */
