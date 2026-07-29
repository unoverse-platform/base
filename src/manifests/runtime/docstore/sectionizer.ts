/**
 * TRANSCRIBED VERBATIM from the retired smart-document package (service/sectionizer.ts),
 * import paths aside. The parsing rules are load-bearing: a doc stored under the old node
 * must parse identically under this one, or every section hash changes and every agent's
 * next edit fails STALE_SECTION at once.
 */
import { createHash, randomBytes } from "crypto";
import type { Section, SectionLevel, Doc } from "./types.js";

/**
 * Parse raw markdown into a flat section list.
 * Only H1/H2 (configurable) become sections; H3+ stays in body.
 * ATX headings only (# / ##). Setext (=== / ---) and fenced-code-lines-that-look-like-headings
 * are intentionally ignored for simplicity.
 */
export function parseMarkdown(source: string, sectionizeAt: SectionLevel = 2): Section[] {
  const lines = source.split("\n");
  const sections: Section[] = [];
  let current: { level: SectionLevel; heading: string; body: string[] } | null = null;
  let inFence = false;
  let fenceMarker = "";

  const flush = () => {
    if (current === null) return;
    // Strip trailing empty lines from body
    const body = current.body.join("\n").replace(/\s+$/g, "");
    sections.push(makeSection(current.level, current.heading, body, null, sections.length));
    current = null;
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^(```+|~~~+)/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1];
      } else if (line.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = "";
      }
    }

    if (!inFence) {
      const headingMatch = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const heading = headingMatch[2].trim();
        if (level <= sectionizeAt) {
          flush();
          current = { level: level as SectionLevel, heading, body: [] };
          continue;
        }
      }
    }

    if (current === null) {
      // Content before the first qualifying heading — if non-empty, stash it.
      if (line.trim().length > 0) {
        current = { level: 1, heading: "", body: [line] };
      }
    } else {
      current.body.push(line);
    }
  }

  flush();

  // Build parentId relationships: H2s nest under the most recent H1.
  let lastH1Id: string | null = null;
  for (const s of sections) {
    if (s.level === 1) {
      lastH1Id = s.id;
      s.parentId = null;
    } else if (s.level === 2) {
      s.parentId = lastH1Id;
    }
  }

  return sections;
}

/**
 * Serialize a section list back to markdown.
 * Order is the section array order (which is kept in render order by the caller).
 */
export function renderMarkdown(sections: Section[]): string {
  const parts: string[] = [];
  for (const s of sections) {
    if (s.heading.length > 0) {
      parts.push(`${"#".repeat(s.level)} ${s.heading}`);
    }
    if (s.body.length > 0) {
      parts.push(s.body);
    }
  }
  return parts.join("\n\n") + "\n";
}

/**
 * Reject bodies that contain H1/H2 headings (would corrupt the outline).
 * Returns the offending heading text, or null if clean.
 */
export function findDisallowedHeading(body: string, sectionizeAt: SectionLevel = 2): string | null {
  const lines = body.split("\n");
  let inFence = false;
  let fenceMarker = "";
  for (const line of lines) {
    const fenceMatch = line.match(/^(```+|~~~+)/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1];
      } else if (line.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m && m[1].length <= sectionizeAt) {
      return line;
    }
  }
  return null;
}

export function makeSection(
  level: SectionLevel,
  heading: string,
  body: string,
  parentId: string | null,
  order: number,
): Section {
  return {
    id: generateId(),
    level,
    heading,
    body,
    parentId,
    order,
    hash: hashSection(heading, body),
  };
}

export function generateId(): string {
  return "sec_" + randomBytes(6).toString("base64url").replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
}

export function hashSection(heading: string, body: string): string {
  return createHash("sha256").update(heading + "\n\n" + body).digest("hex").slice(0, 12);
}

/**
 * Reconcile section order / parentId consistency after a mutation.
 * H2 sections automatically re-parent to the most recent preceding H1.
 * Rewrites `order` so siblings have contiguous ascending indices.
 */
export function reconcile(doc: Doc): void {
  // 1. Re-parent H2s to most recent H1 based on array order.
  let lastH1Id: string | null = null;
  for (const s of doc.sections) {
    if (s.level === 1) {
      lastH1Id = s.id;
      s.parentId = null;
    } else if (s.level === 2) {
      s.parentId = lastH1Id;
    }
  }

  // 2. Rewrite sibling order indices.
  const groups = new Map<string | null, Section[]>();
  for (const s of doc.sections) {
    const key = s.parentId;
    const arr = groups.get(key) ?? [];
    arr.push(s);
    groups.set(key, arr);
  }
  for (const arr of groups.values()) {
    arr.forEach((s, i) => {
      s.order = i;
    });
  }
}
