/**
 * Bringing this universe's installed items onto disk, and keeping them current.
 *
 * ONE ENTRY POINT, THREE MOMENTS. Boot, install, and publish all mean the same thing —
 * "what this universe holds has changed, make the disk say so" — so they call one
 * function rather than three that drift. Nodes already learned this the hard way: they
 * have a reload route AND an install route, and the install route never called it, so
 * installing a node did nothing until something else happened to reload.
 *
 * NOT FATAL. A universe that cannot reach its engine for a moment should come up serving
 * whatever it hydrated last, exactly as `fetchNodeRows` degrades. Throwing here would turn
 * a blip into a universe with no design system.
 *
 * NODES ARE NOT HERE. They are already read from rows by the manifest loader
 * (manifests/rows.ts) and registered as nodes rather than written as files. Hydrating them
 * too would give one thing two homes.
 */
import { hydrateInstalled, type InstalledRow, type HydrateResult } from "./hydrate.js";
import { clearPromptBlockCache } from "./loaders.js";

const ENGINE = process.env.WORKFLOW_SERVICE_URL || "http://localhost:4101";

/** Kinds that become files. `node` loads through the manifest source; `recipe` is copied
 *  onto a canvas and never installed. */
const HYDRATED_KINDS = ["component", "atom", "style", "template", "skill", "prompt-block"];

/**
 * Re-read the installed items and rewrite the installed root.
 *
 * Returns what happened so a caller can log it: silence here is the failure mode that
 * cost a day, where an install wrote rows and nothing said whether they took effect.
 */
export async function refreshInstalled(): Promise<HydrateResult & { fetched: number }> {
  let rows: InstalledRow[] = [];
  try {
    const res = await fetch(`${ENGINE}/items`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { items?: InstalledRow[] };
    rows = (data.items ?? []).filter((r) => HYDRATED_KINDS.includes(r.kind));
  } catch (error: any) {
    console.warn(`[unoverse:installed] could not read items (${error?.message ?? error}); keeping what is on disk`);
    return { written: 0, skipped: [], fetched: 0 };
  }

  const result = hydrateInstalled(rows);

  // The blocks cache is held in memory and would otherwise outlive the files it was built
  // from. Definitions cache on a directory signature, so rewriting them is enough.
  clearPromptBlockCache();

  for (const s of result.skipped) console.warn(`[unoverse:installed] skipped ${s.kind}/${s.name}: ${s.why}`);
  console.log(`[unoverse:installed] ${result.written} of ${rows.length} item(s) on disk`);
  return { ...result, fetched: rows.length };
}
