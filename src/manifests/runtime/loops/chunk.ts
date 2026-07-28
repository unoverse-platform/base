/**
 * CHUNKED WRITES. One call in the manifest, many requests on the wire.
 *
 * The mirror of pagination: that one loops because the vendor decides how much comes back,
 * this one loops because the vendor decides how much may go in at once. Airtable takes 10
 * records per write, HubSpot 100, Salesforce 200, so writing a collection of unknown length
 * is N requests and a manifest has no way to repeat a call N times.
 *
 * The loop is computation, the batch size and the body shape are description, which is the
 * usual split. Every node that writes a collection inherits this.
 *
 * The reply is `{ sent, batches, results, errors }`. Partial success is the normal outcome
 * of a batched write and it must be visible: one rejected batch out of ten is not a failed
 * call, and it is not a successful one either.
 */
import type { ComposedNode } from "../../compose.js";
import type { RunContext } from "../context.js";
import { evaluate } from "../templating.js";
import { sendRequest } from "../http/request.js";
import { fetchPolled } from "./poll.js";
import { readSettled } from "../http/response.js";

export interface Chunked {
  /** Items actually accepted, across every batch that succeeded. */
  sent: number;
  batches: number;
  /**
   * What the walk was OVER, in order — the resolved collection, not a count of it.
   *
   * The other four fields all describe what HAPPENED, and for a write that is the whole
   * story. Fanning out a READ needs the input as well: pairing reply i back to the thing
   * that produced it is impossible from a summary, and re-deriving the list in the events
   * table means the same expression written twice, free to drift.
   */
  items: unknown[];
  /**
   * One entry per batch, IN ORDER, `null` where the batch failed.
   *
   * Positional, not compacted. A write only ever reads `sent`, so the difference did not
   * show until `chunk` was used to fan out a READ (one item per request), where the caller
   * has to pair each reply back to the item that produced it. Dropping the failures would
   * shift every later reply onto the wrong item and label the results wrongly, which is
   * worse than an error, because it looks like an answer.
   */
  results: unknown[];
  /** One entry per FAILED batch, naming which. Empty means every batch landed. */
  errors: string[];
}

/** Independent of anything the manifest says, so a bad `size` cannot melt a vendor. */
const HARD_BATCH_CAP = 200;

export async function sendChunked(
  node: ComposedNode,
  call: any,
  ctx: RunContext,
  label: string,
): Promise<Chunked> {
  const c = call.chunk;
  const all = await evaluate(c.items, ctx as unknown as Record<string, unknown>);
  const items: unknown[] = Array.isArray(all) ? all : [];
  const size = Math.min(Math.max(Number(c.size) || 1, 1), HARD_BATCH_CAP);

  const out: Chunked = { sent: 0, batches: 0, items, results: [], errors: [] };
  if (!items.length) return out;

  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const n = out.batches + 1;

    // `batch` is in scope for the body, which is the whole point: the manifest describes
    // what ONE request looks like for a slice, and this repeats it.
    const scoped = { ...ctx, batch } as RunContext;

    try {
      // The two loops COMPOSE, because they are orthogonal: this one walks the collection,
      // `poll` waits on one request. A vendor whose endpoint takes a single item AND runs
      // it as a job (Hyperbrowser's fetch is both) needs both, and declaring them mutually
      // exclusive would put that node back in TypeScript for no reason.
      out.results.push(
        call.poll
          ? await fetchPolled(node, call, scoped, `${label} (batch ${n})`)
          : await readSettled(await sendRequest(node, call, scoped, `${label} (batch ${n})`), call.transport, call.encoding),
      );
      out.sent += batch.length;
    } catch (err: any) {
      // KEEP GOING. A batched write that abandons everything because batch 3 of 10 failed
      // is worse than one that reports which: the first two already landed and cannot be
      // taken back, so stopping leaves the caller unable to tell what happened.
      out.errors.push(`batch ${n}: ${err?.message ?? err}`);
      // Holds the slot, so `results[i]` is always the reply to batch `i`.
      out.results.push(null);
    }
    out.batches = n;
  }

  return out;
}
