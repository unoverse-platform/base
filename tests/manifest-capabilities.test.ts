/**
 * CAPABILITY PARITY GUARD — every value api.schema.json offers must be implemented.
 *
 * The schema's whole purpose is to BE the executor's capability list: a manifest may
 * only NAME a capability that already exists (DECLARATIVE_NODES.md §2). A value with no
 * implementation is the worst kind of gap, because the node lints clean, publishes
 * clean, and then fails at run time on someone else's universe.
 *
 * This was not hypothetical. Six values shipped in the schema unimplemented
 * (pagination, oauth2ClientCredentials, awsSigV4, ndjson, awsEventStream, binary), and
 * `retry` was declared by every manifest written so far while doing nothing at all.
 * Prose did not prevent it, so this does.
 *
 * If this fails: implement the capability, or take it out of the schema. Do not add it
 * to the allowlist below unless it genuinely needs no code.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(HERE, "../../../apps/unoverse/nodes/_schema/api.schema.json");
const RUNTIME = join(HERE, "../src/manifests/runtime");

const schema = JSON.parse(readFileSync(SCHEMA, "utf8"));
/**
 * The WHOLE runtime TREE, recursively.
 *
 * A capability can be implemented in any file, and the folder is now grouped by concern —
 * auth/, http/, loops/, duplex/, tools/ — so a flat `readdirSync` sees only the handful of
 * modules left at the top and reports every real implementation as missing.
 *
 * It did exactly that when the folders were introduced, and the failure was LOUD: 18 red
 * assertions naming capabilities that were never gone. That is the correct outcome and the reason
 * this reads a tree rather than a listing — the alternative version of this bug is a guard that
 * quietly passes because it found nothing to check.
 */
function runtimeSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...runtimeSources(p));
    else if (entry.name.endsWith(".ts")) out.push(readFileSync(p, "utf8"));
  }
  return out;
}
const runtime = runtimeSources(RUNTIME).join("\n");

/** Values that are real but need no branch of their own. */
const NEEDS_NO_CODE = new Set([
  "none", // the absence of auth
  "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", // fetch handles the verb
]);

/**
 * Every enum the schema exposes to an author, with where it lives. Walked rather than
 * listed, so a NEW enum added to the schema is covered the day it appears — a guard
 * that enumerates by hand passes by seeing nothing.
 */
function* enums(node: any, path: string[] = []): Generator<{ at: string; values: string[] }> {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node.enum)) yield { at: path.join(".") || "(root)", values: node.enum };
  if (typeof node.const === "string") yield { at: path.join("."), values: [node.const] };
  for (const [k, v] of Object.entries(node)) {
    if (k === "enum" || k === "description" || k === "examples") continue;
    yield* enums(v, [...path, k]);
  }
}

const found = [...enums(schema)];

/**
 * NO SOURCE-URL IMPORTS in the runtime.
 *
 * This test used to assert the opposite: that two `new URL("../../../../../apps/unoverse/
 * engine/…")` paths still resolved. The sandbox and the Handlebars resolver lived in the
 * engine, so the runtime could not name them, and a URL is a STRING — tsc could not check
 * either one. Moving a folder broke both while the build stayed green, and this was the
 * only thing that caught it.
 *
 * They live in `packages/base/src/template/` now and are imported like anything else, so
 * the check inverts: a source-URL import is the smell, and reintroducing one would put the
 * unverifiable-path failure mode straight back. If a future module genuinely needs one,
 * it needs its own existence check too.
 */
test("the runtime imports its dependencies, never by source URL", () => {
  const templating = readFileSync(join(RUNTIME, "templating.ts"), "utf8");
  const urls = [...templating.matchAll(/new URL\("([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    urls,
    [],
    `runtime/templating.ts reaches ${urls.join(", ")} by source URL. That is a string, so tsc ` +
      `cannot check it and the node only fails when it runs — import it instead.`,
  );

  // And the two it depends on are real, checkable imports.
  for (const mod of ["SafeExpression.js", "StringTemplateResolver.js"]) {
    assert.ok(
      templating.includes(`../../template/${mod}`),
      `expected templating.ts to import ${mod} from this package's template folder`,
    );
    assert.ok(existsSync(join(RUNTIME, "../../template", mod.replace(".js", ".ts"))), `${mod} must exist in packages/base`);
  }
});

test("the capability guard actually sees the schema", () => {
  // A parity test that walked nothing would pass forever.
  assert.ok(found.length >= 4, `expected several enums in api.schema.json, walked ${found.length}`);
  const all = found.flatMap((e) => e.values);
  assert.ok(all.includes("bearer"), "did not find the auth schemes");
  assert.ok(all.includes("sse"), "did not find the transports");
});

for (const { at, values } of found) {
  for (const value of values) {
    if (NEEDS_NO_CODE.has(value)) continue;
    test(`api.schema.json ${at}: "${value}" is implemented in the executor`, () => {
      assert.ok(
        runtime.includes(`"${value}"`),
        `api.schema.json offers "${value}" at ${at}, but manifests/runtime/ never mentions it. ` +
          `A manifest naming it would lint clean and fail at run time. Implement it, or remove it from the schema.`,
      );
    });
  }
}

/**
 * THE OTHER HALF: a call's PROPERTIES, not just its enum values.
 *
 * The walk above only ever looked at `enum` and `const`, so a scalar property could be offered by
 * the schema, written in manifests, and implemented nowhere — passing this file every time.
 *
 * `timeoutMs` did exactly that. It sat in the schema and in seven manifests from the beginning while
 * the runtime never read it, so every call ran unbounded. It surfaced as an OpenAI node hanging for
 * 154 seconds against a declared `timeoutMs: 120000` before the vendor's edge returned a 520 — the
 * number in the manifest was fiction, and the guard written to prevent precisely this could not see
 * it. `retry` had been the same bug once before, which is why it is named in this file's header.
 *
 * So the enumerator is widened rather than the one value patched: a checker that lists only one kind
 * of thing passes by not looking at the rest.
 */
const CALL_PROPS: Record<string, any> = schema.definitions?.call?.properties ?? {};

test("the property guard actually sees the call definition", () => {
  // Same reasoning as above: an empty walk would pass forever.
  assert.ok(Object.keys(CALL_PROPS).length >= 15, `expected the call definition's properties, saw ${Object.keys(CALL_PROPS).length}`);
  assert.ok("timeoutMs" in CALL_PROPS, "did not find timeoutMs, the property this guard was written for");
});

for (const prop of Object.keys(CALL_PROPS)) {
  // The enum-valued ones are already covered value by value above, which is stricter.
  if (CALL_PROPS[prop]?.enum) continue;
  test(`api.schema.json call.${prop} is read by the executor`, () => {
    // `call.<prop>` or `<prop>:` or a destructure — any of them proves the runtime looks at it.
    assert.ok(
      new RegExp(`\\b${prop}\\b`).test(runtime),
      `api.schema.json offers call.${prop}, but manifests/runtime/ never mentions it. A manifest ` +
        `setting it would lint clean and be silently ignored — which is how timeoutMs shipped dead. ` +
        `Implement it, or remove it from the schema.`,
    );
  });
}
