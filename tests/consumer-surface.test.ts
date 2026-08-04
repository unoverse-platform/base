/**
 * WHAT A CONSUMER CAN ACTUALLY REACH.
 *
 * This exists because of a break nothing caught. Local Studio loaded eight modules by
 * filesystem path out of `apps/unoverse/server/src`. Those files moved into this package,
 * every path pointed at nothing, and the whole suite stayed green — because the tests
 * exercise the modules directly and never the way a CONSUMER gets to them.
 *
 * So this asserts the consumer's view, not the implementation's:
 *   - the package resolves by name, from outside the package
 *   - the subpaths Studio and the server actually import are reachable
 *   - the modules load and export what their callers destructure
 *
 * Nothing here reads a relative path into the package on purpose. A test that reached in
 * directly would keep passing through exactly the kind of move that caused the break.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const require_ = createRequire(import.meta.url);

/**
 * `package.json` needs an EXPLICIT export entry, and this is why.
 *
 * The export map ends in a `./*` wildcard so any module is reachable by subpath. That
 * pattern also swallowed `package.json` and rewrote it to `./src/package.json.ts`, so
 * resolving it threw — and resolving it is how a consumer finds the package without
 * walking the tree, which is precisely what Studio does.
 */
test("the package resolves by name, and package.json is reachable", () => {
  const pkgPath = require_.resolve("@unoverse-platform/base/package.json");
  assert.ok(existsSync(pkgPath), "package.json must resolve, or a consumer cannot locate the package");
  const pkg = require_("@unoverse-platform/base/package.json");
  assert.equal(pkg.name, "@unoverse-platform/base");
});

/**
 * THE EIGHT LOCAL STUDIO LOADS BY PATH.
 *
 * Studio resolves this package, then reads these files off disk through Vite. They are the
 * exact set that silently went missing, so they are checked by the same route Studio uses.
 */
test("every module local Studio loads is present", () => {
  const src = resolve(require_.resolve("@unoverse-platform/base/package.json"), "../src");
  for (const f of [
    "definitions/definitions.ts",
    "definitions/theme.ts",
    "definitions/inputs.ts",
    "plugins/discovery.ts",
    "plugins/loader.ts",
    "platform/index.ts",
    "registry.ts",
    "executor.ts",
  ])
    assert.ok(existsSync(resolve(src, f)), `local Studio loads ${f} by path, and it is missing`);
});

/** The subpaths the server imports as a package. Import, not just exist: an export map can
 *  point at a file that does not resolve. */
test("the subpath exports load and carry their API", async () => {
  const cases: Array<[string, string[]]> = [
    ["manifests/runtime/index.js", ["performApi", "performService", "runCalls", "evaluate", "render"]],
    ["manifests/index.js", ["loadManifests"]],
    ["definitions/definitions.js", ["listDefinitions"]],
    ["definitions/theme.js", ["resolveThemes"]],
    ["definitions/inputs.js", ["inputPropKeys"]],
    ["agent-mcp/index.js", ["parseDiscoveredMCPs", "isTurnEndingHandoff", "DISCOVERY_TOOL_NAMES"]],
    ["template/index.js", ["evaluateSafeExpression", "resolveStringTemplate"]],
    ["paths.js", ["getPaths", "unoverseHome"]],
    ["boot.js", ["boot"]],
  ];
  for (const [subpath, expected] of cases) {
    const mod: any = await import(`@unoverse-platform/base/${subpath}`);
    for (const name of expected)
      assert.ok(name in mod, `@unoverse-platform/base/${subpath} must export ${name} — a caller destructures it`);
  }
});

/**
 * NO REACH BACK INTO THE MONOREPO.
 *
 * The package is published, so an import of `apps/unoverse/...` resolves here and nowhere
 * else. Eleven of these existed before the split and each one was invisible until grepped
 * for; this fails the build instead.
 */
test("no module imports out of this package", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const src = resolve(require_.resolve("@unoverse-platform/base/package.json"), "../src");
  const offenders: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!entry.endsWith(".ts")) continue;
      for (const m of readFileSync(full, "utf8").matchAll(/from\s+"([^"]+)"|import\(\s*"([^"]+)"/g)) {
        const spec = m[1] ?? m[2];
        /**
         * RESOLVED, not pattern-matched on `../../../`.
         *
         * Counting `../` was a proxy for "escapes the package", and it stopped being one as
         * the tree deepened: `src/manifests/runtime/channels/` is four levels down, so three
         * hops up lands on `src/` and is perfectly legal. The old rule failed that import
         * while a shallower file could genuinely escape with `../../` and pass.
         *
         * The question is only ever "does the target land outside src/", so ask that.
         */
        const escapes = spec.startsWith(".") && !resolve(dir, spec).startsWith(src + "/");
        if (spec.includes("apps/unoverse") || escapes)
          offenders.push(`${full.slice(src.length + 1)} → ${spec}`);
      }
    }
  };
  walk(src);

  assert.deepEqual(
    offenders,
    [],
    `these reach outside the package and will not resolve once installed:\n  ${offenders.join("\n  ")}`,
  );
});
