/**
 * YAML serialization for the two workflow documents, plus the one-call dual-write helper.
 * Design record: docs/architecture/WORKFLOW_DOCUMENT.md.
 *
 * CANONICAL FORM: the converters construct documents with a fixed key order (schema
 * order), and YAML.stringify preserves insertion order — so serializing the same
 * workflow always yields the same text, and a diff on the stored document is a
 * semantic diff. Writers MUST go through splitWorkflow/these helpers; hand-built
 * objects with other key orders would break the stability, not the parse.
 */
import { stringify, parse } from "yaml";
import type { WorkflowDocument, LayoutDocument, DocumentProblem } from "./document.js";
import { validateWorkflowDocument, validateLayoutDocument } from "./document.js";
import { splitWorkflow, type LegacyContent } from "./convert.js";

const YAML_OPTS = { lineWidth: 0 } as const; // never wrap — a wrapped string is a diff lie

export function toWorkflowYaml(doc: WorkflowDocument): string {
  return stringify(doc, YAML_OPTS);
}

export function toLayoutYaml(doc: LayoutDocument): string {
  return stringify(doc, YAML_OPTS);
}

/** Parse + validate. Throws with the problem list — a stored document that does not
 *  validate is a defect, never something to limp past. */
export function fromWorkflowYaml(text: string): WorkflowDocument {
  const doc = parse(text);
  const result = validateWorkflowDocument(doc);
  if (!result.ok) throw new Error(`invalid workflow document: ${describe(result.problems)}`);
  return doc as WorkflowDocument;
}

export function fromLayoutYaml(text: string): LayoutDocument {
  const doc = parse(text);
  const result = validateLayoutDocument(doc);
  if (!result.ok) throw new Error(`invalid layout document: ${describe(result.problems)}`);
  return doc as LayoutDocument;
}

function describe(problems: DocumentProblem[]): string {
  return problems.slice(0, 5).map((p) => `${p.path}: ${p.message}`).join("; ");
}

// ---------------------------------------------------------------------------
// The dual-write helper — what a save path calls
// ---------------------------------------------------------------------------

export type DualWriteResult =
  | { ok: true; workflowYaml: string; layoutYaml: string; dropped: string[] }
  | { ok: false; problems: DocumentProblem[]; dropped: string[] };

/**
 * Compute the two YAML documents for a save, or refuse.
 *
 * ok:false is NOT an error to throw on — the workflow saves on the legacy path exactly
 * as before, and the refusal is logged loudly (WORKFLOW_DOCUMENT.md §6: the gate flags,
 * it never blocks a save and never force-converts). ok:true documents went through
 * split AND the schema, so what lands in the columns always validates.
 */
export function dualWriteDocuments(content: LegacyContent): DualWriteResult {
  const { workflow, layout, dropped, problems } = splitWorkflow(content);
  if (problems.length > 0) return { ok: false, problems, dropped };
  return { ok: true, workflowYaml: toWorkflowYaml(workflow), layoutYaml: toLayoutYaml(layout), dropped };
}
