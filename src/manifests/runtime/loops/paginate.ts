/**
 * PAGINATION. One call in the manifest, many requests on the wire.
 *
 * Vendors disagree about the mechanism and agree about the shape: ask, get a page and a way
 * to ask for the next, repeat until there is no next or you have enough. The disagreement
 * is description (where the token lives, what it goes back as); the loop is computation, so
 * it belongs here and every list-returning node inherits it (DECLARATIVE_NODES.md §2).
 *
 * Without this a manifest cannot express a second page at all, because it has no way to
 * repeat a call an unknown number of times. `calls` is an ordered list of DIFFERENT calls,
 * not a loop.
 *
 * A paginated call's reply is `{ items, pages, truncated }`, not the last page's body. The
 * accumulation is the answer, and handing back the final page would quietly lose the rest.
 */
import type { ComposedNode } from "../../compose.js";
import type { RunContext } from "../context.js";
import { evaluate } from "../templating.js";
import { sendRequest } from "../http/request.js";
import { readSettled, assertOk } from "../http/response.js";

/**
 * Put the page token where the manifest said. Explicit on BOTH values rather than treating
 * query as an implicit else: the capability guard reads the enum and asks the executor to
 * name every member, which is what stops a schema value existing with no implementation.
 */
function place(call: any, where: string, into: string, value: unknown): any {
  switch (where) {
    case "query":
      return { ...call, query: { ...(call.query ?? {}), [into]: value } };
    case "body":
      return { ...call, body: withBodyKey(call.body, into, value) };
    default:
      throw new Error(`pagination "in: ${where}" is declared in the schema but not implemented in the executor`);
  }
}

/** Set a key on a body that may be an object OR a `return ...` expression. */
function withBodyKey(body: any, key: string, value: unknown): any {
  return typeof body === "string"
    ? `return Object.assign({}, (${body.replace(/^return\s+/, "")}), ${JSON.stringify({ [key]: value })})`
    : { ...(body ?? {}), [key]: value };
}

export interface Paginated {
  items: unknown[];
  pages: number;
  /** True when a bound stopped the walk while the vendor still had more. */
  truncated: boolean;
}

/**
 * A hard ceiling on requests, independent of anything the manifest says.
 *
 * A vendor that keeps returning the same cursor, or a manifest whose `cursor` expression
 * always finds a value, would otherwise loop until the process died. `max` is the author's
 * bound; this is the platform's, and it exists because the author's can be wrong.
 */
const HARD_PAGE_CAP = 100;

export async function fetchPaginated(
  node: ComposedNode,
  call: any,
  ctx: RunContext,
  label: string,
): Promise<Paginated> {
  const p = call.paginate;

  // Branch on the declared strategy. Without this the enum would be decoration: a value
  // added to the schema would silently walk as a cursor and look like it worked.
  if (p.strategy !== "cursor" && p.strategy !== "page" && p.strategy !== "offset")
    throw new Error(`pagination strategy "${p.strategy}" is declared in the schema but not implemented in the executor`);

  /**
   * UNBOUNDED IS THE DEFAULT, and it must not go through the sandbox to get there.
   *
   * This read `evaluate(p.max ?? "return Infinity")`, which threw `unknown identifier
   * 'Infinity'` — the expression allowlist has no such global, by design. So EVERY
   * paginated call that did not set `max` failed at the first page. AirtableInsert's dedup
   * scan is one of them, in the shipped tree.
   *
   * It survived because the two nodes written since both happen to set `max` from config,
   * and a default only breaks when someone takes it.
   */
  const max = p.max
    ? Number(await evaluate(String(p.max), ctx as unknown as Record<string, unknown>)) || Infinity
    : Infinity;

  const items: unknown[] = [];
  // `page` counts from 1, `offset` counts ITEMS from 0, and both go out on the first
  // request; `cursor` is absent until a reply hands one over.
  let cursor: unknown = p.strategy === "page" ? 1 : p.strategy === "offset" ? 0 : undefined;
  let pages = 0;
  let more = false;

  for (; pages < HARD_PAGE_CAP; ) {
    // The token rides on a COPY of the call, so the manifest's own keys are untouched.
    //
    // `in` says WHERE: a query parameter by default, or the body, because a JSON-body search
    // endpoint takes its page number in the body and there is nowhere else to put it.
    const spec = cursor === undefined ? call : place(call, p.in ?? "query", p.into, cursor);

    const res = await sendRequest(node, spec, ctx, `${label} (page ${pages + 1})`);
    const payload = await readSettled(res, call.transport, call.encoding);
    await assertOk(node, call, payload, `${label} (page ${pages + 1})`);
    pages++;

    const page = await evaluate(p.items, { response: payload } as Record<string, unknown>);
    for (const item of Array.isArray(page) ? page : []) {
      if (items.length >= max) break;
      items.push(item);
    }

    if (p.strategy === "page" || p.strategy === "offset") {
      // No token to follow, so the END is a SHORT PAGE: fewer items than a full one means
      // there is nothing after it. Both counting strategies end the same way; they differ
      // only in what the number MEANS, and so in what it steps by.
      //
      //   page    an index of pages, 1, 2, 3      → step 1
      //   offset  a count of ITEMS already seen   → step size
      //
      // Getting that step wrong is the quiet kind of wrong: stepping an offset by 1 re-reads
      // the same window minus one row and the walk returns mostly duplicates.
      const got = Array.isArray(page) ? page.length : 0;
      const size = Number(await evaluate(String(p.size ?? "return 0"), ctx as unknown as Record<string, unknown>)) || 0;
      if (got === 0 || (size && got < size)) return { items, pages, truncated: false };
      cursor = Number(cursor) + (p.strategy === "offset" ? (size || got) : 1);
    } else {
      cursor = await evaluate(p.cursor, { response: payload } as Record<string, unknown>);
      // A falsy cursor is the vendor saying "that was the last page".
      if (!cursor) return { items, pages, truncated: false };
    }
    if (items.length >= max) {
      more = true;
      break;
    }
  }

  if (pages >= HARD_PAGE_CAP)
    console.warn(`[manifests] ${label}: stopped at the ${HARD_PAGE_CAP}-page ceiling with a cursor still present`);

  return { items, pages, truncated: more || pages >= HARD_PAGE_CAP };
}
