/**
 * Installed items, written to disk so the existing loaders can read them.
 *
 * WHY DISK AND NOT MEMORY. A published component is a FOLDER — manifest, entry, layouts/,
 * states/, `$include` siblings — and `definitions.ts` resolves all of that with rules that
 * took a long time to get right. Serving rows from an in-memory map would mean a second
 * implementation of those rules, and the two would disagree the first time either changed.
 * Writing the files back out means there is still ONE resolver, reading one kind of thing.
 *
 * NEVER INTO rx/. In the monorepo `RX_HOME` is somebody's authoring tree; hydrating there
 * would overwrite work in progress with whatever a database happened to hold. Rows land in
 * their own root, and `definitions.ts` searches it only AFTER the on-disk tiers, so a local
 * definition still wins exactly as it did — the same precedence the node loader applies
 * with [disk, rows].
 *
 * THE FINGERPRINT IS CHECKED HERE. This is the moment a row stops being data and becomes
 * something the universe renders, so it is the moment to notice that the definition and
 * the hash stored beside it disagree. A mismatch means the row was written around
 * `POST /publish` — the only route that computes the hash server-side — and it is skipped
 * rather than served. Tamper evidence, not prevention: a writer who can edit the row can
 * edit the hash. It costs nothing and it catches the careless case.
 *
 * RECONCILED, NOT REBUILT. An item uninstalled from the database must stop resolving, and
 * that used to be done by deleting the whole root and rewriting every row — correct, but it
 * meant every boot paid full disk writes for a tree that had not changed, and a request
 * arriving mid-rewrite could watch the tree vanish under it now that the public port is
 * bound before this runs. So: files whose contents already match are left untouched, files
 * the rows no longer describe are pruned, and only real changes are written. The
 * uninstall-stops-resolving rule survives in the prune pass, and the tree is never absent.
 */
import * as fs from "fs";
import * as path from "path";
import { fingerprintOf } from "./fingerprint.js";
import { INSTALLED_HOME } from "../paths.js";

/** One row, as `GET /items` returns it. */
export interface InstalledRow {
  kind: string;
  name: string;
  /** `{ files: { "<relative path>": "<contents>" } }` — what `collect.ts` publishes. */
  definition: unknown;
  fingerprint?: string;
  org?: string | null;
  enabled?: boolean;
}

export interface HydrateResult {
  written: number;
  /** Items whose files already matched the rows byte for byte — nothing touched. */
  unchanged: number;
  skipped: Array<{ kind: string; name: string; why: string }>;
}

/** Where a kind lands under the installed root. Mirrors the rx layout exactly, because
 *  the resolver already knows that layout and must not learn a second one. */
function targetDir(row: InstalledRow): string | null {
  const org = row.org?.trim() || null;
  const rx = path.join(INSTALLED_HOME, "rx");
  switch (row.kind) {
    // Org-owned tiers: a project folder, exactly as `projectDir` expects one.
    case "component":
      return org ? path.join(rx, org, "components") : path.join(rx, "marketplace", "components");
    case "template":
      // Templates are ALWAYS a project's. A template with no org has nowhere to live in
      // the resolver's model, so it is skipped rather than guessed at.
      return org ? path.join(rx, org, "templates") : null;
    case "atom":
      // Atoms live in ONE shared home. An org-tagged atom would be invisible to the
      // resolver, which never searches an org for one.
      return org ? null : path.join(rx, "marketplace", "atoms");
    case "style":
      return org ? path.join(rx, org, "styles") : path.join(rx, "marketplace", "styles");
    case "skill":
      return path.join(INSTALLED_HOME, "skills");
    case "prompt-block":
      return path.join(INSTALLED_HOME, "prompts", "blocks");
    default:
      // node (loaded from rows already), recipe (copied, never installed): not ours.
      return null;
  }
}

/**
 * A style row is the project's whole token tree, and a skill is a folder. Both are the
 * same shape as a component: a map of relative path to contents. The only difference is
 * whether the files sit under a folder named for the item or directly in the tier, which
 * is what the resolver expects for each.
 */
const FLAT_TIERS = new Set(["style", "prompt-block"]);

/**
 * FOUR SHAPES ARE STORED, and they are all legitimate. What a row holds depends on who
 * wrote it, and both writers predate this reader:
 *
 *   { files: {...} }      Studio publishing a project (items/collect.ts) — a folder.
 *   { "a/b.yaml": "…" }   A marketplace style: the token tree, as a bare path map.
 *   { kind, name, root }  A marketplace component or atom: the LOADED definition.
 *   { name, instructions } A marketplace skill, already parsed out of its SKILL.md.
 *
 * Reading only the first is what skipped 50 of 61 rows as "no files" — every item the
 * marketplace had installed. The shape is DETECTED rather than assumed from `source`,
 * because source says who wrote a row and not what they put in it.
 */
function filesOf(kind: string, name: string, definition: unknown): Record<string, string> | null {
  const d = definition as Record<string, any> | null;
  if (!d || typeof d !== "object") return null;

  // A folder, published whole.
  if (d.files && typeof d.files === "object") return d.files as Record<string, string>;

  // A skill is a SKILL.md, and it was parsed on the way in. Rebuilt from the same fields
  // the parser reads, so what lands is what a hand-authored skill would look like.
  if (kind === "skill") {
    const { instructions, contentHash: _drop, ...front } = d;
    return { "SKILL.md": frontMatter(front, String(instructions ?? "")) };
  }

  // A prompt block is a markdown file with frontmatter, parsed the same way.
  if (kind === "prompt-block") {
    const { content, id: _id, ...front } = d;
    return { [`${d.id ?? name}.md`]: frontMatter(front, String(content ?? "")) };
  }

  // A bare path map: every value a string and at least one key that looks like a file.
  const entries = Object.entries(d);
  if (entries.length && entries.every(([k, v]) => typeof v === "string" && /\.(ya?ml|json|md)$/.test(k))) {
    return d as Record<string, string>;
  }

  // Whatever is left is the loaded definition itself. Written as JSON because the loader
  // reads .json as readily as .yaml, and round-tripping it through YAML would be a second
  // chance to change it.
  return { [`${name.toLowerCase()}.json`]: JSON.stringify(d, null, 2) };
}

/** A markdown file with YAML frontmatter, the way both parsers expect to find it. */
function frontMatter(fields: Record<string, unknown>, body: string): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) lines.push(`${k}: [${v.map((x) => JSON.stringify(String(x))).join(", ")}]`);
    else lines.push(`${k}: ${JSON.stringify(String(v))}`);
  }
  lines.push("---", "", body.trim(), "");
  return lines.join("\n");
}

/**
 * Reconcile one row's files under `dir`: register every desired path in `keep`, write only
 * the ones whose contents differ from what is already on disk.
 */
function writeRow(row: InstalledRow, dir: string, keep: Set<string>): "written" | "unchanged" | "empty" {
  const files = filesOf(row.kind, row.name, row.definition);
  if (!files || !Object.keys(files).length) return "empty";
  const base = FLAT_TIERS.has(row.kind) ? dir : path.join(dir, row.name.toLowerCase());
  let changed = false;
  for (const [rel, contents] of Object.entries(files)) {
    // A stored path is data, and `../` in it would write outside the root. Rejected
    // rather than sanitised: a definition that needs to escape its own folder is not one
    // this platform produced.
    const full = path.join(base, rel);
    if (!full.startsWith(base + path.sep) && full !== base) continue;
    keep.add(full);
    try {
      if (fs.readFileSync(full, "utf8") === contents) continue;
    } catch {
      // Not there or unreadable: written below either way.
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf8");
    changed = true;
  }
  return changed ? "written" : "unchanged";
}

/** Remove files the rows no longer describe, then the empty folders that leaves behind. */
function prune(dir: string, keep: Set<string>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      prune(full, keep);
      try {
        fs.rmdirSync(full); // only succeeds once empty, which is exactly the intent
      } catch {}
    } else if (!keep.has(full)) {
      fs.rmSync(full, { force: true });
    }
  }
}

/**
 * Reconcile the installed root with what these rows describe.
 *
 * Disabled rows are LEFT OUT, not deleted-then-restored: `enabled: false` is a retraction,
 * and a retracted item must resolve to nothing exactly as an uninstalled one does. That is
 * the rule `fetchNodeRows` already applies to nodes. Both retractions land in the prune
 * pass — their files are simply not in `keep`.
 */
export function hydrateInstalled(rows: InstalledRow[]): HydrateResult {
  const result: HydrateResult = { written: 0, unchanged: 0, skipped: [] };
  const keep = new Set<string>();

  fs.mkdirSync(INSTALLED_HOME, { recursive: true });

  for (const row of rows) {
    if (row.enabled === false) continue;

    const dir = targetDir(row);
    if (!dir) continue; // a kind this root does not serve

    if (row.fingerprint && fingerprintOf(row.definition) !== row.fingerprint) {
      result.skipped.push({ kind: row.kind, name: row.name, why: "fingerprint does not match its definition" });
      continue;
    }

    const state = writeRow(row, dir, keep);
    if (state === "empty") {
      result.skipped.push({ kind: row.kind, name: row.name, why: "no files in the stored definition" });
      continue;
    }
    if (state === "written") result.written++;
    else result.unchanged++;
  }

  prune(INSTALLED_HOME, keep);

  return result;
}
