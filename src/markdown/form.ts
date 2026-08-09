/**
 * UNOVERSE MARKDOWN — a document that COLLECTS: steps, forks, and the flattening that lets
 * a field write its own answer.
 *
 * A form is a document. A field is a component, a step is its `group`, and the person
 * confirms a step before it advances. Two produce one, and the difference is only whether
 * a schema exists (docs/unoverse/UNOVERSE_MCP_FORMS.md §1):
 *
 *   schema-driven  the schema says what is asked; the model says how
 *   ad-hoc         the model composes a few fields because the moment needs them
 *
 * WHY FLATTENING EXISTS AT ALL. `setValue` writes its key verbatim and a controlled Input
 * writes `{ [boundField]: text }`, so fields drawn by an `Each` would every one of them
 * write the SAME key. A step is therefore mapped onto NUMBERED SLOTS whose names are
 * static (`f0value`, `f1value`, …), exactly as `toDocument` maps areas onto `tab0`…`tab3`,
 * and for the same reason: SDUI resolves static names. The slot map travels with the step,
 * so an answer comes back addressed by the field's REAL key.
 *
 * WHY ANSWERS ARE KEYED BY FIELD, NEVER BY POSITION. A fork means step three for one
 * person is not step three for another, and changing an earlier answer must not cost the
 * later ones. Re-resolving keeps every answer whose field still exists and drops only what
 * the new branch actually removed.
 *
 * NOTHING HERE ASKS A MODEL ANYTHING. The rules come from the schema, the answers from the
 * person, and the result is the same every run: that is what makes a regulated form
 * auditable, and it is why the renderer needs no condition language.
 */

import type { BriefTag } from "./types.js";
import { tag } from "./collect.js";

/** One field of a composed form: a Markdown component that collects. */
export interface FormField {
  /** The kind that draws it (`form-text`, `form-date`, …). */
  kind: string;
  /** The answer's name, and the only way an answer is ever addressed. */
  key: string;
  /** The step it belongs to. A document's `group`, read as a form. */
  group?: string;
  label?: string;
  placeholder?: string;
  /** Shown to the PERSON, under the field. */
  help?: string;
  /**
   * Told to the MODEL, never drawn: the SAME brief every other bound thing carries, so a
   * field is guided the way an atom's node is. Why the field is asked, what a good answer
   * looks like, and where one might be found: "Required by anti-money-laundering rules",
   * "The IBAN is on the statement they uploaded", "Search spatial for the deal's minimum".
   *
   * It does three jobs at once, which is why it is one field and not three. It answers the
   * person when they ask why this is needed. It tells the model where to look before it
   * proposes anything. And it is where a field says a search or an MCP call would settle
   * it, rather than a guess.
   */
  brief?: string | BriefTag;
  /** Where a proposed value came from, in the reader's words. Empty when nobody proposed. */
  source?: string;
  /** Shown only when this holds. Absent means always. */
  visibleWhen?: Condition;
  /** Must be answered before its step can be confirmed. */
  required?: boolean;
}

/** The closed condition vocabulary. Arithmetic and lookups stay out: a form that computes
 *  is a rules engine, and a rules engine belongs in a node. */
export type Condition =
  | { eq: [string, unknown] }
  | { ne: [string, unknown] }
  | { in: [string, unknown[]] }
  | { present: string }
  | { absent: string }
  | { all: Condition[] }
  | { any: Condition[] };

/** What the model is told about a step it is about to help fill. The person never sees
 *  this: it is each field's `brief`, gathered, in the order the fields are asked. */
export interface StepGuidance {
  key: string;
  label: string;
  required: boolean;
  answered: boolean;
  /** The field's brief, normalized to its description: the instruction channel, unchanged. */
  brief?: string;
}

/** An answer as held: the value, where it came from, and whether a person accepted it. */
export interface Answer {
  value: unknown;
  source?: string;
  confirmed?: boolean;
}

export interface ResolvedStep {
  /** The step's name, which is also its key: a fork makes positions meaningless. */
  group: string;
  /** The fields this person is asked, in order, after the forks are resolved. */
  fields: FormField[];
  /** Slot name → the field's real key, so an answer returns addressed properly. */
  slots: Record<string, string>;
  /** Flat props for the renderer: `f0kind`, `f0label`, `f0value`, `f0source`, … */
  props: Record<string, unknown>;
  complete: boolean;
}

export interface ResolvedForm {
  steps: ResolvedStep[];
  /** The first step carrying an unconfirmed required field. Empty when the form is done. */
  nextStep: string;
  complete: boolean;
  /** Answers whose field the current branch no longer asks for. Dropped, and named so the
   *  caller can say what changing an answer cost. */
  orphaned: string[];
}

const answerOf = (answers: Record<string, Answer>, key: string): unknown => answers[key]?.value;

/** Evaluate a condition against the answers so far. An absent rule is always true. */
export function holds(cond: Condition | undefined, answers: Record<string, Answer>): boolean {
  if (!cond) return true;
  const c = cond as Record<string, unknown>;
  if ("all" in c) return (c.all as Condition[]).every((x) => holds(x, answers));
  if ("any" in c) return (c.any as Condition[]).some((x) => holds(x, answers));
  if ("present" in c) {
    const v = answerOf(answers, c.present as string);
    return v !== undefined && v !== null && v !== "";
  }
  if ("absent" in c) {
    const v = answerOf(answers, c.absent as string);
    return v === undefined || v === null || v === "";
  }
  if ("eq" in c) {
    const [k, v] = c.eq as [string, unknown];
    return answerOf(answers, k) === v;
  }
  if ("ne" in c) {
    const [k, v] = c.ne as [string, unknown];
    return answerOf(answers, k) !== v;
  }
  if ("in" in c) {
    const [k, vs] = c.in as [string, unknown[]];
    return vs.includes(answerOf(answers, k));
  }
  return true;
}

/** THE SLOT NAMES. Static by construction, because a bound field name is part of the
 *  definition and a definition cannot be written per person. */
export const slotKey = (i: number, part: string): string => `f${i}${part}`;

/**
 * Resolve a composed form against the answers so far.
 *
 * Deterministic: same fields, same rules, same answers, same result. Run it again after an
 * answer changes and the form re-resolves in place, keeping every answer whose field
 * survives the new branch.
 */
export function resolveForm(fields: FormField[], answers: Record<string, Answer> = {}): ResolvedForm {
  const asked = fields.filter((f) => holds(f.visibleWhen, answers));
  const askedKeys = new Set(asked.map((f) => f.key));

  // An answer to a question the branch no longer asks is not kept: it would submit a value
  // the person can no longer see. Named rather than silently dropped.
  const orphaned = Object.keys(answers).filter((k) => !askedKeys.has(k));

  const order: string[] = [];
  for (const f of asked) {
    const g = f.group ?? "";
    if (!order.includes(g)) order.push(g);
  }

  const steps: ResolvedStep[] = order.map((group) => {
    const stepFields = asked.filter((f) => (f.group ?? "") === group);
    const slots: Record<string, string> = {};
    const props: Record<string, unknown> = {};
    stepFields.forEach((f, i) => {
      slots[slotKey(i, "value")] = f.key;
      props[slotKey(i, "kind")] = f.kind;
      props[slotKey(i, "label")] = f.label ?? "";
      props[slotKey(i, "placeholder")] = f.placeholder ?? "";
      props[slotKey(i, "help")] = f.help ?? "";
      // The ANSWER, and where it came from. A proposed value renders as something to
      // accept; a confirmed one has no source to show, because a person owns it now.
      props[slotKey(i, "value")] = answers[f.key]?.value ?? "";
      props[slotKey(i, "source")] = answers[f.key]?.confirmed ? "" : (answers[f.key]?.source ?? f.source ?? "");
    });
    const complete = stepFields.every((f) => !f.required || answers[f.key]?.confirmed === true);
    // THE GATE, AS DATA. A step advances only when every required field is answered, and
    // "every" is a COMPUTATION: a definition may not carry one, and the SDK's `disabledWhen`
    // is a truthy test on a single field. So the fact is computed HERE and handed over as
    // one flag the confirm control reads. Naming it for the blocked state rather than the
    // ready one is deliberate: `disabledWhen: stepBlocked` needs no negation, and the
    // vocabulary has none.
    props.stepBlocked = !complete;
    props.stepMissing = stepFields
      .filter((f) => f.required && answers[f.key]?.confirmed !== true)
      .map((f) => f.label ?? f.key)
      .join(", ");
    return { group, fields: stepFields, slots, props, complete };
  });

  const next = steps.find((s) => !s.complete);
  return {
    steps,
    nextStep: next?.group ?? "",
    complete: !next,
    orphaned,
  };
}

/**
 * Apply what a step returned, addressed by SLOT, and get answers back addressed by KEY.
 *
 * The renderer knows `f0value` because a definition must; nothing else ever should. An
 * answer that arrives under a slot the step does not carry is dropped rather than trusted.
 */
export function collectStep(
  step: ResolvedStep,
  submitted: Record<string, unknown>,
  answers: Record<string, Answer> = {},
  opts: { confirmed?: boolean; source?: string } = {},
): Record<string, Answer> {
  const out: Record<string, Answer> = { ...answers };
  for (const [slot, key] of Object.entries(step.slots)) {
    if (!(slot in submitted)) continue;
    const value = submitted[slot];
    const prior = out[key];
    out[key] = {
      value,
      // A CORRECTION LOSES ITS PROVENANCE, and should: once a person has typed over a
      // proposal, the value is theirs and no longer the profile's or the document's.
      source: opts.source ?? (prior && prior.value !== value ? undefined : prior?.source),
      confirmed: opts.confirmed ?? prior?.confirmed ?? false,
    };
  }
  return out;
}

/**
 * What to tell the model about a step: each field's key, whether it is still owed, and the
 * CONTEXT its author attached. This is the whole instruction channel for filling a step,
 * and it is data rather than a prompt: changing a field's `brief` changes what the model
 * does on the next call, with nothing to redeploy.
 *
 * It is also the answer when a person asks "why do you need this?": the model is holding
 * the reason, so it can say it rather than apologise for the form.
 */
export function stepGuidance(step: ResolvedStep, answers: Record<string, Answer> = {}): StepGuidance[] {
  return step.fields.map((f) => ({
    key: f.key,
    label: f.label ?? f.key,
    required: f.required === true,
    answered: answers[f.key]?.confirmed === true,
    ...(tag(f.brief)?.description ? { brief: tag(f.brief)!.description } : {}),
  }));
}
