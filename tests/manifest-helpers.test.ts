/**
 * NAMED HELPERS: functions a package declares in shared/, callable from any expression.
 *
 * They exist because an expression is ONE STRING, so a projection of any size had to be
 * written as one — 45 lines of JavaScript inside a YAML scalar, with a near-copy of the same
 * logic in the file next to it. There was no way for one expression to call another, so there
 * was no way to give the parts names.
 *
 * The properties that matter are the SANDBOX ones. A helper is not an escape hatch: same
 * allowlist, no ambient scope, and a body that never parses must fail when the package loads
 * rather than on the request that first reaches it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { makeHelpers } from "../src/template/SafeExpression.js";
import { evaluateSafeExpression } from "../src/template/SafeExpression.js";
import { packageHelpers, ManifestError } from "../src/manifests/compose.js";

const pkg = (shared: Record<string, string>) => ({ name: "t", shared, nodes: [], packageFile: "" }) as any;

test("a helper is callable directly AND as a callback", () => {
  /**
   * Both forms, because the sandbox reaches them by different paths: a direct call checks the
   * function against an allowlist, while `.map(helpers.row)` never sees a CallExpression at
   * all — the array's own `map` invokes it. A helper callable one way and not the other would
   * be a rule with no reason behind it that nobody could predict from reading a manifest.
   */
  const helpers = makeHelpers({ double: { args: ["n"], body: "return n * 2" } });
  assert.equal(evaluateSafeExpression("helpers.double(21)", { helpers }), 42);
  assert.deepEqual(evaluateSafeExpression("[1, 2].map(helpers.double)", { helpers }), [2, 4]);
});

test("a helper may call its siblings", () => {
  // What makes them decomposable at all. Without it, one big expression becomes several big
  // expressions and nothing is shared.
  const helpers = makeHelpers({
    inner: { args: ["s"], body: "return String(s).trim()" },
    outer: { args: ["s"], body: "return helpers.inner(s).length" },
  });
  assert.equal(evaluateSafeExpression("helpers.outer('  ab  ')", { helpers }), 2);
});

test("a helper sees ONLY its arguments — never the caller's scope", () => {
  /**
   * THE SECURITY PROPERTY, and the readability one at once. A named function whose result
   * depends on ambient state it never named is exactly what this format is trying to escape;
   * worse here, `config` and `credentials` are in scope at most call sites, so a helper that
   * could read the caller's scope could read a decrypted credential it was never passed.
   */
  const helpers = makeHelpers({ peek: { args: [], body: "return typeof secret" } });
  assert.throws(
    () => evaluateSafeExpression("helpers.peek()", { helpers, secret: "sk-live-xxx" }),
    /unknown identifier 'secret'/,
    "a helper can reach a name from the calling scope",
  );
});

test("a helper gets NO extra authority — the sandbox still applies", () => {
  /**
   * A helper body is an ordinary expression. If declaring one widened the allowlist, every
   * security property of the manifest format would be one `helpers:` block away from gone.
   *
   * The two checks land at DIFFERENT times, which is worth stating rather than smoothing
   * over. An illegal FORM (spread, `new`, try/catch) is structural, so the build-time walk
   * sees it on every branch. An unknown NAME is not: `process` is a perfectly legal
   * Identifier, and whether a name resolves is only knowable against a scope. It fails on
   * the call — still refused, still loud, one step later.
   */
  const reachOut = makeHelpers({ bad: { args: [], body: "return process.env" } });
  assert.throws(() => evaluateSafeExpression("helpers.bad()", { helpers: reachOut }), /unknown identifier 'process'/);
  assert.throws(() => makeHelpers({ bad: { args: ["a"], body: "return Object.assign({}, ...a)" } }), /disallowed expression: SpreadElement/);
});

test("a broken helper fails at BUILD, naming itself", () => {
  /**
   * Eagerly, not on first call. A helper reached only by one branch of one method would
   * otherwise sit there parsing-broken through every test and lint run, and fail on the live
   * request that first happened to enter that branch — which is precisely the failure mode
   * the static expression walk was added to end.
   */
  assert.throws(() => makeHelpers({ oops: { args: [], body: "return (" } }));
  assert.throws(() => makeHelpers({ empty: { args: [], body: "  " } }), /helper 'empty' has an empty body/);
});

test("helpers are collected from EVERY shared file, not one reserved name", () => {
  // A helper belongs next to what it serves. Forcing them into helpers.yaml would separate
  // them from the call they shape, which is the problem being fixed.
  const got = packageHelpers(pkg({ "a.yaml": "helpers:\n  one:\n    body: return 1\n", "b.yaml": "helpers:\n  two:\n    body: return 2\n" }));
  assert.deepEqual(Object.keys(got).sort(), ["one", "two"]);
});

test("a duplicate helper name THROWS, naming both files", () => {
  /**
   * Otherwise it resolves by directory order: the loser looks defined, reads correctly, and
   * never runs. Which of two identically-named projections executed would depend on a
   * filename, and nothing would ever say so.
   */
  assert.throws(
    () => packageHelpers(pkg({ "a.yaml": "helpers:\n  row:\n    body: return 1\n", "b.yaml": "helpers:\n  row:\n    body: return 2\n" })),
    (e: unknown) => e instanceof ManifestError && /shared\/a\.yaml and shared\/b\.yaml/.test((e as Error).message),
  );
});

test("a malformed helper declaration is refused with what is wrong", () => {
  assert.throws(() => packageHelpers(pkg({ "a.yaml": "helpers: [1, 2]\n" })), /must be a map/);
  assert.throws(() => packageHelpers(pkg({ "a.yaml": "helpers:\n  row: {}\n" })), /needs a non-empty string "body"/);
  assert.throws(() => packageHelpers(pkg({ "a.yaml": "helpers:\n  row:\n    args: nope\n    body: return 1\n" })), /"args" must be a list/);
});

test("an unbound helper call says so, rather than returning undefined", () => {
  // No empty-bag fallback. A helper call that silently produced undefined would be the same
  // class of quiet wrong answer as the shallow $ref merge that deleted a request body.
  assert.throws(() => evaluateSafeExpression("helpers.row({})", {}), /unknown identifier 'helpers'/);
});

test("a call to a helper the package never declared THROWS, at lint and at run", () => {
  /**
   * The bag is a CLOSED namespace. The general member-call rule — a missing method quietly
   * returns undefined — is right for data (`row.metadata` legitimately varies) and wrong for
   * helper NAMES, where undefined only ever means a misspelling. Proven live: an injected
   * `helpers.nopeReport(...)` in a node's emit row sailed through the whole author-time
   * expression scan and would have emitted undefined on a connector forever. It must be the
   * sandbox's OWN error type, because that scan ignores every other kind on purpose —
   * missing data in its dummy scope is expected; a missing name never is.
   */
  const helpers = makeHelpers({ real: { args: [], body: "return 1" } });
  assert.throws(
    () => evaluateSafeExpression("helpers.nopeReport({})", { helpers }),
    /unknown helper 'nopeReport'/,
  );
});
