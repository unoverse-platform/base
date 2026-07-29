/**
 * THE DOC'S HOME IN REDIS, transcribed from the retired smart-document package
 * (service/markdownStore.ts) with ONE change: functions take the RAW REDIS CLIENT instead
 * of the plugin `api`, because this now lives in the manifest runtime where the executor
 * already holds the client (the same inversion `makeStateStore` uses).
 *
 * WATCH/MULTI optimistic locking is the reason this is an executor capability and not a
 * sequence of `state` calls: read-check-write must be one transaction, retried on conflict,
 * and no manifest call list can express "and if someone wrote in between, start over".
 *
 * KEYS ARE DELIBERATELY NOT NAMESPACED (`md:<user>:<workflow>:<conversation>:<node>`),
 * exactly as the retired node wrote them — a live doc mid-conversation must stay readable
 * across this migration, and hashing or prefixing the key would orphan every one of them.
 */
import type { Doc, Section, SectionLevel } from "./types.js";
import { parseMarkdown, reconcile } from "./sectionizer.js";

const TTL_SECONDS = 60 * 60 * 6;
const MAX_RETRIES = 5;

export function keyFor(
  userId: string,
  workflowId: string,
  conversationId: string,
  nodeId: string,
): string {
  return `md:${userId}:${workflowId}:${conversationId}:${nodeId}`;
}

/**
 * Read the doc. Lazy-migrates the legacy `{ content, version, updatedAt }` shape to the
 * `{ sections, version, updatedAt }` shape on first access.
 */
export async function getDoc(
  redis: any,
  key: string,
  sectionizeAt: SectionLevel = 2,
): Promise<Doc | null> {
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.sections)) {
      return parsed as Doc;
    }
    if (typeof parsed?.content === "string") {
      const migrated = migrateLegacy(parsed.content, parsed.version ?? 1, sectionizeAt);
      await redis.set(key, JSON.stringify(migrated), "EX", TTL_SECONDS);
      return migrated;
    }
    return null;
  } catch {
    return null;
  }
}

function migrateLegacy(content: string, version: number, sectionizeAt: SectionLevel): Doc {
  const sections = parseMarkdown(content, sectionizeAt);
  const doc: Doc = {
    sections,
    version: version + 1,
    updatedAt: new Date().toISOString(),
  };
  reconcile(doc);
  return doc;
}

/** Initialise the doc from `initialMarkdown` if it doesn't exist. No-op when present. */
export async function initDoc(
  redis: any,
  key: string,
  initialMarkdown: string,
  sectionizeAt: SectionLevel = 2,
): Promise<Doc> {
  const existing = await getDoc(redis, key, sectionizeAt);
  if (existing) return existing;
  const sections = parseMarkdown(initialMarkdown, sectionizeAt);
  const doc: Doc = {
    sections,
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  reconcile(doc);
  await redis.set(key, JSON.stringify(doc), "EX", TTL_SECONDS);
  return doc;
}

/** Force a fresh doc from initialMarkdown, discarding existing state. Fresh IDs. */
export async function resetDoc(
  redis: any,
  key: string,
  initialMarkdown: string,
  sectionizeAt: SectionLevel = 2,
): Promise<Doc> {
  const sections = parseMarkdown(initialMarkdown, sectionizeAt);
  const doc: Doc = {
    sections,
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  reconcile(doc);
  await redis.set(key, JSON.stringify(doc), "EX", TTL_SECONDS);
  return doc;
}

/**
 * Optimistic-locking mutation with Redis WATCH/MULTI. `mutate` receives the current doc and
 * may either mutate it in place + return ok, or return an error object. Retries up to
 * MAX_RETRIES on WATCH conflict.
 */
export async function mutateDoc(
  redis: any,
  key: string,
  mutate: (doc: Doc) =>
    | { ok: true }
    | { ok: false; error: string; extra?: Record<string, any> },
): Promise<
  | { ok: true; doc: Doc }
  | { ok: false; error: string; extra?: Record<string, any> }
> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await redis.watch(key);
    const raw = await redis.get(key);
    if (!raw) {
      await redis.unwatch();
      return { ok: false, error: "NOT_INITIALISED" };
    }

    let doc: Doc;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed?.sections)) {
        await redis.unwatch();
        return { ok: false, error: "NOT_INITIALISED" };
      }
      doc = parsed as Doc;
    } catch {
      await redis.unwatch();
      return { ok: false, error: "NOT_INITIALISED" };
    }

    const result = mutate(doc);
    if (!result.ok) {
      await redis.unwatch();
      return result;
    }

    doc.version = doc.version + 1;
    doc.updatedAt = new Date().toISOString();
    reconcile(doc);

    const execResult = await redis
      .multi()
      .set(key, JSON.stringify(doc), "EX", TTL_SECONDS)
      .exec();

    if (execResult !== null) {
      return { ok: true, doc };
    }
    // else retry
  }

  return { ok: false, error: "CONCURRENT_UPDATE" };
}

export function findSection(doc: Doc, id: string): Section | undefined {
  return doc.sections.find((s) => s.id === id);
}

export function findSectionIndex(doc: Doc, id: string): number {
  return doc.sections.findIndex((s) => s.id === id);
}
