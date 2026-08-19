/**
 * Reading a developer's project off disk into publishable items.
 *
 * One item per thing a universe can hold: a component, an atom, a style set, a node, a
 * skill, a prompt block. Each carries its content and a fingerprint, and nothing else is
 * decided here: WHO published it and WHERE it came from are set by the server from the
 * authenticated caller, never from this payload (publishRoute.ts).
 *
 * THE MARKETPLACE IS NEVER COLLECTED. `rx/marketplace` is the design system, installed
 * from `@unoverse-platform/marketplace`, and a developer builds ON it rather than owning
 * it. In a developer's project the folder does not even exist; in THIS monorepo it does,
 * and publishing from here would push the design system source into a universe that is
 * supposed to receive it as a package. Same exclusion the linter already applies when it
 * computes org dirs, for the same reason.
 *
 * The unit is a PROJECT, not a file and not all of rx/. A project is what a developer
 * works in and what they can reason about publishing; per-file selection is a chore nobody
 * performs correctly, and a half-published project is worse than either extreme.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { fingerprintOf } from "./fingerprint.js";

/** One publishable thing: what it is, what it contains, and what it was built on. */
export interface CollectedItem {
  kind: string;
  name: string;
  definition: { files: Record<string, string> };
  fingerprint: string;
  org: string;
  base_version: string;
}
import { designSystemVersion } from "./baseVersion.js";

/** Folders under rx/ that are never a developer's own project. */
const NOT_A_PROJECT = new Set(["marketplace", "_schema", "orgs"]);

const isDef = (f: string) => f.endsWith(".yaml") || f.endsWith(".json");

/**
 * Where the design system is, mirroring definitions.ts marketplaceDir(). In this monorepo
 * it is source on disk; in a developer's project it is the installed bundle, because
 * sync-starter.sh deliberately ships neither the source nor a way to publish it.
 */
function designSystemDir(rxHome: string): string {
  const onDisk = join(rxHome, "marketplace");
  if (existsSync(onDisk)) return onDisk;
  const nodesHome = join(rxHome, "..", "nodes");
  for (const c of [
    join(nodesHome, "marketplace", "definitions"),
    join(rxHome, "..", "plugins", "node_modules", "@unoverse-platform", "marketplace", "definitions"),
  ])
    if (existsSync(c)) return c;
  return onDisk; // nothing found: the version will hash to an empty set, which is honest
}

/** Every project a developer could publish, by name. */
export function listProjects(rxHome: string): string[] {
  if (!existsSync(rxHome)) return [];
  return readdirSync(rxHome)
    .filter((e) => !e.startsWith(".") && !NOT_A_PROJECT.has(e))
    .filter((e) => statSync(join(rxHome, e)).isDirectory())
    .sort();
}

/** Every definition file under a folder, relative-pathed, as one object. */
function filesUnder(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (isDef(e.name) || e.name.endsWith(".md")) out[relative(dir, p)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

/**
 * Collect one project into items.
 *
 * A component is a FOLDER (its envelope, layouts, states, sub-partials), so the item's
 * definition is every file in it keyed by relative path. That mirrors how a node row is
 * already stored (`{ files: {...} }`, manifests/source.ts rowsSource), so both kinds read
 * back the same way.
 */
export function collectProject(rxHome: string, project: string): CollectedItem[] {
  const root = join(rxHome, project);
  if (!existsSync(root)) throw new Error(`No project "${project}" in ${rxHome}`);

  // WHAT THIS WAS BUILT ON, stamped on every item. Computed once per collection: it is the
  // same design system for the whole project, and hashing it per item would be wasteful and
  // could disagree with itself mid-run if a file changed.
  const base_version = designSystemVersion(designSystemDir(rxHome));

  const items: CollectedItem[] = [];
  // A COMPONENT row's name is the qualified ref (`<org>/<name>`): the items table's
  // identity is (kind, name) with no org in the key, and component names are unique
  // only WITHIN an org — two orgs may ship `course-card`, so the org must be in the
  // name for the rows to coexist (the same trick a style row already uses: its name
  // IS the org). Templates keep their bare ids: those are org-qualified by
  // convention (`<org>-chat-layout`). docs/unoverse/UNOVERSE_COMPONENT_ORGS.md.
  const add = (kind: string, name: string, definition: { files: Record<string, string> }) =>
    items.push({
      kind,
      name: kind === "component" ? `${project}/${name}` : name,
      definition,
      fingerprint: fingerprintOf(definition),
      org: project,
      base_version,
    });

  // `templates` publishes as kind `template`, NOT `recipe`. A recipe is a workflow graph
  // that is copied onto a canvas and never installed; an app is installed and tracked, so
  // taking a newer version is the point rather than a hazard (migration 017).
  //
  // A DEFINITION IS EITHER A FOLDER OR A SINGLE FILE, and both are normal. A component
  // that grew layouts and states is a folder; an atom is one file, and templates are a
  // mix. Collecting only folders silently dropped all 24 atoms and two templates, which
  // is the worst kind of bug in a publisher: it succeeds and ships less than you authored.
  //
  // Both become the same shape, a map of relative path to contents, so nothing downstream
  // has to care which it was. A single file is simply a map with one entry.
  for (const [dir, kind] of [["components", "component"], ["templates", "template"], ["atoms", "atom"]] as const) {
    const home = join(root, dir);
    if (!existsSync(home)) continue;
    for (const e of readdirSync(home, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "README.md") continue;
      if (e.isDirectory()) {
        const files = filesUnder(join(home, e.name));
        if (Object.keys(files).length) add(kind, e.name, { files });
      } else if (isDef(e.name)) {
        // The name is the definition's, without the extension: `card.yaml` is `card`,
        // addressed the same way whether it later grows into a folder.
        add(kind, e.name.replace(/\.(ya?ml|json)$/, ""), { files: { [e.name]: readFileSync(join(home, e.name), "utf8") } });
      }
    }
  }

  // styles/ is ONE item: the org's token overrides, which only mean anything together.
  const styles = filesUnder(join(root, "styles"));
  if (Object.keys(styles).length) add("style", project, { files: styles });

  return items;
}
