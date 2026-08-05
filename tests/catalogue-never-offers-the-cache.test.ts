/**
 * The catalogue offers AUTHORED work only — never the database's own cache.
 *
 * Installing an item hydrates it into INSTALLED_HOME so loaders can serve it. The
 * catalogue's disk source then found those files and stamped them origin "local":
 * the act of installing branded the item "YOURS, ON DISK" and locked it out of
 * marketplace management. Could-not-tell-cache-from-authored, the day's oldest bug.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "cache-not-authored-"));
// NOTHING authored anywhere; EVERYTHING lives only in the installed cache.
mkdirSync(join(HOME, "rx"), { recursive: true });
mkdirSync(join(HOME, ".installed/prompts/blocks/formatting"), { recursive: true });
writeFileSync(
  join(HOME, ".installed/prompts/blocks/formatting/markdownGuidelines.md"),
  "---\nname: Markdown Guidelines\ndescription: installed row, hydrated\n---\nUse markdown.\n",
);
mkdirSync(join(HOME, ".installed/skills/pricing-quotes"), { recursive: true });
writeFileSync(
  join(HOME, ".installed/skills/pricing-quotes/SKILL.md"),
  "---\nname: pricing-quotes\ndescription: installed skill\n---\nQuote things.\n",
);
mkdirSync(join(HOME, ".installed/rx/marketplace/components/streamingtext"), { recursive: true });
writeFileSync(
  join(HOME, ".installed/rx/marketplace/components/streamingtext/streamingtext.yaml"),
  "name: StreamingText\nprops:\n  text:\n    type: string\n    input: true\n",
);

process.env.UNOVERSE_HOME = HOME;
process.env.UNOVERSE_INSTALLED_HOME = join(HOME, ".installed");
process.env.NODES_HOME = join(HOME, "nodes");
process.env.SKILLS_HOME = join(HOME, "skills");
process.env.PROMPT_BLOCKS_HOME = join(HOME, "prompts/blocks");
process.env.PLUGINS_DIR = join(HOME, "plugins");

const { buildCatalogue } = await import("../src/items/catalogue.js");
const { loadPromptBlocks } = await import("../src/items/loaders.js");

test.after(() => rmSync(HOME, { recursive: true, force: true }));

test("installed-only content is SERVED but never CATALOGUED as local", async () => {
  // Serving reads the cache — the block must resolve (this is what templates expand).
  const served = loadPromptBlocks();
  assert.ok(served.some((b) => b.id === "markdownGuidelines"), "the installed block must still SERVE");

  // The catalogue must not offer any of it back as authored work.
  const items = await buildCatalogue();
  const ghosts = items.filter((i) => ["prompt-block", "skill", "component", "atom"].includes(i.kind));
  assert.deepEqual(
    ghosts.map((g) => `${g.kind}/${g.name}`),
    [],
    'the catalogue offered the hydration cache back as authored work — this is "yours, on disk" on every install',
  );
});
