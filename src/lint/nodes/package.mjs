/**
 * Rules about a PACKAGE rather than a node: allowedHosts covering every host its nodes
 * call, credentials declared once, node types unique across the whole tree, and shared/
 * fragments earning their place.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { report, rel, refCounts, derivedKinds, allCredentials, state } from "../context.mjs";
import { SCHEMA_ID, SECTIONS, validateAgainst } from "./schema.mjs";
import { readYaml, resolveRefs, sharedDirFor } from "./load.mjs";
import { lintNode } from "./node.mjs";

// ── one package ───────────────────────────────────────────────────────────────
export function lintPackage(dir) {
  const pkgFile = join(dir, "package.yaml");
  const pkg = { file: pkgFile, credentials: new Set(), requires: null, allowedHosts: [] };

  if (existsSync(pkgFile)) {
    const doc = readYaml(pkgFile);
    if (doc) {
      validateAgainst(SCHEMA_ID.package, doc, rel(pkgFile), "package.schema.json");
      pkg.requires = doc.requires ?? null;
      pkg.allowedHosts = (doc.allowedHosts ?? []).map((h) => String(h).toLowerCase());
      if (doc.name && doc.name !== dir.split("/").pop())
        report("warn", rel(pkgFile), `name "${doc.name}" does not match the folder name "${dir.split("/").pop()}"`);
    }
  }

  const credDir = join(dir, "credentials");
  if (existsSync(credDir))
    for (const f of readdirSync(credDir).filter((f) => /\.ya?ml$/.test(f))) {
      const doc = readYaml(join(credDir, f));
      if (!doc) continue;
      validateAgainst(SCHEMA_ID.credential, doc, rel(join(credDir, f)), "credential.schema.json");
      if (doc.name) pkg.credentials.add(doc.name);
      if (doc.name && doc.name !== f.replace(/\.ya?ml$/, ""))
        report("warn", rel(join(credDir, f)), `declares name "${doc.name}" but the file is ${f}. Nodes reference the NAME, so keep them the same`);

      // Two packages may both declare a credential, but they must agree on it:
      // context.credentials is ONE flat bag keyed by name, so a disagreement means
      // whichever package loses the race describes a credential it cannot read.
      if (doc.name) {
        const fields = (doc.properties ?? []).map((p) => p.name).sort().join(",");
        const prior = allCredentials.get(doc.name);
        if (prior && prior.fields !== fields)
          report(
            "error",
            rel(join(credDir, f)),
            `credential "${doc.name}" is also declared in ${prior.file} with different fields (${prior.fields} vs ${fields}). They share one entry in context.credentials and must agree (04-credentials.md)`,
          );
        else if (!prior) allCredentials.set(doc.name, { file: rel(join(credDir, f)), fields });
      }
    }

  // MIGRATION HAZARD, checked per package because the credential's NAME often is not
  // in this package's source at all (openai re-exports OpenAICredential from
  // plugin-base, so only the identifier appears here).
  //
  // registerCredentialType is first-wins-and-SILENT: it logs "already registered,
  // skipping" and returns. With a credentials/*.yaml AND a live api.registerCredential
  // call, whichever loads first takes the slot and the other vanishes. A wrong
  // credential type then makes getDecryptedCredential quietly skip decryption, which
  // surfaces as an auth failure with the right credential visibly selected.
  if (pkg.credentials.size) {
    const entry = join(dir, "src/index.ts");
    if (existsSync(entry) && /api\.registerCredential\s*\(/.test(readFileSync(entry, "utf8")))
      report(
        "error",
        rel(entry),
        `still calls api.registerCredential() while this package also declares credentials/ manifests. Registration is first-wins and silent, so one of them is dropped at random. Move the declaration, do not copy it (04-credentials.md)`,
      );
  }

  const nodesDir = join(dir, "nodes");
  if (!existsSync(nodesDir)) return 0;

  let count = 0;
  const types = new Map();
  for (const entry of readdirSync(nodesDir)) {
    const nd = join(nodesDir, entry);
    if (!statSync(nd).isDirectory()) continue;
    const node = lintNode(nd, pkg);
    count++;
    if (node?.type) {
      if (types.has(node.type))
        report("error", rel(nd), `type "${node.type}" is already used by ${types.get(node.type)}. A node type is a stable global identity`);
      else types.set(node.type, entry);
      if (node.type !== entry)
        report("warn", rel(nd), `folder is "${entry}" but type is "${node.type}". Keep them the same so a type is findable by path`);
    }
  }

  // A shared/ fragment with one consumer should be inlined; shared/ is for DATA
  // several nodes genuinely share, and it silts up if nothing prunes it.
  const sharedDir = join(dir, "shared");
  if (existsSync(sharedDir))
    for (const f of readdirSync(sharedDir).filter((f) => /\.ya?ml$/.test(f))) {
      const n = refCounts.get(join(sharedDir, f))?.size ?? 0;
      /**
       * A HELPERS FILE IS REACHED BY NAME, not by $ref: `helpers:` declarations are collected
       * from every shared file and called as `helpers.someName(...)` from inside an
       * expression. Counting $refs alone reads that as dead and tells the author to delete
       * the file their node depends on — the worst possible advice, delivered confidently.
       */
      const declaresHelpers = /^helpers\s*:/m.test(readFileSync(join(sharedDir, f), "utf8"));
      if (declaresHelpers) continue;
      if (n === 0) report("warn", rel(join(sharedDir, f)), `is referenced by nothing. Delete it or $ref it`);
      else if (n === 1) report("hint", rel(join(sharedDir, f)), `has a single consumer. A fragment earns shared/ at the SECOND one, otherwise inline it`);
    }

  return count;
}
