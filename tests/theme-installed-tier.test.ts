/**
 * A UNIVERSE RESOLVES THE DESIGN SYSTEM IT INSTALLED.
 *
 * The design system is CHOSEN, not shipped (MARKETPLACE.md §3), so on a deployed universe
 * it is neither on disk nor in a package bundle. It is rows, unpacked into the installed
 * tree. `definitions.ts` ends its search there for components and atoms; `theme.ts` did
 * not, and its own neighbour's comment claimed it did.
 *
 * The failure was silent and total. A universe held all 49 design-system rows, rendered
 * components from them, and resolved NO themes: `/dev/themes` answered `{"themes":[]}` and
 * Studio sat on "loading theme from mcp…" for ever, because a screen with no tokens cannot
 * draw. Installed, present, unreachable — and nothing said so.
 *
 * THE FIXTURE IS A DEPLOYED UNIVERSE, which is the only shape that shows the bug: an empty
 * authored `design/`, no bundle, and a styles set in the installed tree. Run it against the
 * monorepo's own design tree and it passes either way, because `design/marketplace/styles`
 * is right there — which is exactly why this went unnoticed.
 */
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "unoverse-theme-home-"));
const INSTALLED = join(HOME, ".installed");

// An authored design/ that exists and holds NOTHING — a deployed universe has no design
// system on disk. Everything must come from the installed tree.
mkdirSync(join(HOME, "design"), { recursive: true });

// The design system as an INSTALLED item: rows unpacked under .installed/design/marketplace.
// Copied from the repo's real styles so this asserts against the actual token set rather
// than a hand-made stub that could drift into passing.
const REAL_STYLES = resolve(import.meta.dirname, "..", "..", "..", "apps/unoverse/design/marketplace/styles");
const INSTALLED_STYLES = join(INSTALLED, "design", "marketplace", "styles");
mkdirSync(join(INSTALLED, "design", "marketplace"), { recursive: true });
if (existsSync(REAL_STYLES)) cpSync(REAL_STYLES, INSTALLED_STYLES, { recursive: true });

/**
 * A MARKER, because "a theme resolved" proves nothing about WHERE it came from.
 *
 * The first version of this test passed with the fix removed: `packagedDesignSystem()`
 * found a copy in this monorepo's own node_modules and answered from there. A deployed
 * universe has no such copy, so the test was green while the bug was live — the same
 * shape of miss as the bug itself.
 *
 * So the installed copy is made DISTINGUISHABLE. Only the installed tier carries this
 * token; if the resolved theme has it, the installed tier is what answered.
 */
const MARKER = "installedtiermarker";
const lightPath = join(INSTALLED_STYLES, "themes", "light.yaml");
if (existsSync(lightPath)) {
  writeFileSync(
    lightPath,
    readFileSync(lightPath, "utf8").replace(/^color:\n(\s+)\$type: color\n/m, `color:\n$1$type: color\n$1${MARKER}:\n$1  $value: "#abcdef"\n`),
  );
}

// Set before the import: paths.ts captures its homes once, at module load.
process.env.UNOVERSE_HOME = HOME;
process.env.UNOVERSE_INSTALLED_HOME = INSTALLED;
process.env.NODES_HOME = join(HOME, "nodes");
process.env.PLUGINS_DIR = join(HOME, "plugins");

const { listThemeNames, resolveTheme } = await import("../src/definitions/theme.js");

after(() => rmSync(HOME, { recursive: true, force: true }));

describe("a deployed universe, whose design system is installed rather than shipped", () => {
  before(() => {
    assert.ok(
      existsSync(join(INSTALLED_STYLES, "themes")),
      "fixture is wrong: no installed styles to resolve, so this would pass by asserting nothing",
    );
    assert.ok(
      !existsSync(join(HOME, "design", "marketplace")),
      "fixture is wrong: an authored design system on disk hides the tier under test",
    );
  });

  test("its themes are listed", () => {
    const names = listThemeNames("default");
    assert.ok(
      names.length > 0,
      'no themes resolved: this is the "/dev/themes → {\\"themes\\":[]}" that hung Studio for ever',
    );
    assert.ok(names.includes("light"), `expected a light theme, got: ${names.join(", ") || "none"}`);
  });

  test("and the theme Studio asks for actually resolves", () => {
    // The exact ref StudioPage falls back to before it gives up (StudioPage.tsx).
    const theme = resolveTheme("default/light");
    assert.ok(theme, "default/light did not resolve, so every themed screen has nothing to draw with");
    assert.ok(Object.keys(theme!.color ?? {}).length > 0, "resolved a theme with no colours");
    // WHERE it came from, not merely that it came. Only the installed copy carries this.
    assert.ok(
      Object.keys(theme!.color).some((k) => k.includes(MARKER)),
      `the theme resolved from a DIFFERENT tier, not the installed one: ${Object.keys(theme!.color).slice(0, 8).join(", ")}`,
    );
  });
});
