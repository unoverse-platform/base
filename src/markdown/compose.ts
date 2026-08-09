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
 * HOW A DOCUMENT IS COMPOSED — true of every document, whoever asked for it and whatever the
 * business. Not a situation, so it is always sent.
 *
 * IT DOES NOT PARTITION. Two attempts were made to get areas out of this call by wording a
 * per-component `group` field: constraints-first returned a document with NO areas, and
 * positive-first returned ONE area over two components on a document with four parts. The
 * fault was never the wording. Partitioning is a judgement about the whole document, and the
 * field is filled while writing the FIRST component, before there is a whole to judge. It is
 * a separate pass now (engine `structureDocument`), the way layout already was.
 */
export const DOCUMENT_COMPOSITION =
  "Return the document as an ordered list of components.\n\n" +
  "MATCH THE COMPONENT TO THE SHAPE OF THE MATERIAL. Figures a reader would compare are keyFacts; " +
  "anything stated across two dimensions is a table; an ordered procedure is steps; enumerated items " +
  "are a list; a question and its answer is faq; a must-not-miss condition is a callout; legal wording " +
  "is finePrint; everything else is prose. There are two ways to get this wrong and both are common: " +
  "inflating plain paragraphs into tiles so the page looks busy, and flattening structured material " +
  "into a bulleted list inside a prose body. The second is not a formatting choice, it hands the " +
  "reader an unstyled imitation of a component that would have been drawn properly.\n\n" +
  "Order the components as a reader would read them: what this is, then how it works, then " +
  "practical detail, then anything legal. Whether the document divides into parts is NOT your " +
  "decision and there is no field for it: a later pass reads the finished document and partitions " +
  "it, which is a judgement about the whole and cannot be made while the first component is " +
  "still being written.";

export interface ComponentType {
  /** The `type` value a component carries, and the atom's ref name. */
  type: string;
  /** The atom's own `whenToUse`, which is the selection guidance. */
  whenToUse?: string;
  description?: string;
  /** The compiled brief schema: this component's fields. */
  schema: Record<string, unknown>;
}

/**
 * An atom's name as the kind a document carries: the Document switches on exactly this.
 *
 * THE KIND IS THE ATOM'S NAME, unchanged. Atoms are kebab (`key-facts`), so kinds are kebab,
 * and there is one spelling of a thing across the whole system: the file, the `name:`, the
 * Ref, the kind and the Switch case. Anything that transforms the name here is a second
 * convention, and a second convention is how `Avatar.json` and `avatar.json` came to be the
 * same atom under two names.
 */
function kindOf(name: string): string {
  return String(name ?? "");
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
      // THE KIND IS THE ATOM'S NAME, camelCased: KeyFacts → keyFacts, FinePrint → finePrint.
      // Lowercasing it produced `keyfacts`, which the Document has no case for, so those
      // components rendered through the prose fallback and lost their shape entirely.
      type: kindOf(String(d.name ?? "")),
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
 * EVERY COMPONENT CARRIES THESE, whatever its kind. They are the DOCUMENT's concerns rather
 * than any atom's: an atom draws its own content and knows nothing about the heading above
 * it or which part of the page it sits in. Declared once here instead of in eight atoms.
 */
const DOCUMENT_FIELDS: Record<string, Record<string, unknown>> = {
  heading: {
    type: "string",
    description:
      "Short heading for this component, in the source's own words. Empty string when the " +
      "content needs none, which is common for a passage continuing the one above it.",
    maxLength: 60,
  },
  // `group`, not `area`: it is what `toDocument` reads, what the tab shaping keys on, and
  // what every stored row already carries. The wire format meets the renderer where it is.
  //
  // IT WAS DESCRIBED HERE AND NEVER OFFERED. Every branch is `additionalProperties: false`,
  // so a model could not label a component with its group even though the renderer reads
  // one, `toDocument` shapes tabs from it and UNOVERSE_MARKDOWN documents it. A document
  // could therefore never be composed into areas, and a FORM could never be composed into
  // steps, because a step is a group (verified 2026-08-09).
  group: {
    type: "string",
    description:
      "The part of the document this component belongs to, in the source's own words: an " +
      "area of a page, or a STEP of a form ('Who is applying', 'Your commitment'). Two or " +
      "more groups render as a strip the reader moves through. Empty string when the " +
      "document is one continuous piece, which is the common case for prose.",
    maxLength: 40,
  },
};

/**
 * The document schema: `components`, an array whose items are a discriminated union over the
 * Markdown atoms. `kind` is a const per branch, so choosing a component and filling it are one
 * act, and a component the renderer does not have cannot be named.
 *
 * `kind`, not `type`, because that is the key the Document component switches on and the key
 * every stored row already carries. The wire format meeting the renderer where it is costs
 * one word here and saves a migration.
 */
export interface DocumentSchemaOptions {
  /** The SITUATION, supplied by whoever knows it. Structuring one record's approved copy
   *  ("the facts are sacred, rewrite the words") and an agent composing from what it already
   *  knows are different jobs, and neither belongs baked in here. */
  grounding?: string;
}

/** The components array on its own, so a caller can store it under whatever name it uses
 *  (the content pipeline's rows carry it as `sections`). */
export function compileDocumentComponents(): Record<string, unknown> | null {
  const full = compileDocumentSchema();
  return full ? ((full.properties as Record<string, unknown>).components as Record<string, unknown>) : null;
}

export function compileDocumentSchema(opts: DocumentSchemaOptions = {}): Record<string, unknown> | null {
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
        kind: { type: "string", const: t.type, description: `Renders the ${t.type} component.` },
        ...DOCUMENT_FIELDS,
        ...props,
      },
      // The discriminant is always required. A branch's own fields keep whatever the brief
      // said, so `optional: true` survives into the union. `heading` and `area` are required
      // but may be the empty string: strict mode has no optional, so "absent" is "".
      required: ["kind", ...Object.keys(DOCUMENT_FIELDS), ...required.filter((r) => Object.keys(props).includes(r))],
      additionalProperties: false,
    };
  });

  return toStrict({
    type: "object",
    description: [opts.grounding ?? "", DOCUMENT_COMPOSITION].filter(Boolean).join(" "),
    properties: {
      components: {
        type: "array",
        description:
          "The document, in reading order. Each entry names its component kind and carries that kind's fields.",
        minItems: 1,
        items: { anyOf: branches },
      },
    },
    required: ["components"],
    additionalProperties: false,
  }) as Record<string, unknown>;
}
