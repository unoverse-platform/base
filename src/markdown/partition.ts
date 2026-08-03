/**
 * UNOVERSE MARKDOWN — partition a FINISHED document into its parts, then derive its layout.
 *
 * SEPARATE FROM COMPOSITION BY EVIDENCE, not by taste. Asking the composing call to label
 * each component's part as it wrote it was tried twice: the field returned no areas at all,
 * then one area over two components on a document with four parts. Both times the wording
 * was blamed and rewritten; both times it failed the same way, because the judgement is
 * about the WHOLE document and the field is filled while the first component is written.
 *
 * This pass sees the finished SHAPE — index, kind, heading, size — and never the copy. It
 * returns one label per component, and the layout follows DETERMINISTICALLY: two or more
 * parts is tabs, anything else is one page. That removes a model call rather than adding
 * one (the old layout matcher is gone).
 *
 * THE CALLER SUPPLIES THE MODEL. Base carries no vendor client and no API key — the engine
 * owns those (its `extractStructuredObject`, keyed by the platform's own env). So this takes
 * an `ask` function rather than importing one, which also means an agent, an email job or a
 * test can partition a document with whatever it already has.
 */

export type DocumentLayout = "scroll" | "tabs";

/** One component of a document, as far as partitioning is concerned. Every content field is
 *  optional: a component carries only its own kind's fields. */
export interface PartitionableComponent {
  kind: string;
  heading?: string;
  group?: string;
  body?: string;
  facts?: unknown[];
  items?: unknown[];
  rows?: unknown[];
  [key: string]: unknown;
}

/** The structured call the caller lends us: prompt + schema in, parsed object out. */
export type StructuredAsk = (args: {
  prompt: string;
  schema: Record<string, unknown>;
  systemPrompt: string;
  schemaName: string;
}) => Promise<any>;

/** Below this there is nothing to divide, and a tab strip over four short passages costs
 *  more than it saves. */
const MIN_COMPONENTS = 4;

const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

const SYSTEM =
  "You partition a finished document. You see only its SHAPE — each component's kind, " +
  "heading and size — never the copy.\n\n" +
  "Would a reader consult this in parts, or read it straight through? Material with any " +
  "breadth usually has two to four parts, and naming them is the job; a document you leave " +
  "unpartitioned had better genuinely be one subject.\n\n" +
  "Name each part for what its components have IN COMMON, in the document's own words. A part " +
  "named after one of the components inside it describes that component, not the part: if a run " +
  "covers a warranty, online-payment security and credit cover, it is 'Protection', not " +
  "'Extended Warranty'. Never give a part the same name as a heading it contains, or the reader " +
  "sees the same words twice. " +
  "A part is CONTIGUOUS: label a run of components, never scatter a label through the " +
  "document. Parts are comparable: none is 'everything else', and none holds a single " +
  "component. Opening material that introduces the whole thing takes an empty label and " +
  "leads. Return an empty string for every component when there are no parts.";

const SCHEMA = {
  type: "object",
  properties: {
    parts: {
      type: "array",
      description:
        "One entry per component, in the SAME ORDER and the same length as the manifest. " +
        "Each is the part that component belongs to, or an empty string when the document " +
        "has no parts.",
      items: { type: "string", maxLength: 40 },
    },
  },
  required: ["parts"],
  additionalProperties: false,
} as const;

/**
 * Partition and lay out. Returns the components with their `group` set, plus the layout.
 *
 * FAIL-OPEN on every path: a document that reads as one column is a worse document, never a
 * broken one, and a partition failure must never cost the copy that was already written.
 */
export async function partitionDocument(
  components: PartitionableComponent[],
  ask: StructuredAsk,
  log?: { info?: (m: string, d?: unknown) => void; warn?: (m: string, d?: unknown) => void },
): Promise<{ components: PartitionableComponent[]; layout: DocumentLayout | null }> {
  if (!Array.isArray(components) || components.length < MIN_COMPONENTS) return { components, layout: null };

  const manifest = components
    .map((s, i) => {
      const size = (s.body?.length || 0) + len(s.items) * 60 + len(s.rows) * 40 + len(s.facts) * 20;
      return `${i}. kind=${s.kind} heading="${s.heading ?? ""}" approxChars=${size}`;
    })
    .join("\n");

  try {
    const result = await ask({
      prompt: `COMPONENT MANIFEST of a finished document:\n\n${manifest}`,
      schema: SCHEMA as unknown as Record<string, unknown>,
      systemPrompt: SYSTEM,
      schemaName: "document_parts",
    });

    const parts: string[] = Array.isArray(result?.parts) ? result.parts.map((p: unknown) => String(p ?? "").trim()) : [];
    if (parts.length !== components.length) {
      log?.warn?.("Partition ignored — one label per component is the contract", {
        got: parts.length,
        expected: components.length,
      });
      return { components, layout: null };
    }

    // A part holding ONE component is not a part: dropped in CODE rather than asked for in
    // prose, because a rule the model can decline is a rule that gets declined.
    const counts = new Map<string, number>();
    for (const p of parts) if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
    const kept = new Set([...counts].filter(([, n]) => n >= 2).map(([p]) => p));

    const labelled = components.map((s, i) => ({ ...s, group: kept.has(parts[i]) ? parts[i] : "" }));
    // LAYOUT IS NOT A JUDGEMENT once the parts are known: two or more of them is a document
    // a reader consults, which is what tabs are for.
    const layout: DocumentLayout = kept.size >= 2 ? "tabs" : "scroll";
    log?.info?.("Document partitioned", { parts: [...kept], layout });
    return { components: labelled, layout };
  } catch (error: any) {
    log?.warn?.("Partition failed — document reads as one page", { error: error?.message });
    return { components, layout: null };
  }
}
