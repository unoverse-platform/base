/**
 * AGENT-MCP NO-FORK GUARD — the agent-MCP harness lives ONCE.
 *
 * The model-agnostic half of every agent's tool loop (spatial discovery parsing,
 * interactive-app minting + etiquette, turn-end provenance) is
 * `@unoverse-platform/base/agent-mcp` (source: packages/base/src/agent-mcp).
 *
 * MOVED 2026-07-27 out of plugin-base. It was never node-specific: it is the MCP judgement
 * the RUNTIME makes, and leaving it in the legacy node library meant the runtime depended
 * on the package the migration is retiring. plugin-base re-exports it for the code nodes
 * that still import it, and that shim goes when the last of them does.
 * History: it lived only in the openai family, GLM couldn't discover apps at all,
 * and Grok carried a fork — behavioral fixes silently missed whole families.
 *
 * This guard fails the build when an agent node family re-implements the logic
 * instead of importing it:
 *   1. The canonical module must exist in base.
 *   2. No node package source may contain the harness's implementation markers
 *      (the app-row parsing literal `object_type` or the INTERACTIVE-APP etiquette
 *      string) — those live only in the harness.
 *   3. Any node source file that USES the harness API must import it from
 *      `@unoverse-platform/base/agent-mcp` (adapters map wire shapes; they
 *      never re-implement).
 *
 * If this fails: delete the fork and import the harness. If the harness itself
 * needs to change, change it in base — every family gets the fix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
/**
 * THE FOLDER, not one file.
 *
 * This read `agent-mcp/index.ts` alone, which was right while the harness WAS one 823-line
 * module. Split by job, every marker it looks for moved into a sibling and the guard went
 * red — correctly, but for the wrong reason. A guard that names one file passes by seeing
 * nothing the moment its subject moves, so it reads the whole folder now.
 */
const HARNESS_DIR = join(ROOT, "packages/base/src/agent-mcp");
const HARNESS_SRC = readdirSync(HARNESS_DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => readFileSync(join(HARNESS_DIR, f), "utf8"))
  .join("\n");
const NODES_DIR = join(ROOT, "apps/unoverse/nodes");

// The agent-side parse comparison, not the bare field name — SpatialIngest legitimately
// WRITES `object_type` rows as a producer; only CONSUMING them as tools is harness logic.
const IMPL_MARKERS = ['object_type === "mcp"', "INTERACTIVE APP:"];

// BURN-DOWN LIST — known pre-existing forks, tolerated until ported to the harness
// (see project TODO: agent-mcp harness extraction). Porting one = delete its entry;
// the guard then keeps it honest forever. Adding to this list requires the same
// justification as changing the harness itself.
const KNOWN_FORKS = [
  // xai-grok's fork left on 2026-07-28, the same way openai-realtime's did: not ported, but made
  // unnecessary by the package becoming a manifest. `transport: ws` plus api/audio.yaml replaced the
  // SessionOrchestrator outright, so there is no second copy of the MCP judgements left to drift.
  // openai-realtime's fork left on 2026-07-27, not by being ported but by the package becoming
  // a manifest: `transport: ws` replaced the orchestrator outright. Same outcome for this
  // guard — one fewer place making its own MCP judgements.
];
const API_MARKERS = ["isTurnEndingHandoff", "parseDiscoveredMCPs", "hasDynamicHandoff", "toolDefFromDiscoveredMCP"];
/**
 * BASE, not plugin-base. The re-export shim in plugin-base is gone: plugin-base is CJS and base
 * is ESM, so `export * from` across that boundary does not compile, and it broke the build the
 * moment plugin-base was next built. It had exactly one consumer, so pointing that consumer at
 * base directly was cheaper than making plugin-base ESM — which every still-code node package
 * depends on.
 */
const HARNESS_IMPORT = "@unoverse-platform/base/agent-mcp";

function tsFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) tsFilesUnder(p, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function nodeSrcFiles(): string[] {
  const out: string[] = [];
  for (const pkg of readdirSync(NODES_DIR)) {
    const src = join(NODES_DIR, pkg, "src");
    try {
      if (statSync(src).isDirectory()) tsFilesUnder(src, out);
    } catch {
      /* not a package dir */
    }
  }
  return out;
}

test("agent-mcp: canonical harness exists in base", () => {
  assert.ok(existsSync(HARNESS_DIR), `missing ${HARNESS_DIR} — the harness is the single home of agent MCP behavior`);
  const src = HARNESS_SRC;
  // The harness parses mcp rows with an early-continue (`!== "mcp"`), so check the
  // field name + etiquette + API surface rather than the fork-detection literal.
  for (const marker of ["object_type", "INTERACTIVE APP:", ...API_MARKERS]) {
    assert.ok(src.includes(marker), `harness lost its '${marker}' — implementation moved without updating this guard?`);
  }
});

test("agent-mcp: no node package re-implements the harness", () => {
  const offenders: string[] = [];
  for (const file of nodeSrcFiles()) {
    if (KNOWN_FORKS.some((k) => file.endsWith(k))) continue; // burn-down list — port, then delete the entry
    const src = readFileSync(file, "utf8");
    for (const marker of IMPL_MARKERS) {
      if (src.includes(marker)) offenders.push(`${file} (contains '${marker}')`);
    }
  }
  assert.deepEqual(offenders, [], "harness logic forked into node source — import @unoverse-platform/plugin-base/agent-mcp instead");
});

test("agent-mcp: harness consumers import it from plugin-base", () => {
  const offenders: string[] = [];
  for (const file of nodeSrcFiles()) {
    const src = readFileSync(file, "utf8");
    if (API_MARKERS.some((m) => src.includes(m)) && !src.includes(HARNESS_IMPORT)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], "file uses harness API without importing @unoverse-platform/plugin-base/agent-mcp");
});

/**
 * A tolerated fork must still EXIST.
 *
 * `KNOWN_FORKS` is only ever consulted as a skip list, so a stale entry is invisible: the file
 * it names is gone, nothing skips anything, and the list reads as more debt than there is. That
 * is the same failure the grandfathered-packages guard is built to prevent, and it nearly
 * happened here — openai-realtime's entry outlived its file by becoming a manifest.
 */
test("every tolerated fork still exists", () => {
  const missing = KNOWN_FORKS.filter((k) => !existsSync(join(NODES_DIR, "..", k)) && !existsSync(join(NODES_DIR, k.replace(/^nodes\//, ""))));
  assert.deepEqual(
    missing,
    [],
    `these forks are listed as tolerated but the files are gone: ${missing.join(", ")}. ` +
      `They were ported or migrated — delete their entries, or the list overstates the debt.`,
  );
});
