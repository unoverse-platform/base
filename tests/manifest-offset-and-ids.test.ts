/**
 * The two capabilities the Apify migration needed, tested where a live run cannot reach.
 *
 * Apify runs are per-account, so there is no public fixture to point `unoverse node test`
 * at. That is exactly when an unwritten test becomes a claim, so both halves are pinned
 * here instead:
 *
 *   OFFSET PAGINATION, which looks like `page` and is not. The number counts ROWS, so it
 *   steps by the page size. Stepping it by 1 re-reads the same window shifted one row and
 *   the walk returns mostly duplicates, which reads as a large result rather than a bug.
 *
 *   THE ID DERIVATION, read out of the SHIPPED ApifyResults events.yaml rather than copied
 *   into this file. A copy would keep passing after the manifest changed, which is the one
 *   thing a test of a manifest must not do.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const UNOVERSE = join(HERE, "../../../apps/unoverse");

const { fetchPaginated, evaluate, emptyContext, primeTemplating } = await import("@unoverse-platform/base/manifests/runtime/index.js");

const NODE: any = { type: "TestNode", allowedHosts: ["api.example.com"] };

/* ─────────────────────────── offset pagination ─────────────────────────── */

/** Serve `total` rows out of a dataset, honouring ?offset= and ?limit=. */
function stubDataset(total: number) {
  const asked: number[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    const u = new URL(String(url));
    const offset = Number(u.searchParams.get("offset") ?? 0);
    const limit = Number(u.searchParams.get("limit") ?? 100);
    asked.push(offset);
    const rows = [];
    for (let i = offset; i < Math.min(offset + limit, total); i++) rows.push({ i });
    // A BARE ARRAY, which is what Apify's dataset endpoint returns.
    return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as any;
  return { asked, restore: () => { globalThis.fetch = real; } };
}

const datasetCall = {
  name: "items",
  method: "GET",
  url: "https://api.example.com/items",
  transport: "json",
  query: { limit: "10" },
  paginate: {
    strategy: "offset",
    into: "offset",
    size: 10,
    items: "return Array.isArray(response) ? response : []",
  },
};

test("an offset walk steps by the PAGE SIZE, not by one", async () => {
  await primeTemplating();
  const { asked, restore } = stubDataset(25);
  try {
    const walked: any = await fetchPaginated(NODE, datasetCall, emptyContext(), "test");
    assert.deepEqual(asked, [0, 10, 20], "offsets count rows already seen");
    assert.equal(walked.items.length, 25, "every row comes back exactly once");
    assert.deepEqual(
      walked.items.map((r: any) => r.i),
      Array.from({ length: 25 }, (_, i) => i),
      "and in order, with no duplicates — which is what stepping by 1 would produce",
    );
    assert.equal(walked.truncated, false);
  } finally {
    restore();
  }
});

test("an offset walk ends on a SHORT page, and a full last page costs one more request", async () => {
  await primeTemplating();
  // Exactly two full pages: the vendor cannot say "that was the last one", so the walk has
  // to ask again and get nothing. Off-by-one here would silently drop the final page.
  const { asked, restore } = stubDataset(20);
  try {
    const walked: any = await fetchPaginated(NODE, datasetCall, emptyContext(), "test");
    assert.deepEqual(asked, [0, 10, 20]);
    assert.equal(walked.items.length, 20);
  } finally {
    restore();
  }
});

test("an empty dataset is one request and no items, not an error", async () => {
  await primeTemplating();
  const { asked, restore } = stubDataset(0);
  try {
    const walked: any = await fetchPaginated(NODE, datasetCall, emptyContext(), "test");
    assert.deepEqual(asked, [0]);
    assert.deepEqual(walked.items, []);
  } finally {
    restore();
  }
});

/**
 * A paginated call with NO `max` walks everything, rather than throwing.
 *
 * REGRESSION. The default was written as `evaluate(p.max ?? "return Infinity")`, and the
 * expression sandbox has no `Infinity` — so every paginated call that did not set a bound
 * failed on its first page with `unknown identifier 'Infinity'`. AirtableInsert's dedup
 * scan is one, in the shipped tree.
 *
 * It hid because the two nodes written after it both set `max` from config. A default is
 * only exercised by whoever takes it, which is why it needs its own test.
 */
test("a paginated call with no `max` walks the whole collection", async () => {
  await primeTemplating();
  const { asked, restore } = stubDataset(25);
  try {
    const unbounded = { ...datasetCall, paginate: { ...datasetCall.paginate, max: undefined } };
    const walked: any = await fetchPaginated(NODE, unbounded, emptyContext(), "test");
    assert.equal(walked.items.length, 25, "no bound means no bound, not a failure");
    assert.deepEqual(asked, [0, 10, 20]);
  } finally {
    restore();
  }
});

/* ─────────────────────── the shipped id derivation ─────────────────────── */

/** The real `items` expression, out of the manifest this test exists to protect. */
const itemsExpression: string = (() => {
  const rows = parse(
    readFileSync(join(UNOVERSE, "nodes/apify/nodes/ApifyResults/api/events.yaml"), "utf8"),
  );
  const row = rows.find((r: any) => r.emit === "items");
  assert.ok(row?.value, "ApifyResults must still have an `items` row to test");
  return row.value;
})();

const shape = (items: unknown[]) =>
  evaluate(itemsExpression, { response: { items }, config: {} } as Record<string, unknown>);

test("ApifyResults strips the payload that broke the bus", async () => {
  const [out]: any = await shape([
    {
      url: "https://example.com/a",
      text: "hello",
      crawl: { httpStatusCode: 200, depth: 1 },
      metadata: { title: "A", headers: { "set-cookie": "x".repeat(4000) } },
    },
  ]);
  assert.equal(out.crawl, undefined, "the per-fetch crawl block is removed");
  assert.equal(out.metadata.headers, undefined, "and the headers inside metadata");
  assert.equal(out.metadata.title, "A", "while the rest of metadata survives");
  assert.equal(out.text, "hello", "and so does the content");
});

test("ApifyResults derives a stable universalId from the url alone", async () => {
  const [a]: any = await shape([{ url: "https://example.com/a", text: "one" }]);
  const [b]: any = await shape([{ url: "https://example.com/a", text: "TWO, quite different" }]);
  assert.equal(a.universalId.length, 12);
  assert.equal(
    a.universalId,
    b.universalId,
    "SAME PAGE, SAME ID: universalId identifies the page, so changed content must not move it",
  );
  const [c]: any = await shape([{ url: "https://example.com/c", text: "one" }]);
  assert.notEqual(c.universalId, a.universalId, "a different url is a different page");
});

test("ApifyResults derives a contentId that MOVES when the content does", async () => {
  const [a]: any = await shape([{ url: "https://example.com/a", text: "one", metadata: { title: "T" } }]);
  const [same]: any = await shape([{ url: "https://example.com/a", text: "one", metadata: { title: "T" } }]);
  const [edited]: any = await shape([{ url: "https://example.com/a", text: "two", metadata: { title: "T" } }]);

  assert.equal(a.contentId.length, 12);
  assert.equal(a.contentId, same.contentId, "an unchanged page hashes the same, which is what makes dedup work");
  assert.notEqual(
    a.contentId,
    edited.contentId,
    "and edited text must move it, or 'have I seen this already?' answers yes forever",
  );
});

test("ApifyResults folds openGraph content into the contentId", async () => {
  const base = { url: "https://example.com/a", text: "one" };
  const [without]: any = await shape([base]);
  const [with_]: any = await shape([{ ...base, metadata: { openGraph: [{ content: "a description" }] } }]);
  assert.notEqual(
    without.contentId,
    with_.contentId,
    "openGraph is part of what identifies a page's content, and the retired node hashed it too",
  );
});

test("ApifyResults leaves the ids off an item that has nothing to hash", async () => {
  // A dataset row with no url and no content. Minting ids from the empty string would give
  // EVERY such row the same id, which then collides in whatever joins on it.
  const [out]: any = await shape([{ someOtherField: 1 }]);
  assert.equal(out.universalId, undefined, "no url, no universalId");
  assert.equal(out.contentId, undefined, "and nothing to hash, so no contentId");
  assert.equal(out.someOtherField, 1, "the row itself still comes through");
});
