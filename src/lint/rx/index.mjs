/**
 * The rx definitions linter, as a LIBRARY. Rules in, findings out.
 *
 * Sibling of ../nodes/ and deliberately SEPARATE: this one knows the closed primitive set,
 * the closed style vocabulary, token-only values and Switch discriminants. Merging the two
 * would give one linter that is worse at both.
 *
 * DEPENDENCY-FREE, still: JSON and YAML frontmatter are parsed by hand rather than pulling
 * `yaml` in. Worth keeping now that it sits beside a package that does have dependencies.
 *
 * THE WHOLE BODY IS INSIDE `lintDefinitions`, on purpose. It was a script whose top-level
 * constants derived from the rx root, and two bare blocks that RAN RULES at import time.
 * As a library that is wrong twice: findings would accumulate between runs, and rules would
 * fire before anyone asked. Function scope makes both impossible rather than merely unlikely.
 *
 * Callers: `unoverse lint` (a thin formatter), Studio, POST /publish, CI.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, basename, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { DEF_EXTS, isDefFile, defName, defPath, parseDef, readDef } from "./defs.mjs";
import { PRIMITIVES, CONDITION_KEYS, STYLE_KEYS, RAW_VALUE, CHILD_NODE_KEYS, PARTIAL_DIRS, DIMENSION_KEYS } from "./vocabulary.mjs";
import { makeWalkNode } from "./walk.mjs";
import { makeLintFile } from "./file.mjs";

/**
 * Lint every definition under `rxHome`. Prints nothing, exits nothing.
 * A missing rx folder is REPORTED rather than thrown, so callers get one shape of answer.
 */
export function lintDefinitions(rxHome) {
  const candidates = rxHome ? [resolve(rxHome)] : [resolve("apps/unoverse/rx"), resolve("rx")];
  const RX = candidates.find(
    (p) => existsSync(join(p, "marketplace")) || existsSync(join(p, "components")) || existsSync(join(p, "atoms")),
  );
  if (!RX)
    return {
      problems: [{ level: "error", file: candidates[0], msg: `no rx/ folder here (looked in: ${candidates.join(", ")})` }],
      homes: [],
    };

// ── tree layout ──
// New layout: rx/marketplace/{atoms,components,styles} + one top-level folder per
// org (rx/<org>/). Legacy layout: components/ + atoms/ at the root, orgs under rx/orgs/.
// The DESIGN SYSTEM is the primary lint target; org folders get the SAME generic
// checks — nothing here may key on a specific org's name.
// WHERE THE DESIGN SYSTEM ACTUALLY IS. `rx/marketplace/` exists in this monorepo and is
  // deliberately absent from a developer's project (sync-starter.sh): the platform installs
  // @unoverse-platform/marketplace, whose `definitions/` bundle carries components, atoms
  // AND styles (bundle-defs.mjs). All three matter — the space-scale check reads
  // styles/base/spacing, so a fallback finding only components would build a PARTIAL scale
  // and reject valid steps, reporting false errors on correct work. Mirrors definitions.ts.
  const DS = (() => {
    const onDisk = join(RX, "marketplace");
    if (existsSync(onDisk)) return onDisk;
    const nodesHome = resolve(RX, "..", "nodes");
    for (const c of [
      join(nodesHome, "marketplace", "definitions"),
      join(resolve(RX, "..", "plugins"), "node_modules", "@unoverse-platform", "marketplace", "definitions"),
    ])
      if (existsSync(c)) return c;
    return RX; // none anywhere: shared refs will not resolve, and the findings will say so
  })();
const legacyOrgsDir = join(RX, "orgs");
const orgDirs = (() => {
  if (existsSync(legacyOrgsDir))
    return readdirSync(legacyOrgsDir)
      .filter((e) => !e.startsWith("."))
      .map((e) => join(legacyOrgsDir, e))
      .filter((d) => statSync(d).isDirectory());
  if (DS === RX) return [];
  return readdirSync(RX)
    .filter((e) => !e.startsWith(".") && e !== "marketplace" && e !== "_schema")
    .map((e) => join(RX, e))
    .filter((d) => statSync(d).isDirectory());
})();

const problems = [];
const seen = new Set();
const report = (level, file, msg, line) => {
  const rel = relative(process.cwd(), file);
  const key = `${level}|${rel}|${line ?? ""}|${msg}`;
  if (seen.has(key)) return;
  seen.add(key);
  problems.push({ level, file: rel, line, msg });
};

// ── helpers ──
function jsonFiles(dir) {
  let out = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (f.startsWith(".")) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out = out.concat(jsonFiles(p));
    else if (isDefFile(f)) out.push(p);
  }
  return out;
}
const isFixture = (f) => /\.states\.(json|yaml)$/.test(f);
const isManifest = (f) => /^manifest\.(json|yaml)$/.test(basename(f));
const isTemplatePath = (f) => f.includes(`${sep}templates${sep}`);
// The DEFINITION ROOT folder for a file: a bare partial lives one level under it
// (layouts/ states/ components/ blocks/); every `$include` resolves against it.
const defRoot = (file) => {
  const dir = dirname(file);
  return PARTIAL_DIRS.has(basename(dir)) ? dirname(dir) : dir;
};

// The space scale — a bare numeric dimension value MUST be a real step, or the
// renderer passes it through as broken CSS and the element auto-sizes silently.
const spaceSteps = new Set(["0", "full", "auto"]);
{
  const styleRoots = [defPath(join(DS, "styles", "base"), "spacing"), ...orgDirs.map((d) => defPath(join(d, "styles", "base"), "spacing"))].filter(Boolean);
  for (const f of styleRoots) {
    if (!existsSync(f)) continue;
    try {
      const space = readDef(f).space ?? {};
      for (const k of Object.keys(space)) if (!k.startsWith("$")) spaceSteps.add(k);
    } catch { /* linted on its own */ }
  }
}
const stepList = () => [...spaceSteps].filter((s) => /^\d/.test(s)).sort((a, b) => Number(a) - Number(b)).join(", ");
const checkDimension = (file, where, key, v) => {
  for (const raw of Array.isArray(v) ? v : [v]) {
    // A NUMBER is held to the same law as a numeric string — raw JSON numbers
    // (`"maxWidth": 560`) must not smuggle pixel values past the scale.
    const val = typeof raw === "number" ? String(raw) : raw;
    if (typeof val !== "string" || val.includes("{{")) continue;
    if (/^\d+(\.\d+)?$/.test(val) && spaceSteps.size > 3 && !spaceSteps.has(val))
      report("error", file, `${where}.${key}: "${val}" is not a step on the space scale. Invalid values fall through as broken CSS (auto sizing). Real steps: ${stepList()} (docs/design/06)`);
  }
};

// atoms — case-insensitive by filename (the platform's lookup rule)
const atomsDirExists = existsSync(join(DS, "atoms"));
const atomNames = new Set(
  (atomsDirExists ? readdirSync(join(DS, "atoms")) : [])
    .filter(isDefFile)
    .map((f) => defName(f).toLowerCase()),
);

// A Ref resolves an atom OR a marketplace component (shared flat chrome like
// ComposerBar). Component folders are named by their id — collect them so a
// Ref to a shared component isn't flagged as a missing atom.
const dsComponentsDir = join(DS, "components");
const dsComponentNames = new Set(
  (existsSync(dsComponentsDir) ? readdirSync(dsComponentsDir, { withFileTypes: true }) : [])
    .filter((e) => !e.name.startsWith("."))
    .map((e) => (e.isDirectory() ? e.name : defName(e.name)).toLowerCase()),
);
// A valid Ref target if there's ANY resolvable home (atoms OR DS components).
const refResolves = (ref) => atomNames.has(ref.toLowerCase()) || dsComponentNames.has(ref.toLowerCase());

// definition homes: marketplace components/atoms + each org's templates AND
// components (same law everywhere — an org component is a component, just org-private)
const homes = [{ dir: join(DS, "components") }, { dir: join(DS, "atoms") }];
for (const orgDir of orgDirs) {
  for (const sub of ["templates", "components"]) {
    const d = join(orgDir, sub);
    if (existsSync(d) && statSync(d).isDirectory()) homes.push({ dir: d });
  }
}

// ── component-name uniqueness across tiers (the no-shadowing law) ──
// Names are the addressing contract: a bare `unoverse://components/<name>` must be
// unambiguous, so ONE name may exist in exactly one home (marketplace OR one org).
{
  const seenNames = new Map(); // lower-name -> first home path
  const componentHomes = [join(DS, "components")];
  for (const orgDir of orgDirs) {
    const d = join(orgDir, "components");
    if (existsSync(d) && statSync(d).isDirectory()) componentHomes.push(d);
  }
  for (const home of componentHomes) {
    if (!existsSync(home)) continue;
    for (const e of readdirSync(home)) {
      if (e.startsWith(".")) continue;
      const p = join(home, e);
      const name = (statSync(p).isDirectory() ? e : isDefFile(e) ? defName(e) : null)?.toLowerCase();
      if (!name) continue;
      const first = seenNames.get(name);
      if (first)
        report("error", p, `component name "${name}" already exists at ${relative(RX, first)}. Names are UNIQUE across the marketplace and every org (no shadowing); rename one`);
      else seenNames.set(name, p);
    }
  }
}

// ── one DEFAULT app per org (the /mcp/<org> front door) ──
// Exactly one app is an org's home; a host opens the app whose manifest sets `default: true`
// as the conversation's entry point. Two defaults = ambiguous front door → error.
for (const orgDir of orgDirs) {
    const tdir = join(orgDir, "templates");
    if (!(existsSync(tdir) && statSync(tdir).isDirectory())) continue;
    const defaults = [];
    for (const e of readdirSync(tdir)) {
      const mf = defPath(join(tdir, e), "manifest");
      if (!existsSync(mf)) continue;
      try {
        if (readDef(mf).default === true) defaults.push(mf);
      } catch {
        /* malformed manifest is reported elsewhere */
      }
    }
    if (defaults.length > 1)
      for (const mf of defaults)
        report(
          "error",
          mf,
          `org "${org}" has ${defaults.length} apps with "default": true. An org has exactly ONE default app (its /mcp/${org} front door). Keep it on one manifest, remove it from the others (docs/unoverse/UNOVERSE_MCP_TEMPLATE_PROTOCOL.md §4b)`,
        );
  }

// ── condition (visibleWhen / style.when entry) ──
function checkCondition(vw, file, where) {
  if (typeof vw === "string") return; // bare truthy field
  if (vw && typeof vw === "object" && !Array.isArray(vw)) {
    if (typeof vw.field !== "string")
      report("error", file, `${where}: condition needs a "field" (docs/design/04)`);
    const extra = Object.keys(vw).filter((k) => !CONDITION_KEYS.has(k));
    if (extra.length)
      report("error", file, `${where}: illegal condition key(s) ${extra.join(", ")}. Only eq/ne/in/truthy exist; no and/or/arithmetic (derive in the node) (docs/design/03)`);
    return;
  }
  report("error", file, `${where}: visibleWhen must be a field name or { field, eq|ne|in } (docs/design/04)`);
}

// ── per-node structural walk ──
// `widthCap` = the tightest numeric maxWidth on this node's ancestor chain (space
// steps are monotonic, so step names compare numerically).
// The STANDARD APP SIZES the `appWidth` names may reference. An org's own
// styles/semantic/app-sizes wins; absent, the org INHERITS the marketplace set
// (new-org copies themes only — base+semantic are inherited). null = the file is
// under no sized tree at all. The old version matched only the LEGACY orgs/ path,
// so on the flat layout it returned null and the whole appWidth check silently
// skipped — which is how an unresolvable token shipped and cost a day (§9.10).
const appSizesCache = new Map();
function readAppSizes(dir) {
  const p = defPath(join(dir, "styles", "semantic"), "app-sizes");
  if (!p || !existsSync(p)) return null;
  try {
    const sizes = {};
    for (const [k, v] of Object.entries(readDef(p).appSize ?? {})) sizes[k] = typeof v === "string" ? v : v?.$value;
    return sizes;
  } catch {
    return null; // the file lints separately
  }
}
function appSizesForFile(file) {
  const home = orgDirs.find((d) => file.startsWith(d + sep)) ?? (file.startsWith(DS + sep) ? DS : null);
  if (!home) return null;
  // INHERITANCE, not replacement: an org's own set OVERRIDES the marketplace's
  // name-by-name (bpp redefines `chat` and adds `flex`; `rail`/`panel` stay inherited).
  if (!appSizesCache.has(home)) appSizesCache.set(home, { ...(readAppSizes(DS) ?? {}), ...(readAppSizes(home) ?? {}) });
  return appSizesCache.get(home);
}

// The universal component names (rx/components/*, case-insensitive) — for validating a
// template manifest's `preview` map. null = the file is not under an rx tree.
const componentNamesCache = new Map();
// Components an ORG's template may reference: the marketplace tier + that org's OWN
// components — never another org's (org-privacy). Cached per org.
function componentNamesForFile(file) {
  const m = file.split(`${sep}orgs${sep}`);
  if (m.length < 2) return null;
  const org = m[1].split(sep)[0];
  const cached = componentNamesCache.get(org);
  if (cached !== undefined) return cached;
  const dirs = [join(m[0], "components"), join(m[0], "orgs", org, "components")];
  let names = null;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    names ??= new Set();
    for (const e of readdirSync(dir)) names.add(defName(e).toLowerCase());
  }
  componentNamesCache.set(org, names);
  return names;
}


  // The run context: everything the extracted rule modules close over. Built here so it
  // cannot outlive the run, and passed once rather than threaded as ten parameters.
  const ctx = {
    RX, DS, orgDirs, report, spaceSteps, stepList, checkDimension, checkCondition,
    appSizesForFile, componentNamesForFile, refResolves, atomsDirExists,
    isFixture, isManifest, isTemplatePath, defRoot,
  };
  const walkNode = makeWalkNode(ctx);
  const lintFile = makeLintFile({ ...ctx, walkNode });

  for (const home of homes) for (const f of jsonFiles(home.dir)) lintFile(f);
  return { problems, homes, rxHome: RX, designSystem: DS };
}

/** True when anything would fail a build. Warnings and hints inform, errors stop. */
export function hasErrors(result) {
  return result.problems.some((p) => p.level === "error");
}
