/**
 * ITERATION BOOKKEEPING — the capability behind the LoopStart / LoopEnd pair.
 *
 * WHY THIS IS ONE CAPABILITY AND NOT SEVERAL STATE OPS. The retired executors reached for
 * hset, hget, hincrby, rpush, lrange, exists, del and expire. Declaring those one by one in
 * api.schema.json would have amounted to "a manifest may run arbitrary Redis", which is the
 * exact authority this format exists to withhold (DECLARATIVE_NODES.md §2). So the manifest
 * names the three things a loop actually DOES, and the key layout, the counter and the
 * teardown stay in here where they can be read once and audited:
 *
 *   open     take an array, record it, hand back the first item
 *   read     hand back the item at the CURRENT index, without moving it
 *   advance  collect this pass's value, move the index, and say whether there is more
 *
 * THE PAIR IS NOT AN ACTOR, which is the thing to understand before changing any of this.
 * There is no XState access and no generator: LoopStart is an ordinary settle-once node that
 * fires on its `items` input and then fires AGAIN because LoopEnd routes a `continue` signal
 * back to it along a real edge. Each pass is a separate execution of both nodes, which is why
 * all the state has to live outside them — a local variable would not survive the gap.
 *
 * `read` and `advance` are deliberately separate so that ITEM EMISSION HAS ONE HOME. LoopEnd
 * moves the index and LoopStart reads it; if LoopEnd also returned the next item, the same
 * fact would be computed in two places and could disagree by one.
 *
 * The engine has its own stake in the output shape: `executingState.ts` lifts {item, index,
 * total} off a node whose type is literally "LoopStart" into `activeLoop`, and that is what
 * makes {{ loop.item }} resolve for every node inside the body. So those three names are a
 * contract, not a preference.
 */

/** The Redis surface a loop needs. Injected, so this file touches no platform global. */
export interface LoopOps {
  open(executionId: string, loopId: string, items: unknown): Promise<LoopPass>;
  read(executionId: string, loopId: string): Promise<LoopPass>;
  advance(executionId: string, loopId: string, collect: unknown): Promise<LoopStep>;
}

/** One pass, as LoopStart emits it. The three names the engine reads. */
export interface LoopPass {
  item: unknown;
  index: number;
  total: number;
}

/** The end of one pass, as LoopEnd emits it. */
export interface LoopStep {
  continuing: boolean;
  index: number;
  total: number;
  collected?: unknown[];
}

/** An hour, matching the retired nodes. The state is within-run; this only stops a leak. */
const TTL_SECONDS = 3600;

/**
 * THE ITEMS INPUT, normalised — and this is executor work rather than manifest work because
 * what it unwraps is the PLATFORM'S OWN envelope, not the shape of anyone's data.
 *
 * A wired input arrives nested twice, by source node id and then by that source's output
 * handle: `{ upstream1: { rows: [...] } }`. The retired executor peeled that off, and doing it
 * in an expression instead would mean repeating `config.items || signal.items || []` five times
 * inside one nested ternary, because the sandbox cannot bind an intermediate. That is the
 * FieldValidator trap, and the answer here is that the envelope belongs to us.
 *
 * TRANSCRIBED from LoopStart's executor, branch for branch:
 *   an array, or anything not an object   use it as-is
 *   one source holding an object          the first ARRAY field in it, else the object itself
 *   one source holding anything else      that value
 * then a non-array becomes a one-item array, so "loop over a single thing" means one pass
 * rather than nothing.
 */
export function normaliseItems(raw: unknown): unknown[] {
  let items: any = raw ?? [];

  if (!Array.isArray(items) && items !== null && typeof items === "object") {
    const firstSource = Object.values(items)[0];
    if (firstSource && typeof firstSource === "object" && !Array.isArray(firstSource)) {
      items = Object.values(firstSource).find((v) => Array.isArray(v)) || firstSource;
    } else {
      items = firstSource || [];
    }
  }

  return Array.isArray(items) ? items : [items];
}

/**
 * Bound to a live client. `undefined` when the platform has no Redis.
 *
 * KEYS ARE NAMESPACED, unlike the saved-context hash in state.ts, and the difference is about
 * who else reads them. `saved:<executionId>` is the engine's and must stay bare. These two are
 * ours alone, read by nothing outside this file, and both halves of the pair always move
 * versions together — so there is no bare-versus-prefixed mismatch to create.
 */
export function makeLoopOps(redis: any, namespace: string | undefined): LoopOps | undefined {
  if (!redis) return undefined;
  const ns = namespace ? `${namespace}:` : "";
  const stateKey = (executionId: string, loopId: string) => `${ns}loop:${executionId}:${loopId}`;
  const collectedKey = (executionId: string, loopId: string) => `${ns}loop:collected:${executionId}:${loopId}`;

  const parseItem = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return raw; // a value stored as plain text reads back as text rather than failing the loop
    }
  };

  return {
    async open(executionId, loopId, items) {
      const list = normaliseItems(items);
      const key = stateKey(executionId, loopId);
      await redis.hset(key, { items: JSON.stringify(list), index: "0", total: String(list.length) });
      await redis.expire(key, TTL_SECONDS);
      return { item: list.length ? list[0] : null, index: 0, total: list.length };
    },

    async read(executionId, loopId) {
      const key = stateKey(executionId, loopId);
      const [itemsJson, indexStr, totalStr] = await Promise.all([
        redis.hget(key, "items"),
        redis.hget(key, "index"),
        redis.hget(key, "total"),
      ]);
      const list: unknown[] = JSON.parse(itemsJson || "[]");
      const index = parseInt(indexStr || "0", 10);
      return { item: list[index] ?? null, index, total: parseInt(totalStr || "0", 10) };
    },

    async advance(executionId, loopId, collect) {
      const key = stateKey(executionId, loopId);
      const bag = collectedKey(executionId, loopId);

      // A MISSING LOOP IS AN ERROR, not an empty result. It means LoopEnd is pointing at a
      // LoopStart that never ran — usually a mistyped loopStartNodeId — and returning "done"
      // would silently complete a loop that never had a first pass.
      if (!(await redis.exists(key))) throw new Error(`loop state not found for ${executionId}:${loopId}`);

      // Empty string as well as null: `collect` is a template field, so a config left blank
      // resolves to "" rather than to nothing, and storing that would put a blank entry in the
      // results for every pass.
      if (collect !== undefined && collect !== null && collect !== "") {
        // An ARRAY IS SPREAD into separate entries rather than nested, matching the retired
        // node: collecting a per-item list gives one flat result list at the end.
        for (const item of Array.isArray(collect) ? collect : [collect]) await redis.rpush(bag, JSON.stringify(item));
        await redis.expire(bag, TTL_SECONDS);
      }

      // hincrby, so two nodes finishing at once cannot both read the same index and skip one.
      const index: number = await redis.hincrby(key, "index", 1);
      const total = parseInt((await redis.hget(key, "total")) || "0", 10);
      if (index < total) return { continuing: true, index, total };

      const collected = (await redis.exists(bag)) ? ((await redis.lrange(bag, 0, -1)) as string[]).map(parseItem) : [];
      // Torn down on the last pass, so a long workflow does not carry every loop it ever ran.
      await redis.del(key, bag);
      return { continuing: false, index, total, collected };
    },
  };
}

/**
 * Perform one declared loop operation.
 *
 * Unlike a state read, THERE IS NO DEGRADED MODE. A cache that reads cold is a cache doing its
 * job badly; a loop with nowhere to keep its index cannot iterate at all, and pretending
 * otherwise would run the body once and call it done.
 */
export async function performLoop(
  op: string,
  executionId: string | undefined,
  loopId: string,
  value: unknown,
  ops: LoopOps | undefined,
): Promise<LoopPass | LoopStep> {
  if (!ops) throw new Error(`loop "${op}" needs Redis to keep its index, and this platform has none configured`);
  if (!executionId) throw new Error(`loop "${op}" needs the run's executionId, and this run supplied none`);
  if (!loopId) throw new Error(`loop "${op}" needs the LoopStart node's id as its "key", and none resolved`);

  switch (op) {
    case "open":
      return ops.open(executionId, loopId, value);
    case "read":
      return ops.read(executionId, loopId);
    case "advance":
      return ops.advance(executionId, loopId, value);
    default:
      throw new Error(`loop operation "${op}" is declared in the schema but not implemented in the executor`);
  }
}
