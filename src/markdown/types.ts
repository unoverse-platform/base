/**
 * UNOVERSE MARKDOWN — the shapes, no behaviour.
 *
 * Split by JOB, the way `agent-mcp/` is: `index.ts` is the surface and carries the map.
 */

export interface BriefTag {
  description?: string;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  /** SERVER-HYDRATED field: the model passes a search result's universal_id instead of
   *  the content itself; the render path fills the real value from that row. The value
   *  names the row projection (v1: "image"). Kills verbatim transcription — the model
   *  cannot invent what it can only reference. */
  hydrate?: string;
  /** OPTIONAL field: the model may leave it out. A brief that says "empty when the source
   *  gives none" must not compile to a required, minLength-1 string, or the model has to
   *  invent one to satisfy the schema. Opt-in, so every existing brief is unchanged. */
  optional?: boolean;
}

export interface DefNode {
  type?: string;
  brief?: string | BriefTag;
  bind?: { value?: string; items?: string; src?: string };
  template?: DefNode;
  [key: string]: unknown;
}

export interface ComponentDefLike {
  props?: Record<string, { type?: string; description?: string }>;
  root?: unknown;
}

export interface Collected {
  fields: Map<string, { description?: string; maxLength?: number; hydrate?: string; optional?: boolean }>;
  arrays: Map<string, { description?: string; minItems?: number; maxItems?: number; items: Collected }>;
  /** Property names in DOCUMENT order (first encounter walking the tree top-down) —
   *  the schema's property order IS the page's visual order, which is what lets the
   *  grounding say "compose top down" generically for any component. */
  order: string[];
  context: string[];
}
