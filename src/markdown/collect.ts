/**
 * UNOVERSE MARKDOWN — walk a definition, gather its briefs.
 *
 * Split by JOB, the way `agent-mcp/` is: `index.ts` is the surface and carries the map.
 */

import type { BriefTag, DefNode, Collected } from "./types.js";

/** Normalize a brief (string shorthand or object) to the object form. */
export function tag(brief: string | BriefTag | undefined): BriefTag | undefined {
  if (brief == null) return undefined;
  return typeof brief === "string" ? { description: brief } : brief;
}

/** The prop name a node binds its content to (value for leaves, src for images). */
export function boundField(node: DefNode): string | undefined {
  return node.bind?.value ?? node.bind?.src;
}

export function collect(node: unknown, out: Collected): void {
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const n = node as DefNode;
  const brief = tag(n.brief);

  if (n.type === "Each" && n.bind?.items) {
    // An Each owns its array prop; its TEMPLATE's binds define the item shape.
    const items: Collected = { fields: new Map(), arrays: new Map(), order: [], context: [] };
    collect(n.template, items);
    // AN EACH BOUND TO `value` IS THE ITEM ITSELF being a list (a table's row of cells). It
    // carries no briefed field of its own, so it would be dropped and the array above it
    // would compile to items of an empty object. Recorded, itemsSchema sees one array named
    // `value` and collapses it to a nested list.
    if (brief || items.fields.size || n.bind.items === "value") {
      if (!out.arrays.has(n.bind.items) && !out.fields.has(n.bind.items)) out.order.push(n.bind.items);
      out.arrays.set(n.bind.items, {
        description: brief?.description,
        minItems: brief?.minItems,
        maxItems: brief?.maxItems,
        items,
      });
    }
    // The template's fields belong to the items, not the outer object — don't re-walk it.
    for (const [k, v] of Object.entries(n)) {
      if (k === "template") continue;
      if (v && typeof v === "object") collect(v, out);
    }
    return;
  }

  const field = boundField(n);
  if (brief && field) {
    if (!out.fields.has(field) && !out.arrays.has(field)) out.order.push(field);
    out.fields.set(field, { description: brief.description, maxLength: brief.maxLength, hydrate: brief.hydrate, optional: brief.optional });
  } else if (brief?.description && !field) {
    // A face/partial root brief — composition context, not a field.
    out.context.push(brief.description);
  }

  for (const v of Object.values(n)) if (v && typeof v === "object") collect(v, out);
}
