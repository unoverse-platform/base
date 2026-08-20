/**
 * Unoverse definition store (v0: flat JSON files under apps/unoverse/design/{components,templates}).
 *
 * These are the NEUTRAL primitive+style definitions — NOT the legacy
 * React UMD bundles in packages/design-system/components. Later this
 * becomes a DB/Redis store for hot-reload + per-tenant (resources/updated).
 */

import { readdirSync, existsSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { packagedDesignSystem } from "./dsPackage.js";
import { readDefCached, defPath, isDefFile, defName, dirSignature, cachedBySignature } from "./fsCache.js";
import { NODES_HOME, PLUGINS_DIR, DESIGN_HOME, INSTALLED_HOME, databaseOnly, designDir } from "../paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// server/src -> apps/unoverse

// ---- Shared parts + per-org parts (the one rule of the layout) ----
//
// UNIVERSAL parts live ONCE at the top of `rx/`: atoms and components (a card is a
// card — the theme carries the brand) plus `rx/orgs/default/styles`, the DEFAULT token set that is
// also the starter you copy for a new client. CLIENT parts live in that client's
// folder `rx/orgs/<org>/`: its templates (apps) and its complete, self-contained
// styles. No fallback, no overlay — each thing has exactly one home.
//
// Addressing follows the homes: components/atoms are bare names
// (unoverse://components/card — unchanged for existing consumers); templates and
// themes are org-scoped `<org>/<name>` (unoverse://apps/sab/banktransfer,
// unoverse://theme/bpp/light). A bare template/app ref is the legacy compat path:
// it scans orgs alphabetically (deterministic; dies with the pre-org consumers).
// The filesystem stays the registry: a new client = a new folder under rx/orgs/.
// One home for the definitions root (paths.ts), so this loader and theme.ts
// cannot drift, and the standalone local Studio can point both at a dev folder.
const DESIGN = DESIGN_HOME;
const ORGS_ROOT = join(DESIGN, "orgs");

/**
 * The rx tree HYDRATED FROM INSTALLED ROWS (items/hydrate.ts), laid out identically.
 *
 * SEARCHED LAST, ALWAYS. What the platform ships on disk wins over anything installed:
 * a developer editing a component in the monorepo must see their own file, never a
 * database's copy of an older one. That is the same precedence the node loader applies
 * with [disk, rows], and putting the installed tree in its own root is what makes the
 * rule structural rather than a comparison somebody has to remember to write.
 *
 * On a deployed universe the disk tiers are empty by design, so this is the only tier
 * with anything in it and the ordering never comes up.
 */
const INSTALLED_DESIGN = designDir(INSTALLED_HOME);

/** The shared homes for the universal kinds — the marketplace.
 *
 * The marketplace ships as an INSTALLED package (@unoverse-platform/marketplace),
 * which bundles its definitions/{components,atoms,styles}. Resolve each shared dir from
 * the on-disk rx/marketplace (monorepo dev) if present, ELSE from the installed package
 * bundle — the home node, then the plugins install. So the platform renders marketplace
 * components/atoms with NO rx/marketplace/ source on disk (the marketplace-installed,
 * pushable-update model). Mirrors theme.ts's styles fallback. Getters resolve LAZILY so a
 * package installed at boot (CORE_PACKAGES self-heal) is picked up on first use. */
const MARKETPLACE = join(DESIGN, "marketplace");
const DS_BUNDLE_CANDIDATES = [
  join(NODES_HOME, "marketplace", "definitions"),
  join(PLUGINS_DIR, "node_modules", "@unoverse-platform", "marketplace", "definitions"),
];
function marketplaceDir(kind: "components" | "atoms"): string {
  const onDisk = join(MARKETPLACE, kind);
  // Under the switch the authored tiers are skipped, so what a deployed universe would
  // resolve is what a developer resolves.
  if (databaseOnly()) {
    const installed = join(INSTALLED_DESIGN, "marketplace", kind);
    return existsSync(installed) ? installed : onDisk;
  }
  if (existsSync(onDisk)) return onDisk;
  for (const base of DS_BUNDLE_CANDIDATES) {
    const p = join(base, kind);
    if (existsSync(p)) return p;
  }
  // Last: what this universe was PUBLISHED. A deployed universe holds no rx and no
  // bundle, so this is where its design system actually lives.
  const installed = join(INSTALLED_DESIGN, "marketplace", kind);
  if (existsSync(installed)) return installed;
  const packaged = packagedDesignSystem();
  if (packaged && existsSync(join(packaged, kind))) return join(packaged, kind);
  return onDisk; // none present → the disk path (may be empty); nothing to resolve
}
const SHARED_DIR = {
  get component() {
    return marketplaceDir("components");
  },
  get atom() {
    return marketplaceDir("atoms");
  },
} as Record<"component" | "atom", string>;

// rx-root entries that are NOT projects: the marketplace, the schema, and the legacy
// orgs/ container itself. Everything else at the root is a flat project (the target model).
const RESERVED_DESIGN = new Set(["marketplace", "_schema"]);

/** A project's on-disk home. During the flatten migration a project can live either FLAT
 *  at the rx root (`rx/<name>` — the target) or under the legacy `rx/orgs/<name>`. Flat
 *  wins. A project folder carries at least one of styles/templates/components. */
export function projectDir(name: string): string {
  const installedProject = join(INSTALLED_DESIGN, name);
  if (databaseOnly()) return installedProject;
  const flat = join(DESIGN, name);
  if (existsSync(flat)) return flat;
  const legacy = join(ORGS_ROOT, name);
  if (existsSync(legacy)) return legacy;
  // Published, not authored here. Checked after both on-disk homes so a project being
  // edited in the monorepo is never shadowed by the database's copy of it.
  const installed = join(INSTALLED_DESIGN, name);
  return existsSync(installed) ? installed : legacy;
}

/** The client projects, sorted: flat at the rx root (the target) PLUS any still under the
 *  legacy `rx/orgs/` (mid-migration). Excludes the marketplace, schema, and orgs/ folder.
 *  A flat candidate must look like a project (styles/templates/components) so a stray dir
 *  isn't mistaken for one. */
export function listOrgs(): string[] {
  const isProject = (dir: string) =>
    existsSync(join(dir, "styles")) || existsSync(join(dir, "templates")) || existsSync(join(dir, "components"));
  const flat = existsSync(DESIGN) && !databaseOnly()
    ? readdirSync(DESIGN, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !RESERVED_DESIGN.has(e.name) && isProject(join(DESIGN, e.name)))
        .map((e) => e.name)
    : [];
  const legacy = existsSync(ORGS_ROOT) && !databaseOnly()
    ? readdirSync(ORGS_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  // Projects this universe was PUBLISHED but does not author. On a deployed universe
  // these are the only ones there are. A name in both is listed once, and `projectDir`
  // decides which home wins — on disk, every time.
  const installed = existsSync(INSTALLED_DESIGN)
    ? readdirSync(INSTALLED_DESIGN, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !RESERVED_DESIGN.has(e.name) && isProject(join(INSTALLED_DESIGN, e.name)))
        .map((e) => e.name)
    : [];
  return [...new Set([...flat, ...legacy, ...installed])].sort();
}

/** Definition roots for guards/tooling sweeps: the shared tree (components/atoms in
 *  the marketplace, org: null) plus each org tree (its templates/). */
export function rxRoots(): { org: string | null; root: string }[] {
  return [{ org: null, root: MARKETPLACE }, ...listOrgs().map((org) => ({ org, root: projectDir(org) }))];
}

/** Split an `<org>/<name>` ref; a bare name has no org. */
function parseRef(ref: string): { org: string | null; name: string } {
  const i = ref.indexOf("/");
  return i === -1 ? { org: null, name: ref } : { org: ref.slice(0, i), name: ref.slice(i + 1) };
}

/** The template homes a ref resolves against: its org's, or (bare ref) every org's. */
function templateDirs(refOrg: string | null): { org: string; dir: string }[] {
  const orgs = refOrg === null ? listOrgs() : [refOrg];
  return orgs
    .filter((o) => existsSync(projectDir(o)))
    .map((o) => ({ org: o, dir: join(projectDir(o), "templates") }));
}

/** The component homes a ref resolves against. Components live in TWO tiers: the
 *  marketplace (`rx/components`, generic, every org may use) and the org packs
 *  (`rx/orgs/<org>/components`, the client's own microapps — org-private). Names are
 *  unique WITHIN a tier, and an org may never shadow a marketplace name, so a bare
 *  ref resolves the shared home first, then the orgs; TWO orgs may carry the same
 *  name (each addressed `<org>/<name>`), so a bare ref matching more than one org is
 *  AMBIGUOUS — resolveComponentDirs turns that into a loud error, never first-wins.
 *  An org-prefixed ref searches its org first (shared last, as compat for prefixed
 *  refs to universal names). */
function componentDirs(refOrg: string | null): { org: string | undefined; dir: string }[] {
  const shared = { org: undefined as string | undefined, dir: SHARED_DIR.component };
  const orgDirs = (refOrg === null ? listOrgs() : [refOrg])
    .filter((o) => existsSync(join(projectDir(o), "components")))
    .map((o) => ({ org: o as string | undefined, dir: join(projectDir(o), "components") }));
  return refOrg === null ? [shared, ...orgDirs] : [...orgDirs, shared];
}

/** True when `dir` holds the component `<lower>` in either authored form. */
function componentHit(dir: string, lower: string): boolean {
  return !!defPath(dir, lower) || !!defPath(join(dir, lower), lower);
}

/** The dirs a component ref may actually load from. Qualified refs pass through
 *  untouched. A bare ref narrows to the ONE home that carries the name: the CONTEXT
 *  org first when given (the org of the definition/app doing the asking — a cloned
 *  pack's own manifests and layouts say `course-card` and mean their own), then the
 *  marketplace (an org may never shadow it, so these two never conflict); a single
 *  org match resolves for compat with pre-org refs (saved workflows, COMPONENT_INIT
 *  `type`); a name in two or more orgs WITH no context throws, naming the qualified
 *  candidates — the caller must say which org it means. */
function resolveComponentDirs(
  dirs: { org: string | undefined; dir: string }[],
  refOrg: string | null,
  lower: string,
  contextOrg?: string,
): { org: string | undefined; dir: string }[] {
  if (refOrg !== null) return dirs;
  const hits = dirs.filter(({ dir }) => componentHit(dir, lower));
  const contextHit = contextOrg ? hits.find((h) => h.org === contextOrg) : undefined;
  if (contextHit) return [contextHit];
  const sharedHit = hits.find((h) => h.org === undefined);
  if (sharedHit) return [sharedHit];
  if (hits.length > 1)
    throw new Error(
      `component ref "${lower}" is ambiguous: it exists in ${hits.map((h) => `${h.org}/${lower}`).join(", ")}. Use the org-qualified ref.`,
    );
  return hits.length === 1 ? hits : dirs;
}

/** Resolve a component ref (bare or `<org>/<name>`, either tier) to its ON-DISK
 *  FOLDER — the home of its manifest and any lifecycle handler files (onstart.js …).
 *  Returns null for a flat/marketplace component with no folder. Used by the MCP
 *  render path to run component lifecycle handlers. */
export function componentFolder(ref: string): string | null {
  const { org: refOrg, name } = parseRef(ref);
  const lower = name.toLowerCase();
  for (const { dir } of resolveComponentDirs(componentDirs(refOrg), refOrg, lower)) {
    const folder = join(dir, lower);
    if (defPath(folder, "manifest") || defPath(folder, lower)) return folder;
  }
  return null;
}

export interface UnoverseDefinition {
  unoverse: string;
  kind: "component" | "template" | "atom";
  name: string;
  /** Source basename for FILE definitions (atoms) — the identity refs resolve by. */
  file?: string;
  /** The client org it belongs to (server-injected from its folder, never
   *  hand-written) — also names its theme (`<org>/light`). Design-system components
   *  and atoms are universal and carry no org; an ORG component (the client's own
   *  microapp, `rx/orgs/<org>/components/`) carries its org and is org-private. */
  org?: string;
  category?: string;
  /** Human display name ("Bank Transfer"); falls back to `name` (the id). */
  title?: string;
  description?: string;
  /** TEMPLATES: the spatial-discovery selection text — ranked against user intent
   *  by findIntent, exactly like a node's whenToUse in the node catalog. Write it
   *  outcome-first in the user's vocabulary (packages/docs/nodes/14-node-discoverability.md);
   *  `description` stays the human "what it is". When present it REPLACES
   *  description in the embedded text. */
  whenToUse?: string;
  props?: Record<string, unknown>;
  /** COMPONENTS (render contract): the composed `state` block. The manifest's arrival
   *  `defaultState` seeds it so the SDK renders that face on arrival (merged beneath
   *  live data). Server-composed from the manifest, never hand-written. */
  state?: Record<string, unknown>;
  /** COMPONENTS: projected capability flag — true iff the component folder carries a
   *  manifest.json (spatial-capable). Derived from presence, never authored in a def. */
  spatial?: boolean;
  /** Display icon URL (from the manifest; catalogs/drawers only). */
  icon?: string;
  /** COMPONENTS: manifest version (display only). */
  version?: string;
  /** COMPONENTS: credential types a lifecycle hook needs, by name. The canvas offers the
   *  same picker a node gets; the value is resolved server-side and never in this folder. */
  credentials?: string[];
  root: unknown;
  /** TEMPLATE LAYOUTS (name-sync): present only when the template folder carries
   *  MULTIPLE layouts/ files. Each entry is a fully composed arrangement; the SDK
   *  presents the layout whose name matches the latest surfaced component view,
   *  falling back to `defaultLayout` (the manifest's `layout`). One-layout
   *  templates never carry this — byte-for-byte the classic behavior. */
  layouts?: Record<string, unknown>;
  defaultLayout?: string;
  /** TEMPLATES (STATE_MODEL v2 §5 rules 3+5): the DECLARED STATE ORDER — the priority
   *  ladder and arrival-scan order, from the manifest's `stateOrder`. First entry
   *  outranks all below it; no name is special. Absent → legacy recency semantics. */
  stateOrder?: string[];
  /** COMPONENTS (STATE_MODEL v2 §5 rule 2): the PUBLIC MENU — the top-level state
   *  names of the authored `state.view` tree, compiled at serve time. What hosts may
   *  place at spawn and templates may react to; nested substates never appear here. */
  publicStates?: string[];
  /** REFERENCE, DON'T COPY: the shared pieces this definition NAMES rather than carries,
   *  by ref name. Present only on the referenced form (`referencedDefinition`), which a
   *  client asks for explicitly; the default form still inlines every Ref. */
  defs?: Record<string, unknown>;
  /** COMPONENTS (STATE_MODEL v2): the view tree's declared initial — the base the
   *  client retracts to and the fallback when no host placement matches. */
  initialView?: string;
  /** COMPONENTS (STATE_MODEL v2): the authored `state.view` TREE, served as a nested
   *  projection so viewers render states from the DECLARATION instead of scanning
   *  layouts for Switches (the scan surfaced embedded components' content selectors —
   *  a Document's tab cases — as fake states). Public states in tree order, each with
   *  its layout, its substep discriminant (`on` + `initial`), and its private
   *  substates. The tree stays the single source of truth; this is its projection. */
  stateTree?: {
    name: string;
    layout?: string;
    on?: string;
    initial?: string;
    states?: { name: string; layout?: string }[];
  }[];
}

/** A COMPONENT manifest — `rx/components/<name>/manifest.json`. OPTIONAL: its PRESENCE
 *  is what makes a component spatial-capable (a basic component has none and is never
 *  discovered). It is the single home for the discovery meta; there is NO flag inside —
 *  presence is the capability, the workbench registry toggle is the activation. */
export interface ComponentManifest {
  title?: string;
  /** Display icon URL (square; shown in catalogs/drawers — never embedded). */
  icon?: string;
  description?: string;
  /** Spatial-discovery selection text — see UnoverseDefinition.whenToUse. Required
   *  in practice (the discoverability guard enforces it). */
  whenToUse?: string;
  category?: string;
  version?: string;
  /** The component's ARRIVAL state — an OPEN name (default "inline"). Injected into the
   *  composed def's `state` block so the SDK renders that face on arrival; the component
   *  still writes its own `defaultState` at runtime via setValue (STATE_MODEL §5b). This is
   *  the render contract's home for the default state — parallel to a template's manifest. */
  defaultState?: string;
  /** LIFECYCLE opt-in — the phases whose server-side handler this component brings
   *  (e.g. ["onStart"]). Each name maps to a sibling file (onStart → onstart.js), run by
   *  the MCP render path. Presence here AUTHORIZES execution; a file with no opt-in is
   *  inert. See UNOVERSE_AUTHORING.md §3c. */
  lifecycle?: string[];
}

// ---- Composition: expand `Ref` nodes by inlining the referenced atom ----
//
// A component composes an atom via { type: "Ref", ref: "Button", props: { label: "callToAction" } }.
// The server inlines the atom's tree, remapping the atom's bind/visibleWhen fields
// (its prop names) → the host's fields per `props`. Atoms are NEVER served standalone;
// channels only ever receive fully-expanded primitive trees.
//
// `with` passes LITERALS where `props` passes field remaps — the per-use content an
// atom can't carry: { type: "Ref", ref: "button", with: { label: "Learn more", icon:
// "arrowRight" }, action: {...} }. Each `with` key resolves the atom's binding to that
// prop name into a hardcoded attribute (bind entry → literal attr, guarding visibleWhen
// → kept when truthy / left field-bound when absent, {{prop}} style bindings → the
// value). This is what makes one standard atom usable with different content per site.

type AnyNode = Record<string, any>;

// Remap `{{field}}` data-bindings embedded in STYLE values (e.g. a radial gauge's
// `radial.at: "{{value}}"`, a progress bar's `width: "{{pct}}"`) — the style-side twin
// of the bind/visibleWhen remap, so an atom whose look is data-driven is parameterizable.
function remapStyleBindings(style: AnyNode, propMap: Record<string, string>): void {
  for (const k of Object.keys(style)) {
    const v = style[k];
    if (typeof v === "string" && v.includes("{{")) {
      style[k] = v.replace(/\{\{(\w[\w.]*)\}\}/g, (m, f) => (propMap[f] ? `{{${propMap[f]}}}` : m));
    } else if (v && typeof v === "object") {
      remapStyleBindings(v as AnyNode, propMap); // nested: radial.at, hover, etc.
    }
  }
}

function remapFields(node: AnyNode, propMap: Record<string, string>): void {
  // A NESTED `Ref` IS REMAPPED THROUGH ITS OWN `props`. The values of an inner reference's
  // `props` are field names in THIS tree's scope, so the host's rename has to reach them:
  // an atom that composes another atom (toggle-row and form-toggle both draw toggle-switch)
  // otherwise hands the inner one the OUTER atom's prop name, which the host has just
  // renamed away. The switch then tests an absent key and never draws its ON state — the
  // control looks right, moves nothing, and says nothing. Same silence as the visibleWhen
  // object form below, one level deeper.
  if (node.type === "Ref" && node.props && typeof node.props === "object") {
    for (const k of Object.keys(node.props as AnyNode)) {
      const v = (node.props as AnyNode)[k];
      if (typeof v === "string" && propMap[v]) (node.props as AnyNode)[k] = propMap[v];
    }
  }
  if (node.bind) for (const k of Object.keys(node.bind)) if (propMap[node.bind[k]]) node.bind[k] = propMap[node.bind[k]];
  if (typeof node.visibleWhen === "string" && propMap[node.visibleWhen]) node.visibleWhen = propMap[node.visibleWhen];
  // THE OBJECT FORM REMAPS TOO. A guard is a guard whichever way it is written, and only
  // the string form was carried across: an atom guarding on `{ field: "value", ne: "" }`
  // kept testing its OWN prop name after the host remapped `value` to its field, so the
  // guard read an absent key and the branch never showed. Silent, and it bit form-select
  // the day it was written (2026-08-09).
  if (node.visibleWhen && typeof node.visibleWhen === "object" && !Array.isArray(node.visibleWhen)) {
    const g = node.visibleWhen as { field?: string };
    if (typeof g.field === "string" && propMap[g.field]) g.field = propMap[g.field];
  }
  // `when` style variants are the same predicate wearing a different hat: an atom whose
  // LOOK is data-driven (a switch track filling when `on` is true) must follow its host's
  // field for the same reason.
  const when = (node.style as AnyNode | undefined)?.when;
  if (Array.isArray(when)) {
    for (const v of when as { field?: string }[]) {
      if (v && typeof v.field === "string" && propMap[v.field]) v.field = propMap[v.field];
    }
  }
  if (node.style && typeof node.style === "object") remapStyleBindings(node.style as AnyNode, propMap);
  if (Array.isArray(node.children)) node.children.forEach((c: AnyNode) => remapFields(c, propMap));
  if (node.template) remapFields(node.template as AnyNode, propMap); // Each item subtree
  if (node.cases && typeof node.cases === "object") for (const k of Object.keys(node.cases)) remapFields(node.cases[k] as AnyNode, propMap); // Switch branches
}

// Resolve an atom's bindings to LITERAL content (the Ref's `with` map). A bind entry
// whose field is a `with` key becomes a hardcoded attribute; a visibleWhen guard on a
// provided (truthy) key is satisfied statically and dropped; `{{key}}` style bindings
// take the value. Keys the atom doesn't bind are ignored (harmless).
/** Substitute `{{name}}` anywhere inside a style object, at any depth. */
function applyStyleLiterals(style: unknown, lits: Record<string, unknown>): void {
  if (Array.isArray(style)) return style.forEach((v) => applyStyleLiterals(v, lits));
  if (!style || typeof style !== "object") return;
  const s = style as AnyNode;
  for (const k of Object.keys(s)) {
    const v = s[k];
    if (typeof v === "string" && v.includes("{{"))
      s[k] = v.replace(/\{\{(\w[\w.]*)\}\}/g, (m, f) => (f in lits ? String(lits[f]) : m));
    else if (v && typeof v === "object") applyStyleLiterals(v, lits);
  }
}

function applyLiterals(node: AnyNode, lits: Record<string, unknown>): void {
  if (node.bind) {
    for (const attr of Object.keys(node.bind)) {
      const field = node.bind[attr];
      if (typeof field === "string" && field in lits) {
        node[attr] = lits[field];
        delete node.bind[attr];
      }
    }
    if (Object.keys(node.bind).length === 0) delete node.bind;
  }
  if (typeof node.visibleWhen === "string" && node.visibleWhen in lits) {
    if (lits[node.visibleWhen]) delete node.visibleWhen; // statically satisfied
    // falsy literal: keep the (now never-true) guard — the node stays hidden
  }
  // Style values may NEST (a radial's `at`, a `when` clause's `apply`), so this walks the
  // whole style object rather than its top level — a `{{value}}` one level down survived
  // and reached the renderer verbatim.
  if (node.style && typeof node.style === "object") applyStyleLiterals(node.style as AnyNode, lits);
  if (Array.isArray(node.children)) node.children.forEach((c: AnyNode) => applyLiterals(c, lits));
  if (node.template) applyLiterals(node.template as AnyNode, lits);
  if (node.cases && typeof node.cases === "object") for (const k of Object.keys(node.cases)) applyLiterals(node.cases[k] as AnyNode, lits);
}

export function expandNode(node: AnyNode, contextOrg?: string): AnyNode {
  if (node?.type === "Ref") {
    // A Ref inlines an ATOM (the usual case, rx/atoms). It also resolves a COMPONENT
    // as a fallback, so a template can embed a shared flat component (e.g. the
    // ComposerBar chrome) the same way it embeds an atom — the one mechanism for fixed,
    // always-present chrome. (A component's root is inlined as-is; flat components only.)
    // The parent definition's org rides along so a bare ref inside an org's own tree
    // resolves to that org's component when two orgs share the name.
    const atom =
      loadDefinition(String(node.ref), "atom") ?? loadDefinition(String(node.ref), "component", "expanded", contextOrg);
    if (!atom?.root) return node; // unknown ref — leave the Ref (renders as a no-op)
    const root = JSON.parse(JSON.stringify(atom.root)) as AnyNode;
    remapFields(root, (node.props ?? {}) as Record<string, string>);
    if (node.with && typeof node.with === "object") applyLiterals(root, node.with as Record<string, unknown>);
    if (node.visibleWhen) root.visibleWhen = node.visibleWhen;
    // A Ref may override the atom's `action` — the per-host behaviour the atom can't carry
    // (e.g. each wizard step's option sets different fields). Parallel to style/visibleWhen.
    if (node.action) root.action = node.action;
    if (node.style) root.style = { ...(root.style ?? {}), ...node.style };
    return expandNode(root, contextOrg); // expand nested refs too
  }
  if (Array.isArray(node?.children)) node.children = node.children.map((c: AnyNode) => expandNode(c, contextOrg));
  // `Each` carries a per-item subtree in `template` (not `children`) — expand it too,
  // so an atom `Ref` inside a repeated item is inlined like anywhere else.
  if (node?.template) node.template = expandNode(node.template, contextOrg);
  // `Switch` carries its branches in `cases` (a value→subtree map) — expand each, so an
  // atom `Ref` inside a Switch branch is inlined like anywhere else (else the branch
  // renders blank). Parallel to children/template.
  if (node?.cases && typeof node.cases === "object") {
    for (const k of Object.keys(node.cases)) node.cases[k] = expandNode(node.cases[k] as AnyNode, contextOrg);
  }
  // `ComponentSlot` carries chrome in `frame` (born when the slot matches) and `fallback`
  // (shown when it doesn't) — both are real child slots, so an atom `Ref` inside them (e.g. a
  // ✕ CloseButton on a rail/panel frame) must inline like anywhere else, else the Ref survives.
  if (node?.frame) node.frame = expandNode(node.frame as AnyNode, contextOrg);
  if (node?.fallback) node.fallback = expandNode(node.fallback as AnyNode, contextOrg);
  return node;
}

function expandRefs(def: UnoverseDefinition, contextOrg?: string): UnoverseDefinition {
  if (def?.root) def.root = expandNode(def.root as AnyNode, contextOrg ?? def.org);
  return def;
}

/**
 * REFERENCE, DON'T COPY — the same definition with its `Ref` nodes LEFT ALONE, plus one
 * copy of each atom they name, in `defs`.
 *
 * `expandRefs` above specialises every Ref into an inline copy, which is why a shared
 * button travels inside every definition that uses it, and again on every page load
 * (MCP reads go over POST, so no browser cache holds them). Measured across the estate
 * when this landed: 1259 KB served against 224 KB of distinct structure, and
 * sab/product-card at 361 KB because it referenced a document carrying six copies of an
 * eleven-branch field switch.
 *
 * A Ref is a pure function of the atom and its own parameters, so the client can do the
 * specialisation (web/sdk core/refs.ts, proven byte-identical to `expandNode` by
 * server/tests/sdk/ref-resolution.test.ts). What travels is the reference plus the atom,
 * once, and the client caches the atom by name for every later definition that names it.
 *
 * OPT-IN, and that is deliberate: a client that cannot resolve a Ref renders nothing where
 * one appears. Callers ask for this form explicitly, so anything that has not been updated
 * keeps receiving fully inlined trees and cannot be broken by a server upgrade.
 */
export function referencedDefinition(def: UnoverseDefinition, contextOrg?: string): UnoverseDefinition {
  const defs: Record<string, AnyNode> = {};
  // Depth-first over the tree, collecting each named atom ONCE. An atom may itself Ref
  // another, so collected atoms are walked too — otherwise the client resolves an atom
  // and finds a reference it was never sent.
  const collect = (node: AnyNode | undefined): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(collect);
    if (node.type === "Ref" && typeof node.ref === "string") {
      const name = node.ref;
      if (!(name in defs)) {
        // The referenced piece in its OWN referenced form, with its references merged up
        // into the same flat map. The client threads `defs` through every recursion, so a
        // Ref inside a referenced piece resolves against the same map. Storing these
        // EXPANDED instead was the difference between product-card costing 17 KB + 173 KB
        // and 17 KB + a handful: it references `document`, and an expanded document drags
        // in every copy this exists to remove.
        const piece =
          loadDefinition(name, "atom", "referenced") ?? loadDefinition(name, "component", "referenced", contextOrg ?? def.org);
        if (piece?.root) {
          defs[name] = piece.root as AnyNode;
          for (const [k, v] of Object.entries((piece.defs ?? {}) as Record<string, AnyNode>)) if (!(k in defs)) defs[k] = v;
          collect(piece.root as AnyNode);
        }
      }
    }
    if (Array.isArray(node.children)) node.children.forEach(collect);
    if (node.template) collect(node.template as AnyNode);
    if (node.cases && typeof node.cases === "object") for (const k of Object.keys(node.cases)) collect(node.cases[k] as AnyNode);
    if (node.frame) collect(node.frame as AnyNode);
    if (node.fallback) collect(node.fallback as AnyNode);
  };
  // EVERY TREE THE DEFINITION SHIPS, not just `root`. A template's arrangements live in
  // `layouts`, and they are the whole payload — a chat template's `root` is a stub. Walking
  // `root` alone deduplicated nothing at all for templates: measured on bpp-chat-layout,
  // whose four layouts include the SAME 7 KB chrome file, the referenced form came back 11%
  // smaller instead of the ~70% every component saw.
  const trees = () => [def.root, ...Object.values(def.layouts ?? {})] as AnyNode[];
  trees().forEach(collect);

  // REPEATS ARE REFERENCES TOO, wherever they came from.
  //
  // Hoisting named atoms only fixes duplication that went through a `Ref`. A template
  // composes its arrangements with `$include`, which is copied just as literally: a chat
  // layout shipping four arrangements carried four copies of the same chrome, 35 KB of a
  // 44 KB payload, and not one byte of it was an atom.
  //
  // So this is structural: any subtree appearing more than once becomes ONE entry plus
  // references to it. Identical trees render identically, and the client resolves a
  // parameterless reference by cloning, so nothing about meaning changes. Counted ACROSS
  // the trees, because the repetition that matters most is one arrangement against another.
  const hoisted = hoistRepeats(trees(), defs);
  if (hoisted.length) {
    const [root, ...layouts] = hoisted;
    def = { ...def, root };
    if (def.layouts) def.layouts = Object.fromEntries(Object.keys(def.layouts).map((k, i) => [k, layouts[i]]));
  }

  return Object.keys(defs).length ? ({ ...def, defs } as UnoverseDefinition) : def;
}

/**
 * Replace every repeated subtree, across ALL of a definition's trees, with a reference to
 * one copy. Returns the rewritten trees in the order given.
 *
 * Counting spans the whole set rather than each tree alone, because the duplication that
 * dominates a template is one ARRANGEMENT against another: four layouts that each include
 * the same chrome share nothing within themselves and everything between themselves.
 *
 * Top-down, so the LARGEST repeated tree is hoisted and its children ride inside it rather
 * than being hoisted separately: hoisting a child first would leave the parent's copies
 * differing only in that child's reference, and they would stop matching each other.
 *
 * `MIN` exists because a reference costs about 40 bytes; hoisting a 60-byte node makes the
 * payload bigger and the tree harder to read for nothing.
 */
function hoistRepeats(roots: AnyNode[], defs: Record<string, AnyNode>): AnyNode[] {
  const MIN = 700; // bytes: comfortably larger than the reference that replaces it
  const counts = new Map<string, number>();
  const count = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(count);
    if (!node || typeof node !== "object") return;
    const n = node as AnyNode;
    if (n.type && n.type !== "Ref") {
      const j = JSON.stringify(n);
      if (j.length >= MIN) counts.set(j, (counts.get(j) ?? 0) + 1);
    }
    for (const v of Object.values(n)) if (v && typeof v === "object") count(v);
  };
  roots.forEach(count);

  const repeated = new Map<string, string>(); // serialized tree → its reference name
  let i = 0;
  for (const [j, n] of counts) if (n > 1) repeated.set(j, `shared:${(i++).toString(36)}`);
  if (!repeated.size) return [];

  const swap = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(swap);
    if (!node || typeof node !== "object") return node;
    const n = node as AnyNode;
    if (n.type && n.type !== "Ref") {
      const name = repeated.get(JSON.stringify(n));
      if (name) {
        // The first sighting becomes the stored copy, with ITS OWN repeats hoisted, so a
        // shape repeated inside a repeated shape collapses too.
        if (!(name in defs)) {
          const stored = JSON.parse(JSON.stringify(n)) as AnyNode;
          defs[name] = stored;
          for (const [k, v] of Object.entries(stored)) if (v && typeof v === "object") stored[k] = swap(v) as AnyNode;
        }
        return { type: "Ref", ref: name };
      }
    }
    for (const [k, v] of Object.entries(n)) if (v && typeof v === "object") n[k] = swap(v) as AnyNode;
    return n;
  };
  // A whole tree can itself be a repeat (two arrangements that are the same), so the
  // returned value is used rather than relying on in-place rewriting.
  return roots.map((r) => swap(r) as AnyNode);
}


// ---- Folder composition: inline `{ "$include": "name" }` from sibling files ----
//
// A template can be a FOLDER (templates/chatlayout/) of multiple data files, so
// UX pieces live in their own files (chatlayout + user-turn + …). Any
// `{ "$include": "user-turn" }` node is replaced by the parsed content of
// `<folder>/user-turn.{yaml,json}` (recursively). All UX stays as served data — the SDK
// receives one fully-assembled tree.
//
// `$include` values are EXTENSION-LESS by design, so a partial can be converted from JSON
// to YAML without touching any file that references it.
function composeIncludes(value: any, folderDir: string): any {
  if (Array.isArray(value)) return value.map((v) => composeIncludes(v, folderDir));
  if (value && typeof value === "object") {
    if (typeof value.$include === "string") {
      const incPath = defPath(folderDir, value.$include);
      // Name the missing include: the raw ENOENT names a `.yaml` that was never meant to
      // exist, which reads as a resolver bug rather than a broken reference.
      if (!incPath) throw new Error(`$include "${value.$include}" resolves to no file in ${folderDir}`);
      return composeIncludes(readDefCached(incPath), folderDir);
    }
    const out: AnyNode = {};
    for (const [k, v] of Object.entries(value)) out[k] = composeIncludes(v, folderDir);
    return out;
  }
  return value;
}

/** Resolve a definition by name (case-insensitive), searching the relevant folder(s).
 *
 *  The EXPANDED result (clone + $include composition + Ref inlining — the expensive
 *  part, run on every MCP read and workbench poll) is memoized on the mtimes of its
 *  inputs: the def's own file/folder tree plus the atoms dir (any Ref may point at any
 *  atom). Edit-and-refresh still works — an mtime moves, the signature changes, the
 *  def re-expands. Returned objects are SHARED: callers must treat them as read-only
 *  (all current consumers stringify or shallow-spread). */
export function loadDefinition(
  ref: string,
  kind?: "component" | "template" | "atom",
  /** "referenced" keeps `Ref` nodes and ships each named atom once in `defs`, for clients
   *  that resolve references themselves. Default inlines every Ref, as it always has. */
  mode: "expanded" | "referenced" = "expanded",
  /** The org of the definition/app doing the asking. A bare component ref resolves in
   *  this org first (a cloned pack's own refs mean its own components) — without it a
   *  name two orgs share is an error rather than a guess. */
  contextOrg?: string,
): UnoverseDefinition | null {
  // The two forms are memoized separately: same inputs, different output. Expansion
  // reads the def's own org (stamped before form runs) so nested bare refs resolve
  // within the def's org first.
  const form = (d: UnoverseDefinition) => (mode === "referenced" ? referencedDefinition(d, d.org) : expandRefs(d));
  const suffix = mode === "referenced" ? ":ref" : "";
  // Default lookup is for SERVED kinds only (component/template). Atoms are
  // internal — load them explicitly with kind: "atom" from the composition resolver.
  const kinds: ("component" | "template" | "atom")[] = kind ? [kind] : ["component", "template"];
  const { org: refOrg, name } = parseRef(ref);
  const lower = name.toLowerCase();
  for (const k of kinds) {
    // Atoms live in ONE shared home. Components live in two tiers (marketplace +
    // org packs). Templates live per org — search the ref's org (or all, bare).
    const dirs =
      k === "template" ? templateDirs(refOrg)
      : k === "component" ? resolveComponentDirs(componentDirs(refOrg), refOrg, lower, contextOrg)
      : [{ org: undefined as string | undefined, dir: SHARED_DIR[k] }];
    for (const { org, dir } of dirs) {
      // Flat form: <name>.{yaml,json}. The cached parse is SHARED — clone before expanding
      // (expandRefs/composeIncludes mutate `root` in place); atoms are returned as-is
      // (their consumers only read + clone the subtree).
      const path = defPath(dir, lower);
      if (path) {
        const raw = readDefCached<UnoverseDefinition>(path);
        // AN ATOM MAY COMPOSE ANOTHER ATOM, so it expands like everything else. Returning
        // it raw was safe only while no atom carried a `Ref`: the composition resolver
        // recurses, so a COMPONENT still drew the whole tree, but the atom served on its
        // own (Studio's `unoverse://atoms/{name}`) kept a bare `Ref` that renders as
        // NOTHING — observed live 2026-08-09, a form-toggle with no switch. Cloned before
        // expanding, because the parsed object is shared and expansion mutates in place.
        if (k === "atom") {
          const sig = `${path}:${statSync(path).mtimeMs};${dirSignature([SHARED_DIR.atom])}`;
          return cachedBySignature(`def:atom:${lower}${suffix}`, sig, () => form(structuredClone(raw)));
        }
        const sig = `${path}:${statSync(path).mtimeMs};${dirSignature([SHARED_DIR.atom, SHARED_DIR.component])}`;
        // The org is stamped BEFORE form so expansion knows whose tree it is walking
        // (bare nested refs resolve in the def's own org first).
        return cachedBySignature(`def:${k}:${org ?? ""}:${lower}${suffix}`, sig, () =>
          form(Object.assign(structuredClone(raw), org ? { org } : {})));
      }
      // Folder form: <name>/<name>.{yaml,json} (+ $include sibling files, states/, …).
      // A TEMPLATE folder needs no envelope at all: the manifest IS the metadata and
      // the default layout is the root (standard anatomy — manifest + layouts/ +
      // components/ + states/). An envelope, when present, remains an override.
      const folderDir = join(dir, lower);
      const entry = defPath(folderDir, lower);
      const manifestPath = defPath(folderDir, "manifest");
      const manifestOnly = k === "template" && !entry && !!manifestPath;
      if (entry || manifestOnly) {
        const sig = `${dirSignature([folderDir])};${dirSignature([SHARED_DIR.atom, SHARED_DIR.component])}`;
        return cachedBySignature(`def:${k}:${org ?? ""}:${lower}${suffix}`, sig, () => {
          const def: UnoverseDefinition = manifestOnly
            ? (() => {
                // manifestOnly is only true when manifestPath resolved.
                const m = readDefCached<AppManifest>(manifestPath!);
                return {
                  unoverse: "1.0",
                  kind: "template",
                  name: lower,
                  ...(m.description ? { description: m.description } : {}),
                  ...(m.whenToUse ? { whenToUse: m.whenToUse } : {}),
                  ...(m.category ? { category: m.category } : {}),
                  ...(m.service ? { service: m.service } : {}),
                } as UnoverseDefinition;
              })()
            // ...otherwise `entry` resolved (the `if` admits only these two cases).
            : structuredClone(readDefCached<UnoverseDefinition>(entry!));
          if (org) def.org = org;
          // COMPONENT manifest (OPTIONAL — its PRESENCE means "spatial-capable"; a basic
          // component has none and is never discovered). It is the single home for the
          // discovery meta (description/whenToUse/title): merged over the def so every
          // consumer (nodegen, workbench, catalog) reads one merged shape. `spatial: true`
          // is the projected capability flag — derived from presence, never authored.
          if (k === "component" && manifestPath) {
            const m = readDefCached<ComponentManifest>(manifestPath);
            if (m.description) def.description = m.description;
            if (m.whenToUse) def.whenToUse = m.whenToUse;
            if (m.category) def.category = m.category;
            if (m.title) def.title = m.title;
            if (m.icon) def.icon = m.icon;
            if (m.version) def.version = m.version;
            // The render contract: the manifest's arrival `defaultState` seeds the composed
            // `state` block, so the SDK (which merges def.state beneath live data) renders
            // that face on arrival. Falls back to any authored state, else "inline".
            // (Legacy path — a v2 `state.view` tree below supersedes it: viewOf reads
            // `view` before `defaultState`, so the compiled scalar wins.)
            if (m.defaultState)
              def.state = { ...((def.state as Record<string, unknown>) ?? {}), defaultState: m.defaultState };
            // A hook's credentials, carried so the canvas offers the same picker a node
            // gets. A component that fetches declares WHICH credential it needs; the value
            // is resolved server-side at run time and never reaches this folder.
            if (Array.isArray((m as { credentials?: unknown }).credentials))
              def.credentials = (m as { credentials?: unknown[] }).credentials!.map(String);
            def.spatial = true;
          }
          // No authored root → the DEFAULT LAYOUT is the root: the manifest names it
          // (`layout`, default "main") and it lives in layouts/ like everything else.
          const layoutsDir = join(folderDir, "layouts");
          const defaultLayout = (manifestPath ? readDefCached<{ layout?: string }>(manifestPath).layout : undefined) ?? "main";
          if (!def.root) {
            if (defPath(layoutsDir, defaultLayout)) def.root = { $include: `layouts/${defaultLayout}` };
          }
          if (def.root) def.root = composeIncludes(def.root, folderDir);
          // TEMPLATE LAYOUTS (name-sync, docs/design/05): a template with MULTIPLE
          // layouts/ files is a set of full arrangements — the SDK presents the one
          // whose NAME matches the latest surfaced component view, else the default.
          // Each is composed+expanded exactly like the root and served as def.layouts.
          if (k === "template" && existsSync(layoutsDir)) {
            const names = readdirSync(layoutsDir).filter(isDefFile).map(defName);
            if (names.length > 1) {
              def.defaultLayout = defaultLayout;
              def.layouts = Object.fromEntries(
                names.map((n) => [n, expandNode(composeIncludes({ $include: `layouts/${n}` }, folderDir) as AnyNode)]),
              );
            }
          }
          // STATE MODEL v2 (UNOVERSE_STATE_MODEL §5 rule 5): a template's manifest
          // `stateOrder` is served on the def — the SDK's priority ladder and
          // arrival-scan order. Absent → the SDK stays in legacy recency mode.
          if (k === "template" && manifestPath) {
            const so = readDefCached<{ stateOrder?: unknown }>(manifestPath).stateOrder;
            if (Array.isArray(so)) def.stateOrder = so.filter((n): n is string => typeof n === "string");
          }
          // THE TEMPLATE TREE (STATE_MODEL v2, template tier — sab checkpoint,
          // 2026-08-08): the manifest's `states:` block is the template's state
          // machine, compiled exactly like a component's `state.view` tree:
          //  - def.stateTree  = the nested projection (viewers render it)
          //  - def.stateOrder = the REACTION ladder — top-level names minus the
          //    BASE (the state named for the default layout), in declared order.
          //    Supersedes an authored `stateOrder`.
          //  - CONTAINMENT is structural: a base substate (welcome) exists ONLY in
          //    the base arrangement. Its composed subtree is STRIPPED from every
          //    other layout — no hand-written guard, the declaration is enforced
          //    by compilation. (Identified by structural equality: the composed
          //    states/<name> file IS the inlined node.)
          if (k === "template" && manifestPath) {
            const mStates = readDefCached<{ states?: Record<string, { states?: Record<string, unknown> } | null> }>(manifestPath).states;
            if (mStates && typeof mStates === "object" && !Array.isArray(mStates)) {
              const names = Object.keys(mStates);
              const base = names.includes(defaultLayout) ? defaultLayout : names[0];
              def.stateTree = names.map((n) => {
                const s = mStates[n];
                const entry: NonNullable<UnoverseDefinition["stateTree"]>[number] = { name: n };
                if (s && typeof s === "object" && s.states && typeof s.states === "object")
                  entry.states = Object.keys(s.states).map((sub) => ({ name: sub }));
                return entry;
              });
              def.stateOrder = names.filter((n) => n !== base);
              const baseSubs = Object.keys((mStates[base] as { states?: Record<string, unknown> } | null)?.states ?? {});
              if (def.layouts && baseSubs.length) {
                const statesDir = join(folderDir, "states");
                const marks = baseSubs
                  .map((s) => defPath(statesDir, s))
                  .filter((p): p is string => Boolean(p))
                  .map((p) => JSON.stringify(expandNode(composeIncludes(readDefCached(p), folderDir) as AnyNode)));
                const strip = (node: unknown): unknown => {
                  if (Array.isArray(node)) return node.filter((c) => !marks.includes(JSON.stringify(c))).map(strip);
                  if (node && typeof node === "object") {
                    const out: AnyNode = {};
                    for (const [k2, v2] of Object.entries(node)) out[k2] = strip(v2);
                    return out;
                  }
                  return node;
                };
                for (const n of Object.keys(def.layouts)) if (n !== base) def.layouts[n] = strip(def.layouts[n]);
              }
            }
          }
          // STATE MODEL v2 (UNOVERSE_STATE_MODEL §5 rules 1+2): an authored
          // `state.view` TREE is the component's state machine — public states owning
          // layouts, private substates nested beneath. It COMPILES here; the tree
          // itself never reaches the render scope:
          //   - def.publicStates = the public menu (top-level names, tree order)
          //   - def.initialView  = the declared initial (the retract/fallback base)
          //   - def.state.view   → the scalar initial (the render scope reads a value)
          //   - a nested `on` + `initial` pair → its scalar initial (the substep key)
          if (k === "component") {
            const tree = (def.state as Record<string, unknown> | undefined)?.view as
              | {
                  initial?: unknown;
                  states?: Record<string, { on?: unknown; initial?: unknown; states?: Record<string, unknown> } | null>;
                }
              | undefined;
            if (tree && typeof tree === "object" && tree.states && typeof tree.states === "object") {
              const names = Object.keys(tree.states);
              const initial = typeof tree.initial === "string" ? tree.initial : names[0];
              def.publicStates = names;
              def.initialView = initial;
              // The nested projection viewers render from (never scan layouts for it).
              def.stateTree = names.map((n) => {
                const s = (tree.states as Record<string, { layout?: unknown; on?: unknown; initial?: unknown; states?: Record<string, { layout?: unknown } | null> } | null>)[n];
                const entry: NonNullable<UnoverseDefinition["stateTree"]>[number] = { name: n };
                if (s && typeof s === "object") {
                  if (typeof s.layout === "string") entry.layout = s.layout;
                  if (typeof s.on === "string") entry.on = s.on;
                  if (typeof s.initial === "string") entry.initial = s.initial;
                  if (s.states && typeof s.states === "object")
                    entry.states = Object.entries(s.states).map(([k, v]) => ({
                      name: k,
                      ...(v && typeof v === "object" && typeof v.layout === "string" ? { layout: v.layout } : {}),
                    }));
                }
                return entry;
              });
              // ONE AXIS ON A MIGRATED SLICE. The manifest's `defaultState` is seeded above
              // for legacy components; a component with a tree has already said where it
              // arrives, so the alias is dropped here rather than shipped alongside `view`.
              // Two spellings on one slice is how a stale reader keeps working by accident:
              // it reads the alias, sees the ARRIVAL state forever, and never notices the
              // component moved. (The manifest keeps the key: at app level it is the load
              // mode the router branches on, a different axis with the same name.)
              const { defaultState: _legacyAlias, ...authored } = (def.state ?? {}) as Record<string, unknown>;
              // ORDER IS THE PRIORITY, at BOTH levels (2026-08-15). The first state
              // declared is the one the component arrives in, and the first substate
              // declared is the step its `on` axis starts on. An `initial` key said the
              // same thing a second time and was free to contradict the list, which is
              // how a component could declare one arrival and ship another. It is still
              // READ where a def has not been swept, and lint-forbidden in rx.
              const flat: Record<string, unknown> = { ...authored, view: initial };
              for (const s of Object.values(tree.states))
                if (s && typeof s === "object" && typeof s.on === "string") {
                  const subs = s.states && typeof s.states === "object" ? Object.keys(s.states) : [];
                  const step = typeof s.initial === "string" ? s.initial : subs[0];
                  if (step) flat[s.on] = step;
                }
              def.state = flat;
            }
          }
          return k === "atom" ? def : form(def);
        });
      }
    }
  }
  return null;
}

/** List definitions of a kind. Atoms come from the ONE shared home. Components come
 *  from the marketplace PLUS the org packs — every org's when `org` is omitted
 *  (each tagged), or just `org`'s own + the shared tier when given (org-private:
 *  another org's components are never listed into an org-scoped view). Templates
 *  come from `org`'s folder, or every org's (each tagged). */
export function listDefinitions(kind: "component" | "template" | "atom", org?: string): UnoverseDefinition[] {
  const out: UnoverseDefinition[] = [];
  const dirs =
    kind === "template" ? templateDirs(org ?? null)
    : kind === "component" ? componentDirs(org ?? null)
    : [{ org: undefined as string | undefined, dir: SHARED_DIR[kind] }];
  for (const { org: o, dir } of dirs) {
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      // PER-ENTRY ISOLATION: a definition MID-EDIT (a saved layout referencing a
      // states/ file not written yet, malformed JSON) is a normal state of a
      // live-editing platform. One broken definition must degrade to a skipped
      // entry with a warning — never fail the whole catalog request (observed
      // live: an in-flight template edit 500'd /dev/templates for every org).
      try {
        if (e.isFile() && isDefFile(e.name)) {
          const raw = readDefCached<UnoverseDefinition>(join(dir, e.name));
          // The FILENAME travels: refs address a file atom by its basename, so the
          // catalogue must name it the same way or an installed atom is unreachable.
          const withFile = { ...raw, file: e.name } as UnoverseDefinition;
          out.push(o ? { ...withFile, org: o } : withFile);
        } else if (e.isDirectory()) {
          const d = loadDefinition(o ? `${o}/${e.name}` : e.name, kind); // composes the folder ($include + refs)
          if (d) out.push(d);
        }
      } catch (err) {
        console.warn(
          `[unoverse] skipping ${kind} '${o ? `${o}/` : ""}${e.name}' — failed to load (mid-edit?): ${(err as Error)?.message ?? err}`,
        );
      }
    }
  }
  return out.filter((d) => d.kind === kind);
}

// ---- MCP apps: a template folder + a manifest.json (UNOVERSE_MCP_TEMPLATE_PROTOCOL §4b) ----
//
// An MCP app is JUST a manifest: self-describing (name/description/category for discovery
// + selection) and self-running (it OWNS its workflow binding — the §6a flip). Loading an
// app = trigger the binding → the workflow streams component(s) back → the SDK renders
// them (no per-app shell; rendering the stream is generic). `template` is OPTIONAL, only
// for an app that wants fixed layout/chrome. The manifest is also the future
// spatial-ingestion record.

/** An MCP app manifest — `rx/templates/<id>/manifest.json`. */
export interface AppManifest {
  /** App id = the folder name (the app URI is `unoverse://apps/<org>/<id>`). */
  id: string;
  /** The org tree that serves this app (injected from the folder location, never
   *  hand-written). Channels use it to address the app's theme (`<org>/light`). */
  org?: string;
  name: string;
  /** Human display name; falls back to `name`. */
  title?: string;
  description?: string;
  /** Spatial-discovery selection text — see UnoverseDefinition.whenToUse. */
  whenToUse?: string;
  category?: string;
  version?: string;
  /** The app's named DEFAULT STATE on load — the single authored field. An OPEN name, not a
   *  closed enum: templates/channels recognize it by NAME (Switch/visibleWhen), so new states
   *  need zero protocol change (UNOVERSE_MCP_TEMPLATE_PROTOCOL §4b). The known names today:
   *  - "template":  fluid height — the app fills/swaps the whole surface (chat/voice shells)
   *  - "focus":     fit-to-content AND opens in focus (large overlay) on load (wizards)
   *  - "component": renders INLINE in the conversation like any card — no focus, no takeover
   *  Any other name: fit-to-content; the org's templates define what the name renders as.
   *  `type` + `fluidHeight` below are LEGACY and DERIVED in `loadAppManifest` (template ⇒
   *  type:template + fluid · anything else ⇒ type:component + fit) so existing consumers keep
   *  reading them unchanged. Author `defaultState`; never set `type`/`fluidHeight` by hand.
   *  (`mode` is the pre-rename alias — still read as a fallback.) */
  defaultState?: string;
  /** @deprecated pre-rename alias of `defaultState`; read as fallback, never author. */
  mode?: string;
  /** @deprecated derived from `defaultState`. The router branch (swap vs inline). */
  type?: "template" | "component";
  /** OPTIONAL layout shell template name. Default: none — the SDK renders the raw
   *  component stream. Set this only when the app wants fixed layout/chrome. */
  template?: string;
  /** The DEFAULT LAYOUT — the layouts/<name>.json used as the def's root when the
   *  envelope authors none (standard folder anatomy). Default: "main". */
  layout?: string;
  /** A native service the template binds (UNOVERSE_SPEC §2e-1) — e.g. "voice". The
   *  channel instantiates the matching service and feeds its state into the scope.
   *  Manifest-authored so a manifest-only template (no envelope) still declares it. */
  service?: string;
  /** Display icon URL (square; shown in catalogs/drawers — never embedded). */
  icon?: string;
  /** How to call it — JSON Schema for the input params. */
  inputSchema?: Record<string, unknown>;
  /** What to run — the app owns its workflow binding (app ≡ workflow). */
  binding?: { workflow?: string; trigger?: string };
  /** Load mode. true = on load, read the template AND fire the workflow (read resource +
   *  call tool). false/absent = just load the template (read resource), wait for the user. */
  autoTrigger?: boolean;
  /** Publish this app on the EXTERNAL MCP endpoint. OPT-IN: absent/false keeps the app off
   *  `/mcp` and `/mcp/{org}` entirely (no tool, no template listing) — only `makeMCP: true`
   *  reaches an outside client. Default-deny, so a new app is never externally callable by
   *  accident; publishing is always a deliberate line in the manifest.
   *  Visibility ONLY: orthogonal to auth, which is decided by the workflow's trigger toggle
   *  (`isPublicEntry`). The org URL picks WHICH SET a connector sees; this picks what is in
   *  that set at all. */
  makeMCP?: boolean;
  /** Asset origins this app's content loads (images, media) — e.g. the org's image CDN.
   *  Authored per app in manifest.yaml; the server UNIONS them across the connector's
   *  published apps into the MCP-app shell's CSP (`ui.csp.resourceDomains`). A sandboxed
   *  host builds its img-src from that list and blocks everything else, so an origin
   *  missing here renders as broken images in ChatGPT/Claude while working in our own
   *  hosts. Full origins with scheme, wildcards allowed: "https://*.datocms-assets.com". */
  assetDomains?: string[];
  /** Render lifetime (docs/design/04 §Two lifetimes). Default "turn": the instance returns
   *  to inline/retires on the next user turn (the universal reset). "conversation" = a
   *  DURABLE conversation-scoped surface (a cart, an itinerary, a composed page): keyed by
   *  the CONVERSATION (not the turn) so every re-call hydrates the same slice, and the
   *  client's new-turn reset skips it — it stays on screen until replaced or closed. */
  lifetime?: "turn" | "conversation";
  /** LATCHABLE (docs/MCP_COMPLETE_GUIDE.md §The Component Latch). Present = the conversation
   *  can be ADDRESSED AT this instance: while its pill is up, what the guest says next travels
   *  with the instance's key and its current state, and the answer merges back into it instead
   *  of placing a new component. Absent = never latchable.
   *  Travels to the client the same way `lifetime` does — as a field on the slice, seeded with
   *  the render — because the holder is DERIVED from the live slices and never stored. At most
   *  one latch exists: the highest-ranked latchable instance by the template's declared state
   *  order. Colours are semantic tokens, never hex. */
  latch?: { title: string; background?: string; color?: string };
  /** Workbench MOCK: what each STATE's preview seeds — `{ "<state>": ["course-card",
   *  "course-card"] }` (a repeated name = several instances, e.g. a card rail). The
   *  author decides per state; the seeded instances are written INTO that state's view
   *  (the same setValue the runtime performs). Not used in LIVE — the workflow decides. */
  preview?: Record<string, string[]>;
  /** LEGACY workbench mock hint (pre-`preview`): a flat component list seeded for any
   *  reaction state. Superseded by `preview` — kept as the fallback. */
  previewComponents?: string[];
  /** Layout height mode. Absent/true = FLUID: the template fills the available height
   *  (chat / assistant / voice layouts). false = size to CONTENT: the frame shrinks to the
   *  rendered component (focused widget apps like Bank Transfer). */
  fluidHeight?: boolean;
  /** The app's layer views — AUTO-DERIVED from its `states/` folder (UNOVERSE_LAYERS.md §7),
   *  NOT hand-written in manifest.json. Injected by `loadAppManifest` so the SERVED manifest
   *  makes external MCP callers aware of the states with zero drift (folder = source of truth). */
  states?: StateEntry[];
}

/** `defaultState` is the authored field (open NAME; `mode` = pre-rename alias); derive the
 *  legacy `type`/`fluidHeight` the rest of the system still reads (and back-derive
 *  `defaultState` for any manifest still on the old fields). */
function normalizeMode(m: AppManifest): AppManifest {
  const declared = m.defaultState ?? m.mode;
  if (declared === "template") return { ...m, defaultState: declared, type: "template", fluidHeight: true };
  // Every non-template name (focus, component, anything future) is an inline/fit app at the
  // router level — same branch (type:component). What the NAME renders as is the channel's
  // and the org's templates' business (they branch on `defaultState` by name); e.g. the
  // channel opens the focus overlay for "focus" and must NOT for "component".
  if (declared) return { ...m, defaultState: declared, type: "component", fluidHeight: false };
  // Legacy manifest (no authored field): infer, so new consumers read `defaultState` uniformly.
  const inferred = m.type === "component" || m.fluidHeight === false ? "focus" : "template";
  return { ...m, defaultState: inferred, mode: inferred };
}

/** The definition folder for a ref: the shared home for components/atoms, the ref's
 *  org (or the compat scan) for templates. */
function findFolder(kind: "component" | "template" | "atom", ref: string): { folder: string; org?: string } | null {
  const { org: refOrg, name } = parseRef(ref);
  const lower = name.toLowerCase();
  if (kind === "atom") {
    const folder = join(SHARED_DIR.atom, lower);
    return existsSync(folder) && statSync(folder).isDirectory() ? { folder } : null;
  }
  const dirs =
    kind === "template" ? templateDirs(refOrg) : resolveComponentDirs(componentDirs(refOrg), refOrg, lower);
  for (const { org, dir } of dirs) {
    const folder = join(dir, lower);
    if (existsSync(folder) && statSync(folder).isDirectory()) return { folder, ...(org ? { org } : {}) };
  }
  return null;
}

/** Load one app manifest by `<org>/<id>` (bare id = legacy compat scan). The served
 *  manifest carries its `org` (a projection from the folder location, like `states` —
 *  never hand-written); the app's URI is `unoverse://apps/<org>/<id>`. */
export function loadAppManifest(ref: string): AppManifest | null {
  const hit = findFolder("template", ref);
  if (!hit) return null;
  const path = defPath(hit.folder, "manifest");
  if (!path) return null;
  const m = readDefCached<AppManifest>(path);
  const id = parseRef(ref).name.toLowerCase();
  // `states` is AUTO-DERIVED from the states/ folder — never hand-written in manifest.json —
  // so the SERVED manifest (MCP `resources/read unoverse://apps/{org}/{id}`, discovery) carries
  // the app's layer views with zero drift. The folder stays the source of truth (§7).
  return normalizeMode({ ...m, id, org: hit.org, states: listStates("template", `${hit.org}/${id}`) });
}

/** Load a COMPONENT as a native MCP app (UNOVERSE_MCP_TEMPLATE_PROTOCOL §0.1 path B): a
 *  universal component folder (`rx/components/<id>`) with a `manifest.json` IS a native MCP
 *  app whose deliverable is the component itself — the server registers it right alongside
 *  template apps. No `binding` by default (calling it just renders the component + runs the
 *  `outputs` elicitation); a `binding` MAY be authored to ALSO fire a workflow (optional,
 *  binding-agnostic handler). `previewComponents` defaults to the component's own id so the
 *  app-tool handler resolves ITS `outputs` (the elicitation schema) with no handler change. */
export function loadComponentApp(id: string, org?: string): AppManifest | null {
  const lower = id.toLowerCase();
  // TWO TIERS: marketplace (`rx/components/<id>`) or, with an org, the client's own
  // microapp (`rx/orgs/<org>/components/<id>`) — org in the address, always.
  const home = org ? join(projectDir(org), "components") : SHARED_DIR.component;
  const path = defPath(join(home, lower), "manifest");
  if (!path) return null;
  const m = readDefCached<AppManifest>(path);
  return normalizeMode({
    ...m,
    id: lower,
    // Component manifests carry `title`, not `name` — default it so every consumer
    // (tool registration, referee/mirror text "call <name> again") has a display name.
    name: m.name ?? m.title ?? lower,
    ...(org ? { org } : {}),
    // Default load mode = focus (interactive widgets); author `defaultState` to override.
    defaultState: m.defaultState ?? m.mode ?? "focus",
    // The deliverable IS this component — point the handler's outputs/elicitation lookup
    // at it, by the QUALIFIED ref for an org component: two orgs may share the bare name,
    // and the bare form here took every /mcp initialize down with the resolver's
    // ambiguity error (observed live, bppunoverse 2026-08-20).
    previewComponents: m.previewComponents?.length ? m.previewComponents : [org ? `${org}/${lower}` : lower],
    states: listStates("component", org ? `${org}/${lower}` : lower),
  });
}

/** List MCP apps — every TEMPLATE app (one org's, or all orgs') PLUS every universal
 *  COMPONENT app (a component with a manifest.json). Both are native MCP app tools. */
export function listApps(org?: string): AppManifest[] {
  const out: AppManifest[] = [];
  // PER-ENTRY ISOLATION (same law as listDefinitions): this list is built INSIDE MCP
  // server construction, so one unloadable app taking the walk down means EVERY
  // initialize on every door answers -32603 (observed live: one ambiguous bare ref
  // dropped the whole universe, 2026-08-20). One broken app degrades to a skipped
  // entry with a warning, never a dead platform.
  const push = (load: () => AppManifest | null, label: string) => {
    try {
      const m = load();
      if (m) out.push(m);
    } catch (err) {
      console.warn(`[unoverse] skipping app '${label}' — failed to load: ${(err as Error)?.message ?? err}`);
    }
  };
  for (const { org: o, dir } of templateDirs(org ?? null)) {
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      push(() => loadAppManifest(`${o}/${e.name}`), `${o}/${e.name}`);
    }
  }
  // DESIGN-SYSTEM component apps carry no org — include them whenever we're listing all
  // apps (no org filter), so the MCP server registers them as native app tools.
  if (org == null && existsSync(SHARED_DIR.component)) {
    for (const e of readdirSync(SHARED_DIR.component, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      push(() => loadComponentApp(e.name), e.name);
    }
  }
  // ORG component apps (`rx/orgs/<org>/components/<id>` + manifest.json) — the client's
  // own microapps ARE apps too; without this walk their /mcp tools are never registered
  // and a discovered org component fails with "Tool <id> not found" (observed live:
  // PerfectDay after the two-tier move). Tool id stays the bare component id (names are
  // unique across tiers, lint-enforced); the org rides on the manifest for addressing.
  const orgsToWalk = org != null ? [org] : listOrgs();
  for (const o of orgsToWalk) {
    const dir = join(projectDir(o), "components");
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      push(() => loadComponentApp(e.name, o), `${o}/${e.name}`);
    }
  }
  return out;
}

/** A layer view enumerated from a definition's `states/` folder (UNOVERSE_LAYERS.md §7:
 *  the folder IS the registry). `when` = the state's root `visibleWhen` selector, so a
 *  viewer can both LIST and ACTIVATE it (set the discriminant that shows it). */
export interface StateEntry {
  name: string;
  when?: unknown;
  /** The state root's `select.where` (a reaction-contract surface, STATE_MODEL §5b) —
   *  the viewer activates it by writing `{field: eq}` into a component's slice. */
  where?: unknown;
}

/** The order states are referenced from the root `<name>` definition (its `$include:
 *  "states/…"` sequence — `Switch` cases / children order). The ROOT declares the order;
 *  reorder the includes and the list reorders. Unreferenced states fall to the end. */
function stateOrder(kind: "template" | "component", ref: string): string[] {
  const lower = parseRef(ref).name.toLowerCase();
  const hit = findFolder(kind, ref);
  if (!hit) return [];
  // An EXPLICIT authored order ranks FIRST (v2: the manifest `stateOrder` is the
  // REACTION-state priority ladder — STATE_MODEL §5 rule 5 — and lists only those).
  // States it does not name (the base arrangement's private substates, welcome/
  // conversation) rank AFTER it, in the order the STRUCTURE includes them — the
  // walk below — so the first included substate is the viewer's landing default.
  const explicit: string[] = [];
  const manifestPath = defPath(hit.folder, "manifest");
  if (manifestPath) {
    const m = readDefCached<{ stateOrder?: unknown; states?: Record<string, { states?: Record<string, unknown> } | null>; layout?: string }>(manifestPath);
    // THE TEMPLATE TREE ranks everything by declaration: reaction states (top-level
    // minus the base) in order, then the base's substates in order — welcome first
    // because it is declared first. Supersedes an authored stateOrder.
    if (m?.states && typeof m.states === "object" && !Array.isArray(m.states)) {
      const names = Object.keys(m.states);
      const base = names.includes(m.layout ?? "main") ? (m.layout ?? "main") : names[0];
      return [
        ...names.filter((n) => n !== base),
        ...Object.keys((m.states[base] as { states?: Record<string, unknown> } | null)?.states ?? {}),
      ];
    }
    if (Array.isArray(m?.stateOrder)) explicit.push(...m.stateOrder.filter((n): n is string => typeof n === "string"));
  }
  // The structural walk starts at the envelope when one exists; a MANIFEST-ONLY
  // template (no envelope) starts at its default layout — that is where its
  // states/ are actually included from (via the shared chrome), so the include
  // order still ranks the base's substates (welcome before conversation).
  let rootPath = defPath(hit.folder, lower);
  if (rootPath) {
    const rootDef = readDefCached<{ stateOrder?: unknown }>(rootPath);
    if (!explicit.length && Array.isArray(rootDef?.stateOrder))
      explicit.push(...rootDef.stateOrder.filter((n): n is string => typeof n === "string"));
  } else {
    const dflt = manifestPath ? (readDefCached<{ layout?: string }>(manifestPath).layout ?? "main") : "main";
    rootPath = defPath(join(hit.folder, "layouts"), dflt);
  }
  if (!rootPath) return explicit;
  const order: string[] = [...explicit];
  const seen = new Set<string>();
  const visited = new Set<string>([rootPath]);
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      const inc = (v as { $include?: unknown }).$include;
      if (typeof inc === "string") {
        const m = inc.match(/^states\/(.+)$/);
        if (m && !seen.has(m[1])) (seen.add(m[1]), order.push(m[1]));
        // Follow NON-state includes (e.g. a switcher root's layouts/full) so the
        // authored state order survives the layouts/ restructure — the order must
        // come from where the Switch actually references the states.
        if (!m) {
          const p = defPath(hit.folder, inc);
          if (p && !visited.has(p)) {
            visited.add(p);
            walk(readDefCached(p));
          }
        }
      }
      Object.values(v).forEach(walk);
    }
  };
  walk(readDefCached(rootPath));
  return order;
}

/** Enumerate `<kind>/<name>/states/*` → the layer views (name + selector), ordered by
 *  the root's reference sequence (`stateOrder`); the folder IS the set (§7). Empty if none. */
export function listStates(kind: "template" | "component", ref: string): StateEntry[] {
  const hit = findFolder(kind, ref);
  if (!hit) return [];
  const order = stateOrder(kind, ref);
  const rank = (n: string) => { const i = order.indexOf(n); return i === -1 ? Infinity : i; };
  const dir = join(hit.folder, "states");
  const entries: StateEntry[] = !existsSync(dir)
    ? []
    : readdirSync(dir)
        .filter(isDefFile)
        .map((f) => {
          const j = readDefCached<{ visibleWhen?: unknown; select?: { where?: unknown } }>(join(dir, f));
          return { name: defName(f), when: j?.visibleWhen, where: j?.select?.where };
        });
  // TEMPLATE LAYOUTS (name-sync): each non-default layout of a multi-layout template
  // is a first-class layer view, activated exactly like a reaction surface — put a
  // component into the view of the layout's name. Served with that selector so the
  // Studio's existing preview machinery seeds + activates it with zero special-casing.
  if (kind === "template") {
    const ldir = join(hit.folder, "layouts");
    if (existsSync(ldir)) {
      const names = readdirSync(ldir).filter(isDefFile).map(defName);
      if (names.length > 1) {
        const manifestPath = defPath(hit.folder, "manifest");
        const dflt = (manifestPath ? readDefCached<{ layout?: string }>(manifestPath).layout : undefined) ?? "main";
        for (const n of names)
          if (n !== dflt && !entries.some((e) => e.name === n)) entries.push({ name: n, where: { field: "defaultState", eq: n } });
      }
    }
  }
  // STATE MODEL v2 (UNOVERSE_STATE_MODEL §5 rule 2): a component with an authored
  // `state.view` TREE serves its PUBLIC MENU as first-class states — each activated
  // by the public axis (`view`), in tree order. The tree is the source of truth; this
  // is its projection, exactly like the states/ folder before it.
  if (kind === "component") {
    const rootPath = defPath(hit.folder, parseRef(ref).name.toLowerCase());
    const tree = rootPath
      ? (readDefCached<{ state?: { view?: { states?: Record<string, unknown> } } }>(rootPath)?.state?.view)
      : undefined;
    if (tree && typeof tree === "object" && tree.states && typeof tree.states === "object") {
      for (const n of Object.keys(tree.states))
        if (!entries.some((e) => e.name === n)) entries.push({ name: n, where: { field: "view", eq: n } });
      const treeOrder = Object.keys(tree.states);
      const treeRank = (n: string) => { const i = treeOrder.indexOf(n); return i === -1 ? Infinity : i; };
      return entries.sort((a, b) => treeRank(a.name) - treeRank(b.name) || rank(a.name) - rank(b.name));
    }
  }
  return entries.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/**
 * Templates for the workbench — each enriched with its app `binding` (and app name)
 * when the folder carries a manifest. The workbench uses the binding to drive the live
 * connection (workflow + trigger), so there's no manual entry: the app decides.
 */
export function listTemplatesForWorkbench(org?: string): (UnoverseDefinition & {
  binding?: AppManifest["binding"];
  appName?: string;
  autoTrigger?: boolean;
  previewComponents?: string[];
  fluidHeight?: boolean;
  states?: StateEntry[];
  /** The full MCP-app manifest when the template folder carries one — so the workbench
   *  can show the app's meta (description, category, version, binding, expose, schema). */
  app?: AppManifest;
})[] {
  return listDefinitions("template", org)
    .map((def) => {
      const ref = `${def.org}/${def.name}`; // folder id = lowercased template name, org-scoped
      const app = loadAppManifest(ref);
      const states = listStates("template", ref);
      return app
        ? { ...def, states, binding: app.binding, appName: app.name, autoTrigger: app.autoTrigger, previewComponents: app.previewComponents, fluidHeight: app.fluidHeight, app }
        : { ...def, states };
    })
    // Templates view shows only apps that ARE surfaces (manifest defaultState
    // "template", or a plain layout with no manifest). Component apps (focus /
    // component / any non-template name) are wizards etc. whose UI is their
    // COMPONENT — designed in the Components view; their app shell is vestigial
    // under the reaction contract (STATE_MODEL §5b). They stay fully served for
    // discovery/launch (resources/list, /registry/spatial) — just not listed here.
    .filter((def) => !("app" in def) || def.app?.type === "template");
}
