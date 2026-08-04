/**
 * A node installed as a ROW must behave exactly like the same node read from disk.
 *
 * That is the whole promise of installing to the database: no npm, no restart, no
 * second code path. The risk it guards is drift, so the test does not assert a shape
 * it invented. It takes the REAL manifests off disk, turns them into rows the way the
 * marketplace does, loads them back through the row source, and demands the composed
 * result be identical. If the two sources ever diverge, this fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { diskSource, rowsSource, type ItemRow } from "@unoverse-platform/base/manifests/source.js";
import { composeNode } from "@unoverse-platform/base/manifests/compose.js";
import { NODES_HOME } from "@unoverse-platform/base/paths.js";

/** Exactly the payload the marketplace stores for `kind: node`. */
async function rowsFromDisk(): Promise<ItemRow[]> {
  const rows: ItemRow[] = [];
  for (const pkg of await diskSource(NODES_HOME).listPackages()) {
    for (const raw of pkg.nodes) {
      rows.push({
        name: raw.dir,
        definition: {
          package: {
            name: pkg.name,
            packageFile: pkg.packageFile ?? null,
            credentials: pkg.credentials,
            shared: pkg.shared,
          },
          dir: raw.dir,
          files: raw.files,
        },
      });
    }
  }
  return rows;
}

test("a node composed from a row is identical to the same node composed from disk", async () => {
  const diskPackages = await diskSource(NODES_HOME).listPackages();
  const rowPackages = await rowsSource(rowsFromDisk).listPackages();

  const fromDisk = new Map<string, any>();
  for (const pkg of diskPackages)
    for (const raw of pkg.nodes) fromDisk.set(raw.dir, composeNode(raw, pkg));

  const fromRows = new Map<string, any>();
  for (const pkg of rowPackages)
    for (const raw of pkg.nodes) fromRows.set(raw.dir, composeNode(raw, pkg));

  assert.ok(fromDisk.size > 0, "no manifest nodes on disk, so this test proves nothing");
  assert.deepEqual(
    [...fromRows.keys()].sort(),
    [...fromDisk.keys()].sort(),
    "the row source produced a different set of nodes than disk",
  );

  for (const [type, disk] of fromDisk) {
    const row = fromRows.get(type);
    // `origin` is expected to differ: it names where the manifest came from, which is
    // the one thing that legitimately changes between a folder and a row.
    assert.deepEqual(row.definition, disk.definition, `${type}: definition differs between row and disk`);
    assert.equal(row.kind, disk.kind, `${type}: kind differs`);
    assert.deepEqual(row.api, disk.api, `${type}: api block differs`);
    assert.deepEqual(row.allowedHosts, disk.allowedHosts, `${type}: allowedHosts differs`);
    assert.equal(row.packageName, disk.packageName, `${type}: package differs`);
  }
});

test("a row with no node.yaml is skipped rather than half-loaded", async () => {
  const packages = await rowsSource(async () => [
    { name: "Broken", definition: { package: { name: "x" }, dir: "Broken", files: { "config.yaml": "x: 1" } } },
  ]).listPackages();
  assert.equal(packages.length, 0);
});
