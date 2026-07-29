/**
 * ONE HANDLER PER TOOL, transcribed verbatim from the retired smart-document package
 * (service/mcpHandlers.ts) — only the `api` parameter became the raw `redis` client. The
 * error shapes are the AGENT'S RECOVERY PROTOCOL (STALE_SECTION returns the fresh hash and
 * body so the model retries without a human): changing a field name here breaks agents, not
 * types.
 */
import {
  findSection,
  findSectionIndex,
  getDoc,
  mutateDoc,
  resetDoc as resetDocStore,
} from "./store.js";
import { findDisallowedHeading, hashSection, makeSection, renderMarkdown } from "./sectionizer.js";
import type {
  Doc,
  Section,
  SectionLevel,
  ServiceResult,
} from "./types.js";

function staleSection(doc: Doc, s: Section): ServiceResult {
  return {
    ok: false,
    error: "STALE_SECTION",
    currentHash: s.hash,
    currentBody: s.body,
    currentVersion: doc.version,
    hint: "Section changed since you read it. Use currentBody and currentHash and retry.",
  };
}

function staleDoc(doc: Doc): ServiceResult {
  return {
    ok: false,
    error: "STALE_DOC",
    currentVersion: doc.version,
    hint: "Document changed since you last read the outline. Call outline() again and retry.",
  };
}

function notFound(id: string): ServiceResult {
  return { ok: false, error: "NOT_FOUND", hint: `No section with id '${id}'.` };
}

function invalidParams(message: string): ServiceResult {
  return { ok: false, error: "INVALID_PARAMS", hint: message };
}

function rehash(s: Section) {
  s.hash = hashSection(s.heading, s.body);
}

// ---------- READ ----------

export async function handleOutline(
  redis: any,
  key: string,
  sectionizeAt: SectionLevel,
): Promise<ServiceResult> {
  const doc = await getDoc(redis, key, sectionizeAt);
  if (!doc) return { ok: false, error: "NOT_INITIALISED" };
  return {
    ok: true,
    version: doc.version,
    sections: doc.sections.map((s) => ({
      id: s.id,
      level: s.level,
      heading: s.heading,
      parentId: s.parentId,
      hash: s.hash,
      wordCount: countWords(s.body),
    })),
  };
}

function countWords(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

export async function handleReadSection(
  redis: any,
  key: string,
  params: { id?: string; includeChildren?: boolean },
  sectionizeAt: SectionLevel,
): Promise<ServiceResult> {
  if (typeof params?.id !== "string") return invalidParams("id must be a string");
  const doc = await getDoc(redis, key, sectionizeAt);
  if (!doc) return { ok: false, error: "NOT_INITIALISED" };
  const s = findSection(doc, params.id);
  if (!s) return notFound(params.id);

  let children: any[] | undefined;
  if (params.includeChildren) {
    children = doc.sections
      .filter((c) => c.parentId === s.id)
      .map((c) => ({ id: c.id, level: c.level, heading: c.heading, body: c.body, hash: c.hash }));
  }

  return {
    ok: true,
    version: doc.version,
    id: s.id,
    level: s.level,
    heading: s.heading,
    body: s.body,
    hash: s.hash,
    ...(children ? { children } : {}),
  };
}

// ---------- EDIT ----------

export async function handleUpdateSection(
  redis: any,
  key: string,
  params: {
    id?: string;
    expectedHash?: string;
    heading?: string;
    body?: string;
    expectedDocVersion?: number;
  },
  sectionizeAt: SectionLevel,
): Promise<ServiceResult> {
  if (typeof params?.id !== "string") return invalidParams("id must be a string");
  if (typeof params?.expectedHash !== "string") return invalidParams("expectedHash is required");
  if (params.heading === undefined && params.body === undefined) {
    return invalidParams("provide at least one of heading or body");
  }

  const result = await mutateDoc(redis, key, (doc) => {
    if (params.expectedDocVersion !== undefined && params.expectedDocVersion !== doc.version) {
      return { ok: false, error: "STALE_DOC" };
    }
    const s = findSection(doc, params.id!);
    if (!s) return { ok: false, error: "NOT_FOUND" };
    if (s.hash !== params.expectedHash) {
      return { ok: false, error: "STALE_SECTION" };
    }
    if (typeof params.body === "string") {
      const bad = findDisallowedHeading(params.body, sectionizeAt);
      if (bad) return { ok: false, error: "INVALID_STRUCTURE", extra: { line: bad } };
      s.body = params.body;
    }
    if (typeof params.heading === "string") {
      s.heading = params.heading;
    }
    rehash(s);
    return { ok: true };
  });

  return resolveMutation(redis, key, result, params.id, sectionizeAt);
}

export async function handleAppendToSection(
  redis: any,
  key: string,
  params: {
    id?: string;
    expectedHash?: string;
    text?: string;
    expectedDocVersion?: number;
  },
  sectionizeAt: SectionLevel,
): Promise<ServiceResult> {
  if (typeof params?.id !== "string") return invalidParams("id must be a string");
  if (typeof params?.expectedHash !== "string") return invalidParams("expectedHash is required");
  if (typeof params?.text !== "string") return invalidParams("text must be a string");

  const result = await mutateDoc(redis, key, (doc) => {
    if (params.expectedDocVersion !== undefined && params.expectedDocVersion !== doc.version) {
      return { ok: false, error: "STALE_DOC" };
    }
    const s = findSection(doc, params.id!);
    if (!s) return { ok: false, error: "NOT_FOUND" };
    if (s.hash !== params.expectedHash) {
      return { ok: false, error: "STALE_SECTION" };
    }
    const appended = s.body.length === 0 ? params.text! : s.body + "\n\n" + params.text!;
    const bad = findDisallowedHeading(appended, sectionizeAt);
    if (bad) return { ok: false, error: "INVALID_STRUCTURE", extra: { line: bad } };
    s.body = appended;
    rehash(s);
    return { ok: true };
  });

  return resolveMutation(redis, key, result, params.id, sectionizeAt);
}

export async function handleReplaceInSection(
  redis: any,
  key: string,
  params: {
    id?: string;
    expectedHash?: string;
    old_str?: string;
    new_str?: string;
    expectedDocVersion?: number;
  },
  sectionizeAt: SectionLevel,
): Promise<ServiceResult> {
  if (typeof params?.id !== "string") return invalidParams("id must be a string");
  if (typeof params?.expectedHash !== "string") return invalidParams("expectedHash is required");
  if (typeof params?.old_str !== "string" || params.old_str.length === 0) {
    return invalidParams("old_str must be a non-empty string");
  }
  if (typeof params?.new_str !== "string") return invalidParams("new_str must be a string");

  const result = await mutateDoc(redis, key, (doc) => {
    if (params.expectedDocVersion !== undefined && params.expectedDocVersion !== doc.version) {
      return { ok: false, error: "STALE_DOC" };
    }
    const s = findSection(doc, params.id!);
    if (!s) return { ok: false, error: "NOT_FOUND" };
    if (s.hash !== params.expectedHash) {
      return { ok: false, error: "STALE_SECTION" };
    }
    const matches = countOccurrences(s.body, params.old_str!);
    if (matches === 0) return { ok: false, error: "NOT_FOUND" };
    if (matches > 1) return { ok: false, error: "NOT_UNIQUE", extra: { matches } };
    const next = s.body.replace(params.old_str!, params.new_str!);
    const bad = findDisallowedHeading(next, sectionizeAt);
    if (bad) return { ok: false, error: "INVALID_STRUCTURE", extra: { line: bad } };
    s.body = next;
    rehash(s);
    return { ok: true };
  });

  return resolveMutation(redis, key, result, params.id, sectionizeAt);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

export async function handleInsertSection(
  redis: any,
  key: string,
  params: {
    afterId?: string;
    beforeId?: string;
    parentId?: string;
    level?: number;
    heading?: string;
    body?: string;
    expectedDocVersion?: number;
  },
  sectionizeAt: SectionLevel,
): Promise<ServiceResult> {
  const placementKeys = ["afterId", "beforeId", "parentId"].filter(
    (k) => typeof (params as any)[k] === "string",
  );
  // Placement is required only when the doc already has sections.
  // An empty doc implicitly appends at root.
  if (params.level !== 1 && params.level !== 2) {
    return invalidParams("level must be 1 or 2");
  }
  if (params.level > sectionizeAt) {
    return invalidParams(`level ${params.level} exceeds sectionizeAt ${sectionizeAt}`);
  }
  if (typeof params.heading !== "string") return invalidParams("heading is required");
  const body = typeof params.body === "string" ? params.body : "";
  const bad = findDisallowedHeading(body, sectionizeAt);
  if (bad) {
    return { ok: false, error: "INVALID_STRUCTURE", hint: `body contains disallowed heading: ${bad}` };
  }

  let newId = "";
  const result = await mutateDoc(redis, key, (doc) => {
    if (params.expectedDocVersion !== undefined && params.expectedDocVersion !== doc.version) {
      return { ok: false, error: "STALE_DOC" };
    }

    const newSection = makeSection(
      params.level as SectionLevel,
      params.heading!,
      body,
      null,
      doc.sections.length,
    );
    newId = newSection.id;

    if (params.afterId) {
      const idx = findSectionIndex(doc, params.afterId);
      if (idx === -1) return { ok: false, error: "INVALID_PLACEMENT" };
      doc.sections.splice(idx + 1, 0, newSection);
    } else if (params.beforeId) {
      const idx = findSectionIndex(doc, params.beforeId);
      if (idx === -1) return { ok: false, error: "INVALID_PLACEMENT" };
      doc.sections.splice(idx, 0, newSection);
    } else if (params.parentId) {
      const parentIdx = findSectionIndex(doc, params.parentId);
      if (parentIdx === -1) return { ok: false, error: "INVALID_PLACEMENT" };
      const parent = doc.sections[parentIdx];
      if (newSection.level <= parent.level) {
        return { ok: false, error: "INVALID_PLACEMENT" };
      }
      let insertAt = parentIdx + 1;
      while (
        insertAt < doc.sections.length &&
        doc.sections[insertAt].level > parent.level
      ) {
        insertAt++;
      }
      doc.sections.splice(insertAt, 0, newSection);
    } else {
      // No placement key — only valid when the doc is empty, or append to the end.
      if (doc.sections.length > 1) {
        // Doc has content but no placement specified — append at the root end.
        doc.sections.push(newSection);
      } else if (doc.sections.length === 1) {
        // Single existing section — append after it at the root.
        doc.sections.push(newSection);
      } else {
        // Empty doc — this is the first section.
        doc.sections.push(newSection);
      }
    }
    return { ok: true };
  });

  if (!result.ok) {
    const doc = await getDoc(redis, key, sectionizeAt);
    return errorFrom(result, doc);
  }

  const doc = result.doc;
  const s = findSection(doc, newId)!;
  return {
    ok: true,
    version: doc.version,
    id: s.id,
    hash: s.hash,
  };
}

export async function handleDeleteSection(
  redis: any,
  key: string,
  params: {
    id?: string;
    expectedHash?: string;
    cascade?: boolean;
    expectedDocVersion?: number;
  },
  sectionizeAt: SectionLevel,
): Promise<ServiceResult> {
  if (typeof params?.id !== "string") return invalidParams("id must be a string");
  if (typeof params?.expectedHash !== "string") return invalidParams("expectedHash is required");

  const result = await mutateDoc(redis, key, (doc) => {
    if (params.expectedDocVersion !== undefined && params.expectedDocVersion !== doc.version) {
      return { ok: false, error: "STALE_DOC" };
    }
    const idx = findSectionIndex(doc, params.id!);
    if (idx === -1) return { ok: false, error: "NOT_FOUND" };
    const target = doc.sections[idx];
    if (target.hash !== params.expectedHash) {
      return { ok: false, error: "STALE_SECTION" };
    }

    const cascade = params.cascade === true;
    const children = doc.sections.filter((c) => c.parentId === target.id);
    if (cascade) {
      const toRemove = new Set<string>([target.id]);
      // Expand to all descendants (only 2 levels given H1/H2, but safe to generalise)
      let grew = true;
      while (grew) {
        grew = false;
        for (const s of doc.sections) {
          if (s.parentId && toRemove.has(s.parentId) && !toRemove.has(s.id)) {
            toRemove.add(s.id);
            grew = true;
          }
        }
      }
      doc.sections = doc.sections.filter((s) => !toRemove.has(s.id));
    } else {
      for (const c of children) {
        c.parentId = target.parentId;
      }
      doc.sections.splice(idx, 1);
    }
    return { ok: true };
  });

  return resolveMutation(redis, key, result, undefined, sectionizeAt);
}

export async function handleMoveSection(
  redis: any,
  key: string,
  params: {
    id?: string;
    expectedHash?: string;
    afterId?: string;
    beforeId?: string;
    parentId?: string;
    expectedDocVersion?: number;
  },
  sectionizeAt: SectionLevel,
): Promise<ServiceResult> {
  if (typeof params?.id !== "string") return invalidParams("id must be a string");
  if (typeof params?.expectedHash !== "string") return invalidParams("expectedHash is required");
  const placementKeys = ["afterId", "beforeId", "parentId"].filter(
    (k) => typeof (params as any)[k] === "string",
  );
  if (placementKeys.length !== 1) {
    return invalidParams("exactly one of afterId, beforeId, or parentId is required");
  }

  const result = await mutateDoc(redis, key, (doc) => {
    if (params.expectedDocVersion !== undefined && params.expectedDocVersion !== doc.version) {
      return { ok: false, error: "STALE_DOC" };
    }
    const idx = findSectionIndex(doc, params.id!);
    if (idx === -1) return { ok: false, error: "NOT_FOUND" };
    const s = doc.sections[idx];
    if (s.hash !== params.expectedHash) {
      return { ok: false, error: "STALE_SECTION" };
    }

    // Remove from current position
    doc.sections.splice(idx, 1);

    // Re-insert at new position
    if (params.afterId) {
      const i = findSectionIndex(doc, params.afterId);
      if (i === -1) return { ok: false, error: "INVALID_PLACEMENT" };
      doc.sections.splice(i + 1, 0, s);
    } else if (params.beforeId) {
      const i = findSectionIndex(doc, params.beforeId);
      if (i === -1) return { ok: false, error: "INVALID_PLACEMENT" };
      doc.sections.splice(i, 0, s);
    } else if (params.parentId) {
      const pIdx = findSectionIndex(doc, params.parentId);
      if (pIdx === -1) return { ok: false, error: "INVALID_PLACEMENT" };
      const parent = doc.sections[pIdx];
      if (s.level <= parent.level) {
        return { ok: false, error: "INVALID_PLACEMENT" };
      }
      let insertAt = pIdx + 1;
      while (insertAt < doc.sections.length && doc.sections[insertAt].level > parent.level) {
        insertAt++;
      }
      doc.sections.splice(insertAt, 0, s);
    }
    return { ok: true };
  });

  return resolveMutation(redis, key, result, params.id, sectionizeAt);
}

// ---------- BULK ----------

export async function handleResetDoc(
  redis: any,
  key: string,
  initialMarkdown: string,
  sectionizeAt: SectionLevel,
): Promise<ServiceResult> {
  const doc = await resetDocStore(redis, key, initialMarkdown, sectionizeAt);
  return {
    ok: true,
    version: doc.version,
    sectionCount: doc.sections.length,
  };
}

// ---------- helpers ----------

type ServiceSuccess = Extract<ServiceResult, { ok: true }>;

async function resolveMutation(
  redis: any,
  key: string,
  result:
    | { ok: true; doc: Doc }
    | { ok: false; error: string; extra?: Record<string, any> },
  sectionId: string | undefined,
  sectionizeAt: SectionLevel,
): Promise<ServiceResult> {
  if (!result.ok) {
    const doc = await getDoc(redis, key, sectionizeAt);
    return errorFrom(result, doc, sectionId);
  }
  const doc = result.doc;
  const response: ServiceSuccess = { ok: true, version: doc.version };
  if (sectionId) {
    const s = findSection(doc, sectionId);
    if (s) response.hash = s.hash;
  }
  return response;
}

function errorFrom(
  r: { ok: false; error: string; extra?: Record<string, any> },
  doc: Doc | null,
  sectionId?: string,
): ServiceResult {
  const base: any = { ok: false, error: r.error };
  if (doc) {
    base.currentVersion = doc.version;
    if (r.error === "STALE_SECTION" && sectionId) {
      const s = findSection(doc, sectionId);
      if (s) {
        base.currentHash = s.hash;
        base.currentBody = s.body;
        base.hint = "Section changed since you read it. Retry with currentHash + currentBody.";
      }
    }
    if (r.error === "STALE_DOC") {
      base.hint = "Document changed since you last read the outline. Retry after outline().";
    }
  }
  if (r.extra) Object.assign(base, r.extra);
  if (r.error === "NOT_UNIQUE" && !base.hint) {
    base.hint = "old_str matched multiple times. Widen it with surrounding context.";
  }
  if (r.error === "INVALID_STRUCTURE" && !base.hint) {
    base.hint = "Body contained an H1 or H2, which would corrupt the outline. Use H3+ inside bodies.";
  }
  if (r.error === "INVALID_PLACEMENT" && !base.hint) {
    base.hint = "Placement target id was not found or violates hierarchy rules.";
  }
  if (r.error === "CONCURRENT_UPDATE" && !base.hint) {
    base.hint = "Too many concurrent writers. Retry.";
  }
  return base;
}

// ---------- RENDER (used by executor) ----------

export function renderDoc(doc: Doc): string {
  return renderMarkdown(doc.sections);
}
