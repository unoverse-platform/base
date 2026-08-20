/**
 * A DEVELOPER'S PROJECT CAN BE LINTED, AND THEREFORE PUBLISHED.
 *
 * Studio publishes only what lints, so every one of these failures presented as "you
 * cannot publish" — and none of them was about the developer's work.
 *
 * A developer's `rx/` looks NOTHING like the monorepo's. It holds org folders and nothing
 * else: the design system is INSTALLED rather than authored, so `rx/marketplace` is
 * deliberately absent from a project (sync-starter.sh). Two rules were written against the
 * monorepo shape and read that layout as "no rx/ folder at all":
 *
 *   1. The rx root was found by looking for `marketplace/`, `components/` or `atoms/`
 *      DIRECTLY inside it. A project has none, so linting refused with "no rx/ folder
 *      here" — naming the rx/ folder it had just been handed.
 *   2. Orgs were skipped when the design system resolved to the rx root, which was meant
 *      to mean "the legacy layout, where rx/ IS the design system". It also means "no
 *      design system anywhere", the ordinary state of a project, so a project that got
 *      past 1 would have linted nothing at all and passed by being empty.
 *
 * And a third, which reported errors on correct work rather than staying silent:
 *
 *   3. App-size names are INHERITED from the design system and overridden per org. With
 *      no design system on disk only the org's own names are readable, so every inherited
 *      name it used ("chat", "rail") "named no app size". A half-built set judged real
 *      work and rejected it. Unreadable is not empty: the check now abstains.
 *
 * The monorepo half is asserted too, because a check that stops firing where it CAN see
 * the answer is a worse bug than the one being fixed.
 */
import test, { describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { lintDefinitions } = await import("../src/lint/design/index.mjs");

const ROOT = mkdtempSync(join(tmpdir(), "unoverse-lint-project-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

/**
 * A project exactly as Studio scaffolds one: `rx/<org>/{components,styles,templates}`,
 * no design system, and an org that overrides ONE app size while using an inherited one.
 */
function project(org: string): string {
  const rx = join(ROOT, org, "rx");
  const home = join(rx, org);
  for (const d of ["components", "styles/semantic", "templates/applayout/components"]) {
    mkdirSync(join(home, d), { recursive: true });
  }
  writeFileSync(
    join(home, "styles/semantic/app-sizes.yaml"),
    "appSize:\n  flex:\n    $value: calc(100% - min(100vw, 680px))\n",
  );
  // `chat` is the design system's, not this org's — the case that was being rejected.
  writeFileSync(
    join(home, "templates/applayout/components/core.yaml"),
    "type: Box\nappWidth: chat\n",
  );
  return rx;
}

describe("linting a developer's project", () => {
  const rx = project("acme");
  const result = lintDefinitions(rx);

  test("the rx root is found, though it holds only org folders", () => {
    const notFound = result.problems.find((p: any) => /no rx\/ folder here/.test(p.msg));
    assert.equal(notFound, undefined, "a project's rx/ was not recognised as an rx/ at all");
  });

  test("the org's own folders are what gets linted", () => {
    assert.ok(result.homes.length > 0, "nothing was linted: the project passed by being invisible");
    const dirs = result.homes.map((h: any) => h.dir).join("\n");
    assert.match(dirs, /acme/, `the org's folders were not linted:\n${dirs}`);
  });

  test("an inherited app size is not reported as unknown", () => {
    const invented = result.problems.filter((p: any) => /names no app size/.test(p.msg));
    assert.deepEqual(
      invented.map((p: any) => p.msg),
      [],
      "the design system is absent, so inherited names are unreadable, not wrong",
    );
  });

  test("nothing at all is wrong with a freshly scaffolded project", () => {
    const errors = result.problems.filter((p: any) => p.level === "error");
    assert.deepEqual(errors.map((e: any) => `${e.file}: ${e.msg}`), []);
  });
});

describe("where the design system IS present, the app-size check still fires", () => {
  // Same shape, plus a design system to inherit from — the monorepo's situation.
  const rx = project("beta");
  mkdirSync(join(rx, "marketplace", "styles", "semantic"), { recursive: true });
  writeFileSync(
    join(rx, "marketplace/styles/semantic/app-sizes.yaml"),
    "appSize:\n  chat:\n    $value: min(100vw, 680px)\n",
  );
  mkdirSync(join(rx, "beta", "templates", "bad", "components"), { recursive: true });
  writeFileSync(
    join(rx, "beta/templates/bad/components/core.yaml"),
    "type: Box\nappWidth: totallynotasize\n",
  );
  const result = lintDefinitions(rx);

  test("a name in neither set is still an error", () => {
    const hit = result.problems.find((p: any) => /totallynotasize/.test(p.msg));
    assert.ok(hit, "the check went silent where it can see the answer, which is worse than the bug it replaced");
  });

  test("and the inherited name beside it is still accepted", () => {
    const wrong = result.problems.find((p: any) => /"chat" names no app size/.test(p.msg));
    assert.equal(wrong, undefined, "an inherited name was rejected while the design system was readable");
  });
});
