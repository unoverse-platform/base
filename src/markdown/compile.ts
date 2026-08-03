/**
 * UNOVERSE MARKDOWN — gathered briefs into JSON Schema.
 *
 * Split by JOB, the way `agent-mcp/` is: `index.ts` is the surface and carries the map.
 */

import type { Collected, ComponentDefLike } from "./types.js";
import { collect } from "./collect.js";

/** The schema property a hydrated field is asked as: `<prop>Ref`, carrying a universal_id. */
export function refName(prop: string): string {
  return `${prop}Ref`;
}

/** Hydration kinds the model may NOT override — it never authors these (e.g. URLs). */
export const HYDRATE_NO_OVERRIDE = new Set(["image"]);

function hydrateSentence(kind: string): string {
  return (
    ` Pass the universal_id of the ONE search result that carries this ${kind}, copied VERBATIM ` +
    `from the result — the server fills the real ${kind} from that row. Never pass a URL here.`
  );
}

function fieldSchema(name: string, f: { description?: string; maxLength?: number; hydrate?: string; optional?: boolean }): [string, Record<string, unknown>] {
  // HYDRATED field: asked as <name>Ref (a universal_id), never as content. The model
  // cannot transcribe — and cannot invent — what it can only reference by id.
  if (f.hydrate) {
    return [
      refName(name),
      { type: "string", minLength: 1, description: `${f.description ?? ""}${hydrateSentence(f.hydrate)}`.trim() },
    ];
  }
  return [
    name,
    {
      type: "string",
      // An OPTIONAL field may legitimately arrive empty; minLength would force invention.
      ...(f.optional ? {} : { minLength: 1 }),
      ...(f.description ? { description: f.description } : {}),
      ...(f.maxLength != null ? { maxLength: f.maxLength } : {}),
    },
  ];
}

function itemsSchema(items: Collected): Record<string, unknown> {
  // THE ITEM ITSELF. A bind named `value` means the entry IS the content, not an object of
  // named fields: a table's column headers are strings, and its rows are lists of strings.
  // Both fall out of the same reading, and without them a table compiles to items of an
  // empty object and cannot be filled at all.
  if (!items.fields.size && !items.arrays.size) return { type: "string" };
  if (!items.fields.size && items.arrays.size === 1 && items.arrays.has("value")) {
    return { type: "array", items: itemsSchema(items.arrays.get("value")!.items) };
  }
  // ITEM-LEVEL REF (lift-and-shift): when an item template carries ANY hydrated
  // field, the item is DRAWN FROM one search result — the schema asks for a single
  // required `ref` (its universal_id) and the server lifts every hydrated field
  // straight off that row. Text kinds stay as OPTIONAL overrides (the model refines
  // when it can say it better for THIS guest); image kinds never appear (the model
  // never authors URLs). Non-hydrated fields stay required and model-authored.
  const hasRef = [...items.fields.values()].some((f) => f.hydrate);
  // DOCUMENT ORDER: emit properties as encountered walking the tree — the schema's
  // property order is the page's visual order (nested Eachs render in place).
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if (hasRef) {
    properties.ref = {
      type: "string",
      minLength: 1,
      description:
        "The universal_id of the ONE search result this entry is drawn from, copied VERBATIM — " +
        "the server fills the entry's content (image, copy) from that result.",
    };
    required.push("ref");
  }
  for (const name of items.order) {
    const f = items.fields.get(name);
    if (f) {
      if (f.hydrate && HYDRATE_NO_OVERRIDE.has(f.hydrate)) continue; // server-only, never asked
      if (f.hydrate) {
        properties[name] = {
          type: "string",
          minLength: 1,
          description:
            `${f.description ?? ""} OPTIONAL override — leave absent to use the referenced result's own copy; ` +
            `provide only when you can say it better for THIS guest.`.trim(),
          ...(f.maxLength != null ? { maxLength: f.maxLength } : {}),
        };
        continue; // optional — not in required
      }
      const [key, spec] = fieldSchema(name, f);
      properties[key] = spec;
      if (!f.optional) required.push(key);
      continue;
    }
    const a = items.arrays.get(name);
    if (a) {
      properties[name] = {
        type: "array",
        ...(a.description ? { description: a.description } : {}),
        ...(a.minItems != null ? { minItems: a.minItems } : {}),
        ...(a.maxItems != null ? { maxItems: a.maxItems } : {}),
        items: itemsSchema(a.items),
      };
      required.push(name);
    }
  }
  return {
    type: "object",
    ...(items.context.length ? { description: items.context.join(" ") } : {}),
    properties,
    required,
  };
}

/**
 * Compile a component definition's briefs into the JSON Schema for its app tool.
 * Returns null when the definition carries no briefed binds (not a briefed component).
 */
export interface CompileOptions {
  /** The SITUATION this schema is for, supplied by whoever knows it. The compiler carries
   *  none of its own: it once defaulted to a guest's live page composed from spatial
   *  search, and every caller inherited it, including a promotion that had run no
   *  searches at all. */
  grounding?: string;
}

export function compileBriefSchema(def: ComponentDefLike, opts: CompileOptions = {}): Record<string, unknown> | null {
  const out: Collected = { fields: new Map(), arrays: new Map(), order: [], context: [] };
  collect(def.root, out);
  if (out.fields.size === 0 && out.arrays.size === 0) return null;

  const propType = (name: string): string => def.props?.[name]?.type ?? "string";
  // DOCUMENT ORDER (top of page first) — this is what makes "compose top down" a
  // generic instruction: the schema's property order IS the page's visual order.
  const properties: Record<string, unknown> = {};
  for (const name of out.order) {
    const f = out.fields.get(name);
    if (f) {
      if (f.hydrate) {
        const [key, spec] = fieldSchema(name, f);
        properties[key] = spec;
        continue;
      }
      const t = propType(name) === "array" ? "array" : propType(name);
      properties[name] = {
        type: t,
        ...(t === "string" ? { minLength: 1 } : {}),
        ...(f.description ? { description: f.description } : {}),
        ...(f.maxLength != null ? { maxLength: f.maxLength } : {}),
      };
      continue;
    }
    const a = out.arrays.get(name);
    if (a) {
      properties[name] = {
        type: "array",
        ...(a.description ? { description: a.description } : {}),
        ...(a.minItems != null ? { minItems: a.minItems } : {}),
        ...(a.maxItems != null ? { maxItems: a.maxItems } : {}),
        items: itemsSchema(a.items),
      };
    }
  }

  return {
    type: "object",
    description: [opts.grounding ?? "", ...out.context].filter(Boolean).join(" "),
    properties,
    // PROGRESSIVE BY CONTRACT: no page-level `required` — a call carrying ANY subset of
    // parts is a valid RENDER (the page grows call by call; the mirror names what's still
    // absent). Item shapes stay fully required (itemsSchema): an entity that is present
    // must be complete. Doneness is judged against `properties`, not demanded up front.
    required: [],
  };
}
