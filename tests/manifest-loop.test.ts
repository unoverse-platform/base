/**
 * THE LOOP, DRIVEN ALL THE WAY ROUND.
 *
 * Each node's own fixture runs ONE pass, which is all a bench can do: LoopStart opens, LoopEnd
 * advances, and neither ever sees the other. That leaves the part most likely to be wrong untested —
 * the handover, and the arithmetic at the end of it. An off-by-one here does not error, it processes
 * the wrong number of items, and the retired executors were the only proof that the sequence held.
 *
 * So this walks a real loop: open, then read/advance for every item, until done. It runs the real
 * `makeLoopOps` against an in-memory client, so what is asserted is production code — a fake store
 * would be a second implementation of the same arithmetic, free to agree with the test and disagree
 * with Redis.
 *
 * NO ACTOR ANYWHERE IN HERE, and that is the design being pinned. Each pass is a separate call, the
 * way each pass is a separate execution on the canvas: LoopEnd emits `continue` on an ordinary edge
 * and LoopStart runs again. The retired single-node Loop reached into the XState actor to re-invoke
 * itself and was replaced for exactly that reason.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { makeLoopOps, normaliseItems, performLoop } from "../src/manifests/runtime/loops/loop.js";

/** The smallest Redis that satisfies a loop. Mirrors the bench's, deliberately. */
function fakeRedis() {
  const store = new Map<string, any>();
  const hash = (k: string) => {
    if (!(store.get(k) instanceof Map)) store.set(k, new Map());
    return store.get(k) as Map<string, string>;
  };
  const list = (k: string) => {
    if (!Array.isArray(store.get(k))) store.set(k, []);
    return store.get(k) as string[];
  };
  return {
    keys: store,
    async hset(k: string, f: any, v?: any) {
      const h = hash(k);
      if (typeof f === "object") for (const [kk, vv] of Object.entries(f)) h.set(kk, String(vv));
      else h.set(f, String(v));
    },
    async hget(k: string, f: string) { return store.get(k) instanceof Map ? (store.get(k).get(f) ?? null) : null; },
    async hincrby(k: string, f: string, by: number) {
      const h = hash(k);
      const next = parseInt(h.get(f) ?? "0", 10) + by;
      h.set(f, String(next));
      return next;
    },
    async rpush(k: string, v: string) { return list(k).push(v); },
    async lrange(k: string, from: number, to: number) { const l = list(k); return to === -1 ? l.slice(from) : l.slice(from, to + 1); },
    async exists(k: string) { return store.has(k) ? 1 : 0; },
    async del(...ks: string[]) { for (const k of ks) store.delete(k); },
    async expire() {},
  };
}

const RUN = "exec1";
const LOOP = "loopstart1";

test("a loop runs every item exactly once, in order, and then stops", async () => {
  const redis = fakeRedis();
  const ops = makeLoopOps(redis, undefined)!;

  const opened = await ops.open(RUN, LOOP, ["a", "b", "c"]);
  assert.deepEqual(opened, { item: "a", index: 0, total: 3 });

  // The canvas: LoopStart emits, the body runs, LoopEnd advances, and on `continue` LoopStart READS.
  const seen: unknown[] = [opened.item];
  let pass = await ops.advance(RUN, LOOP, null);
  while (pass.continuing) {
    seen.push((await ops.read(RUN, LOOP)).item);
    pass = await ops.advance(RUN, LOOP, null);
  }

  // EVERY ITEM, ONCE, IN ORDER. An off-by-one at either end is the whole failure mode here, and it
  // shows up as a short or repeating list rather than as an error.
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.equal(pass.continuing, false);
  assert.equal(pass.total, 3);
});

test("`read` does not move the index, so LoopEnd alone decides when a pass ends", async () => {
  const redis = fakeRedis();
  const ops = makeLoopOps(redis, undefined)!;
  await ops.open(RUN, LOOP, ["a", "b"]);
  await ops.advance(RUN, LOOP, null);

  // Read twice. If reading advanced, the loop would skip items whenever anything re-read a pass —
  // which is exactly what a retry or a re-render would do.
  assert.deepEqual(await ops.read(RUN, LOOP), { item: "b", index: 1, total: 2 });
  assert.deepEqual(await ops.read(RUN, LOOP), { item: "b", index: 1, total: 2 });
});

test("collected values arrive in pass order, with arrays flattened", async () => {
  const redis = fakeRedis();
  const ops = makeLoopOps(redis, undefined)!;
  await ops.open(RUN, LOOP, ["a", "b", "c"]);

  await ops.advance(RUN, LOOP, "first");
  await ops.advance(RUN, LOOP, ["second", "third"]); // an ARRAY spreads, rather than nesting
  const done = await ops.advance(RUN, LOOP, { kept: "fourth" });

  assert.equal(done.continuing, false);
  assert.deepEqual(done.collected, ["first", "second", "third", { kept: "fourth" }]);
});

test("nothing is collected for a pass that kept nothing, including the empty string", async () => {
  const redis = fakeRedis();
  const ops = makeLoopOps(redis, undefined)!;
  await ops.open(RUN, LOOP, ["a", "b", "c"]);

  // "" is the one that matters: `collect` is a TEMPLATE field, so a config left blank resolves to
  // the empty string rather than to nothing. Storing it would put a blank entry in the results on
  // every pass of every loop that does not collect.
  await ops.advance(RUN, LOOP, "");
  await ops.advance(RUN, LOOP, undefined);
  const done = await ops.advance(RUN, LOOP, null);

  assert.deepEqual(done.collected, []);
});

test("a finished loop leaves nothing behind", async () => {
  const redis = fakeRedis();
  const ops = makeLoopOps(redis, undefined)!;
  await ops.open(RUN, LOOP, ["a"]);
  await ops.advance(RUN, LOOP, "kept");

  // Both keys, not just the state one. The collected list is the one that would grow unbounded
  // across a long-running workflow, and it is the easier of the two to forget.
  assert.equal(redis.keys.size, 0, `a finished loop left ${[...redis.keys.keys()].join(", ")} in storage`);
});

test("closing a loop that was never opened is an error, not a quiet completion", async () => {
  const ops = makeLoopOps(fakeRedis(), undefined)!;
  // This is what a mistyped loopStartNodeId looks like. Returning "done" would complete a loop whose
  // body never ran even once, and the workflow would carry on with an empty collected list.
  await assert.rejects(() => ops.advance(RUN, "typo1", null), /loop state not found/);
});

test("an empty array yields no passes rather than one pass over nothing", async () => {
  const ops = makeLoopOps(fakeRedis(), undefined)!;
  const opened = await ops.open(RUN, LOOP, []);
  assert.deepEqual(opened, { item: null, index: 0, total: 0 });

  // 0 of 0: the first advance is already past the end, so the body runs zero times.
  const done = await ops.advance(RUN, LOOP, null);
  assert.equal(done.continuing, false);
  assert.deepEqual(done.collected, []);
});

test("two loops in one run keep separate indexes", async () => {
  const redis = fakeRedis();
  const ops = makeLoopOps(redis, undefined)!;
  await ops.open(RUN, "loopA", ["a1", "a2", "a3"]);
  await ops.open(RUN, "loopB", ["b1", "b2"]);

  await ops.advance(RUN, "loopA", null);

  // Keyed by the LoopStart node id as well as the run, so advancing one cannot move the other. A
  // shared key would make nested or sibling loops corrupt each other silently.
  assert.deepEqual(await ops.read(RUN, "loopA"), { item: "a2", index: 1, total: 3 });
  assert.deepEqual(await ops.read(RUN, "loopB"), { item: "b1", index: 0, total: 2 });
});

/**
 * THE ITEMS INPUT. Transcribed from the retired executor, so these cases ARE the retired branches.
 * They matter because the array usually arrives wired rather than configured, and a wired value is
 * wrapped twice — by source node, then by that source's output handle.
 */
test("the items input is unwrapped from the platform's own signal envelope", () => {
  assert.deepEqual(normaliseItems(["a", "b"]), ["a", "b"], "a plain array passes through");
  assert.deepEqual(normaliseItems({ upstream1: { rows: ["a", "b"] } }), ["a", "b"], "the first array field of the source");
  assert.deepEqual(normaliseItems({ upstream1: ["a", "b"] }), ["a", "b"], "a source holding the array directly");
  assert.deepEqual(normaliseItems({ upstream1: { name: "solo" } }), [{ name: "solo" }], "no array field: the object itself");
  // A single value becomes ONE pass, not zero. "Loop over this one thing" is a real thing to ask.
  assert.deepEqual(normaliseItems("solo"), ["solo"]);
  assert.deepEqual(normaliseItems(undefined), []);
  assert.deepEqual(normaliseItems(null), []);
});

/**
 * NO DEGRADED MODE, unlike a state read. This is the one place the two capabilities deliberately
 * differ, and the difference is load-bearing: `performState` returns {} with no Redis because a cold
 * cache is a recoverable answer, whereas a loop with nowhere to keep its index would run the body
 * once and report success. Silently processing one item out of a thousand is far worse than failing.
 */
test("a loop with no store fails loudly instead of iterating once", async () => {
  await assert.rejects(() => performLoop("open", RUN, LOOP, ["a", "b"], undefined), /needs Redis/);
});

test("a loop refuses to run without the ids that scope it to this run and this node", async () => {
  const ops = makeLoopOps(fakeRedis(), undefined)!;
  // Both messages name what is missing. An id defaulted to a constant would silently merge two
  // loops, or two runs, into one index — the same failure the Code node's nodeId fallback had.
  await assert.rejects(() => performLoop("open", undefined, LOOP, [], ops), /executionId/);
  await assert.rejects(() => performLoop("open", RUN, "", [], ops), /LoopStart node's id/);
});

test("an unimplemented loop operation says so rather than doing nothing", async () => {
  const ops = makeLoopOps(fakeRedis(), undefined)!;
  // The capability-parity guard stops the schema offering an operation with no code. This is the
  // other half: if one ever slips through, it must fail rather than silently no-op.
  await assert.rejects(() => performLoop("rewind", RUN, LOOP, null, ops), /not implemented in the executor/);
});
