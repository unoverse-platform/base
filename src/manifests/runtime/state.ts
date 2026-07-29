/**
 * PLATFORM STATE. The capability that lets a manifest keep something between runs.
 *
 * Every other capability here reaches a vendor over HTTP. This one reaches Redis, through
 * the same `api.getRedisClient()` handle the plugin library already gives a code node, so
 * nothing new is introduced: a manifest simply NAMES an operation the platform already
 * performs (DECLARATIVE_NODES.md §2).
 *
 * Four operations, which is what the retired CRM and Code nodes needed and no more:
 *
 *   read    the value at a key, or {} when cold
 *   merge   shallow-merge a patch into it, stamped with updatedAt
 *   drain   pop up to `max` items off a list, oldest first
 *   save    put this node's value into the RUN's saved-context hash, so a later template
 *           reaches it as saved.<nodeId>
 *
 * `save` NAMES NO KEY, and that is the whole reason it is a separate operation rather than a
 * `merge` the manifest addresses itself. Its key belongs to the ENGINE — NodeExecutionContext
 * reads `saved:<executionId>` when it builds the template scope, and workflowActions deletes it
 * when the run ends — so a manifest writing that key by hand would be guessing at another
 * component's private layout, and would also get the namespace exactly wrong (see below).
 *
 * THE NAMESPACE IS APPLIED HERE, never by the manifest. `REDIS_NAMESPACE` is a deployment
 * fact, and the memory server prefixes its own keys with it. A manifest that had to
 * remember the prefix would eventually forget, both sides would write happily to different
 * keys, and nothing would error: the sync would just silently stop working. So a manifest
 * writes the logical key and cannot get this wrong.
 */

import { makeLoopOps, type LoopOps } from "./loops/loop.js";

/** What the executor needs from Redis. Injected, so this file touches no platform global. */
export interface StateStore {
  read(key: string): Promise<Record<string, unknown>>;
  merge(key: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  drain(key: string, max: number): Promise<unknown[]>;
  /** The run's saved-context hash. Takes ids, not a key: the layout is the engine's, not ours. */
  save(executionId: string, nodeId: string, value: unknown): Promise<unknown>;
  /**
   * ITERATION BOOKKEEPING, implemented in loops/loop.ts and carried here.
   *
   * It hangs off this interface rather than being a seventh argument threaded through
   * performApi, runCalls and runFinal because it needs exactly the same thing this store
   * needs — the Redis handle — and every one of those call sites already has the store. A
   * parallel parameter would be four signature changes to deliver one dependency twice.
   */
  loop?: LoopOps;
  /**
   * THE LIVE CLIENT ITSELF, for the one capability the four named operations cannot express:
   * the docstore's WATCH/MULTI transaction (read-check-write as one unit, retried on
   * conflict). Carried here for the same reason `loop` is — every call site that needs it
   * already has the store. Capabilities take it from here; a manifest never sees it.
   */
  raw?: any;
}

/** Bound to a live client. `null` when the platform has no Redis, which is not an error. */
export function makeStateStore(redis: any, namespace: string | undefined): StateStore | undefined {
  if (!redis) return undefined;
  const ns = namespace ? `${namespace}:` : "";
  const full = (key: string) => `${ns}${key}`;

  const parse = (raw: string | null): Record<string, unknown> => {
    if (!raw) return {};
    try {
      const v = JSON.parse(raw);
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
      return {}; // a corrupt value reads as cold, which is recoverable; throwing is not
    }
  };

  return {
    // Same client, same namespace. See loops/loop.ts for why a loop is one capability rather
    // than the seven raw Redis commands the retired nodes reached for.
    loop: makeLoopOps(redis, namespace),

    // The handle itself, for the docstore's WATCH/MULTI transaction (see the interface).
    raw: redis,

    async read(key) {
      return parse(await redis.get(full(key)));
    },

    async merge(key, patch) {
      // Read-modify-write, shallow. The snapshot is written by more than one node and by
      // the memory server, so replacing it wholesale would drop whatever the others put
      // there. No TTL: CRM context stays until something explicitly refreshes it.
      const next = { ...parse(await redis.get(full(key))), ...patch, updatedAt: new Date().toISOString() };
      await redis.set(full(key), JSON.stringify(next));
      return next;
    },

    /**
     * `saved:<executionId>`, one hash field per node — the ENGINE's layout, matched exactly.
     *
     * NOT namespaced, deliberately, and it is the one key here that must not be. Every other key
     * in this file is ours and is shared with the memory server, which prefixes. This one is read
     * by `NodeExecutionContext` and deleted by `workflowActions` with a bare `saved:${executionId}`,
     * so prefixing it would put the value somewhere nothing looks. That failure is invisible: the
     * write succeeds, the toggle appears to work, and `{{ saved.x }}` is quietly empty forever.
     * Hence `full()` is not applied and this comment sits where someone would think to add it.
     *
     * TTL matches the retired node's hour, which is also the loop state's. It is a within-run
     * cache, and the engine deletes the key at the end of a run anyway — the expiry is only there
     * so a run that dies without cleaning up does not leak the key.
     */
    async save(executionId, nodeId, value) {
      const key = `saved:${executionId}`;
      await redis.hset(key, nodeId, JSON.stringify(value ?? null));
      await redis.expire(key, 3600);
      // `?? null` so `calls.<name>` always HAS a key once this ran. Returning undefined would be
      // indistinguishable from the call being skipped, and that distinction is exactly what the
      // `__saveToContext` flag is derived from.
      return value ?? null;
    },

    async drain(key, max) {
      // LPOP one at a time so dedup is inherent: an item taken is gone, and a crash
      // mid-drain loses at most the one in flight rather than the whole queue.
      const out: unknown[] = [];
      for (let i = 0; i < Math.max(1, max); i++) {
        const raw = await redis.lpop(full(key));
        if (!raw) break;
        try {
          out.push(JSON.parse(raw));
        } catch {
          // A malformed item is skipped rather than retried forever. It is already popped.
        }
      }
      return out;
    },
  };
}

/**
 * Perform one declared state operation and return what the call's `name` will hold.
 *
 * With no store this returns empty rather than throwing. A universe with no Redis should
 * degrade to "the cache was cold", which every caller already handles, instead of failing
 * a workflow over a cache.
 */
export async function performState(
  op: string,
  key: string,
  value: unknown,
  max: number | undefined,
  store: StateStore | undefined,
  /** Only `save` reads this: its key is the run's, not the manifest's. */
  scope: { executionId?: string; nodeId?: string } = {},
): Promise<unknown> {
  if (!store) return op === "drain" ? [] : op === "save" ? (value ?? null) : {};

  switch (op) {
    case "read":
      return store.read(key);
    case "merge":
      return store.merge(key, (value as Record<string, unknown>) ?? {});
    case "drain":
      return store.drain(key, max ?? 25);
    case "save":
      // Both ids or nothing. A save keyed by "undefined" would write a hash no run ever reads,
      // and would look identical to a working one from the manifest's side. The retired node
      // defaulted the node id instead, which silently merged two nodes into one field.
      if (!scope.executionId || !scope.nodeId)
        throw new Error(`state "save" needs the run's executionId and nodeId, and this run supplied neither`);
      return store.save(scope.executionId, scope.nodeId, value);
    default:
      throw new Error(`state operation "${op}" is declared in the schema but not implemented in the executor`);
  }
}
