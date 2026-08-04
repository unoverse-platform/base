/**
 * WHO MAY RUN A NODE — the check that did not exist until 2026-07-28.
 *
 * `requires.role` was in the node schema and enforced by lint from the day the format
 * shipped, and read by NO runtime code: `compose.ts` never carried the field onto the
 * composed node, so the executor could not have checked it. Four docs said so in writing
 * ("schema + lint exist, the executor check does not") and every one of the 64 manifests was
 * in the default state, so nothing was mis-secured and nothing complained.
 *
 * That is exactly the failure this file guards against, and it is why the assertions below
 * are about REFUSAL rather than about the happy path. A gate that admits everyone passes any
 * test that only checks the allowed case.
 *
 * The two directions are easy to confuse and this is the inbound one, about the CALLER.
 * A call's `credential` is outbound: how the node proves itself to a vendor.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { assertAuthorized, NodeAuthorizationError } from "../src/manifests/runtime/authorize.js";
import { nodeAuth } from "../src/manifests/compose.js";

const node = (auth: any) => ({ type: "Payments", auth }) as any;

/** What the platform gate puts on a run. */
const signedIn = (extra: Record<string, unknown> = {}) => ({ auth: { user: { id: "auth0|7", email: "a@b.c", ...extra } } });
const guest = { auth: { user: { id: "guest:2f6c-4e", roles: [], permissions: [] } } };
const nobody = {};

test("required: false runs for anyone the trigger admitted, guests included", () => {
  // The DEFAULT, and correct for almost every node: the trigger owns the door and the node
  // adds nothing. If this ever throws, 63 of 64 nodes stop working.
  assert.doesNotThrow(() => assertAuthorized(node({ required: false }), guest));
  assert.doesNotThrow(() => assertAuthorized(node({ required: false }), nobody));
  assert.doesNotThrow(() => assertAuthorized(node({ required: false }), signedIn()));
});

test("required: true refuses an anonymous guest, and says it was a guest", () => {
  // A guest is ADMITTED but anonymous: they legitimately reached a public workflow. The
  // message has to separate that from "no identity arrived", because the fixes differ —
  // one is a workflow that is public on purpose, the other is a broken token hop.
  assert.throws(
    () => assertAuthorized(node({ required: true }), guest),
    (e: Error) => e instanceof NodeAuthorizationError && /anonymous guest/.test(e.message),
  );
});

test("required: true refuses a run carrying no identity at all", () => {
  assert.throws(
    () => assertAuthorized(node({ required: true }), nobody),
    (e: Error) => /no identity/.test(e.message),
  );
});

test("required: true admits a signed-in caller", () => {
  assert.doesNotThrow(() => assertAuthorized(node({ required: true }), signedIn()));
});

test("a role is refused when the caller does not carry it, and the claim is NAMED", () => {
  // Naming the claim is the whole point. "Forbidden" sends the person who hit it to read the
  // manifest, and an operator granting the role needs the exact string anyway.
  assert.throws(
    () => assertAuthorized(node({ required: true, role: "payments:refund" }), signedIn({ roles: ["crm:write"] })),
    (e: Error) => /payments:refund/.test(e.message) && /crm:write/.test(e.message),
  );
});

test("a role is satisfied from EITHER the roles or the permissions claim", () => {
  // One namespace on purpose: both are noun:verb claims off the same token, and
  // marketplace:publish is already checked as a permission while reading exactly like a
  // role. Making an author know which list their identity provider used is a footgun.
  assert.doesNotThrow(() => assertAuthorized(node({ required: true, role: "payments:refund" }), signedIn({ roles: ["payments:refund"] })));
  assert.doesNotThrow(() =>
    assertAuthorized(node({ required: true, role: "payments:refund" }), signedIn({ permissions: ["payments:refund"] })),
  );
});

test("a guest never satisfies a role, however the claim arrived", () => {
  // Belt and braces against a client that mints its own guest id AND claims roles: the gate
  // refuses that shape, and if it ever stopped, this node still would.
  assert.throws(
    () => assertAuthorized(node({ required: true, role: "payments:refund" }), { auth: { user: { id: "guest:x", roles: ["payments:refund"] } } }),
    NodeAuthorizationError,
  );
});

/**
 * FAIL CLOSED on anything malformed. Lint makes these unreachable in this tree, but a
 * manifest can arrive as a database row that never met lint — and that one path must not
 * also be the path that skips authorization.
 */
test("a manifest with no auth block at all is treated as requiring a signed-in caller", () => {
  assert.equal(nodeAuth({}).required, true);
  assert.equal(nodeAuth({ auth: null }).required, true);
  assert.equal(nodeAuth({ auth: { required: "yes" } }).required, true);
  assert.throws(() => assertAuthorized({ type: "Legacy" } as any, guest), NodeAuthorizationError);
});

test("role with required: false collapses to required: true rather than admitting everyone", () => {
  // The unsatisfiable pair lint rejects. Reached only by a manifest that skipped lint, and
  // the author's intent is unmistakable: they asked for a role. Reading it as "open" would
  // invert the one thing they did say.
  const a = nodeAuth({ auth: { required: false, role: "payments:refund" } });
  assert.equal(a.required, true);
  assert.equal(a.role, "payments:refund");
  assert.throws(() => assertAuthorized(node(a), guest), NodeAuthorizationError);
});

test("an empty or whitespace role is not a role, and does not silently gate on \"\"", () => {
  // `role: ""` would otherwise become a claim nobody can carry, refusing every caller with a
  // message naming nothing.
  assert.equal(nodeAuth({ auth: { required: false, role: "   " } }).role, undefined);
  assert.equal(nodeAuth({ auth: { required: false, role: "" } }).required, false);
});

/**
 * THE SECOND SOURCE: the workflow builder's instance config.
 *
 * `finance:approve` is a claim ONE deployment's identity provider mints, so a node published
 * to the marketplace cannot name it in its manifest — the author has no idea what roles the
 * universes installing it issue. The builder does. That is why this half exists, and why it
 * must be able to demand things the manifest never mentioned.
 */
test("the instance toggle demands sign-in on a node whose manifest is open", () => {
  const open = node({ required: false });
  assert.doesNotThrow(() => assertAuthorized(open, guest, { authRequired: false }));
  assert.throws(() => assertAuthorized(open, guest, { authRequired: true }), NodeAuthorizationError);
});

test("the instance can name a role the manifest never mentioned", () => {
  const open = node({ required: false });
  assert.throws(
    () => assertAuthorized(open, signedIn({ roles: ["crm:write"] }), { authRequired: true, authRole: "finance:approve" }),
    (e: Error) => /finance:approve/.test(e.message),
  );
  assert.doesNotThrow(() => assertAuthorized(open, signedIn({ roles: ["finance:approve"] }), { authRequired: true, authRole: "finance:approve" }));
});

test("an instance role implies sign-in even if whoever set it left the toggle off", () => {
  // Otherwise a filled-in role box with the toggle off would read as protected and admit
  // everyone, which is the exact failure this whole change was made to remove.
  assert.throws(
    () => assertAuthorized(node({ required: false }), guest, { authRequired: false, authRole: "finance:approve" }),
    NodeAuthorizationError,
  );
});

test("the instance can NEVER loosen the manifest's floor", () => {
  // The one direction that must be impossible. A builder turning their toggle off does not
  // get to run a node its author marked privileged.
  assert.throws(() => assertAuthorized(node({ required: true }), guest, { authRequired: false }), NodeAuthorizationError);
  assert.throws(
    () => assertAuthorized(node({ required: true, role: "payments:refund" }), signedIn({ roles: [] }), { authRequired: false, authRole: "" }),
    (e: Error) => /payments:refund/.test(e.message),
  );
});

test("both roles are demanded when the manifest and the instance each name one", () => {
  // Requirements only narrow, so two sources mean two claims rather than one overriding the
  // other. Carrying either alone is not enough.
  const both = node({ required: true, role: "payments:refund" });
  const cfg = { authRequired: true, authRole: "finance:approve" };
  assert.throws(() => assertAuthorized(both, signedIn({ roles: ["payments:refund"] }), cfg), (e: Error) => /finance:approve/.test(e.message));
  assert.throws(() => assertAuthorized(both, signedIn({ roles: ["finance:approve"] }), cfg), (e: Error) => /payments:refund/.test(e.message));
  assert.doesNotThrow(() => assertAuthorized(both, signedIn({ roles: ["payments:refund", "finance:approve"] }), cfg));
});

test("a blank or whitespace role box is not a requirement", () => {
  // `default: ""` is what 64 configs ship with, so this is the common path: an empty box must
  // mean nothing at all, not a claim nobody can carry.
  assert.doesNotThrow(() => assertAuthorized(node({ required: false }), guest, { authRequired: false, authRole: "" }));
  assert.doesNotThrow(() => assertAuthorized(node({ required: false }), guest, { authRequired: false, authRole: "   " }));
});

test("a missing config is the same as an unset one, not an error", () => {
  // The service and callback channels can be reached with no config at all.
  assert.doesNotThrow(() => assertAuthorized(node({ required: false }), guest, undefined));
  assert.throws(() => assertAuthorized(node({ required: true }), guest, undefined), NodeAuthorizationError);
});

/**
 * COVERAGE PROOF. Every assertion above is about a function I can call directly, so the
 * usual enumerator trap (a guard that lists files and passes by seeing none) does not apply
 * — but the executor wiring is a different matter: the check could be correct and simply
 * never called. This proves the call sites exist by reading them.
 */
test("every executor entry point calls the check before it runs anything", async () => {
  const { readFileSync } = await import("node:fs");
  // The two executor classes, one file each since the executor/ split (2026-07-29). Read
  // BOTH: a class file this misses is a class file whose entry points go ungated.
  const src = ["promise", "callback"]
    .map((f) => readFileSync(new URL(`../src/manifests/executor/${f}.ts`, import.meta.url), "utf8"))
    .join("\n");

  // execute, handleEvent, and handleServiceCall on BOTH executor classes.
  const calls = src.match(/assertAuthorized\(/g) ?? [];
  assert.equal(calls.length, 4, `expected 4 call sites (execute, handleEvent, 2 × handleServiceCall), found ${calls.length}`);

  // Every site must pass the INSTANCE CONFIG as well. A two-argument call compiles, runs, and
  // silently ignores the builder's toggle — the gate would look present and enforce only half
  // of itself, which is the failure mode this whole file exists to prevent.
  const twoArg = src.match(/assertAuthorized\([^)]*\)/g)?.filter((c) => c.split(",").length < 3) ?? [];
  assert.equal(twoArg.length, 0, `these call sites drop the instance config: ${twoArg.join(" | ")}`);

  // ORDER is the property that matters: authorization after the request has gone out is an
  // audit log, not a gate. In `execute`, the check must precede performApi.
  const exec = src.slice(src.indexOf("async execute("));
  assert.ok(
    exec.indexOf("assertAuthorized(") < exec.indexOf("performApi("),
    "execute() authorizes AFTER building the request, so a refused run would still have called the vendor",
  );
});
