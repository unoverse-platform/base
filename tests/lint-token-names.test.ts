/**
 * A TOKEN NAME THAT RESOLVES TO NOTHING IS AN ERROR, NOT A GREEN RUN.
 *
 * LAW 1 already banned a RAW value (`#ff0000`, `12px`). It never checked the other half —
 * whether a NAME is real — and nothing downstream does either: the SDK resolves every
 * style value as `theme.<bucket>[name] ?? name` (sdk/style.ts), so an unknown name is
 * handed to CSS verbatim, CSS discards the declaration, and the property is simply absent
 * from the rendered element. `radius: lgg` is a square corner that lints clean, publishes,
 * and is found weeks later by a designer with nothing to point at.
 *
 * `font` is the sharpest case: it is applied ONLY on a hit, so an invented text style
 * applies no size, no weight and no line-height at all.
 *
 * THE RULE MUST ALSO KNOW WHEN NOT TO FIRE. A developer's project has no design system on
 * disk — it is installed, not authored — so the token set cannot be fully read there.
 * Judging real work against half a set rejects it, and publishing lints first, so that
 * reads as "you cannot publish". The last suite is the one that keeps this rule from
 * becoming the bug it was written to prevent.
 *
 * The rule is tested, not the values: each case asserts that an INVENTED name in a bucket
 * is reported and a REAL one beside it is not, so adding a token to the fixture never
 * changes an expectation.
 */
import test, { describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { lintDefinitions } = await import("../src/lint/rx/index.mjs");

const ROOT = mkdtempSync(join(tmpdir(), "unoverse-lint-tokens-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const write = (p: string, body: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
};

/**
 * An rx tree shaped like the monorepo's: a design system at `rx/marketplace/` holding the
 * token foundation, and one org whose component is the thing under test.
 */
function tree(name: string): { rx: string; component: string } {
  const rx = join(ROOT, name, "rx");
  const styles = join(rx, "marketplace", "styles");
  mkdirSync(join(rx, "acme", "components", "card"), { recursive: true });

  // The scale is read from `base/spacing` + `semantic/spacing` BY NAME (index.mjs), so a
  // step in any other file is invisible to the linter — steps belong here.
  write(
    join(styles, "base", "spacing.yaml"),
    'space:\n  "0":\n    $value: "0"\n  "4":\n    $value: 1rem\n  "90":\n    $value: 22.5rem\n  "160":\n    $value: 40rem\n',
  );
  write(join(styles, "semantic", "spacing.yaml"), 'space:\n  md:\n    $value: "{space.4}"\n');
  write(join(styles, "semantic", "layout.yaml"), 'layout:\n  reading:\n    $value: "{space.160}"\n');
  write(join(styles, "base", "radius.yaml"), "radius:\n  md:\n    $value: 0.5rem\n");
  write(join(styles, "base", "shadow.yaml"), "shadow:\n  sm:\n    $value: 0 1px 3px rgba(0,0,0,0.04)\n");
  write(join(styles, "base", "border.yaml"), 'border:\n  width:\n    thin:\n      $value: 1px\n    thick:\n      $value: 2px\n');
  write(
    join(styles, "base", "typography.yaml"),
    "font:\n  lineHeight:\n    tight:\n      $value: 1.2\n  weight:\n    semibold:\n      $value: 600\n",
  );
  write(join(styles, "semantic", "text-styles.yaml"), "text:\n  headline:\n    lg:\n      $value:\n        fontSize: 2rem\n");
  write(join(styles, "semantic", "icons.yaml"), "icons:\n  close:\n    $value: x\n");
  write(join(styles, "semantic", "keyframes.yaml"), "keyframes:\n  pulse:\n    $value:\n      from:\n        opacity: 0\n");
  write(
    join(styles, "themes", "light.yaml"),
    "color:\n  text:\n    primary:\n      $value: rgb(0,0,0)\n  surface:\n    base:\n      $value: rgb(255,255,255)\n  border:\n    strong:\n      $value: rgb(200,200,200)\n",
  );
  // A colour only the DARK theme names is still real work — the union must accept it.
  write(join(styles, "themes", "dark.yaml"), "color:\n  surface:\n    night:\n      $value: rgb(10,10,10)\n");

  return { rx, component: join(rx, "acme", "components", "card", "card.yaml") };
}

const errorsFor = (rx: string, component: string, style: string) => {
  writeFileSync(component, `type: Box\nstyle:\n${style}`);
  return lintDefinitions(rx).problems.filter((p: { level: string }) => p.level === "error");
};

describe("an unresolvable token NAME is reported", () => {
  const { rx, component } = tree("monorepo");

  /** Each case: the style line that is real, and the one beside it that resolves to nothing. */
  const CASES: [bucket: string, good: string, bad: string][] = [
    ["color", "  color: text.primary\n", "  color: text.doesNotExist\n"],
    ["background", "  background: surface.base\n", "  background: surface.nope\n"],
    ["radius", "  radius: md\n", "  radius: totallyFakeRadius\n"],
    ["shadow", "  shadow: sm\n", "  shadow: notARealShadow\n"],
    ["border colour", "  border: strong\n", "  border: notARealBorder\n"],
    ["border width", "  border: thick strong\n", "  border: heavy strong\n"],
    ["font", "  font: headline.lg\n", "  font: headline.enormous\n"],
    ["weight", "  weight: semibold\n", "  weight: ultraheavy\n"],
    ["lineHeight", "  lineHeight: tight\n", "  lineHeight: squishy\n"],
    ["space step (numeric)", '  width: "4"\n', '  width: "999"\n'],
    ["space step (named)", "  gap: md\n", "  gap: mdd\n"],
    ["keyframe", "  animation:\n    name: pulse\n", "  animation:\n    name: shimmy\n"],
  ];

  for (const [bucket, good, bad] of CASES) {
    test(`${bucket}: the invented name errors, the real one does not`, () => {
      assert.equal(errorsFor(rx, component, good).length, 0, `the real ${bucket} name was rejected`);
      const bads = errorsFor(rx, component, bad);
      assert.ok(bads.length > 0, `the invented ${bucket} name passed silently — the whole point of this rule`);
    });
  }

  test("an Icon naming no served glyph errors (it draws a blank, not an error)", () => {
    writeFileSync(component, "type: Box\nchildren:\n  - type: Icon\n    icon: close\n");
    assert.equal(lintDefinitions(rx).problems.filter((p: { level: string }) => p.level === "error").length, 0);
    writeFileSync(component, "type: Box\nchildren:\n  - type: Icon\n    icon: definitelyNotAGlyph\n");
    assert.ok(lintDefinitions(rx).problems.some((p: { level: string }) => p.level === "error"));
  });

  test("a colour only the dark theme defines is real work, not a typo", () => {
    assert.equal(errorsFor(rx, component, "  background: surface.night\n").length, 0);
  });

  test("a bound value is DATA and cannot be judged here", () => {
    assert.equal(errorsFor(rx, component, '  color: "{{accentToken}}"\n').length, 0);
  });

  test("CSS words with no token equivalent still pass", () => {
    assert.equal(
      errorsFor(rx, component, "  background: transparent\n  border: none\n  radius: \"0\"\n  width: fit-content\n  height: auto\n").length,
      0,
    );
  });
});

describe("where the token set cannot be read, the rule ABSTAINS", () => {
  /**
   * A project exactly as Studio scaffolds one: org folders only, no design system. Every
   * name it uses is inherited and therefore unreadable — reporting them all would block
   * the publish on work that is correct.
   */
  test("a developer's project reports no token errors on inherited names", () => {
    const rx = join(ROOT, "project", "rx");
    const home = join(rx, "acme");
    mkdirSync(join(home, "components", "card"), { recursive: true });
    mkdirSync(join(home, "styles", "themes"), { recursive: true });
    writeFileSync(join(home, "styles", "themes", "light.yaml"), "color:\n  brand:\n    ink:\n      $value: rgb(1,1,1)\n");
    writeFileSync(
      join(home, "components", "card", "card.yaml"),
      "type: Box\nstyle:\n  color: text.primary\n  radius: md\n  shadow: sm\n  font: headline.lg\n",
    );
    const errors = lintDefinitions(rx).problems.filter((p: { level: string }) => p.level === "error");
    assert.deepEqual(errors, [], `abstain failed: ${errors.map((e: { msg: string }) => e.msg).join(" | ")}`);
  });
});

/**
 * ONE VALUE, ONE SPELLING — the rule that keeps the scale from drifting back.
 *
 * `maxWidth` is honestly two things: a PAGE container's cap and an ELEMENT's own cap, so
 * "page widths must be named" cannot be enforced on the key alone without rejecting the
 * second. It is enforced on the VALUE instead: a step that has a name in semantic/layout
 * has exactly one correct spelling. A step with no name is left alone, which is what makes
 * a card's `maxWidth: "90"` legal beside a page's `maxWidth: reading`.
 *
 * This is the rule the t-shirt aliases broke (xs and 1 were the same value, both in use).
 * Written as a rule about aliases, not about a list of names, so adding one to
 * semantic/layout extends it with no test to update.
 */
describe("a page width with a name must use the name", () => {
  const { rx, component } = tree("page-widths");

  test("an aliased step on a page-level key errors, and names the alias", () => {
    const errs = errorsFor(rx, component, '  maxWidth: "160"\n');
    assert.equal(errs.length, 1);
    assert.match(errs[0].msg, /reading/);
  });

  test("the name itself passes", () => {
    assert.equal(errorsFor(rx, component, "  maxWidth: reading\n").length, 0);
  });

  test("a step with NO alias is an element cap, and stays a number", () => {
    assert.equal(errorsFor(rx, component, '  maxWidth: "90"\n').length, 0);
  });

  test("the same step on an ELEMENT key is untouched: an image tile is not a page", () => {
    assert.equal(errorsFor(rx, component, '  height: "160"\n').length, 0);
  });

  test("the responsive thresholds are page-level too", () => {
    for (const key of ["hideBelow", "hideAbove", "stackBelow"]) {
      const errs = errorsFor(rx, component, `  ${key}: "160"\n`);
      assert.equal(errs.length, 1, `${key} did not require the name`);
      assert.match(errs[0].msg, /reading/);
    }
  });
});
