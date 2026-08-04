#!/usr/bin/env node
/**
 * Copy the linters into dist. Part of the build, not an afterthought.
 *
 * The two linters are plain JavaScript (.mjs) so the CLIs can run them under bare node with
 * no build step, which is why `unoverse lint` works in a fresh clone. `tsc` does not process
 * or emit .mjs, so `npm run build` produced a dist where `items/publish.js` imports
 * `../lint/rx/index.mjs` and that folder does not exist.
 *
 * Installed, that is a runtime failure on the first lint: the package resolves, the import
 * throws, and nothing catches it at publish time because the source tree looks complete.
 * Verified by `npm pack --dry-run`, which showed ZERO lint files in the tarball.
 *
 * The .d.mts declarations come too, or consumers lose the types the source has.
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(pkg, "src/lint");
const out = join(pkg, "dist/lint");

if (!existsSync(src)) {
  console.error(`[copy-lint] no linters at ${src}`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
cpSync(src, out, {
  recursive: true,
  filter: (from) => !/\.(ts|tsx)$/.test(from) || from.endsWith(".d.mts"),
});
console.log("[copy-lint] src/lint → dist/lint");
