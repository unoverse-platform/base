/**
 * Section helpers — pure, dependency-free, and safe to import from a browser bundle.
 *
 * A record's structured body copy is rendered by the design system on every surface. The
 * rules for reading those sections belong in ONE place, or each renderer re-invents them
 * and they drift. This module is deliberately a leaf: no transport, no server imports, so
 * a UI can use it without dragging the agent runtime into its bundle.
 */

/**
 * Mark the first section of each group, so a renderer can print the group label once.
 *
 * A repeated template cannot see the item before it, which is how a hand-written renderer
 * decided this in React. Deriving it into the DATA keeps the rule in one place and gives
 * every surface the same answer.
 */
export function withGroupStarts<T>(sections: T): T {
  if (!Array.isArray(sections)) return sections;
  let previous = "";
  return sections.map((s) => {
    const section = (s ?? {}) as Record<string, unknown>;
    const group = typeof section.group === "string" ? section.group : "";
    const groupStart = Boolean(group) && group !== previous;
    if (group) previous = group;
    return { ...section, groupStart };
  }) as unknown as T;
}

/** How many tab slots the Document component authors. Four is a strip a reader takes in at
 *  a glance; beyond that the tabs stop helping. Later groups fold into the last tab rather
 *  than disappearing. */
export const MAX_TABS = 4;

/**
 * Shape a record's sections for the Document component.
 *
 * SDUI switches on STATIC case names, and a group label is whatever the source called it,
 * so tabs are addressed by POSITION: `tab0`…`tab5`, each with its own label. Flat, static,
 * and renderable by a component that cannot know a group's name in advance.
 *
 * Two rules carried over from the renderer this replaces, because both are load-bearing:
 * ungrouped material stays above the tabs (what the offering IS is never hidden behind
 * one), and fine print appears on every tab rather than only the one it happened to land in.
 */
export function toDocument(sections: unknown, layout?: string): Record<string, unknown> {
  const list = (Array.isArray(sections) ? sections : []) as Record<string, unknown>[];

  const groups: string[] = [];
  for (const s of list) {
    const g = typeof s?.group === "string" ? s.group : "";
    if (g && !groups.includes(g)) groups.push(g);
  }

  // The layout pass decides. Absent a decision, tabs earn their interaction cost only when
  // there is enough material that one page would be a wall.
  const tabbed = groups.length >= 2 && (layout === "tabs" || (!layout && list.length > 4));
  if (!tabbed) {
    // ONE group is not a grouping: a lone label applied to every section says nothing and
    // would print an eyebrow over the whole document. Drop it and read as one page.
    const flat = groups.length < 2 ? list.map((s) => ({ ...s, group: "" })) : list;
    return { tabbed: false, sections: withGroupStarts(flat) };
  }

  const finePrint = list.filter((s) => s.kind === "finePrint");
  const out: Record<string, unknown> = {
    tabbed: true,
    lead: withGroupStarts(list.filter((s) => !s.group && s.kind !== "finePrint")),
    // ALWAYS carried, even tabbed. The component switches on `tabbed` and ignores it, but a
    // host asking "does this record have a body?" has one field to look at either way. A
    // card guarding on `sections` rendered nothing for a tabbed record without it.
    sections: withGroupStarts(list),
  };

  const shown = groups.slice(0, MAX_TABS);
  shown.forEach((group, i) => {
    const last = i === MAX_TABS - 1;
    // The final tab absorbs every remaining group, so a fifth group is folded in rather
    // than dropped. Its sections keep their labels, since that tab now holds more than one.
    const mine = last ? groups.slice(i) : [group];
    const own = list.filter((s) => mine.includes(s.group as string) && s.kind !== "finePrint");
    out[`tab${i}Label`] = group;
    // The tab IS the label for a single group, so its eyebrow would only repeat it. A
    // folded tab keeps them, because it holds several.
    const labelled = last && mine.length > 1 ? withGroupStarts(own) : own.map((s) => ({ ...s, group: "", groupStart: false }));
    out[`tab${i}`] = [...(labelled as Record<string, unknown>[]), ...finePrint];
  });
  return out;
}

/**
 * A record's sections as plain text, for embeddings and for anything that wants words
 * rather than a document.
 *
 * DERIVED, never authored: the sections are the body, and this is a projection of them.
 * The old order (markdown first, sections filed from it) is what made two representations
 * of the same copy able to disagree.
 */
export function sectionsToText(sections: unknown): string {
  if (!Array.isArray(sections)) return "";
  const parts: string[] = [];
  for (const raw of sections) {
    const s = (raw ?? {}) as Record<string, any>;
    if (s.heading) parts.push(`## ${s.heading}`);
    if (s.body) parts.push(String(s.body));
    for (const f of Array.isArray(s.facts) ? s.facts : [])
      parts.push([f?.label, f?.value, f?.qualifier].filter(Boolean).join(": "));
    for (const i of Array.isArray(s.items) ? s.items : [])
      parts.push([i?.title, i?.body].filter(Boolean).join(" — ").replace(" — ", ": "));
    if (Array.isArray(s.columns) && s.columns.length) parts.push(s.columns.join(" | "));
    for (const row of Array.isArray(s.rows) ? s.rows : [])
      if (Array.isArray(row)) parts.push(row.join(" | "));
  }
  return parts.filter(Boolean).join("\n\n");
}
