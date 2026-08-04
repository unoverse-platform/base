/**
 * PLATFORM STATE — the capability that let the CRM nodes stop being code.
 *
 * These assert behaviour that is otherwise invisible. A manifest reading a cache that was
 * never written, or writing to a key the memory server does not read, produces no error at
 * all: the cache just looks permanently cold and the queue silently fills. That is exactly
 * the failure the retired code had a comment warning about.
 *
 * See SECURITY.md and DECLARATIVE_NODES.md §"platform state".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const UNOVERSE = join(HERE, "../../../apps/unoverse");

const { makeStateStore, performState, runCalls, emptyContext, primeTemplating } = await import("@unoverse-platform/base/manifests/runtime/index.js");

/** A Redis stand-in: a Map plus the three methods the store actually uses. */
function fakeRedis(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  const lists = new Map<string, string[]>();
  return {
    data,
    lists,
    async get(k: string) {
      return data.get(k) ?? null;
    },
    async set(k: string, v: string) {
      data.set(k, v);
    },
    async lpop(k: string) {
      const l = lists.get(k);
      return l?.length ? l.shift()! : null;
    },
  };
}

test("read returns the stored object, and {} when the key is cold", async () => {
  const redis = fakeRedis({ "k1": JSON.stringify({ contact: { id: "1" } }) });
  const store = makeStateStore(redis, undefined)!;
  assert.deepEqual(await store.read("k1"), { contact: { id: "1" } });
  assert.deepEqual(await store.read("nope"), {}, "a cold key is empty, never an error");
});

/**
 * THE NAMESPACE. The memory server prefixes its keys with REDIS_NAMESPACE, so a manifest
 * writing an unprefixed key would land somewhere nothing reads. Both sides would work
 * perfectly and the sync would simply never happen.
 */
test("the deployment namespace is applied by the executor, not by the manifest", async () => {
  const redis = fakeRedis();
  const store = makeStateStore(redis, "gravity")!;
  await store.merge("crm:u1:w1", { contact: { id: "9" } });
  assert.deepEqual(
    [...redis.data.keys()],
    ["gravity:crm:u1:w1"],
    "the manifest writes the logical key and the executor prefixes it",
  );
});

/**
 * MERGE, not replace. The memory server writes its own fields into the same snapshot, so
 * a wholesale write would silently drop them.
 */
test("merge keeps fields another writer put there, and stamps updatedAt", async () => {
  const redis = fakeRedis({ "k": JSON.stringify({ attributes: { room: "12" }, contact: { id: "old" } }) });
  const store = makeStateStore(redis, undefined)!;
  const next: any = await store.merge("k", { contact: { id: "new" } });

  assert.deepEqual(next.attributes, { room: "12" }, "another writer's field must survive");
  assert.equal(next.contact.id, "new");
  assert.ok(typeof next.updatedAt === "string");
});

test("drain pops oldest first, stops when empty, and is bounded", async () => {
  const redis = fakeRedis();
  redis.lists.set("q", [1, 2, 3, 4].map((n) => JSON.stringify({ claim: `c${n}` })));
  const store = makeStateStore(redis, undefined)!;

  assert.deepEqual(await store.drain("q", 2), [{ claim: "c1" }, { claim: "c2" }], "oldest first, bounded by max");
  assert.deepEqual(await store.drain("q", 10), [{ claim: "c3" }, { claim: "c4" }], "then the rest, stopping when empty");
  assert.deepEqual(await store.drain("q", 10), [], "an empty queue drains to nothing");
});

test("a drained item is GONE, so a re-run cannot duplicate it", async () => {
  const redis = fakeRedis();
  redis.lists.set("q", [JSON.stringify({ claim: "once" })]);
  const store = makeStateStore(redis, undefined)!;
  await store.drain("q", 10);
  assert.deepEqual(await store.drain("q", 10), [], "dedup is inherent because the pop is the read");
});

/**
 * A universe with no Redis must degrade to "the cache was cold", not fail a workflow. The
 * whole point of a cache is that losing it costs time, never correctness.
 */
test("with no store configured, a read is empty and a drain is empty, never a throw", async () => {
  assert.equal(makeStateStore(null, undefined), undefined);
  assert.deepEqual(await performState("read", "k", undefined, undefined, undefined), {});
  assert.deepEqual(await performState("drain", "k", undefined, undefined, undefined), []);
});

/** State calls sit in the SAME ordered list as requests, and read each other by name. */
test("a state call runs in the call list and is reachable as calls.<name>", async () => {
  await primeTemplating();
  const redis = fakeRedis({ "crm:u1:w1": JSON.stringify({ contact: { id: "cached" } }) });
  const store = makeStateStore(redis, undefined)!;

  const { results } = await runCalls(
    { type: "T", allowedHosts: [] } as any,
    [
      { name: "snapshot", state: "read", key: "crm:{{ scope.userId }}:{{ scope.workflowId }}" },
      {
        name: "cache",
        state: "merge",
        when: "return !!calls.snapshot.contact",
        key: "crm:{{ scope.userId }}:{{ scope.workflowId }}",
        value: "return { seen: calls.snapshot.contact.id }",
      },
    ],
    emptyContext({ scope: { userId: "u1", workflowId: "w1" } }),
    "test",
    store,
  );

  assert.equal(results.snapshot.contact.id, "cached", "the key templated from scope, and the read landed");
  assert.equal(results.cache.seen, "cached", "the merge saw the earlier call by name");
  assert.equal(JSON.parse(redis.data.get("crm:u1:w1")!).seen, "cached", "and it actually persisted");
});
