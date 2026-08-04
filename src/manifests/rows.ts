/**
 * Reading installed node rows.
 *
 * The engine owns database access (this server has no Postgres client), so rows come
 * over the same internal hop plugin state already uses. Kept in its own file so
 * `source.ts` stays a pure shape-conversion with no transport in it.
 *
 * COULD NOT READ IS NOT THE SAME AS HAS NONE, and conflating them cost a universe every
 * node it owned.
 *
 * This used to answer `[]` for any failure — a bad status, a refused connection, a
 * malformed body — on the reasoning that a universe briefly unable to reach its database
 * should come up with the nodes it has on disk rather than none at all. That was sound
 * when disk was the primary source. It stopped being sound when the design system and
 * every marketplace node became ROWS: a deployed universe has NO nodes on disk, so rows
 * are not a supplement, they are the whole set.
 *
 * The result: a deploy starts every container at once, this read loses the race to the
 * engine, `[]` comes back indistinguishable from an empty universe, and the loader
 * reports a clean success with zero packages. Every node in every workflow then renders
 * as "in the marketplace as …", exactly as though it had been uninstalled, while all 46
 * rows sit untouched in the database. Nothing retried, because nothing knew anything had
 * failed. The caller had a retry and this function made sure it could never fire.
 *
 * So a failure THROWS. `loadManifests` already catches per source and records it, so one
 * dead source still cannot lose the other — the difference is that the failure is now
 * visible, and the boot can wait for the engine and try again.
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
