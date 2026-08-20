/**
 * THE TOKEN REGISTRY — does the name a definition writes actually resolve?
 *
 * LAW 1 (file.mjs) bans a RAW value: `#ff0000`, `12px`. It says nothing about a name that
 * looks like a token and is not one, and that is the half that fails silently. The SDK's
 * interpreter resolves every style value as `theme.<bucket>[name] ?? name` (sdk/style.ts),
 * so an unknown name is not an error anywhere in the stack — it is handed to CSS verbatim,
 * CSS discards the declaration, and the element renders with that property simply absent.
 * `radius: lgg` is a square corner with a green lint run behind it. `font: headline.enormous`
 * is worse still: `font` is applied only when the lookup HITS, so an invented text style
 * applies nothing at all and the text falls back to whatever it inherits.
 *
 * One namespace was already covered — the space scale, via `checkDimension` — and that is
 * the shape this generalises: every other bucket the interpreter reads gets the same
 * treatment, from the same files the server resolves at serve time.
 *
 * THE REGISTRY IS BUILT THE WAY THE SERVER BUILDS IT (definitions/theme.ts `buildTheme`):
 * the marketplace foundation's `base` + `semantic` first, then the org's ON TOP, per token
 * — an org omits a token to inherit it. Themes are UNIONED rather than resolved one at a
 * time, because a name that resolves under `dark` is legitimate work; per-theme parity is
 * a different rule with its own guard (server/tests/rx/theme-contract.test.ts).
 *
 * UNREADABLE IS NOT EMPTY. A developer's project has no design system on disk — it is
 * installed, not authored — so the foundation half cannot be read and only the org's own
 * names are left. Judging real work against half the answer rejects it, and publishing
 * lints first, so that reads as "you cannot publish". `null` = abstain, exactly as
 * `appSizesForFile` abstains, and for the same reason.
 */
import { readdirSync, existsSync } from "node:fs";
import { join, sep } from "node:path";
import { isDefFile, readDef } from "./defs.mjs";

/** Flatten a token file into { "dotted.path": rawValue } — mirrors theme.ts `collect`. */
function collect(obj, prefix, out) {
  if (!obj || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("$")) continue;
    if (v && typeof v === "object" && "$value" in v) out[prefix ? `${prefix}.${k}` : k] = v.$value;
    else if (v && typeof v === "object") collect(v, prefix ? `${prefix}.${k}` : k, out);
  }
}

/** Read every token file in a dir into the flat registry. A malformed file lints on its own. */
function readTokenDir(dir, into) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter(isDefFile)) {
    try {
      collect(readDef(join(dir, f)), "", into);
    } catch {
      /* the file has its own findings */
    }
  }
}

/** Every theme in a folder, merged into one registry — see the union note in buildTokens. */
function readThemes(dir, into) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter(isDefFile)) {
    try {
      collect(readDef(join(dir, f)), "", into);
    } catch {
      /* the file has its own findings */
    }
  }
}

/** The leaf names under a dotted prefix: `color.` → { "text.primary", "border.strong", … }. */
const names = (reg, prefix) =>
  new Set(Object.keys(reg).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));

/**
 * Build the name sets one home (the design system, or an org) resolves against.
 * Returns null when the foundation cannot be read — see the header.
 */
function buildTokens(dsStyles, homeStyles) {
  const reg = {};
  const foundation = existsSync(join(dsStyles, "base")) || existsSync(join(dsStyles, "semantic"));
  const ownFoundation = homeStyles === dsStyles;
  if (!foundation && !ownFoundation) return null; // abstain: half an answer judges nothing
  if (!ownFoundation) {
    readTokenDir(join(dsStyles, "base"), reg);
    readTokenDir(join(dsStyles, "semantic"), reg);
  }
  readTokenDir(join(homeStyles, "base"), reg);
  readTokenDir(join(homeStyles, "semantic"), reg);
  /**
   * Colours live in the THEMES, and a home has several. Union them, foundation first:
   *
   *  - across a home's own themes, because a name only `dark` defines is real work, not a
   *    typo (whether every theme defines every name is a DIFFERENT rule, guarded by
   *    server/tests/rx/theme-contract.test.ts — this one must not double as a weaker copy);
   *  - the foundation's underneath, because the colour contract is the shared one every
   *    org is written against. An org that has no themes folder of its own would otherwise
   *    read as "no colours exist", and the rule would report every colour it uses.
   */
  if (!ownFoundation) readThemes(join(dsStyles, "themes"), reg);
  readThemes(join(homeStyles, "themes"), reg);
  // A styles set with no colour at all is not a set — treat it as unreadable rather than
  // reporting every colour in the org as invented.
  const color = names(reg, "color.");
  if (color.size === 0) return null;
  return {
    color,
    radius: names(reg, "radius."),
    shadow: names(reg, "shadow."),
    borderWidth: names(reg, "border.width."),
    weight: names(reg, "font.weight."),
    lineHeight: names(reg, "font.lineHeight."),
    text: names(reg, "text."),
    icons: names(reg, "icons."),
    keyframes: names(reg, "keyframes."),
  };
}

/**
 * `tokensForFile(file)` → the name sets that file's home resolves against, or null to
 * abstain. Cached per home; the cache lives for the run, like `appSizesCache`.
 */
export function makeTokensForFile({ DS, orgDirs }) {
  const cache = new Map();
  const dsStyles = join(DS, "styles");
  return function tokensForFile(file) {
    const home = orgDirs.find((d) => file.startsWith(d + sep)) ?? (file.startsWith(DS + sep) ? DS : null);
    if (!home) return null;
    if (!cache.has(home)) cache.set(home, buildTokens(dsStyles, join(home, "styles")));
    return cache.get(home);
  };
}
