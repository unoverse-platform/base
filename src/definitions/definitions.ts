/**
 * Unoverse definition store (v0: flat JSON files under apps/unoverse/rx/{components,templates}).
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
import { NODES_HOME, PLUGINS_DIR, RX_HOME, INSTALLED_HOME, databaseOnly } from "../paths.js";

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
const RX = RX_HOME;
const ORGS_ROOT = join(RX, "orgs");

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
const INSTALLED_RX = join(INSTALLED_HOME, "rx");

/** The shared homes for the universal kinds — the marketplace.
 *
 * The marketplace ships as an INSTALLED package (@unoverse-platform/marketplace),
 * which bundles its definitions/{components,atoms,styles}. Resolve each shared dir from
 * the on-disk rx/marketplace (monorepo dev) if present, ELSE from the installed package
 * bundle — the home node, then the plugins install. So the platform renders marketplace
 * components/atoms with NO rx/marketplace/ source on disk (the marketplace-installed,
 * pushable-update model). Mirrors theme.ts's styles fallback. Getters resolve LAZILY so a
 * package installed at boot (CORE_PACKAGES self-heal) is picked up on first use. */
const MARKETPLACE = join(RX, "marketplace");
const DS_BUNDLE_CANDIDATES = [
  join(NODES_HOME, "marketplace", "definitions"),
  join(PLUGINS_DIR, "node_modules", "@unoverse-platform", "marketplace", "definitions"),
];
function marketplaceDir(kind: "components" | "atoms"): string {
  const onDisk = join(MARKETPLACE, kind);
  // Under the switch the authored tiers are skipped, so what a deployed universe would
  // resolve is what a developer resolves.
  if (databaseOnly()) {
    const installed = join(INSTALLED_RX, "marketplace", kind);
    return existsSync(installed) ? installed : onDisk;
  }
  if (existsSync(onDisk)) return onDisk;
  for (const base of DS_BUNDLE_CANDIDATES) {
    const p = join(base, kind);
    if (existsSync(p)) return p;
  }
  // Last: what this universe was PUBLISHED. A deployed universe holds no rx and no
  // bundle, so this is where its design system actually lives.
  const installed = join(INSTALLED_RX, "marketplace", kind);
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
const RESERVED_RX = new Set(["marketplace", "_schema"]);

/** A project's on-disk home. During the flatten migration a project can live either FLAT
 *  at the rx root (`rx/<name>` — the target) or under the legacy `rx/orgs/<name>`. Flat
 *  wins. A project folder carries at least one of styles/templates/components. */
export function projectDir(name: string): string {
  const installedProject = join(INSTALLED_RX, name);
  if (databaseOnly()) return installedProject;
  const flat = join(RX, name);
  if (existsSync(flat)) return flat;
  const legacy = join(ORGS_ROOT, name);
  if (existsSync(legacy)) return legacy;
  // Published, not authored here. Checked after both on-disk homes so a project being
  // edited in the monorepo is never shadowed by the database's copy of it.
  const installed = join(INSTALLED_RX, name);
  return existsSync(installed) ? installed : legacy;
}

/** The client projects, sorted: flat at the rx root (the target) PLUS any still under the
 *  legacy `rx/orgs/` (mid-migration). Excludes the marketplace, schema, and orgs/ folder.
 *  A flat candidate must look like a project (styles/templates/components) so a stray dir
 *  isn't mistaken for one. */
export function listOrgs(): string[] {
  const isProject = (dir: string) =>
    existsSync(join(dir, "styles")) || existsSync(join(dir, "templates")) || existsSync(join(dir, "components"));
  const flat = existsSync(RX) && !databaseOnly()
    ? readdirSync(RX, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !RESERVED_RX.has(e.name) && isProject(join(RX, e.name)))
        .map((e) => e.name)
    : [];
  const legacy = existsSync(ORGS_ROOT) && !databaseOnly()
    ? readdirSync(ORGS_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  // Projects this universe was PUBLISHED but does not author. On a deployed universe
  // these are the only ones there are. A name in both is listed once, and `projectDir`
  // decides which home wins — on disk, every time.
  const installed = existsSync(INSTALLED_RX)
    ? readdirSync(INSTALLED_RX, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !RESERVED_RX.has(e.name) && isProject(join(INSTALLED_RX, e.name)))
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
 *  UNIQUE across all tiers (lint-enforced), so a bare ref is unambiguous: the shared
 *  home first, then every org's. An org-prefixed ref searches its org first (shared
 *  last, as compat for prefixed refs to universal names). */
function componentDirs(refOrg: string | null): { org: string | undefined; dir: string }[] {
  const shared = { org: undefined as string | undefined, dir: SHARED_DIR.component };
  const orgDirs = (refOrg === null ? listOrgs() : [refOrg])
    .filter((o) => existsSync(join(projectDir(o), "components")))
    .map((o) => ({ org: o as string | undefined, dir: join(projectDir(o), "components") }));
  return refOrg === null ? [shared, ...orgDirs] : [...orgDirs, shared];
}

/** Resolve a component id (either tier) to its ON-DISK FOLDER — the home of its
 *  manifest and any lifecycle handler files (onstart.js …). Names are unique across
 *  tiers, so the bare id is unambiguous. Returns null for a flat/marketplace component
 *  with no folder. Used by the MCP render path to run component lifecycle handlers. */
export function componentFolder(ref: string): string | null {
  const lower = ref.toLowerCase();
  for (const { dir } of componentDirs(null)) {
    const folder = join(dir, lower);
    if (defPath(folder, "manifest") || defPath(folder, lower)) return folder;
  }
  return null;
}

export interface UnoverseDefinition {
  unoverse: string;
  kind: "component" | "template" | "atom";
  name: string;
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
  if (node.bind) for (const k of Object.keys(node.bind)) if (propMap[node.bind[k]]) node.bind[k] = propMap[node.bind[k]];
  if (typeof node.visibleWhen === "string" && propMap[node.visibleWhen]) node.visibleWhen = propMap[node.visibleWhen];
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

export function expandNode(node: AnyNode): AnyNode {
  if (node?.type === "Ref") {
    // A Ref inlines an ATOM (the usual case, rx/atoms). It also resolves a marketplace
    // COMPONENT as a fallback, so a template can embed a shared flat component (e.g. the
    // ComposerBar chrome) the same way it embeds an atom — the one mechanism for fixed,
    // always-present chrome. (A component's root is inlined as-is; flat components only.)
    const atom = loadDefinition(String(node.ref), "atom") ?? loadDefinition(String(node.ref), "component");
    if (!atom?.root) return node; // unknown ref — leave the Ref (renders as a no-op)
    const root = JSON.parse(JSON.stringify(atom.root)) as AnyNode;
    remapFields(root, (node.props ?? {}) as Record<string, string>);
    if (node.with && typeof node.with === "object") applyLiterals(root, node.with as Record<string, unknown>);
    if (node.visibleWhen) root.visibleWhen = node.visibleWhen;
    // A Ref may override the atom's `action` — the per-host behaviour the atom can't carry
    // (e.g. each wizard step's option sets different fields). Parallel to style/visibleWhen.
    if (node.action) root.action = node.action;
    if (node.style) root.style = { ...(root.style ?? {}), ...node.style };
    return expandNode(root); // expand nested refs too
  }
  if (Array.isArray(node?.children)) node.children = node.children.map(expandNode);
  // `Each` carries a per-item subtree in `template` (not `children`) — expand it too,
  // so an atom `Ref` inside a repeated item is inlined like anywhere else.
  if (node?.template) node.template = expandNode(node.template);
  // `Switch` carries its branches in `cases` (a value→subtree map) — expand each, so an
  // atom `Ref` inside a Switch branch is inlined like anywhere else (else the branch
  // renders blank). Parallel to children/template.
  if (node?.cases && typeof node.cases === "object") {
    for (const k of Object.keys(node.cases)) node.cases[k] = expandNode(node.cases[k] as AnyNode);
  }
  // `ComponentSlot` carries chrome in `frame` (born when the slot matches) and `fallback`
  // (shown when it doesn't) — both are real child slots, so an atom `Ref` inside them (e.g. a
  // ✕ CloseButton on a rail/panel frame) must inline like anywhere else, else the Ref survives.
  if (node?.frame) node.frame = expandNode(node.frame as AnyNode);
  if (node?.fallback) node.fallback = expandNode(node.fallback as AnyNode);
  return node;
}

function expandRefs(def: UnoverseDefinition): UnoverseDefinition {
  if (def?.root) def.root = expandNode(def.root as AnyNode);
  return def;
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
export function loadDefinition(ref: string, kind?: "component" | "template" | "atom"): UnoverseDefinition | null {
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
      : k === "component" ? componentDirs(refOrg)
      : [{ org: undefined as string | undefined, dir: SHARED_DIR[k] }];
    for (const { org, dir } of dirs) {
      // Flat form: <name>.{yaml,json}. The cached parse is SHARED — clone before expanding
      // (expandRefs/composeIncludes mutate `root` in place); atoms are returned as-is
      // (their consumers only read + clone the subtree).
      const path = defPath(dir, lower);
      if (path) {
        const raw = readDefCached<UnoverseDefinition>(path);
        if (k === "atom") return raw;
        const sig = `${path}:${statSync(path).mtimeMs};${dirSignature([SHARED_DIR.atom, SHARED_DIR.component])}`;
        return cachedBySignature(`def:${k}:${org ?? ""}:${lower}`, sig, () => ({ ...expandRefs(structuredClone(raw)), ...(org ? { org } : {}) }));
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
        return cachedBySignature(`def:${k}:${org ?? ""}:${lower}`, sig, () => {
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
          return k === "atom" ? def : expandRefs(def);
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
          out.push(o ? { ...raw, org: o } : raw);
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
  /** The org's DEFAULT app — the front door of its `/mcp/{org}` endpoint. Exactly one app per
   *  org sets this; the endpoint marks its tool as the entry point (`_meta["unoverse/default"]`)
   *  so a host opens it first as the conversation's home. Absent/false = an ordinary app in the
   *  org, reached by name or discovery. Replaces the legacy per-app `expose` flag. */
  default?: boolean;
  /** Render lifetime (docs/design/04 §Two lifetimes). Default "turn": the instance returns
   *  to inline/retires on the next user turn (the universal reset). "conversation" = a
   *  DURABLE conversation-scoped surface (a cart, an itinerary, a composed page): keyed by
   *  the CONVERSATION (not the turn) so every re-call hydrates the same slice, and the
   *  client's new-turn reset skips it — it stays on screen until replaced or closed. */
  lifetime?: "turn" | "conversation";
  /** Workbench MOCK: what each STATE's preview seeds — `{ "<state>": ["coursecard",
   *  "coursecard"] }` (a repeated name = several instances, e.g. a card rail). The
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
  const dirs = kind === "template" ? templateDirs(refOrg) : componentDirs(refOrg);
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
    // The deliverable IS this component — point the handler's outputs/elicitation lookup at it.
    previewComponents: m.previewComponents?.length ? m.previewComponents : [lower],
    states: listStates("component", lower),
  });
}

/** List MCP apps — every TEMPLATE app (one org's, or all orgs') PLUS every universal
 *  COMPONENT app (a component with a manifest.json). Both are native MCP app tools. */
export function listApps(org?: string): AppManifest[] {
  const out: AppManifest[] = [];
  for (const { org: o, dir } of templateDirs(org ?? null)) {
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const m = loadAppManifest(`${o}/${e.name}`);
      if (m) out.push(m);
    }
  }
  // DESIGN-SYSTEM component apps carry no org — include them whenever we're listing all
  // apps (no org filter), so the MCP server registers them as native app tools.
  if (org == null && existsSync(SHARED_DIR.component)) {
    for (const e of readdirSync(SHARED_DIR.component, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const m = loadComponentApp(e.name);
      if (m) out.push(m);
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
      const m = loadComponentApp(e.name, o);
      if (m) out.push(m);
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
  // An EXPLICIT authored order wins (first = the default the viewer lands on).
  // A manifest-only template has no envelope, so the manifest is the home for it —
  // `stateOrder: [...]` there ranks the states/ folder just like an envelope would.
  const manifestPath = defPath(hit.folder, "manifest");
  if (manifestPath) {
    const m = readDefCached<{ stateOrder?: unknown }>(manifestPath);
    if (Array.isArray(m?.stateOrder)) return m.stateOrder.filter((n): n is string => typeof n === "string");
  }
  const rootPath = defPath(hit.folder, lower);
  if (!rootPath) return [];
  // Else the envelope: an explicit `stateOrder: [...]`, or derive from where the
  // Switch references the states ($include order, following layout includes).
  const rootDef = readDefCached<{ stateOrder?: unknown }>(rootPath);
  if (Array.isArray(rootDef?.stateOrder)) return rootDef.stateOrder.filter((n): n is string => typeof n === "string");
  const order: string[] = [];
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
