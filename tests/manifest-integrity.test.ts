/**
 * THE CONTENT HASH — asserted on the properties it is claimed to have.
 *
 * A hash is easy to compute and easy to get subtly wrong, and every way of getting it
 * wrong is silent. A hash that ignores the package envelope leaves `allowedHosts` editable. A
 * hash sensitive to key order changes when someone reorders a YAML block and reads as a
 * tamper. A hash that includes `origin` differs between a laptop and a server, so it can
 * never be compared, which is its only purpose.
 *
 * So these tests state the properties rather than pinning a value: a golden string would
 * pass while the hash covered nothing at all.
 *
 * See SECURITY.md §"Manifest integrity — phase 1, the content hash".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const UNOVERSE = join(HERE, "../../../apps/unoverse");

const { hashNode, assertUnchanged, IntegrityError } = await import("@unoverse-platform/base/manifests/integrity.js");
const { composeNode } = await import("@unoverse-platform/base/manifests/compose.js");
const { diskSource } = await import("@unoverse-platform/base/manifests/source.js");

const NODES = join(UNOVERSE, "nodes");

/** A minimal composed-node shape. Only the fields the hash reads matter here. */
const node = (over: Record<string, unknown> = {}): any => ({
  type: "T",
  kind: "PromiseNode",
  packageName: "p",
  allowedHosts: ["api.example.com"],
  origin: "/somewhere/on/disk",
  definition: { type: "T", outputs: [{ name: "a" }, { name: "b" }] },
  api: { run: [{ name: "one", url: "https://api.example.com/x", transport: "json" }] },
  ...over,
});

test("the same node hashes the same way twice", () => {
  assert.equal(hashNode(node()), hashNode(node()));
});

test("changing a URL changes the hash", () => {
  const tampered = node({ api: { run: [{ name: "one", url: "https://evil.example/x", transport: "json" }] } });
  assert.notEqual(hashNode(node()), hashNode(tampered));
});

/**
 * THE ONE THAT MATTERS. `allowedHosts` lives in package.yaml, outside the node's own files, so
 * a hash over the node alone would leave the allowlist that bounds it freely editable.
 */
test("changing ALLOWED_HOSTS changes the hash, because the allowlist is inside the seal", () => {
  const widened = node({ allowedHosts: ["api.example.com", "evil.example"] });
  assert.notEqual(
    hashNode(node()),
    hashNode(widened),
    "if this passes, someone can add a host to package.yaml without breaking the seal",
  );
});

test("key ORDER does not change the hash, so reformatting is not a tamper", () => {
  const reordered = node({
    api: { run: [{ transport: "json", url: "https://api.example.com/x", name: "one" }] },
  });
  assert.equal(hashNode(node()), hashNode(reordered));
});

/**
 * Arrays are order-SENSITIVE and must stay that way: `run` order is the order calls
 * happen, and `events` order is the connector order lint enforces. Sorting them for
 * canonicalisation would erase meaning and hide a real change.
 */
test("ARRAY order DOES change the hash, because order is meaning", () => {
  const swapped = node({ definition: { type: "T", outputs: [{ name: "b" }, { name: "a" }] } });
  assert.notEqual(hashNode(node()), hashNode(swapped), "reordering output connectors is a real change");
});

test("origin is EXCLUDED, so the same node hashes identically on a laptop and a server", () => {
  assert.equal(
    hashNode(node()),
    hashNode(node({ origin: "postgres:p/T" })),
    "including the path would make the value impossible to compare, which is its only use",
  );
});

test("a source with no recorded hash is accepted — disk is governed by git", () => {
  assert.doesNotThrow(() => assertUnchanged(node(), undefined, "p/T"));
});

test("a recorded hash that matches is accepted", () => {
  const n = node();
  assert.doesNotThrow(() => assertUnchanged(n, hashNode(n), "p/T"));
});

test("a recorded hash that does NOT match is refused, by name", () => {
  assert.throws(
    () => assertUnchanged(node(), "sha256:0000", "p/T"),
    (err: any) => err instanceof IntegrityError && /p\/T/.test(err.message) && /hash mismatch/.test(err.message),
    "a mismatch must name the node and refuse it, never warn and continue",
  );
});

/**
 * An OLDER PUBLISHED PACKAGE must fail loudly, not half-load.
 *
 * Lint protects authoring, but a package already on npm arrives as a row and is never
 * linted. Before this check, an old-format node composed to an api block with no `run`: a
 * PromiseNode registered fine and then died on first execution complaining it had only
 * service methods, and a CallbackNode failed on a kind mismatch that named neither the
 * cause nor the fix. Both are the wrong failure at the wrong time.
 */
test("a manifest in the retired format is refused at load, naming its replacement", () => {
  const pkg: any = { name: "old", shared: {}, credentials: {}, packageFile: "allowedHosts: [api.example.com]\n" };
  const raw: any = {
    dir: "Old",
    origin: "postgres:old/Old",
    files: {
      "node.yaml": "type: Old\nkind: PromiseNode\n",
      "api/request.yaml": "method: POST\nurl: https://api.example.com/x\ntransport: json\n",
      "api/events.yaml": "- emit: out\n  value: \"return response\"\n",
    },
  };
  assert.throws(
    () => composeNode(raw, pkg),
    (err: any) => /older manifest format/.test(err.message) && /api\/run/.test(err.message),
    "an old published package must say what to do, at load, rather than registering a node that cannot run",
  );
});

/** Against the real packages, so the properties above hold for nodes that actually ship. */
test("every shipped manifest node hashes, and no two share a hash", async () => {
  const packages = await diskSource(NODES).listPackages();
  const seen = new Map<string, string>();

  for (const pkg of packages)
    for (const raw of pkg.nodes) {
      const composed = composeNode(raw, pkg);
      const h = hashNode(composed);
      assert.match(h, /^sha256:[0-9a-f]{64}$/, `${composed.type} produced a malformed hash`);
      assert.ok(!seen.has(h), `${composed.type} and ${seen.get(h)} share a hash, so the subject is too narrow`);
      seen.set(h, composed.type);
    }

  assert.ok(seen.size >= 5, `expected the shipped manifest nodes, hashed ${seen.size}`);
});
