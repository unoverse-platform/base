/**
 * UNOVERSE MARKDOWN — judge what came back, one part at a time.
 *
 * Split by JOB, the way `agent-mcp/` is: `index.ts` is the surface and carries the map.
 */

/**
 * The REFEREE, one PART at a time: validate a single provided part against its spec.
 * Checks exactly the keywords the compiler emits (minLength, maxLength, maxItems, item
 * required fields) — no external validator dependency. Returns human-readable
 * violations for the model to correct; empty = the part is good.
 *
 * Per-part is the contract that makes rendering PROGRESSIVE even when the model
 * one-shots the whole page (observed live: it always does): the caller accepts the
 * good parts and rejects only the broken ones by name.
 */
export function validateBriefPart(schema: Record<string, unknown>, name: string, value: unknown): string[] {
  const problems: string[] = [];

  const checkString = (path: string, v: unknown, spec: Record<string, unknown>): void => {
    if (typeof v !== "string" || v.trim() === "") {
      problems.push(`${path}: empty or missing — fill it with real content from your spatial search results`);
      return;
    }
    const max = spec.maxLength as number | undefined;
    if (max != null && v.length > max) problems.push(`${path}: ${v.length} chars — shorten to ≤${max}`);
  };

  // One recursive checker mirrors the compiler exactly: arrays may nest (a chapter's
  // experiences inside the chapters array) — validate every level the schema declares.
  const checkValue = (path: string, v: unknown, spec: Record<string, unknown>): void => {
    if (spec.type === "array") {
      if (!Array.isArray(v) || v.length === 0) {
        problems.push(`${path}: missing or empty — compose the entries from your search results`);
        return;
      }
      // minItems is a TARGET, not a gate (progressive pages grow toward it — the mirror
      // reports the shortfall via listBriefGaps). maxItems stays a hard cap.
      const max = spec.maxItems as number | undefined;
      if (max != null && v.length > max) problems.push(`${path}: ${v.length} entries — at most ${max}`);
      const items = (spec.items ?? {}) as Record<string, unknown>;
      const itemProps = (items.properties ?? {}) as Record<string, Record<string, unknown>>;
      const itemRequired = (items.required ?? []) as string[];
      v.forEach((entry, i) => {
        const e = (entry ?? {}) as Record<string, unknown>;
        for (const f of itemRequired) checkValue(`${path}[${i}].${f}`, e[f], itemProps[f] ?? {});
      });
      return;
    }
    checkString(path, v, spec);
  };

  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  checkValue(name, value, props[name] ?? {});
  return problems;
}

/**
 * The REFEREE over a whole call: validate exactly what the call PROVIDES — a present
 * part must be real and complete; an absent part is simply "not composed yet" (the
 * mirror names it). A call providing NO briefed part at all renders nothing and is
 * rejected. Callers wanting per-part accept/reject use `validateBriefPart` directly.
 */
export function validateBriefArgs(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): string[] {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const provided = Object.keys(props).filter((name) => args[name] !== undefined);
  if (provided.length === 0) {
    return ["nothing to render — compose at least one part of the page from your spatial search results before calling"];
  }
  return provided.flatMap((name) => validateBriefPart(schema, name, args[name]));
}

// ─── Hydration map (the server's half of `hydrate`) ─────────────────────────
