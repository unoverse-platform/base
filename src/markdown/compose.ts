/**
 * UNOVERSE MARKDOWN, the open way: the MENU a model composes a document from.
 *
 * `compileBriefSchema` turns ONE definition into the form a model fills, which is the
 * Template way. This turns EVERY Markdown atom into a list of forms and asks for an ordered
 * selection: which components, in what order, filled with what.
 *
 *   atoms marked `category: markdown`  →  one JSON Schema  →  the model returns a document
 *   →  the renderer expands each atom
 *
 * THE MENU IS DERIVED, never written down. Adding an atom offers the model a new component
 * on the next call, with no prompt to edit and no list to keep in step. Two vocabularies
 * written beside the thing that renders them have already drifted in this codebase (the
 * feature icon list, the prose recipe keys), and both stopped drifting the moment they were
 * read from the source.
 *
 * The model writes CONTENT, never design. No component carries a style, a colour or a size,
 * because those are not fields on an atom's brief. An invented token is unreachable rather
 * than discouraged.
 *
 * See docs/unoverse/UNOVERSE_MARKDOWN.md.
 */

import { listDefinitions } from "@unoverse-platform/base/definitions/definitions.js";
import { compileBriefSchema } from "./compile.js";

/** The atom category that marks a document component. Interface atoms are never offered. */
export const MARKDOWN_CATEGORY = "markdown";

/**
 * What the model is doing here, which is NOT what a page composer does. It has the copy
 * already; the job is to say what shape each part of it is, and to keep the words.
 */
const GROUNDING =
  "Structure the body copy you have been given as an ordered list of components. " +
  "Use the source's OWN words: reuse and cut, never add a fact, a figure or a claim it does not state. " +
  "Prose is the default and carries anything Markdown carries. Reach for a structured component " +
  "ONLY when the source is genuinely structured, never to make a plain passage look busier. " +
  "A document is mostly prose with a little structure in it; one that is mostly structure reads as a dashboard.";

export interface ComponentType {
  /** The `type` value a component carries, and the atom's ref name. */
  type: string;
  /** The atom's own `whenToUse`, which is the selection guidance. */
  whenToUse?: string;
  description?: string;
  /** The compiled brief schema: this component's fields. */
  schema: Record<string, unknown>;
}

/** Every Markdown atom, compiled. Sorted so the schema is stable call to call. */
export function markdownComponentTypes(): ComponentType[] {
  const out: ComponentType[] = [];
  for (const def of listDefinitions("atom")) {
    const d = def as unknown as Record<string, unknown>;
    if (d.category !== MARKDOWN_CATEGORY) continue;
    // An atom with no briefs cannot be filled by a model: it would compile to a component with
    // no fields, which the model could select and never populate.
    const schema = compileBriefSchema(def as never, { grounding: "" });
    if (!schema) continue;
    out.push({
      type: String(d.name ?? "").toLowerCase(),
      whenToUse: typeof d.whenToUse === "string" ? d.whenToUse : undefined,
      description: typeof d.description === "string" ? d.description : undefined,
      schema,
    });
  }
  return out.sort((a, b) => a.type.localeCompare(b.type));
}

/**
 * STRICT-MODE ADAPTATION. Constrained decoding is the layer that makes an invalid component
 * impossible rather than discouraged, and it demands two things a brief schema does not
 * carry: every object closed (`additionalProperties: false`), and every property listed in
 * `required`. Optionality is expressed by allowing null instead of by omission.
 *
 * Applied here rather than in the brief compiler, whose other caller is the MCP tool
 * surface and follows different rules (a page call may carry any subset).
 */
function toStrict(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toStrict);
  if (!node || typeof node !== "object") return node;
  const o = { ...(node as Record<string, unknown>) };

  if (o.anyOf) o.anyOf = toStrict(o.anyOf);
  if (o.items) o.items = toStrict(o.items);

  if (o.type === "object" && o.properties && typeof o.properties === "object") {
    const props = o.properties as Record<string, Record<string, unknown>>;
    const wasRequired = new Set((o.required as string[] | undefined) ?? Object.keys(props));
    const next: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(props)) {
      const s = toStrict(spec) as Record<string, unknown>;
      // An optional field stays optional in MEANING by admitting null, since strict mode
      // has no way to omit it. `minLength` would then contradict null, so it goes.
      if (!wasRequired.has(name) && typeof s.type === "string") {
        s.type = [s.type, "null"];
        delete s.minLength;
      }
      next[name] = s;
    }
    o.properties = next;
    o.required = Object.keys(next);
    o.additionalProperties = false;
  }
  return o;
}

/**
 * The document schema: `components`, an array whose items are a discriminated union over the
 * Markdown atoms. `type` is a const per branch, so choosing a component and filling it are one
 * act, and a component the renderer does not have cannot be named.
 */
export function compileDocumentSchema(): Record<string, unknown> | null {
  const types = markdownComponentTypes();
  if (!types.length) return null;

  const branches = types.map((t) => {
    const props = (t.schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    // A PAGE compiles with an empty top-level `required`, because a page is filled
    // progressively and any subset is a valid render. A COMPONENT is the opposite: it appears
    // in the document as a whole thing, and one carrying no content is not a component. So
    // every field is required here EXCEPT the ones a brief marked optional, which are
    // exactly the string fields the compiler left without `minLength`.
    const required = Object.entries(props)
      .filter(([, spec]) => !(spec.type === "string" && spec.minLength === undefined))
      .map(([name]) => name);
    return {
      type: "object",
      // The atom's own `whenToUse` IS the selection guidance. Written once, next to the
      // thing it describes, and it travels here automatically.
      description: [t.description, t.whenToUse].filter(Boolean).join(" "),
      properties: {
        type: { type: "string", const: t.type, description: `Renders the ${t.type} component.` },
        ...props,
      },
      // The discriminant is always required. A branch's own fields keep whatever the brief
      // said, so `optional: true` survives into the union.
      required: ["type", ...required.filter((r) => Object.keys(props).includes(r))],
      additionalProperties: false,
    };
  });

  return toStrict({
    type: "object",
    description: GROUNDING,
    properties: {
      components: {
        type: "array",
        description:
          "The document, in reading order. Each entry names its component type and carries that type's fields.",
        minItems: 1,
        items: { anyOf: branches },
      },
    },
    required: ["components"],
    additionalProperties: false,
  }) as Record<string, unknown>;
}
