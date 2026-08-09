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
import { PRIMITIVES, CONDITION_KEYS, STYLE_KEYS, RAW_VALUE, CHILD_NODE_KEYS, PARTIAL_DIRS, DIMENSION_KEYS, DIMENSION_LITERALS, TOKEN_KEYS, LITERAL_VALUES } from "./vocabulary.mjs";
import { makeWalkNode } from "./walk.mjs";
import { makeLintFile } from "./file.mjs";
import { makeTokensForFile } from "./tokens.mjs";

/**
 * Lint every definition under `rxHome`. Prints nothing, exits nothing.
 * A missing rx folder is REPORTED rather than thrown, so callers get one shape of answer.
 *
 * `options.overlay` maps an absolute path to text that STANDS IN for what is on disk.
 * Studio's editor lints what the developer has typed before it is saved, and the only
 * honest way to do that is to run THESE rules over it. Without the overlay an editor has
 * to approximate the rules, which is a second linter, which is the thing this module's
 * existence rules out. Sibling files are still read from disk: only the file being edited
 * is substituted.
 */
export function lintDefinitions(rxHome, options = {}) {
  const overlay = {};
  for (const [k, v] of Object.entries(options.overlay ?? {})) overlay[resolve(k)] = v;
  const readText = (f) => {
    const hit = overlay[resolve(f)];
    return hit === undefined ? readFileSync(f, "utf8") : hit;
  };
  const candidates = rxHome ? [resolve(rxHome)] : [resolve("apps/unoverse/rx"), resolve("rx")];

  /** The monorepo's shapes: the design system at `rx/marketplace/`, or the legacy one
   *  with `components/` and `atoms/` loose at the root. */
  const holdsDesignSystem = (p) =>
    existsSync(join(p, "marketplace")) || existsSync(join(p, "components")) || existsSync(join(p, "atoms"));

  /**
   * A DEVELOPER'S rx/ HOLDS ONLY ORG FOLDERS, and looking for the monorepo's shapes there
   * finds nothing. `rx/<org>/{components,styles,templates}` is what Studio scaffolds and
   * the only layout a developer ever has, because the design system is INSTALLED rather
   * than authored (sync-starter.sh keeps `rx/marketplace` out of a project on purpose).
   *
   * So a project could not be linted, and since publishing lints first, it could not be
   * published either: "no rx/ folder here", naming the rx/ folder it was standing in.
   */
  const holdsOrgs = (p) => {
    if (!existsSync(p)) return false;
    return readdirSync(p)
      .filter((e) => !e.startsWith("."))
      .map((e) => join(p, e))
      .some((d) => {
        try {
          return (
            statSync(d).isDirectory() &&
            ["components", "atoms", "styles", "templates"].some((s) => existsSync(join(d, s)))
          );
        } catch {
          return false;
        }
      });
  };

  const RX = candidates.find((p) => holdsDesignSystem(p) || holdsOrgs(p));
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
  // THE LEGACY LAYOUT, where the design system IS the root: `components/` and `atoms/`
  // sit directly in rx/, so listing children here would lint "components" as an org.
  //
  // NOT `DS === RX`, which was the same test until the design system stopped being
  // guaranteed. DS falls back to RX when no design system is found ANYWHERE, which is the
  // ordinary state of a developer's project — so that test read "this is the legacy
  // layout" and returned no orgs, silently linting nothing at all.
  if (existsSync(join(RX, "components")) || existsSync(join(RX, "atoms"))) return [];
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
// A LIFECYCLE HOOK, not a UI definition: `onstart.yaml` beside a component declares the
// calls that fill it. It is checked by the lifecycle rules below and by the node call
// rules at run time, never by the primitive/token laws that govern a rendered tree.
// A LIFECYCLE HOOK file, not a UI definition: it declares the calls that fill a component
// and is named for its HANDLER. Recognised by a sibling manifest naming it.
const isHook = (f) => {
  const dir = dirname(f);
  const mf = defPath(dir, "manifest");
  if (!mf || !existsSync(mf)) return false;
  let life;
  try { life = readDef(mf).lifecycle; } catch { return false; }
  if (!Array.isArray(life)) return false;
  const stem = basename(f).replace(/\.(json|ya?ml)$/, "").toLowerCase();
  return life.some((e) => typeof e === "object" && e && typeof e.handler === "string" && e.handler.toLowerCase() === stem);
};
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
/**
 * step → the PAGE-WIDTH name that aliases it (`"160" → "reading"`), from semantic/layout.
 *
 * This is what makes the rule below safe. `maxWidth` is honestly two things: a PAGE
 * container's cap and an ELEMENT's own cap (a card at `"90"`), so it cannot be required to
 * carry a name outright without rejecting the second. But a step that HAS an alias has
 * exactly one correct spelling, and that is the whole of the rule: not "name your widths",
 * but "one value, one name". Steps with no alias are left alone, and adding an alias to
 * `semantic/layout` extends the rule by itself.
 */
const layoutAlias = new Map();
{
  /**
   * BOTH TIERS. The scale is numeric in `base/spacing` and NAMED in `semantic/spacing`
   * ("md" → {space.4}), and the server reads both into one `space` bucket (theme.ts
   * `readTokenDir` over base THEN semantic). Reading only `base` here meant the linter
   * held a scale the renderer does not have: every t-shirt name was invisible to it, so
   * the "Real steps:" list it printed omitted the names most definitions actually use,
   * and an org that defined a numeric step in `semantic/` would have had correct work
   * rejected. Same class of mistake as a partial app-size set — judge with the whole
   * answer or not at all.
   */
  const spacingFiles = [DS, ...orgDirs].flatMap((d) => [
    [defPath(join(d, "styles", "base"), "spacing"), "space"],
    [defPath(join(d, "styles", "semantic"), "spacing"), "space"],
    // PAGE WIDTHS by name (semantic/layout) are aliases onto this same scale, and `dim()`
    // resolves them alongside it — so to the dimension check they ARE steps.
    [defPath(join(d, "styles", "semantic"), "layout"), "layout"],
  ]);
  for (const [f, key] of spacingFiles) {
    if (!f || !existsSync(f)) continue;
    try {
      const scale = readDef(f)[key] ?? {};
      for (const [k, v] of Object.entries(scale)) {
        if (k.startsWith("$")) continue;
        spaceSteps.add(k);
        // A layout name is an ALIAS onto a step (`reading` → `{space.160}`). Remember which
        // step it covers, so the rule below can name the alias in its message and, more
        // importantly, so it fires ONLY where an alias actually exists.
        if (key === "layout") {
          const step = /^\{space\.([^}]+)\}$/.exec(String(v?.$value ?? ""))?.[1];
          if (step && !layoutAlias.has(step)) layoutAlias.set(step, k);
        }
      }
    } catch { /* linted on its own */ }
  }
}
/**
 * KEYFRAME DECLS ARE KEBAB-CASE — one spelling, every renderer.
 *
 * A keyframe's declaration keys are real CSS property names, and the two serializers
 * treated their casing differently: Studio's gallery kebab-cased them, the SDK emitted
 * them verbatim. Today's keyframes only use single-word props (`transform`, `opacity`) so
 * nobody noticed — but a `boxShadow` would have PLAYED in Studio and silently done nothing
 * in the app. Both serializers now normalize, and this rule keeps the DATA canonical
 * anyway: these files are the contract every future renderer (Flutter, RN, iOS) parses,
 * and one value gets one spelling — the same law the space scale already enforces.
 */
for (const home of [DS, ...orgDirs]) {
  const f = defPath(join(home, "styles", "semantic"), "keyframes");
  if (!f || !existsSync(f)) continue;
  let kf;
  try {
    // Through `readText`, not straight off disk — Studio lints the file being TYPED
    // via the overlay, and a rule that bypasses it judges stale content (see options.overlay).
    kf = parseDef(readText(f), f).keyframes ?? {};
  } catch {
    continue; /* a malformed file lints on its own */
  }
  for (const [name, entry] of Object.entries(kf)) {
    if (name.startsWith("$")) continue;
    for (const [stop, decls] of Object.entries(entry?.$value ?? {})) {
      if (!decls || typeof decls !== "object") continue;
      for (const prop of Object.keys(decls))
        if (/[A-Z_]/.test(prop))
          report(
            "error",
            f,
            `keyframes.${name}.${stop}: "${prop}" — keyframe declarations use kebab-case CSS property names ("${prop.replace(/_/g, "-").replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}"). The keyframe files are the one animation contract every renderer parses; one value, one spelling`,
          );
    }
  }
}

const stepList = () => {
  const all = [...spaceSteps];
  const nums = all.filter((s) => /^\d/.test(s)).sort((a, b) => Number(a) - Number(b));
  const named = all.filter((s) => !/^\d/.test(s)).sort();
  return [...nums, ...named].join(", ");
};
/**
 * A DIMENSION IS A SCALE STEP — numeric ("8") or named ("md"), both live in the same
 * `space` bucket. The named half went unchecked, so `gap: mdd` resolved to nothing and
 * CSS dropped the declaration: the gap silently became zero with a green lint run behind
 * it. Same failure as an invented radius, one bucket over.
 */
/**
 * PAGE-LEVEL keys: a container's cap and the responsive thresholds. These are the places a
 * width is a PAGE decision rather than an element's own size, so these are where the named
 * scale belongs (`maxWidth: reading`, not `"160"`). See `layoutAlias` for why the rule is
 * keyed on the alias existing rather than on the key alone.
 */
const PAGE_WIDTH_KEYS = new Set(["maxWidth", "hideBelow", "hideAbove", "stackBelow"]);

const checkDimension = (file, where, key, v) => {
  for (const raw of Array.isArray(v) ? v : [v]) {
    // A NUMBER is held to the same law as a numeric string — raw JSON numbers
    // (`"maxWidth": 560`) must not smuggle pixel values past the scale.
    const val = typeof raw === "number" ? String(raw) : raw;
    if (typeof val !== "string" || val.includes("{{")) continue;
    if (spaceSteps.size <= 3) continue; // no scale readable: abstain rather than guess
    // ONE VALUE, ONE SPELLING. A page-level width whose step has a name must use the name,
    // or the scale drifts straight back to two vocabularies for the same number — which is
    // the state the t-shirt aliases left it in, and the reason they were retired.
    if (PAGE_WIDTH_KEYS.has(key) && layoutAlias.has(val))
      report("error", file, `${where}.${key}: "${val}" has a name — use "${layoutAlias.get(val)}". A page-level width reads as what it IS; a bare step here puts two spellings on one value (docs/design/06)`);
    // A shorthand ("auto auto 0 0" on `inset`) is a list of dimensions; each word is one.
    for (const word of val.trim().split(/\s+/)) {
      if (spaceSteps.has(word) || DIMENSION_LITERALS.has(word)) continue;
      // Anything starting with a digit that is NOT a bare step is a unit-bearing or
      // percentage value; LAW 1 owns those, and `calc()`/`%` are legitimate escape hatches.
      if (/^\d/.test(word) && !/^\d+(\.\d+)?$/.test(word)) continue;
      if (/[()%]/.test(word)) continue; // calc(), min(), clamp(), 50%
      report("error", file, `${where}.${key}: "${word}" is not a step on the space scale. Invalid values fall through as broken CSS (auto sizing). Real steps: ${stepList()} (docs/design/06)`);
    }
  }
};

/**
 * LAW 1's OTHER HALF — the name has to resolve.
 *
 * The raw-value rule (file.mjs) catches `#ff0000` and `12px`. It cannot catch `radius: lgg`,
 * and nothing downstream catches it either: the SDK resolves `theme.radius[name] ?? name`,
 * hands CSS the literal `lgg`, and CSS drops the declaration. The corner renders square,
 * the lint run is green, and the only report is a designer noticing weeks later.
 *
 * `font` is the worst of them — it is applied ONLY on a hit (`if (s.font && theme.text[s.font])`),
 * so an invented text style applies no size, weight or line-height whatsoever.
 *
 * The rule ABSTAINS rather than guesses: `tokensForFile` returns null wherever the token
 * set cannot be fully read (a developer's project, which has no design system on disk),
 * because judging against half a set rejects correct work — the trap `appSizesForFile`
 * already documents at length.
 */
const tokensForFile = makeTokensForFile({ DS, orgDirs });
const checkToken = (file, where, key, v) => {
  const T = tokensForFile(file);
  if (!T) return;
  // A bound value is DATA — resolved from the record at render time, unknowable here.
  const named = (x) => typeof x === "string" && !x.includes("{{") && x.trim() !== "";
  const bad = (k, val, bucket, extra = "") =>
    report(
      "error",
      file,
      `${where}.${k}: "${val}" is not a ${bucket} token. Unknown names are handed to CSS verbatim and dropped — the style simply does not apply, with no error anywhere${extra}. Known: ${[...T[bucket]].sort().join(", ") || "none"} (docs/design/06)`,
    );

  // The straightforward one-bucket keys (background/color/shadow/radius*/font/lineHeight).
  const bucket = TOKEN_KEYS[key];
  if (bucket) {
    if (!named(v)) return;
    if (LITERAL_VALUES.has(v)) return;
    // `lineHeight` legitimately takes a bare ratio (1.4) as well as a token.
    if (key === "lineHeight" && /^\d*\.?\d+$/.test(v)) return;
    // A bare `0` radius is the one dimensionless CSS value that needs no unit and has no
    // token (a squared corner on a chat bubble). It resolves; nothing is dropped.
    if (bucket === "radius" && v === "0") return;
    if (!T[bucket].has(v))
      bad(key, v, bucket, key === "font" ? ", and an unknown text style applies NO size, weight or line-height at all" : "");
    return;
  }

  // `border` is a PAIR: an optional width token then a colour, e.g. "thick action.primary".
  // The colour resolves as `color.border.<name>` first, then `color.<name>` (sdk/style.ts).
  if (/^border(Top|Right|Bottom|Left)?$/.test(key)) {
    if (!named(v) || LITERAL_VALUES.has(v)) return;
    const parts = v.trim().split(/\s+/);
    const [w, c] = parts.length > 1 ? parts : [null, parts[0]];
    if (w !== null && !T.borderWidth.has(w))
      report("error", file, `${where}.${key}: "${w}" is not a border-width token (the leading word of "<width> <colour>"). Known: ${[...T.borderWidth].sort().join(", ") || "none"} (docs/design/06)`);
    if (!LITERAL_VALUES.has(c) && !T.color.has(`border.${c}`) && !T.color.has(c))
      report("error", file, `${where}.${key}: "${c}" resolves to no colour token (tried border.${c}, then ${c}). The border renders with no colour and nothing reports it (docs/design/06)`);
    return;
  }

  // `weight` — an ordinary served token (`font.weight.*`) since the SDK stopped holding
  // the scale as a literal map. A raw number is CSS's own form and passes through.
  if (key === "weight") {
    if (!named(v) || /^\d+$/.test(v)) return;
    if (!T.weight.has(v)) bad("weight", v, "weight");
    return;
  }

  // `radial` — both stops are colour tokens; `at` is a value or a binding.
  if (key === "radial" && v && typeof v === "object") {
    for (const k of ["fill", "track"])
      if (named(v[k]) && !LITERAL_VALUES.has(v[k]) && !T.color.has(v[k])) bad(`radial.${k}`, v[k], "color");
    return;
  }

  // `animation` is an OBJECT ({ name, duration?, easing?, iteration? }). The string form
  // (`animation: kenBurns`) slipped past every rule and rendered `uno-undefined` — the SDK
  // destructures `.name` from an object and a string has none, so the component named for
  // its motion had none, silently. A shape the interpreter cannot read is an error here.
  if (key === "animation" && typeof v === "string")
    report("error", file, `${where}.animation: "${v}" is a string, but animation is an object — write animation: { name: ${v}, duration: …, easing: … }. The SDK reads .name from an object; a bare string animates NOTHING (renders "uno-undefined")`);

  // `animation.name` names a SERVED keyframe; an unknown one animates nothing.
  if (key === "animation" && v && typeof v === "object" && named(v.name) && !T.keyframes.has(v.name))
    bad("animation.name", v.name, "keyframes");

  // The Icon primitive's glyph (passed by walkNode, not a style key).
  if (key === "icon" && named(v) && !T.icons.has(v)) bad("icon", v, "icons");
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

/**
 * THE KEY IS ONE STRING, CASE AND ALL.
 *
 * Ref lookup above is case-insensitive on purpose, and the marketplace is not: an item is
 * fetched as `items/<kind>/<key>.json` over HTTP, off a case-sensitive host. So a name that
 * disagrees with itself resolves forever in `rx/` and 404s the moment anyone installs it.
 *
 * That is not hypothetical. 2026-08-06: twelve atoms were unreachable from every universe
 * because git held `Avatar.json` while the build wrote `avatar.json`. macOS is
 * case-insensitive, so every local check passed, git never recorded the rename, and Linux
 * served what git held. The error surfaced as `could not fetch atom/avatar (HTTP 404)` in
 * the Installed view, months after the cause.
 *
 * Nothing in `rx/` could have caught it, because `rx/` was correct. What was missing was a
 * rule that the key agrees with itself EXACTLY, which is what this checks:
 *
 *   filename === `name:` === every Ref that points at it
 *
 * Compared as strings, never through the filesystem. `existsSync("avatar.json")` matches
 * `Avatar.json` on a Mac, which is precisely how this stayed invisible.
 */
// COMPONENTS FIRST so ATOMS OVERWRITE THEM, matching `refResolves` above, which tries
// atoms before components. A name can exist as both (`table` is an atom AND a shared
// component); resolution picks the atom, so the canonical spelling must be the atom's.
// Built the other way round, this told an author to write `Table` for a Ref that resolves
// to the atom `table` — a correction that would have broken what it touched.
const canonicalKeys = new Map(); // lowercased key -> the exact-case key
for (const [dir, isDir] of [[join(DS, "components"), true], [join(DS, "atoms"), false]]) {
  if (!existsSync(dir)) continue;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    if (isDir ? !e.isDirectory() : !isDefFile(e.name)) continue;
    const key = isDir ? e.name : defName(e.name);
    canonicalKeys.set(key.toLowerCase(), key);
  }
}

/** The exact-case key a Ref should use, or null when it resolves to nothing. */
const canonicalRef = (ref) => canonicalKeys.get(ref.toLowerCase()) ?? null;

// The filename is the key. A `name:` that disagrees with it is the drift above, waiting.
//
// EVERY HOME, not just the design system. This checked `marketplace/atoms` and
// `marketplace/components` only, so an org's own components and templates were invisible to
// it and their drift had to be found by hand: `course-card/` holding `name: CourseCard`, and
// every template folder holding a display sentence (`name: BPP Assistant`) where the key
// belongs. A rule that covers the shared tier and not the private one teaches that the
// private one is exempt.
const keyHomes = [
  [join(DS, "atoms"), false],
  [join(DS, "components"), true],
];
for (const orgDir of orgDirs) {
  keyHomes.push([join(orgDir, "components"), true], [join(orgDir, "templates"), true]);
}
for (const [dir, isDir] of keyHomes) {
  if (!existsSync(dir)) continue;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    if (isDir ? !e.isDirectory() : !isDefFile(e.name)) continue;
    const key = isDir ? e.name : defName(e.name);
    // A TEMPLATE KEEPS ITS DEFINITION IN `manifest.yaml`, a component in `<name>.yaml`.
    // Looking only for the latter meant every template folder was skipped in silence, so
    // the rule reported them clean while each held a display sentence where its key belongs.
    // A guard that cannot find a file must not read that as nothing to check.
    const file = isDir
      ? [`${e.name}.yaml`, `${e.name}.json`, "manifest.yaml", "manifest.json"]
          .map((n) => join(dir, e.name, n))
          .find(existsSync)
      : join(dir, e.name);
    if (!file || !existsSync(file)) continue;
    const def = readDef(file);
    if (!def || typeof def.name !== "string") continue;
    if (def.name !== key)
      report(
        "warn",
        file,
        `name: "${def.name}" disagrees with the filename "${key}". The key is fetched as items/<kind>/${key}.json over HTTP, so the two must match exactly, capitals included`,
      );
  }
}

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

// ── lifecycle declarations (the ONE sanctioned code carve-out) ──
// A component may run server-side code at a platform fire point, and the safety of that
// rests on the manifest and the thing that runs agreeing. Both halves are checked here so
// a bad declaration is caught in the terminal and at publish, not by silence at run time.
// Mirrors server/tests/rx/lifecycle-declaration.test.ts (UNOVERSE_AUTHORING.md §3c).
const KNOWN_LIFECYCLES = new Set(["onStart", "onEnterView"]);
const PHASES_WITH_LAYOUTS = new Set(["onEnterView"]); // phases that fire per VIEW
const PLATFORM_HANDLERS = new Set(["getDetail"]); // named handlers needing no file

// Every credential DEFINITION this universe can offer a form for. They ship with node
// packages (nodes/<pkg>/credentials/<name>.yaml); a component NAMES one, it never defines
// one. Declared before the loop that reads it: a `const` referenced above its own
// declaration throws, and the throw is swallowed by the enclosing try, which would
// silently disable every rule after it.
const credentialDefs = new Set();
{
  const nodesHome = resolve(RX, "..", "nodes");
  try {
    for (const pkg of readdirSync(nodesHome)) {
      try {
        for (const f of readdirSync(join(nodesHome, pkg, "credentials"))) if (isDefFile(f)) credentialDefs.add(defName(f));
      } catch {
        /* this package ships none */
      }
    }
  } catch {
    /* no nodes tree beside rx: the rule cannot judge, so it stays quiet */
  }
}

for (const orgDir of [DS, ...orgDirs]) {
  const cdir = join(orgDir, "components");
  if (!(existsSync(cdir) && statSync(cdir).isDirectory())) continue;
  for (const entry of readdirSync(cdir)) {
    const folder = join(cdir, entry);
    let mf;
    try {
      if (!statSync(folder).isDirectory()) continue;
      mf = defPath(folder, "manifest");
    } catch {
      continue;
    }
    if (!mf || !existsSync(mf)) continue;
    let raw;
    try {
      raw = readDef(mf).lifecycle;
    } catch {
      continue; // malformed manifest is reported elsewhere
    }
    const entries = Array.isArray(raw)
      ? raw
          .map((r) => (typeof r === "string" ? { phase: r } : r && typeof r === "object" && typeof r.phase === "string" ? r : null))
          .filter(Boolean)
      : [];
    const declared = new Set(entries.map((e) => e.phase.toLowerCase()));

    for (const e of entries) {
      if (!KNOWN_LIFECYCLES.has(e.phase))
        report("error", mf, `lifecycle "${e.phase}" is not a phase the platform fires, so it would never run. Known: ${[...KNOWN_LIFECYCLES].join(", ")} (docs/unoverse/UNOVERSE_AUTHORING.md §3c)`);
      if (e.layouts !== undefined && !PHASES_WITH_LAYOUTS.has(e.phase))
        report("error", mf, `lifecycle "${e.phase}" declares layouts, but only ${[...PHASES_WITH_LAYOUTS].join(", ")} fires per view — the scope would be ignored`);
      // WHAT RUNS is named by `handler`; the phase only says WHEN. A custom hook is a
      // YAML file named for the handler (what it DOES), never for the phase.
      const custom = e.handler && !PLATFORM_HANDLERS.has(e.handler) ? `${e.handler.toLowerCase()}.yaml` : null;
      const hookYaml = custom ? existsSync(join(folder, custom)) : false;
      if (custom && !hookYaml)
        report("error", mf, `lifecycle "${e.phase}" names handler "${e.handler}", so ${custom} must sit beside this manifest (a custom hook is named for what it does). Or name a platform handler: ${[...PLATFORM_HANDLERS].join(", ")}`);
      if (!e.handler && !existsSync(join(folder, `${e.phase.toLowerCase()}.js`)))
        report("error", mf, `lifecycle "${e.phase}" declares no "handler", so nothing would run. Name a platform handler (${[...PLATFORM_HANDLERS].join(", ")}) or your own, with the matching <handler>.yaml beside this manifest`);
      // Declared calls reach the network, so the hosts they may reach are not optional.
      if (hookYaml && !Array.isArray(readDef(mf).allowedHosts))
        report("error", mf, `${custom} makes requests, so this manifest must declare "allowedHosts". Deny by default: no list, no network`);

      // A NAME with no definition behind it is a key nobody can ever enter: nothing offers
      // a form for it, the hook runs credential-less, the vendor refuses, and the card
      // renders its preview defaults with no error anywhere. Caught here instead. Skipped
      // when no definition was found at all, since that means the nodes tree is absent
      // rather than the name being wrong.
      if (credentialDefs.size)
        for (const cname of Array.isArray(readDef(mf).credentials) ? readDef(mf).credentials : [])
          if (!credentialDefs.has(String(cname)))
            report(
              "error",
              mf,
              `credential "${cname}" has no definition in any installed node package, so nothing can offer a form to enter it. Install the package that defines it, or name one that exists: ${[...credentialDefs].sort().join(", ")}`,
            );

    }

    // A handler FILE nothing opted into is un-opted code: it never runs, and a reader
    // cannot tell that from looking. Name it in the manifest, or delete it.
    for (const f of readdirSync(folder))
      if (f.endsWith(".js") && !declared.has(f.slice(0, -3)))
        report("error", join(folder, f), `${f} is a lifecycle handler no manifest opted into. Add "${f.slice(0, -3)}" to the manifest's lifecycle array, or delete the file — un-opted code never runs`);
  }
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
  if (!appSizesCache.has(home)) {
    // INHERITANCE, not replacement: an org's own set OVERRIDES the marketplace's
    // name-by-name (bpp redefines `chat` and adds `flex`; `rail`/`panel` stay inherited).
    const inherited = readAppSizes(DS);
    /**
     * A PARTIAL SET IS WORSE THAN NO SET, and this is the same trap the design-system
     * lookup above already names: judge against half the answer and correct work is
     * rejected.
     *
     * A developer's project has NO design system on disk — it is installed, not authored
     * — so the inherited half is unreadable and only the org's own names are left. Every
     * inherited name it uses then "names no app size", which is a lint error on work that
     * is right, and publishing lints first, so it blocked the publish outright.
     *
     * Unreadable is not empty. `null` skips the name check (walk.mjs guards on it), which
     * is the honest answer: this cannot be verified here, so it is not asserted. In the
     * monorepo the design system IS present and the check runs exactly as before.
     */
    appSizesCache.set(home, inherited === null ? null : { ...inherited, ...(readAppSizes(home) ?? {}) });
  }
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
    RX, DS, orgDirs, report, spaceSteps, stepList, checkDimension, checkToken, checkCondition,
    appSizesForFile, componentNamesForFile, refResolves, canonicalRef, atomsDirExists,
    isFixture, isHook, isManifest, isTemplatePath, defRoot, readText,
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
