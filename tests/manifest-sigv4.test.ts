/**
 * AWS SIGNATURE V4 — pinned against AWS's own published example, not against itself.
 *
 * A signer is the wrong thing to test by "it produced a signature". Any HMAC produces a
 * signature; the question is whether AWS computes the SAME one, and the only honest answer
 * to that is a KNOWN-GOOD value someone else published.
 *
 * The vector below is AWS's documented worked example for SigV4 (the `get-vanilla` case
 * from the signing test suite): fixed credentials, fixed date, fixed request, and a
 * signature AWS states the result must equal. If our wiring drifts — wrong canonical
 * headers, wrong scope, host omitted — this stops matching.
 *
 * There are no AWS credentials in .env, so this is what stands in for a live call. It is
 * the stronger check anyway: a live 200 proves one request to one service worked, while the
 * vector proves the algorithm.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const UNOVERSE = join(HERE, "../../../apps/unoverse");

const { signAwsRequest } = await import("@unoverse-platform/base/manifests/runtime/auth/aws.js");

/** AWS's documented example credentials. Not secret: they appear in the AWS docs. */
const VECTOR = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  service: "service",
};

/** Freeze the clock: the signature is scoped to a date, so a moving one cannot be pinned. */
function atFixedTime<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  const fixed = new RealDate(iso).getTime();
  // @ts-expect-error swapping the global for the duration of one call
  globalThis.Date = class extends RealDate {
    constructor(...args: any[]) {
      // @ts-expect-error passthrough
      super(...(args.length ? args : [fixed]));
    }
    static now() { return fixed; }
  };
  return fn().finally(() => { globalThis.Date = RealDate; });
}

test("the signature matches AWS's published vector exactly", async () => {
  // `applyChecksum: false` because AWS's vectors are written without the payload-hash
  // header. We send it by default (S3 requires it), which changes SignedHeaders and so the
  // signature — correctly. Turning it off here is what makes the comparison like-for-like.
  const headers = await atFixedTime("2015-08-30T12:36:00Z", () =>
    signAwsRequest("https://example.amazonaws.com/", "GET", {}, undefined, { ...VECTOR, applyChecksum: false }),
  );

  assert.equal(
    headers.authorization ?? headers.Authorization,
    "AWS4-HMAC-SHA256 " +
      "Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
      "SignedHeaders=host;x-amz-date, " +
      "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    "this is AWS's documented answer for this exact request — a mismatch is our bug, not theirs",
  );
});

test("the request is scoped to date, region and service", async () => {
  const headers: any = await atFixedTime("2015-08-30T12:36:00Z", () =>
    signAwsRequest("https://example.amazonaws.com/", "GET", {}, undefined, { ...VECTOR, service: "dynamodb" }),
  );
  const auth = headers.authorization ?? headers.Authorization;
  assert.match(auth, /Credential=AKIDEXAMPLE\/20150830\/us-east-1\/dynamodb\/aws4_request/);
  // Naming a different service must change the signature, or the scope is decorative and a
  // signature minted for one service would be replayable against another.
  assert.equal(auth.includes("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"), false);
});

test("host is signed, because the server compares it with the Host it was dialled on", async () => {
  const a: any = await signAwsRequest("https://a.amazonaws.com/", "GET", {}, undefined, VECTOR);
  const b: any = await signAwsRequest("https://b.amazonaws.com/", "GET", {}, undefined, VECTOR);
  assert.match(a.authorization ?? a.Authorization, /SignedHeaders=[^,]*host/);
  assert.notEqual(
    a.authorization ?? a.Authorization,
    b.authorization ?? b.Authorization,
    "a different host must give a different signature",
  );
});

/**
 * THE BODY IS COVERED. This is why signing had to move after body resolution: an earlier
 * version could have signed before the body existed, producing a valid-looking header for
 * a request that was never sent, and a 403 on every call with a payload.
 */
test("the body is part of what is signed", async () => {
  const one: any = await atFixedTime("2015-08-30T12:36:00Z", () =>
    signAwsRequest("https://example.amazonaws.com/", "POST", {}, JSON.stringify({ TableName: "a" }), VECTOR),
  );
  const two: any = await atFixedTime("2015-08-30T12:36:00Z", () =>
    signAwsRequest("https://example.amazonaws.com/", "POST", {}, JSON.stringify({ TableName: "b" }), VECTOR),
  );
  assert.notEqual(
    one.authorization ?? one.Authorization,
    two.authorization ?? two.Authorization,
    "same clock, same everything but the body — the signatures MUST differ, or the payload is unprotected",
  );
});

/**
 * Temporary credentials. An empty token header is NOT the same as no token header: AWS
 * rejects the former, so the absent case has to stay absent rather than become "".
 */
test("a session token is sent and signed only when there is one", async () => {
  const withToken: any = await signAwsRequest("https://example.amazonaws.com/", "GET", {}, undefined, {
    ...VECTOR,
    sessionToken: "FQoDYXdzEEXAMPLE",
  });
  assert.equal(withToken["x-amz-security-token"], "FQoDYXdzEEXAMPLE");
  assert.match(withToken.authorization ?? withToken.Authorization, /SignedHeaders=[^,]*x-amz-security-token/);

  const without: any = await signAwsRequest("https://example.amazonaws.com/", "GET", {}, undefined, VECTOR);
  assert.equal("x-amz-security-token" in without, false, "no token means the header is absent, not empty");
});

/* ───────────────────────── the dynamodb encoding ───────────────────────── */

const { encodeDynamoJson, decodeDynamoJson } = await import("@unoverse-platform/base/manifests/runtime/auth/aws.js");

/**
 * ONLY THE ITEM-DATA KEYS ARE TAGGED. This is the whole reason the encoder is selective
 * rather than a blanket marshall of the body: `TableName` is an ordinary string, and
 * turning it into { S: "Users" } is a 400 on every call the node ever makes.
 */
test("encoding tags item data and leaves the rest of the request alone", () => {
  const out: any = encodeDynamoJson({
    TableName: "Users",
    Limit: 25,
    Item: { universalId: "u-1", visits: 3, active: true },
  });
  assert.equal(out.TableName, "Users", "a table name is a string, not a typed value");
  assert.equal(out.Limit, 25, "and a limit is a number");
  assert.deepEqual(out.Item.universalId, { S: "u-1" });
  assert.deepEqual(out.Item.visits, { N: "3" }, "numbers travel as decimal STRINGS, so precision survives");
  assert.deepEqual(out.Item.active, { BOOL: true });
});

/** The case an expression could never have handled, and the reason this is executor code. */
test("encoding reaches all the way into a nested record", () => {
  const out: any = encodeDynamoJson({
    TableName: "Pages",
    Item: { url: "https://a.test", metadata: { title: "A", openGraph: [{ content: "x" }] } },
  });
  assert.deepEqual(out.Item.metadata.M.title, { S: "A" });
  assert.deepEqual(out.Item.metadata.M.openGraph.L[0].M.content, { S: "x" }, "nested map inside a list inside a map");
});

test("decoding strips the tags back off, so a node never sees them", () => {
  const out: any = decodeDynamoJson({
    Item: { universalId: { S: "u-1" }, visits: { N: "3" }, meta: { M: { title: { S: "A" } } } },
    ConsumedCapacity: { CapacityUnits: 1 },
  });
  assert.deepEqual(out.Item, { universalId: "u-1", visits: 3, meta: { title: "A" } });
  assert.deepEqual(out.ConsumedCapacity, { CapacityUnits: 1 }, "untagged keys pass through untouched");
});

test("decoding handles a LIST of items, which is what a query returns", () => {
  const out: any = decodeDynamoJson({ Items: [{ id: { S: "a" } }, { id: { S: "b" } }], Count: 2 });
  assert.deepEqual(out.Items, [{ id: "a" }, { id: "b" }]);
  assert.equal(out.Count, 2);
});

/** A miss is an answer: GetItem returns 200 with no Item, and that must survive decoding. */
test("a missing Item stays missing rather than becoming an empty object", () => {
  const out: any = decodeDynamoJson({ ConsumedCapacity: { CapacityUnits: 0.5 } });
  assert.equal("Item" in out, false, "found: false has to remain distinguishable from found: {}");
});

/** Round trip: what a node writes is what a node reads back. */
test("a record survives a round trip unchanged", () => {
  const record = { universalId: "u-1", name: "Ada", visits: 3, active: true, meta: { title: "A", tags: ["x", "y"] } };
  const encoded: any = encodeDynamoJson({ Item: record });
  const decoded: any = decodeDynamoJson({ Item: encoded.Item });
  assert.deepEqual(decoded.Item, record);
});

/* ──────────────────── xml, headers, and presigned links ─────────────────── */

const { presignAwsUrl } = await import("@unoverse-platform/base/manifests/runtime/auth/aws.js");
const { readSettled } = await import("@unoverse-platform/base/manifests/runtime/index.js");

const xml = (body: string) => new Response(body, { status: 200, headers: { "Content-Type": "application/xml" } });

/**
 * THE ONE-ELEMENT TRAP. XML cannot tell a single element from a list of one, so a bucket
 * holding ONE object parses `Contents` as an object while two parse as an array. A manifest
 * written against the second breaks on the first, and only once a bucket happens to have a
 * single file in it — which is exactly the sort of thing that reaches production.
 */
test("a single XML element still parses as a list", async () => {
  const one: any = await readSettled(
    xml(`<ListBucketResult><Contents><Key>a.pdf</Key><Size>10</Size></Contents></ListBucketResult>`),
    "xml",
  );
  assert.ok(Array.isArray(one.ListBucketResult.Contents), "ONE object must still be an array");
  assert.equal(one.ListBucketResult.Contents[0].Key, "a.pdf");

  const two: any = await readSettled(
    xml(`<ListBucketResult><Contents><Key>a.pdf</Key></Contents><Contents><Key>b.pdf</Key></Contents></ListBucketResult>`),
    "xml",
  );
  assert.equal(two.ListBucketResult.Contents.length, 2, "and two must be the same shape as one");
});

test("a HEAD's headers ARE its reply, lower-cased", async () => {
  const res = new Response(null, {
    status: 200,
    headers: { "Content-Length": "2048", "Content-Type": "application/pdf", ETag: '"abc"' },
  });
  const out: any = await readSettled(res, "headers");
  assert.equal(out["content-length"], "2048", "the size, without downloading the object to measure it");
  assert.equal(out["content-type"], "application/pdf");
  assert.equal(
    out["etag"],
    '"abc"',
    "keys are lower-cased so an expression does not depend on the vendor's capitalisation",
  );
});

/**
 * A presigned URL carries its own authority: the signature moves into the QUERY STRING with
 * an expiry, so the link alone is enough to fetch the object. That is the whole difference
 * from an ordinary signed request, and it is what makes the link shareable.
 */
test("presigning puts the signature in the query string, with an expiry", async () => {
  const url = await atFixedTime("2015-08-30T12:36:00Z", () =>
    presignAwsUrl("https://my-bucket.s3.us-east-1.amazonaws.com/reports/q3.pdf", { ...VECTOR, service: "s3" }, 3600),
  );
  const u = new URL(url);
  assert.equal(u.searchParams.get("X-Amz-Expires"), "3600");
  assert.equal(u.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.ok(u.searchParams.get("X-Amz-Signature"), "the signature travels in the url, not a header");
  assert.match(String(u.searchParams.get("X-Amz-Credential")), /\/s3\/aws4_request$/, "scoped to s3");
  assert.equal(u.pathname, "/reports/q3.pdf", "the key survives intact");
});

test("a different expiry gives a different link", async () => {
  const a = await atFixedTime("2015-08-30T12:36:00Z", () =>
    presignAwsUrl("https://b.s3.us-east-1.amazonaws.com/k", { ...VECTOR, service: "s3" }, 60),
  );
  const b = await atFixedTime("2015-08-30T12:36:00Z", () =>
    presignAwsUrl("https://b.s3.us-east-1.amazonaws.com/k", { ...VECTOR, service: "s3" }, 3600),
  );
  assert.notEqual(a, b, "the expiry is signed, so it cannot be edited in the url to extend access");
});

/* ────────────────────── the allowedHosts wildcard depth ────────────────────── */

const { assertAllowedHost } = await import("@unoverse-platform/base/manifests/runtime/index.js");

const allows = (patterns: string[], url: string) => {
  try { assertAllowedHost(url, patterns, "T"); return true; } catch { return false; }
};

/**
 * FOUND LIVE, in Studio, by the control refusing a real request.
 *
 * `*.` matches ONE label, which is right for most vendors and wrong for AWS: a regional
 * endpoint is two labels deep and an S3 bucket is three, because the region AND the bucket
 * are part of the host. `**.` says any depth, and is two stars because it is a weaker claim
 * the author should have to make deliberately.
 */
test("`*.` is one level and does NOT reach an AWS regional endpoint", () => {
  assert.equal(allows(["*.amazonaws.com"], "https://s3.amazonaws.com/"), true, "one label, allowed");
  assert.equal(
    allows(["*.amazonaws.com"], "https://dynamodb.us-east-1.amazonaws.com/"),
    false,
    "two labels deep — this is the refusal that surfaced the bug",
  );
});

test("`**.` reaches any depth under the domain, and nothing outside it", () => {
  for (const host of [
    "https://s3.amazonaws.com/",
    "https://dynamodb.us-east-1.amazonaws.com/",
    "https://my-bucket.s3.eu-west-1.amazonaws.com/key.pdf",
  ])
    assert.equal(allows(["**.amazonaws.com"], host), true, `${host} must be allowed`);

  // STILL BOUNDED. This is the whole point: a weaker wildcard is not an open door, and a
  // tampered manifest still cannot post a credential somewhere the package never declared.
  for (const host of [
    "https://evil.example/",
    "https://amazonaws.com.evil.example/",
    "https://notamazonaws.com/",
  ])
    assert.equal(allows(["**.amazonaws.com"], host), false, `${host} must be refused`);
});

test("`**.a.com` requires a label in front, so it is not a way to write a bare domain", () => {
  assert.equal(allows(["**.amazonaws.com"], "https://amazonaws.com/"), false);
});

/* ─────────── the "*" host rule: unauthenticated calls only ─────────── */

/**
 * A node that reads an image or document from a url a PERSON supplies cannot declare that
 * host in advance — the whole point is that it is not known until someone types it.
 *
 * `"*"` allows it, and the reason it is safe is narrow and must stay narrow: this boundary
 * exists to stop EXFILTRATION, and a call with no `auth` block has no credential to leak.
 * The moment a call carries one, `"*"` stops matching. These tests are that guarantee.
 */
test('"*" allows an unauthenticated call to any host', () => {
  assert.equal(allows2(["*"], "https://images.example/cat.png", false), true);
  assert.equal(allows2(["*"], "https://anything.at.all/doc.pdf", false), true);
});

test('"*" NEVER allows a call that carries a credential', () => {
  assert.equal(
    allows2(["*"], "https://evil.example/collect", true),
    false,
    "this is the whole guarantee: a wildcard host must not become a way to move a credential",
  );
});

test('a package with "*" still holds credentialled calls to its declared list', () => {
  const patterns = ["**.amazonaws.com", "*"];
  assert.equal(allows2(patterns, "https://bedrock-runtime.eu-west-1.amazonaws.com/", true), true, "declared, allowed");
  assert.equal(allows2(patterns, "https://evil.example/", true), false, "undeclared with a credential, refused");
  assert.equal(allows2(patterns, "https://images.example/cat.png", false), true, "undeclared without one, allowed");
});

test('"*" does not defeat the https rule, so metadata and plaintext stay unreachable', () => {
  // The cloud metadata endpoint is the classic target, and it is plain http.
  assert.equal(allows2(["*"], "http://169.254.169.254/latest/meta-data/", false), false);
  assert.equal(allows2(["*"], "http://internal-service.local/", false), false);
});

function allows2(patterns: string[], url: string, carriesCredential: boolean) {
  try { assertAllowedHost(url, patterns, "T", carriesCredential); return true; } catch { return false; }
}
