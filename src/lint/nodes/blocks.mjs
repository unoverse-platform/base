/**
 * THE TEMPLATE VOCABULARY a manifest may use: the helpers the platform registers, and the prompt
 * blocks it ships. Both answer the same question — "does this name resolve at run time?" — and both
 * fail the same way if it does not: silently, at run time, in a prompt.
 *
 * ITS OWN MODULE TO BREAK A CYCLE. These lived in `package.mjs` after the linter was split out of
 * scripts/, but the only consumer is `node.mjs`, and `package.mjs` already imports `node.mjs` to
 * lint each node — so importing them back would be circular. Neither is a package-level rule
 * anyway: they are facts about the template language, shared by every node in every package.
 */
import { readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { rel, state } from "../context.mjs";

/**
 * Handlebars built-ins plus the helpers the platform registers in
 * engine/src/template/StringTemplateResolver.ts. Anything else compiles fine and
 * then throws when the node actually runs, which is the worst place to find out.
 */
export const HANDLEBARS_HELPERS = new Set([
  "if", "unless", "each", "with", "lookup", "log", "else", // built-in
  "toJSON", "filter", "eq", "contains", // registered
]);

/**
 * The prompt-block library: prompts/blocks/**\/*.md, keyed the way the resolver keys them
 * (engine/src/template/promptBlocks.ts) — the filename camelCased, so markdown-guidelines.md is
 * referenced as {{prompt.markdownGuidelines}}.
 *
 * A manifest must never hold a COPY of a block's words: that is a fork that silently stops tracking
 * the block. It references, and this checks the reference resolves.
 *
 * COMPUTED PER RUN, not once at import. As a CLI this was a module-level IIFE over a `NODES_HOME`
 * constant; the split left that constant behind and the IIFE ran at import time, so the whole linter
 * threw `NODES_HOME is not defined` before `lintNodes` was even called. A constant is also wrong on
 * its own terms now: Studio, /publish and CI each lint their own tree, and a value frozen at import
 * would describe whichever tree loaded first. `state.nodesHome` is set by `reset()` every run.
 *
 * Memoized per home, because one lint walks many packages and the library is the same for all.
 */
const CACHE = new Map();

export function promptBlocks() {
  const home = resolve(state.nodesHome, "../prompts/blocks");
  const cached = CACHE.get(home);
  if (cached) return cached;

  const found = new Map();
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith(".md")) {
        const id = e.replace(/\.md$/, "");
        found.set(id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), rel(p));
      }
    }
  };
  walk(home);
  CACHE.set(home, found);
  return found;
}
