/**
 * An atom is catalogued under the name a Ref can resolve — its FILENAME.
 *
 * `name:` inside an atom is display copy (OutlineButton); refs load by basename
 * (`ref: outline-button` → outline-button.yaml). Cataloguing atoms under the display
 * name installed rows nothing could resolve: the hydrated file took the row's name and
 * every filename-keyed Ref missed, silently — a button that existed simply vanished.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "atom-identity-"));
mkdirSync(join(HOME, "rx/marketplace/atoms"), { recursive: true });
mkdirSync(join(HOME, "rx/marketplace/components"), { recursive: true });
writeFileSync(
  join(HOME, "rx/marketplace/atoms/outline-button.yaml"),
  'unoverse: "1.0"\nkind: atom\nname: OutlineButton\ndescription: display name differs from the filename on purpose\n',
);
process.env.UNOVERSE_HOME = HOME;
process.env.UNOVERSE_INSTALLED_HOME = join(HOME, ".installed");
process.env.NODES_HOME = join(HOME, "nodes");
process.env.SKILLS_HOME = join(HOME, "skills");

const { buildCatalogue } = await import("../src/items/catalogue.js");

test.after(() => rmSync(HOME, { recursive: true, force: true }));

test("a file atom is catalogued by its basename, never its display name", async () => {
  const items = await buildCatalogue();
  const atoms = items.filter((i) => i.kind === "atom");
  assert.equal(atoms.length, 1, "fixture atom was not catalogued at all");
  assert.equal(
    atoms[0].name,
    "outline-button",
    `catalogued as "${atoms[0].name}" — a name no Ref resolves, so installing it delivers nothing`,
  );
});
