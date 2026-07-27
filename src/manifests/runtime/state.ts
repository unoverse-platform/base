/**
 * PLATFORM STATE. The capability that lets a manifest keep something between runs.
 *
 * Every other capability here reaches a vendor over HTTP. This one reaches Redis, through
 * the same `api.getRedisClient()` handle the plugin library already gives a code node, so
 * nothing new is introduced: a manifest simply NAMES an operation the platform already
 * performs (DECLARATIVE_NODES.md §2).
 *
 * Three operations, which is what the retired CRM code needed and no more:
 *
 *   read    the value at a key, or {} when cold
 *   merge   shallow-merge a patch into it, stamped with updatedAt
 *   drain   pop up to `max` items off a list, oldest first
 *
 * THE NAMESPACE IS APPLIED HERE, never by the manifest. `REDIS_NAMESPACE` is a deployment
 * fact, and the memory server prefixes its own keys with it. A manifest that had to
 * remember the prefix would eventually forget, both sides would write happily to different
 * keys, and nothing would error: the sync would just silently stop working. So a manifest
 * writes the logical key and cannot get this wrong.
 */

/** What the executor needs from Redis. Injected, so this file touches no platform global. */
export interface StateStore {
  read(key: string): Promise<Record<string, unknown>>;
  merge(key: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  drain(key: string, max: number): Promise<unknown[]>;
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
  value: Record<string, unknown> | undefined,
  max: number | undefined,
  store: StateStore | undefined,
): Promise<unknown> {
  if (!store) return op === "drain" ? [] : {};

  switch (op) {
    case "read":
      return store.read(key);
    case "merge":
      return store.merge(key, value ?? {});
    case "drain":
      return store.drain(key, max ?? 25);
    default:
      throw new Error(`state operation "${op}" is declared in the schema but not implemented in the executor`);
  }
}
