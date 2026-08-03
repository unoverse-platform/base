/**
 * UNOVERSE MARKDOWN — which fields the SERVER fills from a row, never the model.
 *
 * Split by JOB, the way `agent-mcp/` is: `index.ts` is the surface and carries the map.
 */

import type { Collected, ComponentDefLike } from "./types.js";
import { collect } from "./collect.js";
import { refName, HYDRATE_NO_OVERRIDE } from "./compile.js";

export interface HydrationField {
  /** The component prop the hydrated value lands on (e.g. "image", "title"). */
  prop: string;
  /** The schema/arg field carrying the universal_id ("ref" at item level, "<prop>Ref" for top-level leaves). */
  ref: string;
  /** The row projection to fill from ("image" | "title" | "place" | "body" | …). */
  kind: string;
  /** True when the model may supply its own value (text kinds) — a present value wins over the row's copy. */
  override: boolean;
}

export interface HydrationLevel {
  /** True at ITEM levels: one shared `ref` per entry feeds every hydrated field. */
  itemRef: boolean;
  fields: HydrationField[];
  arrays: Record<string, HydrationLevel>;
}

function hydrationLevel(items: Collected): HydrationLevel | null {
  const fields: HydrationField[] = [];
  for (const [name, f] of items.fields) {
    if (f.hydrate) fields.push({ prop: name, ref: "ref", kind: f.hydrate, override: !HYDRATE_NO_OVERRIDE.has(f.hydrate) });
  }
  const arrays: Record<string, HydrationLevel> = {};
  for (const [name, a] of items.arrays) {
    const inner = hydrationLevel(a.items);
    if (inner) arrays[name] = inner;
  }
  if (!fields.length && !Object.keys(arrays).length) return null;
  return { itemRef: fields.length > 0, fields, arrays };
}

/**
 * Collect the definition's hydrated fields as a tree mirroring the parts structure —
 * the render path walks provided args with this, resolves refs to spatial rows, and
 * fills the real content. Top-level leaves address per-field (`<prop>Ref`); item
 * entries share ONE `ref` feeding all their hydrated fields. Null = pure authored.
 */
export function collectBriefHydration(def: ComponentDefLike): HydrationLevel | null {
  const out: Collected = { fields: new Map(), arrays: new Map(), order: [], context: [] };
  collect(def.root, out);
  const fields: HydrationField[] = [];
  for (const [name, f] of out.fields) {
    if (f.hydrate) fields.push({ prop: name, ref: refName(name), kind: f.hydrate, override: !HYDRATE_NO_OVERRIDE.has(f.hydrate) });
  }
  const arrays: Record<string, HydrationLevel> = {};
  for (const [name, a] of out.arrays) {
    const inner = hydrationLevel(a.items);
    if (inner) arrays[name] = inner;
  }
  if (!fields.length && !Object.keys(arrays).length) return null;
  return { itemRef: false, fields, arrays };
}
