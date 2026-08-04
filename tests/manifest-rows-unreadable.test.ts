/**
 * "COULD NOT READ" MUST NOT LOOK LIKE "HAS NONE".
 *
 * A deployed universe has no nodes on disk: every node it owns is a row. So when the read
 * of those rows fails and answers `[]`, the loader reports a clean success with zero
 * packages, and the universe serves an EMPTY node catalog. Every node in every workflow
 * renders as "in the marketplace as …", exactly as though it had been uninstalled, while
 * the rows sit untouched in the database.
 *
 * That is what happened. A deploy starts every container at once, the read lost the race
 * to the engine, and `catch { return [] }` turned a transient failure into a permanent,
 * silent, total outage. Worse, the caller HAD a retry — this function guaranteed it could
 * never fire, because nothing above ever learned anything had gone wrong.
 *
 * So: a failure throws, an empty universe does not. Those are different answers and the
 * difference is the whole bug.
 */
import test, { describe, after } from "node:test";
import assert from "node:assert/strict";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const { fetchNodeRows } = await import("../src/manifests/rows.js");

/** Point global fetch at one canned outcome. */
function serving(outcome: { throws?: string; status?: number; body?: unknown }) {
  globalThis.fetch = (async () => {
    if (outcome.throws) throw new Error(outcome.throws);
    return new Response(JSON.stringify(outcome.body ?? {}), {
      status: outcome.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("reading installed node rows", () => {
  test("an unreachable engine THROWS, so the caller can retry it", async () => {
    serving({ throws: "connect ECONNREFUSED 127.0.0.1:4101" });
    await assert.rejects(
      () => fetchNodeRows(),
      /could not reach the engine/,
      "an unreachable engine answered 'no rows', which is how a universe loses every node it owns",
    );
  });

  test("a non-OK status THROWS too: a 503 is not an empty universe", async () => {
    serving({ status: 503, body: {} });
    await assert.rejects(() => fetchNodeRows(), /answered 503/);
  });

  test("a universe that genuinely holds no rows answers empty, and does NOT throw", async () => {
    serving({ body: { items: [] } });
    assert.deepEqual(await fetchNodeRows(), [], "a fresh universe with nothing installed is a legitimate state");
  });

  test("rows come back, and a retracted one is left out", async () => {
    serving({
      body: {
        items: [
          { name: "Note", definition: { files: { "node.yaml": "x" } }, enabled: true },
          { name: "Code", definition: { files: { "node.yaml": "y" } } }, // absent = enabled
          { name: "Gone", definition: { files: { "node.yaml": "z" } }, enabled: false },
        ],
      },
    });
    const rows = await fetchNodeRows();
    assert.deepEqual(
      rows.map((r) => r.name),
      ["Note", "Code"],
      "a disabled row is retracted, and an unset `enabled` is not disabled",
    );
  });
});
