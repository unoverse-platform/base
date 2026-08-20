/**
 * Definition file formats: how an rx definition is named, found and parsed.
 *
 * Mirrors the server's fsCache.ts, deliberately. A definition is `.yaml` or `.json`, and
 * the linter must agree with the loader about which file IS the definition, or it lints a
 * file nothing reads.
 *
 * The YAML parse is hand-rolled frontmatter-free minimal parsing rather than a dependency:
 * this linter stays runnable with nothing installed.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

// ── definition file formats (mirrors server/src/fsCache.ts) ──
// A LOCAL copy, not an import: this script ships standalone to the starter and cannot
// reach the server's TypeScript. `.yaml` first, matching the loader's resolution order.
// If these ever disagree with fsCache.ts, lint checks a different set of files than the
// server serves — which is exactly the silent gap this block exists to close.
export const DEF_EXTS = [".yaml", ".json"];
export const isDefFile = (f) => DEF_EXTS.some((e) => f.endsWith(e));
export const defName = (f) => f.replace(/\.(yaml|json)$/, "");
export const defPath = (dir, name) => {
  for (const e of DEF_EXTS) {
    const p = join(dir, name + e);
    if (existsSync(p)) return p;
  }
  return undefined;
};

// YAML is required LAZILY, only when a .yaml definition is actually read, so a JSON-only
// project (and a fresh starter clone that has not installed devDependencies) never needs
// the package — the "no deps" property above holds for everyone not authoring YAML.
let _yamlParse = null;
export function parseDef(text, file) {
  if (!file.endsWith(".yaml")) return JSON.parse(text);
  if (!_yamlParse) {
    try {
      _yamlParse = createRequire(import.meta.url)("yaml").parse;
    } catch {
      throw new Error('YAML definitions need the "yaml" package. Run: npm i -D yaml');
    }
  }
  return _yamlParse(text);
}
export const readDef = (file) => parseDef(readFileSync(file, "utf8"), file);
