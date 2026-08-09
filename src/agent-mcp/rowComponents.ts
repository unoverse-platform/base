/**
 * ROW COMPONENTS: a search result row may NAME a component, and surfacing the row renders
 * that component rather than describing it.
 *
 * It is whatever component the row attached — a page, a chart, a document, a product panel.
 * Nothing here is card-shaped; the lane was called "cards" for its first use and the name
 * outlived the accuracy (renamed 2026-08-09).
 *
 * Deduped per conversation, because a component already on screen must not be pushed again
 * when a later search returns the same row.
 */
import type { RowComponent, AppInvocationContext } from "./types.js";
import { invokeComponentAppNative } from "./invoke.js";
// Pure section helpers, shared with every renderer so the rules live in one place.
import { toDocument } from "../markdown/document.js";


/**
 * Extract renderable COMPONENTS from search RESULT ROWS — content-tree rows
 * (service/need) with a component ATTACHED (`metadata.app`, no workflow).
 *
 * The attachment is a component URI, so it is ANY component the row's author chose,
 * not a card. (`unoverse://components/…` only: a row naming a template or carrying a
 * `workflow` is skipped — the latter is a TOOL the model calls.)
 *
 * These NEVER reach a model's toolset: the component renders DATA-DRIVEN the moment
 * discovery surfaces its row — the conversation flows normally and it simply appears
 * (however many rows carry one). The model is neither asked nor able to decide; there
 * is no prompt. The lane executes in the SPATIAL SEARCH NODE (the search that produced
 * the rows renders them — every agent family gets the behavior by wiring the node), via
 * `renderRowComponents` below.
 */
export function rowComponentsFromResults(results: unknown): RowComponent[] {
  const out: RowComponent[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(results)) return out;
  for (const item of results as any[]) {
    if (item?.object_type === "mcp") continue; // registry apps are TOOLS (path A/B above)
    const app = item?.metadata?.app;
    if (typeof app !== "string" || !app.startsWith("unoverse://components/") || item.metadata.workflow) continue;
    const component = componentTypeFromAppUri(app);
    const id = String(item.id || item.universal_id || `${component}:${item.title ?? ""}`);
    if (!component || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      component,
      // The row's content IS the component's state. Row-level facts ride along:
      // `link` is the row's page as a LABELLED markdown link — tagline (fallback
      // title) linked to source_url, ready for a Markdown bind.
      props: {
        title: item.title,
        description: item.description,
        // EVERY row carries `sections`, so a renderer has ONE thing to read. A row promoted
        // before the structuring pass existed has only `bodyCopy`, which is a valid document
        // of one prose section — synthesised here rather than in each renderer, and never
        // overwriting the sections the row already carries.
        ...(!item.metadata.sections && item.metadata.bodyCopy
          ? { sections: [{ kind: "prose", heading: "", body: item.metadata.bodyCopy }] }
          : {}),
        ...(item.metadata.sections ? toDocument(item.metadata.sections, item.metadata.layout as string) : {}),
        ...(item.source_url
          ? { link: `[${item.metadata.tagline || item.title || item.source_url}](${item.source_url})` }
          : {}),
        ...item.metadata,
      },
    });
  }
  return out;
}

/**
 * Render the components discovered rows carry, on the caller's live session — the ONE
 * place this lane executes (every agent family calls this; adapters never re-implement
 * it). Renders are fire-and-forget (a display component declares no `outputs`, so the
 * held call resolves immediately server-side) and a failed render never breaks the
 * conversation.
 */
// ONCE PER CONVERSATION: overlapping searches keep re-surfacing the same rows, and
// re-rendering them re-fired every component's onStart (external API calls, again) and
// churned the client with redundant writes — the visible symptom was components
// SHUFFLING while a page loaded. A row renders once per conversation; the slice already
// exists after that, and real refinements still merge through the normal channels.
// Bounded like the search memo.
//
// ⚠ This is a LIFETIME rule (`turn` vs `conversation`) living in a search helper, where
// neither the app, the template, nor the ladder can see it. Observed 2026-08-09: a fresh
// question re-surfaced the same rows, every render was skipped, NOTHING reached the
// client, and the screen looked like a state-model bug. The component's own manifest
// `lifetime` is where this belongs.
const renderedByConv = new Map<string, Set<string>>();
const RENDERED_CONVS_MAX = 300;

export function renderRowComponents(
  items: RowComponent[] | undefined,
  ctx: AppInvocationContext,
  log?: (msg: string) => void,
): void {
  // No live session (builder/test/headless callers) → nothing to render; the
  // search stays pure automatically — no flag juggling needed by the caller.
  if (!items?.length || !ctx.userId) return;
  let rendered = ctx.conversationId ? renderedByConv.get(ctx.conversationId) : undefined;
  if (!rendered && ctx.conversationId) {
    if (renderedByConv.size >= RENDERED_CONVS_MAX) {
      const oldest = renderedByConv.keys().next().value;
      if (oldest !== undefined) renderedByConv.delete(oldest);
    }
    rendered = new Set();
    renderedByConv.set(ctx.conversationId, rendered);
  }
  let skipped = 0;
  for (const item of items) {
    if (rendered?.has(item.id)) {
      skipped++;
      continue;
    }
    rendered?.add(item.id);
    // Per-row instance id: keys the render `<component>:<rowId>` server-side, so
    // multiple rows sharing one component each get their OWN slice (and a repeat
    // render of the same row re-merges the same slice — idempotent, no dupes).
    /**
     * LOG ON SETTLE, NOT ON DISPATCH.
     *
     * This used to print "🧩 Rendered" on the line AFTER the call was fired, never awaited,
     * so it announced success before the wire call had done anything. A render that 401'd, that
     * named a tool the server had not registered, or that never came back at all read exactly
     * like one that worked — and a whole session went by treating that line as proof the components
     * were on screen. It was proof of nothing but that the lane had been reached.
     *
     * Still fire-and-forget: a slow render must not hold up the answer. Only the REPORT moved.
     * A held call that never settles now prints "dispatched" and nothing after it, which is
     * itself the diagnosis — silence used to be indistinguishable from success.
     */
    /**
     * THE IDENTITY IS THE PAYLOAD HERE. A render lands in a turn bubble keyed
     * `conversationId:chatId`, so a missing or stale chatId renders it into a turn nobody is
     * looking at — the server reports success and the screen stays empty, which is exactly
     * the state this lane was in when the call started succeeding but nothing appeared.
     */
    log?.(
      `🧩 dispatching ${item.component} (${item.id}) → conv=${ctx.conversationId ?? "MISSING"} ` +
        `chat=${ctx.chatId ?? "MISSING"} user=${ctx.userId ?? "MISSING"} token=${ctx.accessToken ? "yes" : "NO"}`,
    );
    // fromRow: this content came from the DATABASE, not from a model composing parts.
    // Without it the brief referee judges the row — a component that renders the Document
    // inherits its prose/keyFacts briefs and gets rejected for parts nobody composes.
    invokeComponentAppNative(item.component, { ...ctx, message: "", props: item.props, instanceId: item.id, fromRow: true })
      .then(() => log?.(`🧩 RENDERED ${item.component} (${item.id})`))
      .catch((e: any) => {
        // UN-POISON on failure: the optimistic add above guards concurrent dispatch,
        // but a failed render marked "rendered" disabled the row for the whole
        // conversation with one transient error. A later search may retry it.
        rendered?.delete(item.id);
        log?.(`🧩 FAILED ${item.component} (${item.id}) — ${e?.message ?? e}`);
      });
  }
  if (skipped) log?.(`🧩 ${skipped} row component(s) already rendered this conversation — skipped`);
}

// Model-usable metadata fields — everything the calling LLM has ever actually used from
// a search row. The RAW rows (full bodyCopy markdown, openGraph, jsonLd, questions,
// crawl bookkeeping) are for the SERVER side — the card lane and app mint consume them
// BEFORE this projection is applied — and were costing ~100k tokens per search in the
// model's thread (observed live: context-window overflow on the first refinement turn).

/** `unoverse://components/journey-finder` → `journey-finder` (the render type). */
export function componentTypeFromAppUri(app: string): string {
  return String(app).split("/").pop() || "";
}
