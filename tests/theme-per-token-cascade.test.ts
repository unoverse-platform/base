/**
 * AN ORG OMITS A TOKEN TO INHERIT IT — PER TOKEN, NOT PER LAYER.
 *
 * `design/marketplace/styles` is the foundation every org inherits. `buildTheme` reads the
 * foundation's `base` + `semantic` into ONE flat registry keyed by dotted path, then the
 * org's on top, so an org token overrides the foundation's and an omitted token is
 * inherited. That is what lets a brand name `color` and `typography` and keep the
 * foundation's spacing, radius, shadow and motion.
 *
 * THE READING THIS GUARDS AGAINST is per-LAYER: "an org that ships its own `base` fully
 * replaces the foundation's for that layer". `buildTheme`'s own docstring said exactly that
 * until 2026-08-18, and both readings look identical against the orgs we have, because
 * every one of them was forked from the full default set and therefore names every token.
 * A pack authored the documented way — one `base/color.yaml`, nothing else — is the only
 * shape that tells them apart, and there wasn't one.
 *
 * Under per-layer this org loses every space, radius and shadow token the moment it adds a
 * single brand colour, and the failure is silent: a theme resolves, components ask for
 * `space.4`, CSS drops the declaration, and the layout collapses to unstyled boxes.
 */
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "unoverse-theme-cascade-"));

// The real foundation, copied rather than stubbed: a hand-made fixture could drift into
// passing while the actual token set stopped inheriting.
const REAL_STYLES = resolve(import.meta.dirname, "..", "..", "..", "apps/unoverse/design/marketplace/styles");
const FOUNDATION = join(HOME, "design", "marketplace", "styles");
mkdirSync(join(HOME, "design", "marketplace"), { recursive: true });
if (existsSync(REAL_STYLES)) cpSync(REAL_STYLES, FOUNDATION, { recursive: true });

/**
 * A MINIMAL org, authored the way the playbook says: it names ONE brand ingredient and one
 * theme, and ships no spacing, radius, shadow or motion of its own. It DOES ship a `base/`
 * folder, which is the whole point — per-layer semantics would let that folder shadow the
 * foundation's entire base layer.
 */
const ORG = join(HOME, "design", "tinyorg", "styles");
mkdirSync(join(ORG, "base"), { recursive: true });
mkdirSync(join(ORG, "themes"), { recursive: true });
writeFileSync(
  join(ORG, "base", "color.yaml"),
  ["color:", "  $type: color", "  brand:", "    signal:", '      $value: "#abcdef"', ""].join("\n"),
);
/**
 * THE THEME FILE DOES NOT CASCADE, and only base/semantic do.
 *
 * `buildTheme` reads the foundation's base+semantic, then the org's, then **one** theme
 * file: the org's own. The foundation's `themes/light.yaml` is never read for an org theme,
 * so a theme file must assign every role the semantic layer aliases. A theme naming one
 * role fails to resolve entirely (`Unknown token alias: {color.action.primary}`), which is
 * a different failure from the inheritance under test here.
 *
 * So this org starts from the foundation's own light theme and overrides ONE role, which is
 * what a real brand does. The base/ folder above stays minimal: that is the part being
 * guarded.
 */
const foundationLight = readFileSync(join(FOUNDATION, "themes", "light.yaml"), "utf8");
const orgLight = foundationLight.replace(/\{color\.gray\.900\}/, "{color.brand.signal}");
assert.notEqual(
  orgLight,
  foundationLight,
  "fixture is wrong: the org theme is byte-identical to the foundation's, so it overrides nothing",
);
writeFileSync(join(ORG, "themes", "light.yaml"), orgLight);

process.env.UNOVERSE_HOME = HOME;
process.env.NODES_HOME = join(HOME, "nodes");
process.env.PLUGINS_DIR = join(HOME, "plugins");

const { resolveTheme } = await import("../src/definitions/theme.js");

after(() => rmSync(HOME, { recursive: true, force: true }));

describe("an org pack that names one token and omits the rest", () => {
  before(() => {
    assert.ok(
      existsSync(join(FOUNDATION, "base")),
      "fixture is wrong: no foundation to inherit FROM, so inheritance cannot be observed",
    );
    assert.ok(
      existsSync(join(ORG, "base")),
      "fixture is wrong: the org must ship a base/ folder or per-layer and per-token agree",
    );
  });

  test("inherits the foundation's other base tokens", () => {
    const theme = resolveTheme("tinyorg/light");
    assert.ok(theme, "tinyorg/light did not resolve at all");

    // The discriminating assertions. The org ships base/color.yaml and NOTHING else, so
    // every one of these can only have come from the foundation.
    for (const bucketName of ["space", "radius", "shadow"] as const) {
      assert.ok(
        Object.keys(theme![bucketName] ?? {}).length > 0,
        `theme.${bucketName} is empty: the org's base/ replaced the foundation's whole base layer ` +
          `instead of overriding the one token it names. Components asking for a ${bucketName} token ` +
          `now get nothing, CSS drops the declaration, and the layout silently collapses.`,
      );
    }
  });

  test("and its own token still wins where it names one", () => {
    const theme = resolveTheme("tinyorg/light");
    assert.equal(
      theme!.color["text.primary"],
      "#abcdef",
      "the org's own theme did not override: inheritance must not cost precedence",
    );
  });
});
