/**
 * mtime-validated definition file cache.
 *
 * The definition + theme stores (definitions.ts, theme.ts) read the same small rx/ files
 * on EVERY MCP resource read/list and every theme fetch — and a single
 * `listDefinitions()` re-reads the same atoms once per composing component. Re-reading +
 * re-parsing them per request is the server's hottest avoidable cost.
 *
 * This caches the PARSED value keyed by absolute path, re-reading ONLY when the file's
 * mtime changes. So hot-reload still works (edit a definition, refresh → mtime moves →
 * re-parse), but a steady-state request pays a single `stat()` instead of open+read+parse.
 *
 * Returned objects are SHARED, not cloned — callers that MUTATE the parsed value MUST
 * clone first (the definition loader does, to expand atom `Ref`s in place); theme reads
 * are read-only. Call only for files known to exist (callers already guard with existsSync);
 * `statSync` throws on a missing path.
 *
 * ---
 *
 * FORMAT: rx definitions are authored as `.yaml` OR `.json` and the two are
 * interchangeable everywhere. YAML is the authoring format (it carries comments and reads
 * without punctuation noise); JSON stays the WIRE format, because definitions are served
 * verbatim as MCP resources to clients that `JSON.parse` them. Nothing downstream of this
 * module knows which extension a definition was authored in.
 *
 * YAML parses to the same data model, so the JSON Schema at `rx/_schema/` validates both
 * with no change. `$schema` is stripped on read: an editor needs the pointer in the file,
 * a client must never receive it in the payload.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";

/** Authored definition extensions, in RESOLUTION ORDER. `.yaml` wins so a converted file
 *  takes precedence over a `.json` left behind mid-migration. `defPath` is the only place
 *  that order is applied — never re-implement it at a call site. */
export const DEF_EXTS = [".yaml", ".json"] as const;

const cache = new Map<string, { mtimeMs: number; data: unknown }>();

/** Parsed definition for `path`, cached until the file's mtime changes. Parser is chosen
 *  by extension; `$schema` (an editor affordance, never wire data) is dropped. */
export function readDefCached<T = any>(path: string): T {
  const mtimeMs = statSync(path).mtimeMs;
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.data as T;
  const text = readFileSync(path, "utf8");
  const parsed = path.endsWith(".yaml") ? parseYaml(text) : JSON.parse(text);
  if (parsed && typeof parsed === "object" && "$schema" in parsed) delete (parsed as Record<string, unknown>).$schema;
  cache.set(path, { mtimeMs, data: parsed });
  return parsed as T;
}

/**
 * Resolve an EXTENSION-LESS definition path to the file that actually exists, or
 * undefined. `defPath(dir, "card")` finds `card.yaml` then `card.json`.
 *
 * Every definition lookup goes through here so the migration stays invisible: a folder may
 * hold YAML and JSON side by side while it is being converted. Authoring BOTH for one name
 * is an error the linter reports — this resolver silently prefers `.yaml` rather than
 * failing, because a half-converted tree must keep serving.
 */
export function defPath(dir: string, name: string): string | undefined {
  for (const ext of DEF_EXTS) {
    const p = join(dir, name + ext);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** True when `file` is an authored definition (either format). Replaces the
 *  `endsWith(".json")` filters that used to gate directory scans. */
export const isDefFile = (file: string): boolean => DEF_EXTS.some((e) => file.endsWith(e));

/** A definition filename without its extension: `welcome.yaml` → `welcome`. */
export const defName = (file: string): string => file.replace(/\.(yaml|json)$/, "");

const textCache = new Map<string, { mtimeMs: number; text: string }>();

/** File text for `path`, cached until the file's mtime changes. Same contract as
 *  readDefCached — for large non-JSON reads (e.g. the single-file webSDK bundle)
 *  that would otherwise sync-read megabytes off disk per request. */
export function readTextCached(path: string): string {
  const mtimeMs = statSync(path).mtimeMs;
  const hit = textCache.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.text;
  const text = readFileSync(path, "utf8");
  textCache.set(path, { mtimeMs, text });
  return text;
}

/**
 * Change signature over a set of directories: every definition file's name+mtime,
 * recursing into subdirectories (definition folders carry `states/` etc. — all
 * shallow). A stat sweep is tens of µs for the rx/ dirs — versus re-running full
 * token/definition resolution per request. Missing dirs contribute their absence
 * (so creating one invalidates).
 *
 * MUST cover both extensions: a signature that only saw `.json` would leave every YAML
 * edit invisible to hot reload, and the staleness would look like a caching bug rather
 * than a missing filter.
 */
export function dirSignature(dirs: string[]): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (isDefFile(e.name)) parts.push(`${dir}/${e.name}:${statSync(join(dir, e.name)).mtimeMs}`);
    }
  };
  for (const dir of dirs) {
    if (!existsSync(dir)) parts.push(`${dir}:absent`);
    else walk(dir);
  }
  return parts.join(";");
}

const computed = new Map<string, { sig: string; value: unknown }>();

/** Memoize `compute()` under `key`, re-running only when `sig` changes.
 *  Returned values are SHARED — callers must not mutate them. */
export function cachedBySignature<T>(key: string, sig: string, compute: () => T): T {
  const hit = computed.get(key);
  if (hit && hit.sig === sig) return hit.value as T;
  const value = compute();
  computed.set(key, { sig, value });
  return value;
}
