/**
 * A NODE'S LIST OF CALLS, and the `user` SCOPE — the two capabilities that let an identity-joined
 * REST node stop being code (DECLARATIVE_NODES.md §5, §10).
 *
 * Both are asserted on BEHAVIOUR against a stubbed fetch rather than on the shape of the
 * manifest, because both failure modes are silent. A `when` that never skips still
 * returns a plausible object. A `user` scope that resolves to undefined produces a search
 * for the empty string, which HubSpot answers with a cheerful empty result: found: false,
 * no error anywhere, and the node looks like it works until someone notices it never
 * finds anybody.
 *
 * The `user` scope is also a security boundary, so the last test here is the one that
 * matters most: identity is exposed, the caller's TOKEN is not, and a manifest that goes
 * looking for it must find nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const UNOVERSE = join(HERE, "../../../apps/unoverse");

const { runCalls, emptyContext, primeTemplating } = await import("@unoverse-platform/base/manifests/runtime/index.js");

/** A node stub: only `allowedHosts` and `type` are read by the request path. */
const NODE: any = { type: "TestNode", allowedHosts: ["api.example.com"] };

/** Swap fetch for one that records every call and answers from a table. */
function stubFetch(reply: (url: string, init: any) => unknown) {
  const seen: Array<{ url: string; body: any }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(reply(String(url), init)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as any;
  return { seen, restore: () => { globalThis.fetch = real; } };
}

const call = (over: Record<string, unknown>) => ({
  method: "GET",
  url: "https://api.example.com/thing",
  transport: "json",
  ...over,
});

test("a later call reads an earlier call's reply by name", async () => {
  await primeTemplating();
  const { seen, restore } = stubFetch((url) =>
    url.endsWith("/first") ? { id: "abc" } : { ok: true },
  );
  try {
    const { results, last } = await runCalls(
      NODE,
      [
        call({ name: "first", url: "https://api.example.com/first" }),
        call({ name: "second", url: "https://api.example.com/thing/{{ calls.first.id }}" }),
      ],
      emptyContext(),
      "test",
    );
    assert.equal(seen[1].url, "https://api.example.com/thing/abc", "the second URL must be built from the first reply");
    assert.deepEqual(results.first, { id: "abc" });
    assert.deepEqual(last, { ok: true }, "the run settles on the LAST call's reply");
  } finally {
    restore();
  }
});

test("a call whose `when` is false is skipped, and leaves NO key behind", async () => {
  await primeTemplating();
  const { seen, restore } = stubFetch(() => ({ company: "already set" }));
  try {
    const { results } = await runCalls(
      NODE,
      [
        call({ name: "first", url: "https://api.example.com/first" }),
        call({ name: "skipped", when: "return !calls.first.company" }),
      ],
      emptyContext(),
      "test",
    );
    assert.equal(seen.length, 1, "the skipped call must not be sent");
    assert.ok(!("skipped" in results), "a skipped call must leave no key, so `!!calls.x` is how you ask whether it happened");
  } finally {
    restore();
  }
});

test("a call sees only the calls BEFORE it", async () => {
  await primeTemplating();
  const { seen, restore } = stubFetch(() => ({ id: "later" }));
  try {
    await runCalls(
      NODE,
      [
        call({ name: "first", url: "https://api.example.com/{{ calls.second.id }}" }),
        call({ name: "second" }),
      ],
      emptyContext(),
      "test",
    );
    // Not an error at run time, but it must resolve to nothing rather than to the value
    // the call will hold later. The linter is what turns this into a build failure.
    assert.equal(seen[0].url, "https://api.example.com/", "a forward reference must resolve to empty, never to a later value");
  } finally {
    restore();
  }
});

test("a non-final call that streams is REFUSED rather than half-supported", async () => {
  await primeTemplating();
  const { restore } = stubFetch(() => ({}));
  try {
    await assert.rejects(
      () => runCalls(NODE, [call({ name: "a", transport: "sse" })], emptyContext(), "test"),
      /must settle/,
      "a call that streams mid-list has no defined meaning, so it must fail loudly",
    );
  } finally {
    restore();
  }
});

test("`user` is in scope for a request body, so identity comes from the SESSION", async () => {
  await primeTemplating();
  const { seen, restore } = stubFetch(() => ({ results: [] }));
  try {
    await runCalls(
      NODE,
      [
        call({
          name: "search",
          method: "POST",
          body: "return { email: params.email || user.email }",
        }),
      ],
      emptyContext({ user: { email: "signed-in@example.com" } }),
      "test",
    );
    assert.equal(
      seen[0].body.email,
      "signed-in@example.com",
      "without this a CRM node has to take identity off the wire, and a caller can ask for someone else's record",
    );
  } finally {
    restore();
  }
});

/**
 * EVERY call is reachable by name, including the LAST one.
 *
 * This shipped broken and the failure was silent. `performApi` splits the list into lead
 * and final, and only the lead's replies were written into `calls`, so the last call was
 * reachable as `response` and nowhere else. An events row reading `calls.<lastName>` got
 * undefined and emitted null.
 *
 * What made it worse than an ordinary bug: the SERVICE channel puts every call through
 * `runCalls`, so it had the name. One expression, $ref'd into both channels, behaved
 * differently depending on which one ran it. Found against the live HubSpot API, where a
 * contact's company came back null while all three calls demonstrably succeeded.
 */
test("the LAST call is in `calls` by name, so both channels read one expression alike", async () => {
  await primeTemplating();
  const { performApi, makeEmitter } = await import("@unoverse-platform/base/manifests/runtime/index.js");
  void makeEmitter;

  const { restore } = stubFetch((url) => (url.endsWith("/lead") ? { id: "L" } : { name: "Gravitas" }));
  try {
    const node: any = {
      type: "TwoCall",
      kind: "PromiseNode",
      allowedHosts: ["api.example.com"],
      api: {
        run: [
          call({ name: "lead", url: "https://api.example.com/lead" }),
          call({ name: "last", url: "https://api.example.com/last" }),
        ],
        events: [{ emit: "out", from: "response", value: "return { lead: calls.lead.id, last: calls.last.name }" }],
      },
    };
    const { outputs }: any = await performApi(node, emptyContext());
    assert.deepEqual(
      outputs.out,
      { lead: "L", last: "Gravitas" },
      "the final call must be readable as calls.<name>, not only as `response`",
    );
  } finally {
    restore();
  }
});

/**
 * THE LAST call honours `when` like every other one.
 *
 * It did not, and it shipped. HubSpot's last call writes queued notes to a real CRM and is
 * gated on a config toggle; with the toggle off the node POSTed to the notes endpoint on
 * every single run, and nothing errored because the vendor accepted an empty write. A
 * conditional call that fires anyway is worse than one that never fires.
 */
test("a conditional LAST call is skipped, and the node settles on the last one that ran", async () => {
  await primeTemplating();
  const { performApi } = await import("@unoverse-platform/base/manifests/runtime/index.js");
  const { seen, restore } = stubFetch(() => ({ id: "from-lead" }));
  try {
    const node: any = {
      type: "SkipLast",
      kind: "PromiseNode",
      allowedHosts: ["api.example.com"],
      api: {
        run: [
          call({ name: "lead", url: "https://api.example.com/lead" }),
          call({ name: "write", method: "POST", url: "https://api.example.com/write", when: "return false" }),
        ],
        events: [{ emit: "out", from: "response", value: "return response.id" }],
      },
    };
    const { outputs }: any = await performApi(node, emptyContext());
    assert.deepEqual(
      seen.map((s) => s.url),
      ["https://api.example.com/lead"],
      "the skipped last call must NOT be sent",
    );
    assert.equal(outputs.out, "from-lead", "the node settles on the last call that actually ran");
  } finally {
    restore();
  }
});

/**
 * THE SECURITY LINE. `user` carries who is signed in; it must never carry what
 * authenticates as them. An email proves nothing, while the platform JWT IS the user
 * against our own services, and a manifest can arrive by paste or by database row.
 */
test("the caller's token is NOT reachable from a manifest", async () => {
  const { contextFor }: any = await import("@unoverse-platform/base/manifests/executor/index.js");

  // contextFor lives in executor/context.ts since the folder split and is exported there
  // ONLY for its sibling files; the executor's public surface must not re-export it —
  // everything outside the folder receives a RunContext already built, and a second
  // builder is how the token rule would eventually be widened by accident.
  const ctx: any = emptyContext({ user: { email: "a@b.com", id: "u1", name: "A" } });
  assert.deepEqual(Object.keys(ctx.user).sort(), ["email", "id", "name"], "user is identity ONLY");
  assert.equal(JSON.stringify(ctx).includes("accessToken"), false, "no token may appear anywhere a manifest can read");
  assert.equal(typeof contextFor, "undefined", "contextFor stays off the executor's public surface");
});

/**
 * URL ENCODING is reachable from an expression.
 *
 * Found by running AirtableExists in Studio, which returned
 * `unknown identifier 'encodeURIComponent'` rather than a result: the sandbox's allowlist
 * had no URL-encoding function, so every manifest that builds a path segment from data
 * failed at the first call. Airtable's table part may be a NAME, and Salesforce's record ids
 * go into paths, so this is not a corner case.
 *
 * Asserted through the real evaluator rather than by reading the allowlist, because the
 * allowlist is only half of it: the interpreter also has to permit calling a bare global.
 */
test("an expression can percent-encode a path segment", async () => {
  const { evaluate } = await import("@unoverse-platform/base/manifests/runtime/index.js");
  assert.equal(
    await evaluate("return 'https://api.example.com/' + encodeURIComponent(config.table)", {
      config: { table: "My Table/2024" },
    }),
    "https://api.example.com/My%20Table%2F2024",
    "a table name with a space and a slash must encode, not corrupt the path",
  );
});

/**
 * CONTENT ADDRESSING is reachable from an expression.
 *
 * Same class as encodeURIComponent above, and the same reason it is asserted through the
 * real evaluator: the allowlist is only half, the interpreter also has to permit the call.
 *
 * A node that pulls pages derives a universal id from the url and a content id from the
 * text, and downstream dedup and ref hydration JOIN on those ids. Minting them in
 * TypeScript is what would keep such a node from ever being a manifest, so a pure hash
 * belongs in the sandbox for the same reason a pure encoder does.
 */
test("an expression can derive a stable content id", async () => {
  const { evaluate } = await import("@unoverse-platform/base/manifests/runtime/index.js");
  const id = await evaluate("return sha256(config.url).substring(0, 12)", {
    config: { url: "https://example.com/a" },
  });
  assert.match(String(id), /^[0-9a-f]{12}$/, "12 hex characters, which is what the id fields hold");
  assert.equal(
    await evaluate("return sha256(config.url).substring(0, 12)", { config: { url: "https://example.com/a" } }),
    id,
    "STABLE: the same input gives the same id, which is the entire point of joining on it",
  );
  assert.notEqual(
    await evaluate("return sha256(config.url).substring(0, 12)", { config: { url: "https://example.com/b" } }),
    id,
    "and a different input gives a different id",
  );
});
