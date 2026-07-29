/**
 * Reading a node off disk: YAML parsing, $ref resolution, and where shared/ lives.
 *
 * $refs are resolved HERE rather than by the schema validator so a broken reference is a
 * lint finding pointing at the file that made it, not a validation error deep in a
 * composed document nobody wrote.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { report, rel, refCounts } from "../context.mjs";

const require_ = createRequire(import.meta.url);
let YAML;
try {
  YAML = require_("yaml");
} catch {
  throw new Error("the node linter needs yaml (npm install -D yaml)");
}

export function readYaml(file) {
  try {
    const doc = YAML.parse(readFileSync(file, "utf8"));
    if (doc && typeof doc === "object") delete doc.$schema;
    return doc ?? {};
  } catch (e) {
    report("error", rel(file), `is not valid YAML: ${e.message.split("\n")[0]}`);
    return null;
  }
}

/**
 * Resolve a `$ref` against the package's `shared/` folder.
 *
 * SHORT FORM, and the one to write:
 *     url:  { $ref: endpoints#responses }
 *     enum: { $ref: models#enum }
 *     toolExchange:
 *       $ref: tools          # whole file
 *       maxTurns: 5          # local keys layer on top and win
 *
 * No path, because there was never a real path: shared fragments are package-scoped and
 * the directory part was always thrown away. `../../shared/endpoints.yaml#/responses`
 * still works, but it is arithmetic that buys nothing.
 *
 * A LONE $ref REPLACES. A $ref WITH SIBLINGS MERGES, local winning, which is what lets a
 * node import a whole shared block and adjust one field.
 */
/**
 * DEEP for plain objects, so overriding one field does not delete its siblings.
 *
 * A shallow spread made `{ $ref: x, body: { mode: 'intent' } }` REPLACE the imported body
 * entirely: every other key — the filters, the result cap, the query itself — vanished, and
 * the request still went out, valid and wrong. Nothing failed, because a body with fewer
 * keys is a legal body. That is the worst shape of bug this format can produce, and the
 * whole point of a $ref with siblings is "import a block and adjust one field".
 *
 * Arrays REPLACE rather than concatenating: a list is an ordered whole, and merging two
 * would give an author no way to shorten one.
 */
function deepMerge(base, over) {
  if (base === null || typeof base !== "object" || Array.isArray(base)) return over;
  if (over === null || typeof over !== "object" || Array.isArray(over)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

export function resolveRefs(value, baseDir, file, seen = new Set()) {
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, baseDir, file, seen));
  if (!value || typeof value !== "object") return value;

  const keys = Object.keys(value);
  if (typeof value.$ref === "string") {
    const [target, frag = ""] = value.$ref.split("#");
    // `endpoints`, `endpoints.yaml`, or a full relative path — all the same file.
    const stem = (target.split("/").pop() ?? "").replace(/\.ya?ml$/, "");
    const abs = target.includes("/")
      ? resolve(baseDir, target)
      : [join(sharedDirFor(baseDir), `${stem}.yaml`), join(sharedDirFor(baseDir), `${stem}.yml`)].find(existsSync) ??
        join(sharedDirFor(baseDir), `${stem}.yaml`);
    if (seen.has(value.$ref)) {
      report("error", file, `$ref cycle at "${value.$ref}"`);
      return null;
    }
    if (!existsSync(abs)) {
      report("error", file, `$ref "${value.$ref}" points at a file that does not exist`);
      return null;
    }
    const doc = readYaml(abs);
    if (doc === null) return null;
    const hit = frag
      .replace(/^\//, "")
      .split("/")
      .filter(Boolean)
      .reduce((a, k) => (a == null ? a : a[k]), doc);
    if (hit === undefined) {
      report("error", file, `$ref "${value.$ref}" resolved to nothing. Check the fragment path`);
      return null;
    }
    // Count distinct CONSUMERS, not $ref sites: one config.yaml referencing a
    // fragment twice (enum + enumNames) is still a single consumer.
    if (!refCounts.has(abs)) refCounts.set(abs, new Set());
    refCounts.get(abs).add(file);
    // Recurse with the ORIGINAL baseDir, not the fragment's own directory. A $ref stem is
    // package-scoped (compose.ts resolves every one against pkg.shared), so re-basing onto
    // shared/ made a nested ref look for <pkg>/../shared and report a missing file. It
    // only stayed hidden because no shared fragment had contained a $ref before.
    const imported = resolveRefs(hit, baseDir, file, new Set([...seen, value.$ref]));
    if (keys.length === 1) return imported;
    const local = Object.fromEntries(
      keys.filter((k) => k !== "$ref").map((k) => [k, resolveRefs(value[k], baseDir, file, seen)]),
    );
    if (imported === null || typeof imported !== "object" || Array.isArray(imported)) {
      report("error", file, `$ref "${value.$ref}" is not an object, so it cannot be merged with sibling keys`);
      return local;
    }
    return deepMerge(imported, local);
  }
  return Object.fromEntries(keys.map((k) => [k, resolveRefs(value[k], baseDir, file, seen)]));
}
/** A node dir is <pkg>/nodes/<Node>, so shared/ is two levels up. */
export function sharedDirFor(nodeDir) {
  return join(nodeDir, "..", "..", "shared");
}

