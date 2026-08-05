/**
 * The catalogue: everything a universe CAN take, and whether it already has it.
 *
 * One list across every kind, built from the definitions this platform publishes, each
 * carrying a content fingerprint. Joined against the `items` table, that fingerprint is
 * the whole update story: present and equal means installed, present and different
 * means an update is waiting, absent means available.
 *
 * FINGERPRINT THE MEANING, NOT THE BYTES. Every definition is canonicalised (keys
 * sorted, recursively) before hashing, so reformatting is not a change.
 *
 * NOT YET THE SAME NUMBER as `catalogue.json` in the marketplace package. That one
 * hashes an item's FILES (path plus canonical content, per file); this hashes the
 * LOADED definition. Both ignore formatting, and each is internally consistent, which
 * is all install state needs today because a universe only ever compares this
 * catalogue against its own rows. The two MUST be reconciled before a universe
 * installs from a published package, or every item would read as an update the moment
 * it landed. Whichever survives, it has to be one function used by both.
 *
 * Sources are on DISK today (rx/, prompts/, nodes/). That is deliberate and temporary:
 * a universe's own rows are the truth for what it HAS, while what it CAN HAVE still
 * comes from the platform's files until publishing writes catalogue rows.
 */
import * as fs from "fs";
import * as path from "path";
// THE fingerprint, not a local copy. It lives in base so the publisher and the universe
// cannot decide differently; a second implementation makes every unchanged item read as
// an update and nobody notices until the marketplace looks permanently stale.
import { fingerprintOf } from "./fingerprint.js";
import { listDefinitions } from "../definitions/definitions.js";
import { loadPromptBlocks, loadParsedSkill, listSkillNames } from "./loaders.js";
import { SKILLS_HOME, NODES_HOME, RX_HOME, databaseOnly } from "../paths.js";
import { diskSource } from "../manifests/source.js";
import { composeNode } from "../manifests/compose.js";

/** The kinds a row can be. Mirrors the CHECK constraint in 013_items.sql. */
/**
 * The kinds a universe can hold. MIRRORS the CHECK constraint on `items` (migration 017);
 * they must move together or a row the type allows is refused by the database.
 *
 * `template` is an APP and `recipe` is a WORKFLOW GRAPH. An app is installed and tracked,
 * so taking a newer version is the point. A recipe is copied onto a canvas and owned by
 * that workflow, so tracking it would mutate somebody's graph underneath them.
 */
export type ItemKind =
  | "component"
  | "atom"
  | "style"
  | "skill"
  | "node"
  | "prompt-block"
  | "recipe"
  | "template";

export interface CatalogueItem {
  kind: ItemKind;
  name: string;
  fingerprint: string;
  /** The install unit when the item is not taken alone. The design system is one go. */
  bundle?: string;
  /** A recipe's own tags, from the recipe manifest. Browse fields are per-kind: what a
   *  card shows for a recipe is not what it shows for a node. */
  tags?: string[];
  /** The package a node was authored in (airtable, openai, ...). Nodes arrive in packages
   *  and share their envelope, so a list of seventy loose nodes hides the shape of what a
   *  universe actually has. Absent on every other kind. */
  pack?: string;
  title?: string;
  description?: string;
  category?: string;
  icon?: string;
  whenToUse?: string;
  /**
   * What a node takes, gives back, and needs to be given access to.
   *
   * Read off the COMPOSED node, because ports and credentials only exist once the
   * package envelope and its $ref fragments have resolved; the raw manifest under
   * `definition` cannot answer any of these questions on its own.
   *
   * Withheld from list responses alongside `definition`: `configSchema` alone is
   * larger than every browse field of every item put together, and only one page
   * ever reads it.
   */
  detail?: {
    inputs?: unknown[];
    outputs?: unknown[];
    credentials?: unknown[];
    configSchema?: unknown;
  };
  /** Withheld from list responses; loaded on demand when something is installed. */
  definition: unknown;
}

/** The design system: every component, atom and style file, installed as ONE unit. */
const DESIGN_SYSTEM = "design-system";

function designSystemItems(): CatalogueItem[] {
  const items: CatalogueItem[] = [];

  // Marketplace tier only. An org's own components (rx/bpp, rx/sab) are theirs, never
  // ours to publish, so anything carrying an org is excluded here.
  for (const kind of ["component", "atom"] as const) {
    for (const d of listDefinitions(kind) as Array<Record<string, any>>) {
      if (d.org) continue;
      // An atom is addressed by its FILENAME (`ref: outline-button` loads
      // outline-button.yaml), while `name:` is display copy (OutlineButton). Cataloguing
      // atoms under the display name installed rows nothing could resolve: the hydrated
      // file took the row's name and every filename-keyed Ref missed it, silently.
      items.push({
        kind,
        name: kind === "atom" && (d as any).file ? String((d as any).file).replace(/\.(yaml|json)$/, "") : d.name,
        fingerprint: fingerprintOf(d),
        bundle: DESIGN_SYSTEM,
        title: d.title ?? d.name,
        description: d.description,
        category: d.category,
        definition: d,
      });
    }
  }

  // Styles are ONE item: base, semantic and themes only mean anything as a set, and a
  // universe holding half of them would render against a contract with holes.
  const stylesDir = path.join(RX_HOME, "marketplace", "styles");
  if (fs.existsSync(stylesDir)) {
    // Walked recursively: styles is base/, semantic/ and themes/, not a flat folder,
    // and a top-level-only read silently produced NO styles item at all.
    const files: Record<string, unknown> = {};
    const walk = (dir: string, prefix = "") => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), rel);
        else if (/\.(ya?ml|json)$/.test(e.name)) files[rel] = fs.readFileSync(path.join(dir, e.name), "utf8");
      }
    };
    walk(stylesDir);
    if (Object.keys(files).length)
      items.push({
        kind: "style",
        name: "styles",
        fingerprint: fingerprintOf(files),
        bundle: DESIGN_SYSTEM,
        title: "Design tokens and themes",
        description: "The token contract every component renders against.",
        definition: files,
      });
  }

  return items;
}

function skillItems(): CatalogueItem[] {
  const items: CatalogueItem[] = [];
  // LISTED THE SAME WAY THEY ARE READ. This used to enumerate SKILLS_HOME with its own
  // readdir, so the catalogue offered exactly the authored skills while `loadParsedSkill`
  // could also resolve installed ones — a list and a loader disagreeing about what exists.
  for (const name of listSkillNames()) {
    const skill = loadParsedSkill(name);
    if (!skill) continue;
    items.push({
      kind: "skill",
      name: skill.name,
      // A skill already computes a content hash for spatial re-ingest. Reusing it would
      // couple two unrelated change detectors, so the catalogue hashes the same way it
      // hashes everything else.
      fingerprint: fingerprintOf(skill),
      title: skill.title ?? skill.name,
      description: skill.description,
      category: skill.category,
      icon: skill.icon,
      whenToUse: skill.whenToUse,
      definition: skill,
    });
  }
  return items;
}

function promptBlockItems(): CatalogueItem[] {
  return loadPromptBlocks().map((b) => ({
    kind: "prompt-block" as const,
    name: b.id,
    fingerprint: fingerprintOf(b),
    title: b.name,
    description: b.description,
    category: b.category,
    definition: b,
  }));
}

/** Declarative nodes: the YAML manifests, which are the nodes that CAN be installed as
 *  data. A code node is not offered here, because taking one would mean taking code. */
async function nodeItems(): Promise<CatalogueItem[]> {
  const items: CatalogueItem[] = [];
  // A deployed universe has no node manifests on disk, and under the switch a developer's
  // machine pretends it has none either. Without this the catalogue kept offering all
  // seventy as "yours, on disk" while every reader had stopped seeing them.
  if (databaseOnly()) return items;
  try {
    const packages = await diskSource(NODES_HOME).listPackages();
    for (const pkg of packages) {
      for (const raw of pkg.nodes) {
        try {
          // Composed ONLY to read its browse fields and prove the manifest is valid
          // before it is offered. What gets stored is the RAW manifest below.
          const node = composeNode(raw, pkg);
          const d = node.definition as Record<string, any>;

          // THE ROW HOLDS THE MANIFEST, NOT THE COMPOSED DEFINITION. Composition stays
          // the single path for both sources, so a node installed from a row and a node
          // read from disk cannot behave differently. It also keeps the row readable:
          // it is the same YAML someone authored. The package envelope travels with it
          // because $ref fragments and credential shapes resolve against the package.
          const definition = {
            package: {
              name: pkg.name,
              packageFile: pkg.packageFile ?? null,
              credentials: pkg.credentials,
              shared: pkg.shared,
            },
            dir: raw.dir,
            files: raw.files,
          };

          items.push({
            kind: "node",
            name: node.type,
            pack: pkg.name,
            fingerprint: fingerprintOf(definition),
            title: d.name ?? node.type,
            description: d.description,
            category: d.category,
            icon: d.logoUrl,
            whenToUse: d.whenToUse,
            detail: {
              inputs: d.inputs ?? [],
              outputs: d.outputs ?? [],
              credentials: d.credentials ?? [],
              configSchema: d.configSchema ?? {},
            },
            definition,
          });
        } catch {
          // A manifest that does not compose is a lint problem, not a catalogue one.
          // It is already reported by the loader; skipping keeps one bad file from
          // costing the whole catalogue.
        }
      }
    }
  } catch {
    /* no manifest packages on disk */
  }
  return items;
}

/**
 * Recipes: whole workflows, published to be READ and COPIED.
 *
 * They are catalogued like everything else so they can be browsed and versioned, but
 * they are NOT installed. A recipe lands on a canvas and belongs to that workflow from
 * then on, so publishing a better one must never reach into a graph someone already
 * built. The install route refuses them for exactly this reason.
 */
function recipeItems(): CatalogueItem[] {
  const dir = path.join(NODES_HOME, "recipes");
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return [];
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const items: CatalogueItem[] = [];
    for (const r of manifest.recipes ?? []) {
      // `file` is already relative to the package ("recipes/smart-agent.json"), so
      // joining another "recipes" produced a path that never existed and every recipe
      // was silently skipped.
      const file = path.join(dir, r.file ?? path.join("recipes", `${r.id}.json`));
      if (!fs.existsSync(file)) continue; // listed but missing: skip rather than offer a broken copy
      const workflow = JSON.parse(fs.readFileSync(file, "utf8"));
      items.push({
        kind: "recipe",
        name: r.id,
        tags: Array.isArray(r.tags) ? r.tags : [],
        fingerprint: fingerprintOf(workflow),
        title: r.name ?? r.id,
        description: r.description,
        category: r.category,
        icon: r.art,
        whenToUse: r.whenToUse,
        definition: workflow,
      });
    }
    return items;
  } catch {
    return [];
  }
}

/** Everything on offer, every kind, with definitions attached. */
export async function buildCatalogue(): Promise<CatalogueItem[]> {
  return [...designSystemItems(), ...skillItems(), ...promptBlockItems(), ...recipeItems(), ...(await nodeItems())];
}

export { DESIGN_SYSTEM };
