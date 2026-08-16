/**
 * A PLACEHOLDER IS NEVER CONTENT.
 *
 * The referee's two erasers exist so a model NEVER needs a stand-in: omit a part and it
 * stays untouched; send it empty (string "" / array []) and it clears. Models pad
 * anyway when told to send only some sections — observed live 2026-08-16: every omitted
 * part of a deal page padded with a literal "x" per fill call, briefly rendering an
 * "x"-covered page to the person watching. The prompt asked the model not to do this
 * and the model did it anyway, which is why the rule is enforced here rather than
 * requested there.
 *
 * The escape hatches matter as much as the rule: the placeholder vocabulary is a
 * closed, observed set ("x", dashes, "N/A", "TBD", "Not stated", ...) — a genuine short
 * value ("8%", "A", "£5m") is not in it, and the two deliberate CLEAR shapes stay
 * accepted exactly as before.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { validateBriefPart } from "../src/markdown/referee.js";

const STRING_SPEC = { properties: { tagline: { type: "string", maxLength: 240 } } };
const ARRAY_SPEC = {
  properties: {
    feeFields: {
      type: "array",
      maxItems: 24,
      items: {
        required: ["label", "value"],
        properties: {
          label: { type: "string", maxLength: 40 },
          value: { type: "string", maxLength: 120 },
        },
      },
    },
  },
};

test("a literal 'x' in an item field is rejected as a placeholder, not merged", () => {
  const problems = validateBriefPart(ARRAY_SPEC, "feeFields", [{ label: "x", value: "x" }]);
  assert.ok(problems.length >= 1, "expected at least one problem");
  assert.ok(
    problems.every((p) => p.includes("placeholder")),
    `every problem should name the placeholder rule, got: ${problems.join(" | ")}`,
  );
});

test("the observed stand-in vocabulary is rejected top-level too", () => {
  for (const junk of ["x", "X", "-", "—", "...", "N/A", "n/a", "TBD", "Not stated", "pending"]) {
    const problems = validateBriefPart(STRING_SPEC, "tagline", junk);
    assert.equal(problems.length, 1, `"${junk}" should be rejected`);
    assert.ok(problems[0].includes("placeholder"), `"${junk}" should be named a placeholder`);
  }
});

test("genuine short values are NOT placeholders", () => {
  for (const real of ["8%", "£5m", "A", "0.75%", "Q4 2026", "None"]) {
    const problems = validateBriefPart(STRING_SPEC, "tagline", real);
    assert.deepEqual(problems, [], `"${real}" must be accepted`);
  }
});

test("the two deliberate CLEAR shapes stay accepted: empty string and empty array, top-level only", () => {
  assert.deepEqual(validateBriefPart(STRING_SPEC, "tagline", ""), []);
  assert.deepEqual(validateBriefPart(ARRAY_SPEC, "feeFields", []), []);
  // Nested stays strict: an entry with an empty field is malformed.
  const nested = validateBriefPart(ARRAY_SPEC, "feeFields", [{ label: "", value: "0.75%" }]);
  assert.ok(nested.length === 1 && nested[0].includes("empty or missing"));
});
