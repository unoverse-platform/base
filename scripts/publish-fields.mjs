#!/usr/bin/env node
/**
 * Apply `publishConfig`'s field overrides, because npm does not.
 *
 * npm's `publishConfig` carries CONFIG values: registry, tag, access, provenance.
 * Rewriting `main`/`types`/`exports` at publish time is a pnpm and Yarn Berry feature, and
 * npm copies those fields into the tarball untouched. So this package published `exports`
 * pointing at `./src/*.ts` while `files` shipped only `dist/`, and every subpath import of
 * the published package resolved to a path that was not in the tarball:
 *
 *   Failed to load url .../@unoverse-platform/base/src/paths.ts. Does the file exist?
 *
 * Verified rather than assumed (npm 10.8.2): `npm pack` on this package produced a
 * package.json with `main: ./src/index.ts`, and `npm view @unoverse-platform/base exports`
 * agreed for every version up to 0.3.7.
 *
 * `apply` runs on prepack and `restore` on postpack, so the tarball gets dist paths and the
 * working tree keeps the source paths the monorepo resolves against. The backup is a real
 * file rather than a variable because pack and publish are separate processes, and a failed
 * publish must not leave the working tree rewritten.
 */
import { readFileSync, writeFileSync, existsSync, rmSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgFile = join(pkgDir, "package.json");
const backup = join(pkgDir, "package.json.prepack");

/**
 * Keys of `publishConfig` that ARE npm config and must stay where they are. Everything
 * else in there is a package.json field being overridden. A denylist rather than an
 * allowlist, so adding `bin` or `imports` later needs no change here.
 */
const NPM_CONFIG_KEYS = new Set(["access", "registry", "tag", "provenance"]);

const mode = process.argv[2];

if (mode === "apply") {
  const raw = readFileSync(pkgFile, "utf8");
  const pkg = JSON.parse(raw);
  const overrides = pkg.publishConfig ?? {};

  const fields = Object.keys(overrides).filter((k) => !NPM_CONFIG_KEYS.has(k));
  if (!fields.length) process.exit(0);

  // Byte-for-byte, so restore cannot reformat a file somebody is about to commit.
  writeFileSync(backup, raw);
  for (const key of fields) pkg[key] = overrides[key];
  writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`[publish-fields] applied: ${fields.join(", ")}`);
} else if (mode === "restore") {
  // Missing backup means apply never ran or already restored. Not an error: postpack must
  // not fail a publish that otherwise worked.
  if (existsSync(backup)) {
    rmSync(pkgFile, { force: true });
    renameSync(backup, pkgFile);
    console.log("[publish-fields] restored package.json");
  }
} else {
  console.error("usage: publish-fields.mjs apply|restore");
  process.exit(1);
}
