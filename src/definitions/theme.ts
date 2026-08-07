/**
 * Runtime theme resolver — the MCP server’s live, compiled view of the org styles sets (rx/orgs/<org>/styles).
 *
 * The server OWNS THE VISUAL. It reads the design tokens (rx/orgs/<org>/styles, the design
 * system source) at request time and serves the RESOLVED theme to channels at
 * `unoverse://theme/{name}`. The SDK owns ZERO token values — it FETCHES this
 * (UnoverseClient.readTheme). So a brand/spacing/type change in an org’s styles is
 * refresh-only, exactly like a definition change — never a SDK rebuild
 * (UNOVERSE_SPEC §2d-1).
 *
 * This is the same resolution `stylegen` performs — but SERVED, not baked into
 * the SDK bundle. stylegen now imports this so there is ONE resolver, used only
 * to EXPORT tokens for the native SDKs (web fetches live).
 */
import { readdirSync, existsSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readDefCached, defPath, isDefFile, defName, dirSignature, cachedBySignature } from "./fsCache.js";
import { packagedDesignSystem } from "./dsPackage.js";
// Icon glyphs are sourced from a pack HERE (control plane), never in the SDK bundle:
// rx/ lists semantic→lucide names; we resolve each to served `theme.icons` data.
import { icons as lucideIcons } from "lucide";

// lucide renders stroke glyphs with these standard svg attrs (it ships no runtime
// `defaultAttributes`). Served as DATA so the SDK applies them verbatim — it authors none.
const LUCIDE_SVG_ATTRS = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" };

const __dirname = dirname(fileURLToPath(import.meta.url));
// The marketplace FOUNDATION (base + semantic + default themes) lives at
// `rx/marketplace/styles` — the shared token contract every org inherits. An org
// (`rx/orgs/<org>/styles`) supplies ONLY what it customises (typically just its brand
// themes); base/semantic tokens it omits are INHERITED from the foundation via
// buildTheme's per-token cascade. A theme is addressed `<org>/<name>`
// (unoverse://theme/sab/light); a bare name (or the `default` org) = the foundation's
// own default set. Token NAMES are the shared contract (components reference them);
// VALUES are each org's own — that's how two clients get different fonts/colors/spacing
// from the same components, without re-copying the foundation.
import { listOrgs, projectDir } from "./definitions.js";
import { NODES_HOME, PLUGINS_DIR, RX_HOME, INSTALLED_HOME, databaseOnly } from "../paths.js";

const RX = RX_HOME;
export const DEFAULT_ORG = "default";

/** The styles dir for a project, or null if it has none. `projectDir` resolves the
 *  project whether it's flat at the rx root (the target) or under legacy `rx/orgs/`. */
function orgStyles(org: string): string | null {
  const dir = join(projectDir(org), "styles");
  return existsSync(dir) ? dir : null;
}

/**
 * The marketplace FOUNDATION — base + semantic + default themes, the shared token
 * contract every org inherits (buildTheme's fallback layer) AND the `default` theme set
 * itself. Its home is now `rx/marketplace/styles` (the honest marketplace folder, no
 * longer an org costume under `orgs/default`). Resolution mirrors `findRxComponentsDir`:
 * the on-disk marketplace dir wins (dev/local), else the bundled package — the monorepo
 * home node, then the installed marketplace package. This lets the foundation ship WITH
 * the package (no `rx/marketplace` on disk) once purged from the image (Phase 4).
 */
const DS_STYLES_CANDIDATES = [
  join(NODES_HOME, "marketplace", "definitions", "styles"),
  join(PLUGINS_DIR, "node_modules", "@unoverse-platform", "marketplace", "definitions", "styles"),
];
/**
 * WHAT THIS UNIVERSE WAS INSTALLED — the tier this function was missing.
 *
 * The design system is CHOSEN now, not shipped (MARKETPLACE.md §3), so on a deployed
 * universe it is neither on disk nor in a bundle: it is rows, unpacked here. `definitions.ts`
 * already ends its search on this tier for components and atoms, and its comment says it
 * "mirrors theme.ts's styles fallback" — which was true when written and stopped being
 * true when that tier was added there and not here.
 *
 * The cost was total and silent. A universe would install the design system, hold all 49
 * rows, render components from them, and still resolve NO themes: `/dev/themes` answered
 * `{"themes":[]}` and Studio sat on "loading theme from mcp…" for ever, because a screen
 * with no tokens cannot draw. Installed, present, and unreachable.
 */
const INSTALLED_STYLES = join(INSTALLED_HOME, "rx", "marketplace", "styles");

function foundationStyles(): string | null {
  // Under the switch the authored tiers are skipped, so what a deployed universe would
  // resolve is what a developer resolves. Same shape as `marketplaceDir`.
  if (databaseOnly()) return existsSync(INSTALLED_STYLES) ? INSTALLED_STYLES : null;
  const rxDs = join(RX, "marketplace", "styles");
  if (existsSync(rxDs)) return rxDs; // on-disk marketplace wins (dev/local)
  for (const c of DS_STYLES_CANDIDATES) if (existsSync(c)) return c;
  // SEARCHED LAST, so anything on disk still wins — the same precedence the node loader
  // applies with [disk, rows]. On a deployed universe the tiers above are empty by design
  // and this is the only one with anything in it.
  if (existsSync(INSTALLED_STYLES)) return INSTALLED_STYLES;
  // Last: the copy the running HOST carries. Studio has the design system in its own
  // node_modules and no project-local tier will ever hold one (dsPackage.ts).
  const packaged = packagedDesignSystem();
  if (packaged && existsSync(join(packaged, "styles"))) return join(packaged, "styles");
  return null;
}

/** Styles home for an org REF — the marketplace foundation for the `default` ref,
 *  else the org's own folder. (`default` is no longer a folder under `orgs/`; it IS the
 *  marketplace, so its themes resolve from the foundation.) */
function stylesForOrg(org: string): string | null {
  return org === DEFAULT_ORG ? foundationStyles() : orgStyles(org);
}

/** Every org that has a styles set: the default first, then the clients. */
export function themeOrgs(): string[] {
  return [DEFAULT_ORG, ...listOrgs().filter((o) => o !== DEFAULT_ORG && orgStyles(o) !== null)];
}

export interface ResolvedTheme {
  /** Webfont stylesheet URLs (`fonts.stylesheets` — e.g. Google Fonts css2). Served
   *  DATA like everything else; the SDK injects a <link> per URL into document.head
   *  (fonts must register at document level — shadow roots can't). */
  fonts: string[];
  color: Record<string, string>;
  space: Record<string, string>;
  radius: Record<string, string>;
  shadow: Record<string, string>;
  borderWidth: Record<string, string>;
  /** Font weights (`font.weight.*`) — SERVED, like every other token.
   *
   *  These were the one scale the SDK held as a literal map of four names, so the six the
   *  foundation actually defines were never all reachable and an org that added its own
   *  (yasisland's `extrabold`) got silence: the SDK passed the unknown word to CSS, CSS
   *  dropped the declaration, and the text rendered at whatever it inherited. */
  weight: Record<string, string | number>;
  lineHeight: Record<string, string | number>;
  text: Record<string, Record<string, string | number>>;
  skeleton: Record<string, unknown>;
  prose: Record<string, unknown>;
  /** STANDARD APP SIZES (semantic/app-sizes.json) — the named width blocks `appWidth`
   *  references ("chat"/"rail"/"panel" → raw host-facing CSS). Resolved by the SDK
   *  like every other token: ONE pipeline, no serve-time rewriting of definitions. */
  appSize: Record<string, string>;
  /** Grid behaviour (`grid.*`) — currently `stackBelow`, the width at which a columns
   *  grid stacks. Served, so the SDK holds no threshold of its own. */
  grid: Record<string, string>;
  /** PAGE WIDTHS by name (`layout.*`) — aliases onto the space scale so a page-level cap
   *  reads as what it is. Element sizes stay scale steps; see semantic/layout. */
  layout: Record<string, string>;
  keyframes: Record<string, Record<string, Record<string, string>>>;
  icons: Record<string, { viewBox?: string; attrs?: Record<string, unknown>; children?: [string, Record<string, unknown>][] }>;
  root: Record<string, unknown>;
}

type Json = any;

/** Flatten a token file into { "dotted.path": rawValue } (rawValue = $value). */
function collect(obj: Json, prefix: string, out: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("$")) continue;
    if (v && typeof v === "object" && "$value" in (v as Json)) {
      out[prefix ? `${prefix}.${k}` : k] = (v as Json).$value;
    } else if (v && typeof v === "object") {
      collect(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
}

function readTokenDir(dir: string, into: Record<string, unknown>): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter(isDefFile)) {
    collect(readDefCached(join(dir, f)), "", into);
  }
}

/** Resolve one raw value: alias → looked-up value (recursive), composite → per-field, array → join. */
function resolveValue(raw: unknown, reg: Record<string, unknown>, seen = new Set<string>()): unknown {
  if (typeof raw === "string") {
    // Replace EVERY {token.path} occurrence — supports composite values like
    // "{space.3} {space.6}" or "{border.width.thick} solid {color.action.primary}".
    if (!raw.includes("{")) return raw;
    return raw.replace(/\{([^}]+)\}/g, (_, path) => {
      if (seen.has(path)) throw new Error(`Cyclic token alias: ${path}`);
      if (!(path in reg)) throw new Error(`Unknown token alias: {${path}}`);
      return String(resolveValue(reg[path], reg, new Set(seen).add(path)));
    });
  }
  if (Array.isArray(raw)) return raw.map((x) => resolveValue(x, reg, new Set(seen)));
  if (raw && typeof raw === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) o[k] = resolveValue(v, reg, new Set(seen));
    return o;
  }
  return raw;
}

const flat = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v);

/** Build one resolved theme from an org tree, with the DEFAULT set as the foundation.
 *
 * Phase 3 cascade ("org = just a theme"): the default set's `base`/`semantic` (the shared
 * marketplace contract) is the foundation. An org supplies only what differs — typically
 * just its `themes/<name>.json` brand file — and inherits the rest. The fallback is applied
 * PER LAYER and only when the org LACKS that layer: an org that ships its own `base`/
 * `semantic` fully replaces the default's for that layer, so existing full-set orgs resolve
 * byte-identically (verified). A theme-only org (no `base`/`semantic` folders) inherits both.
 */
function buildTheme(styles: string, themeFile: string): ResolvedTheme {
  const reg: Record<string, unknown> = {};
  // PER-TOKEN cascade: read the foundation's base+semantic FIRST, then the org's ON TOP —
  // the flat token registry is keyed by dotted path, so an org token overrides the
  // foundation's and an org OMITS a token to inherit it. An org therefore keeps only the
  // files/tokens it customises; everything else comes from the foundation. Existing full
  // forks (every default token present in the org) resolve byte-identically (verified).
  const defaultStyles = foundationStyles();
  if (defaultStyles && defaultStyles !== styles) {
    readTokenDir(join(defaultStyles, "base"), reg);
    readTokenDir(join(defaultStyles, "semantic"), reg);
  }
  readTokenDir(join(styles, "base"), reg);
  readTokenDir(join(styles, "semantic"), reg);
  collect(readDefCached(themeFile), "", reg);

  const bucket = (prefix: string, mapVal: (v: unknown) => unknown) => {
    const out: Record<string, string> = {};
    for (const path of Object.keys(reg)) {
      if (!path.startsWith(prefix)) continue;
      out[path.slice(prefix.length)] = mapVal(resolveValue(reg[path], reg)) as string;
    }
    return out;
  };

  return {
    fonts: ((resolveValue(reg["fonts.stylesheets"], reg) as string[] | undefined) ?? []).filter((u) => typeof u === "string"),
    color: bucket("color.", (v) => v),
    space: bucket("space.", (v) => v),
    radius: bucket("radius.", (v) => v),
    appSize: bucket("appSize.", (v) => v),
    grid: bucket("grid.", (v) => v),
    layout: bucket("layout.", (v) => v),
    shadow: bucket("shadow.", (v) => v),
    borderWidth: bucket("border.width.", (v) => v),
    weight: bucket("font.weight.", (v) => v) as Record<string, string | number>,
    lineHeight: bucket("font.lineHeight.", (v) => v) as Record<string, string | number>,
    text: (() => {
      const out: Record<string, Record<string, string | number>> = {};
      for (const path of Object.keys(reg)) {
        if (!path.startsWith("text.")) continue;
        const v = resolveValue(reg[path], reg) as Record<string, unknown>;
        out[path.slice("text.".length)] =
          v && typeof v === "object"
            ? (Object.fromEntries(Object.entries(v).map(([k, x]) => [k, flat(x)])) as Record<string, string | number>)
            : (v as never);
      }
      return out;
    })(),
    // Skeleton recipe — dimensions as DATA (gap/fill/radius + per-variant `bars`).
    // Arrays are kept as-is (NOT flattened); the SDK reads them verbatim.
    skeleton: (() => {
      const out: Record<string, unknown> = {};
      for (const path of Object.keys(reg)) {
        if (!path.startsWith("skeleton.")) continue;
        out[path.slice("skeleton.".length)] = resolveValue(reg[path], reg);
      }
      return out;
    })(),
    // Prose recipe — the Markdown primitive's element styling as DATA (link/list/
    // table/image/heading-map). The SDK reads these verbatim; it authors nothing.
    prose: (() => {
      const out: Record<string, unknown> = {};
      for (const path of Object.keys(reg)) {
        if (!path.startsWith("prose.")) continue;
        out[path.slice("prose.".length)] = resolveValue(reg[path], reg);
      }
      return out;
    })(),
    // Keyframes — named animation recipes as DATA (each a stop→decls map). The SDK
    // serializes these into @keyframes once per root (keyframesCss); it authors none.
    keyframes: (() => {
      const out: Record<string, unknown> = {};
      for (const path of Object.keys(reg)) {
        if (!path.startsWith("keyframes.")) continue;
        out[path.slice("keyframes.".length)] = resolveValue(reg[path], reg);
      }
      return out;
    })() as Record<string, Record<string, Record<string, string>>>,
    // Icons — semantic name (rx/) → pack glyph name → SERVED element DATA. The pack
    // (lucide) lives ONLY here on the control plane; the SDK gets `{viewBox, attrs,
    // children}` and renders it generically. To add a pack, adapt its data to this same
    // shape below — the SDK and definitions never change (see iconFromPack).
    icons: (() => {
      const out: Record<string, unknown> = {};
      for (const path of Object.keys(reg)) {
        if (!path.startsWith("icons.")) continue;
        const glyph = iconFromPack(String(resolveValue(reg[path], reg)));
        if (glyph) out[path.slice("icons.".length)] = glyph;
      }
      return out;
    })() as Record<string, { viewBox?: string; attrs?: Record<string, unknown>; children?: [string, Record<string, unknown>][] }>,
    // Base render-root CSS (font-smoothing etc.) — served; the SDK spreads it at the root.
    root: (resolveValue(reg["root"], reg) as Record<string, unknown>) ?? {},
  };
}

/**
 * Adapt a pack's icon → the SERVED shape `{ viewBox, attrs, children }` (pack-agnostic;
 * the SDK only ever sees this shape). lucide gives raw `[tag, attrs][]` elements + a
 * 24×24 stroke convention. Another pack = another branch here that normalizes to the
 * same shape — nothing in the SDK or in rx/ definitions changes.
 */
function iconFromPack(name: string): { viewBox: string; attrs: Record<string, unknown>; children: [string, Record<string, unknown>][] } | null {
  const node = (lucideIcons as Record<string, [string, Record<string, unknown>][]>)[name];
  if (!node) return null;
  return { viewBox: "0 0 24 24", attrs: LUCIDE_SVG_ATTRS, children: node };
}

/**
 * THE ICON VOCABULARY a content record may name, derived from the SERVED set.
 *
 * A promoted row carries `features: [{ title, description, icon }]`, where the icon is
 * chosen by the extractor and rendered by a card from `theme.icons`. Those are two ends of
 * one contract, and when the extraction prompt carried its own hand-written list they
 * drifted: the model named icons the renderer could not resolve, and every feature drew a
 * blank chip. Silently, because a missing glyph is not an error anywhere.
 *
 * So the writer asks the renderer. Add a name to `rx/styles/semantic/icons.yaml` and the
 * extractor may use it on the next call, with no prompt to edit and nothing to keep in step.
 * Empty (a deployment with no rx tree) leaves the schema to describe the field in words.
 */
export function iconVocabulary(org = "default"): string[] {
  const theme = resolveTheme(`${org}/light`);
  return theme ? Object.keys(theme.icons).sort() : [];
}

/** The theme names available — `<org>/<name>` across every styles set, or one org's
 *  bare names when `org` is given (each set typically ships light + dark). */
export function listThemeNames(org?: string): string[] {
  const orgs = org ? [org] : themeOrgs();
  const out: string[] = [];
  for (const o of orgs) {
    const styles = stylesForOrg(o);
    if (!styles) continue;
    const themes = join(styles, "themes");
    if (!existsSync(themes)) continue;
    for (const f of readdirSync(themes).filter(isDefFile)) {
      const name = defName(f);
      out.push(org ? name : `${o}/${name}`);
    }
  }
  return out;
}

/** Resolve a theme by `<org>/<name>` ref (bare name = the default set), or null if it
 *  doesn't exist. Resolution (token expansion, icon glyphs) is the expensive part and
 *  is pure in the styles files — memoized on their mtimes, so a token edit still
 *  hot-reloads (mtime moves → rebuild) while steady-state reads pay a stat sweep
 *  instead of a full build. */
export function resolveTheme(ref: string): ResolvedTheme | null {
  const i = ref.indexOf("/");
  const [org, name] = i === -1 ? [DEFAULT_ORG, ref] : [ref.slice(0, i), ref.slice(i + 1)];
  const styles = stylesForOrg(org);
  if (!styles) return null;
  const file = defPath(join(styles, "themes"), name);
  if (!file) return null;
  // Signature includes the DEFAULT foundation dirs too — a theme-only org inherits them
  // (buildTheme), so an edit to default's base/semantic must invalidate this org's cache.
  const defaultStyles = foundationStyles();
  const sigDirs = [join(styles, "base"), join(styles, "semantic")];
  if (defaultStyles && defaultStyles !== styles) sigDirs.push(join(defaultStyles, "base"), join(defaultStyles, "semantic"));
  const sig = `${dirSignature(sigDirs)};${file}:${statSync(file).mtimeMs}`;
  return cachedBySignature(`theme:${org}/${name}`, sig, () => buildTheme(styles, file));
}

/** Resolve every theme (for stylegen's native-SDK export). */
export function resolveThemes(): Record<string, ResolvedTheme> {
  const out: Record<string, ResolvedTheme> = {};
  for (const name of listThemeNames()) {
    const t = resolveTheme(name);
    if (t) out[name] = t;
  }
  return out;
}
