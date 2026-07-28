/**
 * The content fingerprint of an item.
 *
 * ONE implementation, because two would decide differently and nobody would notice. The
 * publisher computes it before sending; the universe compares it against the row it holds
 * to decide installed / update / unchanged. A second copy that canonicalises keys in a
 * different order makes every publish look like a change, and every unchanged item look
 * stale, which is the kind of wrong that erodes trust in the whole marketplace view.
 *
 * KEY ORDER IS NOT CONTENT. Objects are serialised with sorted keys, so re-saving a
 * definition through a different YAML writer does not read as an edit. That property is
 * load-bearing: converting rx/ from JSON to YAML rewrote 242 files and must have altered
 * nothing a universe consumes (013_items.sql).
 *
 * Truncated to 16 hex characters. This identifies content, it does not defend against a
 * forged one: integrity is the node content hash (manifests/integrity.ts), and authority
 * is the publish gate.
 */
import { createHash } from "crypto";

/** Deterministic JSON: sorted keys, arrays in order, primitives as JSON. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

export function fingerprintOf(definition: unknown): string {
  return createHash("sha256").update(canonical(definition)).digest("hex").slice(0, 16);
}
