/**
 * Reading installed node rows.
 *
 * The engine owns database access (this server has no Postgres client), so rows come
 * over the same internal hop plugin state already uses. Kept in its own file so
 * `source.ts` stays a pure shape-conversion with no transport in it.
 *
 * A failure here is NOT fatal: it returns nothing and lets disk manifests load. A
 * universe that cannot reach its database briefly should come up with the nodes it has
 * on disk rather than with none at all.
 */
import type { ItemRow } from "./source.js";

const ENGINE = process.env.WORKFLOW_SERVICE_URL || "http://localhost:4101";

export async function fetchNodeRows(): Promise<ItemRow[]> {
  try {
    const res = await fetch(`${ENGINE}/items?kind=node`);
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: Array<{ name: string; definition: any; enabled?: boolean }> };
    // A disabled row is retracted, not hidden: it must not register, exactly as an
    // uninstalled one would not. Enabled is the running state, presence is possession.
    return (data.items ?? []).filter((r) => r.enabled !== false).map((r) => ({ name: r.name, definition: r.definition }));
  } catch {
    return [];
  }
}
