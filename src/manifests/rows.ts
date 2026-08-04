/**
 * Reading installed node rows.
 *
 * The engine owns database access (this server has no Postgres client), so rows come
 * over the same internal hop plugin state already uses. Kept in its own file so
 * `source.ts` stays a pure shape-conversion with no transport in it.
 *
 * A failure here THROWS. It used to answer [] instead, which is indistinguishable from
 * a universe that owns nothing, and on a deployed universe rows are the only node
 * source, so a boot that lost the race to the engine silently served an empty catalog.
 * The loader records a thrown source and carries on, so one dead source still cannot
 * lose the other.
 */
import type { ItemRow } from "./source.js";

const ENGINE = process.env.WORKFLOW_SERVICE_URL || "http://localhost:4101";

export async function fetchNodeRows(): Promise<ItemRow[]> {
  let res: Response;
  try {
    res = await fetch(`${ENGINE}/items?kind=node`);
  } catch (error: any) {
    // Unreachable: the engine is not up yet, or not where we think it is. Both are worth
    // retrying, and neither means this universe has no nodes.
    throw new Error(`could not reach the engine at ${ENGINE} to read node rows: ${error?.message ?? error}`);
  }
  if (!res.ok) throw new Error(`the engine answered ${res.status} reading node rows from ${ENGINE}/items?kind=node`);

  const data = (await res.json()) as { items?: Array<{ name: string; definition: any; enabled?: boolean }> };
  // A disabled row is retracted, not hidden: it must not register, exactly as an
  // uninstalled one would not. Enabled is the running state, presence is possession.
  return (data.items ?? []).filter((r) => r.enabled !== false).map((r) => ({ name: r.name, definition: r.definition }));
}
