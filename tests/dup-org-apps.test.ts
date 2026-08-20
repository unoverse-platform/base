/**
 * DUPLICATE-NAME SURVIVAL GUARD — two orgs sharing a component name must never take
 * the platform down (UNOVERSE_COMPONENT_ORGS.md).
 *
 * What it pins, against a fixture tree where orga and orgb both ship `twin`:
 *
 *   1. listApps() SURVIVES and lists both twins (per-entry isolation): this list is
 *      built inside MCP server construction, so a throw here answered -32603 to every
 *      initialize on every door — one publish dropped the whole universe (observed
 *      live, bppunoverse 2026-08-20).
 *   2. Each org's app addresses ITS OWN twin: previewComponents carries the qualified
 *      ref, so the app door, brief schema and lifecycle all resolve unambiguously.
 *   3. The resolver's three-way rule: bare + no context throws (names the qualified
 *      candidates); bare + org context resolves that org's own; qualified resolves.
 *
 * The paths module reads UNOVERSE_HOME at import time, so the fixture run happens in
 * a SUBPROCESS with the env set; this file only asserts on its output.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "dup-orgs");

const SCRIPT = `
import { listApps, loadDefinition } from "${join(HERE, "..", "src", "definitions", "definitions.ts").replace(/\\/g, "/")}";
const apps = listApps();
const twins = apps.filter((a) => a.id === "twin");
const out = {
  twinOrgs: twins.map((t) => t.org).sort(),
  previews: twins.map((t) => (t.previewComponents ?? [])[0]).sort(),
  bareThrows: (() => { try { loadDefinition("twin", "component"); return false; } catch { return true; } })(),
  ctxA: loadDefinition("twin", "component", "expanded", "orga")?.org ?? null,
  ctxB: loadDefinition("twin", "component", "expanded", "orgb")?.org ?? null,
  qualified: loadDefinition("orgb/twin", "component")?.org ?? null,
};
console.log(JSON.stringify(out));
`;

test("two orgs sharing a component name: apps list survives and self-addresses", () => {
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, UNOVERSE_HOME: FIXTURE },
    cwd: join(HERE, ".."),
  });
  assert.equal(r.status, 0, `subprocess failed:\n${r.stderr}`);
  const lines = r.stdout.trim().split("\n");
  const out = JSON.parse(lines[lines.length - 1]);
  assert.deepEqual(out.twinOrgs, ["orga", "orgb"], "both orgs' twins are listed as apps");
  assert.deepEqual(out.previews, ["orga/twin", "orgb/twin"], "each app addresses its OWN twin, qualified");
  assert.equal(out.bareThrows, true, "a context-free bare ref is a loud error, not a guess");
  assert.equal(out.ctxA, "orga", "orga context resolves orga's twin");
  assert.equal(out.ctxB, "orgb", "orgb context resolves orgb's twin");
  assert.equal(out.qualified, "orgb", "the qualified ref resolves");
});
