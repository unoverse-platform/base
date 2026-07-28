/**
 * The declarative node linter, as a LIBRARY. Rules in, findings out.
 *
 * It prints nothing and exits nothing, because four callers need the same rules and each
 * presents them differently:
 *
 *   `unoverse lint nodes`  coloured lines in a terminal (scripts/lib/lint-nodes.mjs)
 *   Studio                 findings beside the definition you are editing
 *   POST /publish          a refusal, so a broken manifest never reaches the database
 *   CI                     a non-zero exit
 *
 * It lived in scripts/ as a CLI, which meant the universe could not use it. Publishing
 * without it is the gap LOCAL_STUDIO.md:246 names: "a malformed definition is one restart
 * from a broken server", and a published row does not even need the restart.
 *
 * FOUR TIERS (docs/architecture/DECLARATIVE_NODES.md §6). This is tiers 2 and 3.
 *   1  editor    $schema pointers + .vscode yaml.schemas, no tool
 *   2  structural   every part validated against nodes/_schema/*.json
 *   3  semantic     the cross-file rules a schema cannot express
 *   4  dry run      `unoverse node test`, executes against testData, not here
 */
import { readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { problems, derivedKinds, reset, report } from "../context.mjs";
import { loadSchemas } from "./schema.mjs";
import { lintPackage } from "./package.mjs";

/**
 * Lint every node package under `nodesHome`.
 *
 * Returns findings rather than printing them, and NEVER throws for a lint failure: a
 * missing directory or unreadable schema is itself reported, so a caller gets one shape
 * of answer whatever went wrong.
 */
export function lintNodes(nodesHome) {
  const home = resolve(nodesHome);
  reset(home, join(home, "_schema"));

  if (!existsSync(home)) {
    report("error", home, "no nodes directory here");
    return { problems: [...problems], derivedKinds: new Map(), nodeCount: 0, pkgCount: 0, nodesHome: home };
  }

  loadSchemas();

  let nodeCount = 0,
    pkgCount = 0;
  for (const entry of readdirSync(home)) {
    const dir = join(home, entry);
    if (entry.startsWith("_") || entry.startsWith(".") || !statSync(dir).isDirectory()) continue;
    if (!existsSync(join(dir, "nodes")) && !existsSync(join(dir, "package.yaml"))) continue; // pure code package
    pkgCount++;
    nodeCount += lintPackage(dir);
  }

  const rank = { error: 0, warn: 1, hint: 2 };
  const sorted = [...problems].sort((a, b) => rank[a.level] - rank[b.level] || a.file.localeCompare(b.file));
  return { problems: sorted, derivedKinds: new Map(derivedKinds), nodeCount, pkgCount, nodesHome: home };
}

/** True when anything would fail a build. Warnings and hints inform, errors stop. */
export function hasErrors(result) {
  return result.problems.some((p) => p.level === "error");
}
