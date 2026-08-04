/**
 * A MANIFEST SERVICE NODE IS REACHABLE, which it was not until 2026-07-29.
 *
 * `executeServiceCall` constructed the executor as `new ExecutorClass()`, with no argument,
 * while the two graph paths in the same file both pass `nodeDef.type`. A code node never
 * noticed: its executor hardcodes its own type in its constructor. The two SHARED manifest
 * classes cannot, because one class serves every manifest node, so the type IS the argument.
 *
 * The result was `No manifest loaded for node type "undefined"` on every service call, and a
 * consuming agent that discovered ZERO tools and simply answered without them. Nothing threw
 * in the agent's path; the tool list was empty and the model carried on.
 *
 * It survived the entire migration because every manifest node before SpatialSearch is
 * reached by the GRAPH. SpatialSearch is the first that is only ever called as a service.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { executorForKind } from "../src/manifests/executor/index.js";

/**
 * The construction contract, asserted directly on the shared classes: they take the node
 * type and keep it, because a lookup by `this.nodeType` is how every method finds its
 * manifest.
 */
test("both shared manifest executors take the node type and keep it", () => {
  for (const kind of ["PromiseNode", "CallbackNode"] as const) {
    const Cls = executorForKind(kind);
    const withType = new Cls("SpatialSearch");
    assert.equal(withType.nodeType, "SpatialSearch", `${kind} did not keep the type it was constructed with`);

    // The failing case, stated so the reason this file exists is legible: constructed with
    // nothing, the lookup key is undefined and every method fails on a node that IS loaded.
    const without = new Cls();
    assert.equal(without.nodeType, undefined);
  }
});

/**
 * THE REAL GUARD. The bug was not in the classes, it was one call site out of three passing
 * no argument, so this reads the source and holds all three to the same contract.
 *
 * Asserted against the text because the alternative is booting a registry, a manifest loader
 * and an HTTP route to prove one argument is present.
 */
test("every executor construction site passes the node type", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/executor.ts", import.meta.url), "utf8");

  // COMMENTS STRIPPED FIRST. This file's own explanation of the bug quotes the bad form,
  // and the guard matched that, failing on a fixed file — a guard that cries wolf gets
  // deleted. Only an ASSIGNMENT counts as a construction site.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const sites = code.match(/=\s*new ExecutorClass\([^)]*\)/g) ?? [];
  assert.ok(sites.length >= 3, `expected at least 3 construction sites, found ${sites.length}`);

  const bare = sites.filter((s) => /new ExecutorClass\(\s*\)/.test(s));
  assert.deepEqual(
    bare,
    [],
    `these construct the executor with NO node type: ${bare.join(", ")}. ` +
      `A manifest node's type is the constructor argument — without it the manifest lookup ` +
      `is by "undefined" and the node is unreachable on that channel.`,
  );
});

test("the service channel is one of the sites that passes it", async () => {
  // Named explicitly: this is the channel that was broken, and the one with no graph path to
  // fall back on. A pure service node is reached ONLY here.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/executor.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const fn = code.slice(code.indexOf("export async function executeServiceCall"));
  const site = fn.slice(0, fn.indexOf("handleServiceCall")).match(/=\s*new ExecutorClass\([^)]*\)/)?.[0];
  assert.ok(site, "executeServiceCall no longer constructs an executor — did it move?");
  assert.ok(!/new ExecutorClass\(\s*\)/.test(site), "executeServiceCall constructs without the node type");
});
