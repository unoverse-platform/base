/**
 * The design system version an asset was authored against.
 *
 * TWO PARTS, because neither alone is enough:
 *
 *     1.4.2+a3f1
 *     └───┘ └──┘
 *       │     └── HASH over every member's content. Derived, so it cannot be forgotten or
 *       │         bumped wrongly, and it moves the instant anything moves. This is what
 *       │         actually answers "did it change".
 *       └──────── PACKAGE VERSION, when there is one. Declared, so it can be stale, but it
 *                 is ORDERED, which a hash never is. This is what answers "which way".
 *
 * A hash alone tells you two things differ and not which is newer. A version alone can be
 * wrong, and is absent entirely in the monorepo where the design system is uncommitted
 * source on disk rather than an installed package. So: hash always, version when known.
 *
 * WHAT IT IS FOR. Every published asset is built ON the design system: a component composes
 * marketplace atoms, an app composes components, an org's tokens override a foundation
 * scale. When the foundation moves, an item authored against the older one may reference
 * something that no longer exists. The symptom is a hole where a component should be, seen
 * by an end user and traceable to nothing. This is the record that makes it traceable.
 *
 * It cannot be backfilled: nothing else anywhere records what a definition was written
 * against. See migration 018 and DECLARATIVE_NODES.md §9.12.
 */
import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { fingerprintOf } from "./fingerprint.js";

/** Short, readable, and only ever compared for equality. */
function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

/** Every file under a directory, sorted, so the hash is order-independent. */
function filesUnder(dir: string, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) filesUnder(join(dir, e.name), rel, out);
    else if (/\.(ya?ml|json)$/.test(e.name)) out[rel] = readFileSync(join(dir, e.name), "utf8");
  }
  return out;
}

/**
 * The declared version, if the design system arrived as a package.
 *
 * Absent in the monorepo, where it is source on disk. That absence is honest rather than a
 * gap: there is no version, because nobody cut one.
 */
function packageVersion(designSystemDir: string): string | null {
  // The bundle lives at <package>/definitions, so its package.json is one level up.
  for (const candidate of [join(designSystemDir, "..", "package.json"), join(designSystemDir, "package.json")]) {
    if (!existsSync(candidate)) continue;
    try {
      const v = JSON.parse(readFileSync(candidate, "utf8"))?.version;
      if (typeof v === "string") return v;
    } catch {
      /* unreadable package.json: fall through to the hash alone */
    }
  }
  return null;
}

/**
 * Compute the version of the design system at `designSystemDir` (the resolved marketplace
 * directory: on-disk design/marketplace, or the installed bundle).
 *
 * Hashes components, atoms and styles together, because they only mean anything as a set:
 * a universe holding half of them renders against a contract with holes.
 */
export function designSystemVersion(designSystemDir: string): string {
  const parts: string[] = [];

  for (const kind of ["components", "atoms"] as const) {
    const home = join(designSystemDir, kind);
    if (!existsSync(home)) continue;
    for (const e of readdirSync(home, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".") || e.name === "README.md") continue;
      const files = e.isDirectory()
        ? filesUnder(join(home, e.name))
        : { [e.name]: readFileSync(join(home, e.name), "utf8") };
      parts.push(`${kind}/${e.name}:${fingerprintOf(files)}`);
    }
  }

  const styles = filesUnder(join(designSystemDir, "styles"));
  if (Object.keys(styles).length) parts.push(`styles:${fingerprintOf(styles)}`);

  const hash = shortHash(parts.join("|"));
  const declared = packageVersion(designSystemDir);
  return declared ? `${declared}+${hash}` : hash;
}
