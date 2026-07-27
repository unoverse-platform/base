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
import { existsSync } from "fs";

/**
 * Find the content home when nobody said.
 *
 * ANCHORED ON A MARKER, never on a depth. Counting `../` from this file's own location is
 * what broke every path in the platform the last time this file moved: RX_HOME landed one
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
      "Falling back to the working directory; set UNOVERSE_HOME to the folder holding nodes/, rx/ and prompts/.",
  );
  return process.cwd();
}

let HOME = findHome();

/** Everything the runtime reads off disk, in one place. */
export interface Paths {
  /** Node manifests and node packages authored for this deployment. */
  nodes: string;
  /** Design data: components, templates, styles. */
  rx: string;
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

function derive(home: string): Paths {
  return {
    nodes: path.join(home, "nodes"),
    rx: path.join(home, "rx"),
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
export const RX_HOME = paths.rx;
export const SKILLS_HOME = paths.skills;
export const PROMPT_BLOCKS_HOME = paths.promptBlocks;
export const PLUGINS_DIR = paths.plugins;
export const PACKAGES_PATH = paths.packages;
export const MARKETPLACE_PATH = paths.marketplace;
