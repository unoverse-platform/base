/**
 * REF PROP CONTRACT — a key the atom does not declare must be an ERROR, not a shrug.
 *
 * `props` remaps an atom's own field names onto the host's and `with` supplies literals for
 * them. Both are matched BY NAME against the atom's `props` block, and the expander ignores
 * anything it cannot find. That makes a misspelled key the quietest failure in the system:
 * the element renders, every other rule passes, and the control is wired to nothing.
 *
 * It shipped. `form-toggle` declares `on` and `description`; the course application wrote
 * `props: { value: … }` and `with: { help: … }`, so the switch bound to no field and its
 * sub-line never appeared. The screen looked finished. Clicking the switch did nothing at
 * all, and there was no error anywhere to explain why.
 *
 * The rule is checked through the linter's OVERLAY, so this proves the real rule against a
 * real atom without a fixture atom that could drift from the one the estate uses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { lintDefinitions } from "../src/lint/design/index.mjs";

const RX = resolve(join(import.meta.dirname, "../../../apps/unoverse/design"));

/** ANY layout in ANY project, DISCOVERED — this test must not name a customer's work
 *  (server/tests/ops/no-project-fixtures). It needs one real path to stand the overlay on,
 *  and which one is irrelevant: the overlay replaces the file's text entirely. */
const findLayout = (): string | undefined => {
  if (!existsSync(RX)) return undefined;
  for (const org of readdirSync(RX)) {
    const components = join(RX, org, "components");
    if (org.startsWith(".") || !existsSync(components)) continue;
    for (const c of readdirSync(components)) {
      const layouts = join(components, c, "layouts");
      if (!existsSync(layouts)) continue;
      const f = readdirSync(layouts).find((n) => n.endsWith(".yaml"));
      if (f && statSync(join(layouts, f)).isFile()) return join(layouts, f);
    }
  }
  return undefined;
};

const TARGET = findLayout() ?? "";

/** One layout whose single node is a Ref, written into a real component folder via the
 *  overlay so the design system resolves exactly as it does in a real run. */
const layout = (body: string) => `type: Box\nchildren:\n${body}`;

const lintOverlay = (text: string) =>
  lintDefinitions(RX, { overlay: { [TARGET]: text } }).problems.filter((p) => /does not declare/.test(p.msg));

test("a Ref that remaps a prop the atom does not declare is an error", { skip: !existsSync(TARGET) }, () => {
  const found = lintOverlay(
    layout(`  - type: Ref\n    ref: form-toggle\n    props:\n      value: marketing_opt_in\n`),
  );
  assert.equal(found.length, 1, `expected one finding, got ${found.length}`);
  assert.equal(found[0].level, "error");
  // The message must name the offending key AND what the atom really offers: an author who
  // gets "value is wrong" still has to go and read the atom.
  assert.match(found[0].msg, /"value"/);
  assert.match(found[0].msg, /declares: description, label, on/);
});

test("a Ref that passes a `with` literal the atom does not declare is an error", { skip: !existsSync(TARGET) }, () => {
  const found = lintOverlay(
    layout(`  - type: Ref\n    ref: form-toggle\n    with:\n      help: Occasional email.\n`),
  );
  assert.equal(found.length, 1, `expected one finding, got ${found.length}`);
  assert.match(found[0].msg, /"help"/);
});

test("the keys an atom DOES declare pass clean", { skip: !existsSync(TARGET) }, () => {
  const found = lintOverlay(
    layout(
      `  - type: Ref\n    ref: form-toggle\n    props:\n      on: marketing_opt_in\n` +
        `    with:\n      label: Send me updates\n      description: Occasional email.\n`,
    ),
  );
  assert.deepEqual(found, [], `a correct Ref must not be flagged: ${found.map((f) => f.msg).join("; ")}`);
});
