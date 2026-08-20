/**
 * WHERE THE CONTENT LIVES. One root, everything else derived from it.
 *
 * This used to be five environment variables over a repo-root walk that looked for a folder
 * called `apps/unoverse`. That made the package repo-shaped: installed anywhere else, the
 * walk finds nothing and every path silently comes out wrong, which surfaces as "the
 * definition does not load" rather than as a path error.
 *
 * Now there is ONE knob, `UNOVERSE_HOME`, and the rest are folders inside it. A host that
 * wants a different layout calls `setPaths()`; it does not need five more variables.
 */

import * as path from "path";
import { fileURLToPath } from "url";
import { existsSync, renameSync } from "fs";

/**
 * Find the content home when nobody said.
 *
 * ANCHORED ON A MARKER, never on a depth. Counting `../` from this file's own location is
 * what broke every path in the platform the last time this file moved: DESIGN_HOME landed one
 * directory above the repo and every loader quietly found nothing.
 */
function findHome(): string {
  const explicit = process.env.UNOVERSE_HOME;
  if (explicit) return path.resolve(explicit);

  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    // The in-repo home. Checked for `nodes` as well as the folder itself, so a stray
    // directory of the same name elsewhere cannot claim it.
    const candidate = path.join(dir, "apps/unoverse");
    if (existsSync(path.join(candidate, "nodes"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Installed outside the monorepo with nothing configured. Returning a guess here is what
  // produced the silent-wrong-path failures, so say so instead: every export below becomes
  // a path under cwd, and anything reading them will fail somewhere obvious.
  console.warn(
    "[unoverse:base] UNOVERSE_HOME is not set and no apps/unoverse was found above this package. " +
      "Falling back to the working directory; set UNOVERSE_HOME to the folder holding nodes/, design/ and prompts/.",
  );
  return process.cwd();
}

let HOME = findHome();

/** Everything the runtime reads off disk, in one place. */
export interface Paths {
  /** Node manifests and node packages authored for this deployment. */
  nodes: string;
  /** Design data: components, templates, styles. */
  design: string;
  /** Authored agent skills (SKILL.md). */
  skills: string;
  /** Reusable prompt snippets. */
  promptBlocks: string;
  /** Where `npm install` puts legacy code node packages. */
  plugins: string;
  /** LEGACY: the pre-migration node package folders. Usually absent. */
  packages: string;
  /** LEGACY: the pre-migration marketplace folder. Usually absent. */
  marketplace: string;
}

/**
 * The design folder's on-disk name, renamed `rx` → `design` (2026-08-20).
 *
 * MIGRATE-ONCE, not dual-read: a root still holding the legacy `rx/` is renamed to
 * `design/` the first time anything resolves it, and the platform knows ONE name from
 * then on. Resolution doubling as migration is deliberate — every reader passes through
 * here, so no entry point can forget to migrate, and no second code path survives to
 * drift. If the rename is impossible (read-only mount), the warning says exactly what
 * to do and resolution still returns `design/`: the failure is loud and immediate,
 * never a silent read from a folder half the platform no longer knows about.
 */
export function designDir(root: string): string {
  const design = path.join(root, "design");
  const legacy = path.join(root, "rx");
  if (!existsSync(design) && existsSync(legacy)) {
    try {
      renameSync(legacy, design);
      console.warn(`[unoverse:base] migrated ${legacy} → ${design} (rx/ is now design/)`);
    } catch (e) {
      console.warn(
        `[unoverse:base] could not rename ${legacy} → ${design} (${(e as Error).message}). ` +
          `Rename it by hand; the platform reads design/ only.`,
      );
    }
  }
  return design;
}

function derive(home: string): Paths {
  return {
    nodes: path.join(home, "nodes"),
    design: designDir(home),
    skills: path.join(home, "prompts/skills"),
    promptBlocks: path.join(home, "prompts/blocks"),
    plugins: path.join(home, "plugins"),
    // DELIBERATELY under the home, not at the repo root.
    //
    // `packages` used to mean "node packages" and now means "workspace libraries", and the
    // old default pointed at the new folder. `discoverPlugins()` scans it for anything in
    // the @unoverse-platform scope with an entry point, so it found THIS package and
    // returned ["@unoverse-platform/base"] — the runtime being offered as a node.
    packages: path.join(home, "packages"),
    marketplace: path.join(home, "packages-marketplace"),
  };
}

let paths: Paths = derive(HOME);

/**
 * Point the runtime at a different layout. For a host that does not lay content out this
 * way, and the reason there is no environment variable per folder.
 */
export function setPaths(next: Partial<Paths> & { home?: string }): void {
  if (next.home) {
    HOME = path.resolve(next.home);
    paths = derive(HOME);
  }
  const { home: _ignored, ...rest } = next;
  paths = { ...paths, ...rest };
}

/** The content home in force. */
export function unoverseHome(): string {
  return HOME;
}

/** Everything, as one object. Prefer this over the individual exports below. */
export function getPaths(): Paths {
  return paths;
}

// Named exports, kept because the tree already reads them. They are RESOLVED ONCE at import,
// so a host calling setPaths() must do it before anything else imports this module.
export const NODES_HOME = paths.nodes;
export const DESIGN_HOME = paths.design;
export const SKILLS_HOME = paths.skills;
export const PROMPT_BLOCKS_HOME = paths.promptBlocks;
/**
 * Where INSTALLED items are written so the loaders can read them (items/hydrate.ts).
 *
 * A SEPARATE ROOT, never inside the design tree. In the monorepo `DESIGN_HOME` is somebody's authoring
 * tree, and hydrating a database into it would overwrite work in progress. Keeping it
 * apart is also what makes the precedence rule enforceable: the on-disk tiers are searched
 * first and an installed row can only ever fill a gap, never replace what the platform
 * ships.
 *
 * Rebuilt whole on every hydrate, so nothing here is worth backing up and editing it by
 * hand achieves nothing.
 */
export const INSTALLED_HOME = process.env.UNOVERSE_INSTALLED_HOME?.trim() || path.join(HOME, ".installed");

/**
 * `UNOVERSE_DATABASE_ONLY=1` — behave like a deployed universe on a developer's machine.
 *
 * A server holds no design tree, no prompts and no node manifests, so everything it serves comes
 * from its database. In the monorepo those folders are full, they are searched first, and
 * they win — which is correct for authoring and means the production path is never
 * exercised until it is deployed. This turns the on-disk tiers off so the database is the
 * only source, exactly as it is in production.
 *
 * A TEST SWITCH, NOT A MODE. It changes nothing about how anything is stored or resolved,
 * only which tiers are consulted, so a bug found with it on is a real bug rather than an
 * artefact of a second code path. It is read from the environment and never written to,
 * and a deployed universe does not set it: there, the folders are empty anyway.
 */
export function databaseOnly(): boolean {
  const v = process.env.UNOVERSE_DATABASE_ONLY?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
export const PLUGINS_DIR = paths.plugins;
export const PACKAGES_PATH = paths.packages;
export const MARKETPLACE_PATH = paths.marketplace;
