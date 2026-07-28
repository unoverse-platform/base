/**
 * Tier 2: structural validation against nodes/_schema/*.json.
 *
 * A JSON Schema catches shape. Everything a schema CANNOT express (cross-file agreement,
 * ordering, reachability) is tier 3 and lives in the rule modules.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { report, state } from "../context.mjs";

const require_ = createRequire(import.meta.url);
/**
 * EXPORTED, because `node.mjs` validates a fixture against a RELAXED copy of the node's own
 * configSchema — an ad-hoc schema built at run time, not one of the files loaded above. It needs the
 * same validator, and this module is where the dependency is resolved and its absence explained, so
 * re-requiring it there would mean two places to change and two error messages for one missing
 * package.
 */
export let Validator;
try {
  ({ Validator } = require_("@cfworker/json-schema"));
} catch {
  throw new Error("the node linter needs @cfworker/json-schema (npm install -D @cfworker/json-schema)");
}

export const SCHEMA_ID = {
  node: "https://unoverse/nodes/node.schema.json",
  interface: "https://unoverse/nodes/interface.schema.json",
  config: "https://unoverse/nodes/config.schema.json",
  api: "https://unoverse/nodes/api.schema.json",
  test: "https://unoverse/nodes/test.schema.json",
  package: "https://unoverse/nodes/package.schema.json",
  credential: "https://unoverse/nodes/credential.schema.json",
};

/** The four sections that may live in their own file OR inline in node.yaml. */
export const SECTIONS = ["interface", "config", "api", "test"];

/** Read _schema/*.json into the run. A malformed schema is REPORTED, never thrown: the
 *  caller gets one shape of answer whatever went wrong. */
export function loadSchemas() {
  if (!existsSync(state.schemaDir)) return;
  for (const f of readdirSync(state.schemaDir).filter((f) => f.endsWith(".json")))
    try {
      const s = JSON.parse(readFileSync(join(state.schemaDir, f), "utf8"));
      state.schemas[s.$id] = s;
    } catch (e) {
      report("error", `_schema/${f}`, `is not valid JSON: ${e.message}`);
    }
}

export function validateAgainst(schemaId, doc, file, label) {
  const schema = state.schemas[schemaId];
  if (!schema) {
    report("warn", file, `no schema found for ${label}. Is nodes/_schema/ present?`);
    return;
  }
  const v = new Validator(schema, "7", false);
  for (const [id, s] of Object.entries(state.schemas)) if (id !== schemaId) v.addSchema(s, id);
  const r = v.validate(doc);
  if (r.valid) return;
  // A single bad value produces one error per schema level plus internal artefacts.
  // Keep only the DEEPEST error per location: that is the one naming the real problem.
  const useful = r.errors.filter(
    (e) => !/False boolean schema|does not match additional properties|A subschema had errors|does not match schema\.$/.test(e.error),
  );
  const deepest = new Map();
  for (const e of useful.length ? useful : r.errors) {
    const at = e.instanceLocation.replace(/^#/, "") || "(root)";
    if (!deepest.has(at)) deepest.set(at, e.error);
  }
  for (const [at, err] of [...deepest].slice(0, 6)) report("error", file, `${at} ${err} (${label})`);
}

