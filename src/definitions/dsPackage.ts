/**
 * The design system as an INSTALLED PACKAGE, wherever the HOST put it.
 *
 * Every other tier in `definitions.ts` and `theme.ts` is a path under the content home,
 * which is the developer's own project. That is right for a universe, where the design
 * system is installed INTO the deployment, and wrong for Studio, which is a TOOL run
 * against somebody else's folder. Studio depends on `@unoverse-platform/marketplace`, so
 * it already carries the design system in its own node_modules, and then went looking for
 * it in a project that will never have one.
 *
 * A new Studio project therefore had NO design system at all: zero components, zero atoms,
 * no foundation styles (measured against an empty home: 17 components and 30 atoms resolve
 * with this, none without). Primitives still render, so the scaffolded Welcome component
 * looks fine and hides it; the failure surfaces later, on the first `Card` or token. And it
 * is silent either way, because both callers fall through to a path rather than raising.
 *
 * ASKED OF NODE rather than walked, so it is found from wherever the host is installed.
 * NOT a dependency: `marketplace` depends on THIS package, so declaring it would be a
 * cycle. Absent is a normal answer (a universe resolves from a tier above), hence the
 * catch, and the answer is memoized because a failed resolve is the expensive case.
 *
 * ITS OWN MODULE so `definitions.ts` and `theme.ts` share one implementation without
 * importing each other. They resolve different kinds out of the same bundle
 * (components/atoms, and styles), and two copies of this would drift into two answers
 * about where the design system is.
 *
 * SEARCHED LAST by both callers, after every project-local tier, so nothing changes for a
 * host that already resolves: this fires only where the alternative was nothing at all.
 */
import { join, dirname } from "path";
import { createRequire } from "module";

let cached: string | null | undefined;

/** The bundle's `definitions/` folder, or null when the package is not installed. */
export function packagedDesignSystem(): string | null {
  if (cached !== undefined) return cached;
  try {
    const pkg = createRequire(import.meta.url).resolve("@unoverse-platform/marketplace/package.json");
    cached = join(dirname(pkg), "definitions");
  } catch {
    cached = null;
  }
  return cached;
}
