/**
 * THE CONTENT HASH. Its own file, like allowedHosts.ts, because it is a security control.
 *
 * AllowedHosts answers "what can this node do?". It does NOT answer "is this the node I
 * approved?", and only the second question is about tampering. See SECURITY.md
 * §"Manifest integrity — phase 1, the content hash".
 *
 * WHAT IS HASHED: the COMPOSED document, which includes the package envelope.
 *
 * Not the node's own files alone, and this is the whole point rather than a detail.
 * `allowedHosts` is declared in package.yaml, so a hash over only api/run.yaml would leave the
 * allowlist that bounds the node editable by anyone who can edit the node. Hashing the
 * composition is what makes the allowedHosts declaration itself tamper-evident.
 *
 * Canonical JSON, not the YAML bytes, so reformatting or editing a comment does not break
 * the seal while everything that actually EXECUTES stays covered. A comment cannot change
 * behaviour; a changed URL, credential reference or expression always can.
 *
 * WHEN: at load, and only at load. Verification is a boot-time cost of milliseconds across
 * a package. Nothing is hashed while a node is running, and nothing ever should be: a
 * per-call check would be the one design that actually slows nodes down.
 *
 * WHAT THIS IS NOT: a hash stored beside the thing it protects is tamper EVIDENCE, not
 * tamper PREVENTION. Someone with database write access can change the manifest and the
 * hash in one transaction. It catches a hand-edited row, a stray script, drift between git
 * and a universe, and corruption. Defeating an attacker who already owns the database is
 * what signing is for, and that is phase 2.
 */
import { createHash } from "node:crypto";
import type { ComposedNode } from "./compose.js";

/** Prefixed so a stored value says what produced it, and a future scheme can coexist. */
const PREFIX = "sha256";

/**
 * Canonical JSON: object keys sorted at every depth, arrays left alone.
 *
 * Sorting keys makes the hash independent of the order YAML happened to be written in, so
 * moving `transport` above `auth` in a file is not a tamper. Array order is PRESERVED and
 * must be: the order of `run` is the order the calls happen, and the order of `events` is
 * the connector order lint enforces. Sorting those would erase real meaning.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      out[key] = canonical((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/**
 * The hash of a composed node: `sha256:<hex>`.
 *
 * `origin` is deliberately EXCLUDED. It is the absolute path on disk or a `postgres:` id,
 * so including it would give the same node a different hash on every machine and make the
 * value useless for comparing what a developer reviewed against what a universe is running.
 * Everything else about the node is in scope, including `allowedHosts`.
 */
export function hashNode(node: ComposedNode): string {
  const subject = {
    type: node.type,
    kind: node.kind,
    packageName: node.packageName,
    allowedHosts: node.allowedHosts,
    definition: node.definition,
    api: node.api,
  };
  return `${PREFIX}:${createHash("sha256").update(JSON.stringify(canonical(subject))).digest("hex")}`;
}

export class IntegrityError extends Error {}

/**
 * Refuse a node whose content does not match the hash its source recorded.
 *
 * A source with no expected hash is NOT an error: manifests on disk are governed by git,
 * which is a better integrity control than a hash file sitting next to the thing it
 * protects, and demanding one would make local authoring impossible. The check applies
 * where a hash was recorded, which in practice means rows.
 */
export function assertUnchanged(node: ComposedNode, expected: string | undefined, where: string): void {
  if (!expected) return;
  const actual = hashNode(node);
  if (actual === expected) return;
  throw new IntegrityError(
    `${where}: content hash mismatch. Recorded ${expected}, computed ${actual}. ` +
      `This node's manifest has changed since it was published, so it will NOT be registered. ` +
      `Re-deploy it from source rather than editing the stored copy (SECURITY.md §Manifest integrity).`,
  );
}
