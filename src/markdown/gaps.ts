/**
 * UNOVERSE MARKDOWN — what a page still owes.
 *
 * Split by JOB, the way `agent-mcp/` is: `index.ts` is the surface and carries the map.
 */

/**
 * What the brief still wants: the briefed parts this page does not yet carry, plus
 * arrays still below their minItems target — AT EVERY LEVEL. Nested collections count
 * too (a chapter whose `items` sits below its own minItems is a named gap like
 * `collections[0].items (1 of 2+ entries)`) — without this the mirror said COMPLETE
 * while a chapter sat half-empty and the model was never told (observed live).
 * Guidance for the mirror — never a rejection.
 */
export function listBriefGaps(schema: Record<string, unknown>, args: Record<string, unknown>): string[] {
  const gaps: string[] = [];
  const walkArray = (path: string, v: unknown, spec: Record<string, unknown>): void => {
    if (!Array.isArray(v)) return;
    const min = spec.minItems as number | undefined;
    if (min != null && v.length < min) gaps.push(`${path} (${v.length} of ${min}+ entries)`);
    const items = (spec.items ?? {}) as Record<string, unknown>;
    const itemProps = (items.properties ?? {}) as Record<string, Record<string, unknown>>;
    v.forEach((entry, i) => {
      const e = (entry ?? {}) as Record<string, unknown>;
      for (const [name, s] of Object.entries(itemProps)) {
        if (s.type === "array") walkArray(`${path}[${i}].${name}`, e[name], s);
      }
    });
  };
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, spec] of Object.entries(props)) {
    const v = args[name];
    if (v === undefined) gaps.push(name);
    else if (spec.type === "array") walkArray(name, v, spec);
  }
  return gaps;
}
