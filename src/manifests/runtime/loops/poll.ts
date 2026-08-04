/**
 * POLLING. One call in the manifest, a job on the wire.
 *
 * The third loop, after `paginate` and `chunk`, and the same trade as both: vendors
 * disagree about the mechanism and agree about the shape. Start work, get a handle, ask
 * "done yet?" until it is. What differs is description (where the handle lives, which
 * field says finished, what the status URL looks like); the waiting is computation, so it
 * belongs here and every long-running node inherits it (DECLARATIVE_NODES.md §2).
 *
 * Without this a manifest cannot express a job at all. `run` is an ordered list of
 * DIFFERENT calls, so a manifest can say "start, then check once" but never "check until".
 * Every crawler, render farm, transcription and batch-import API in the world works this
 * way, so the alternative is that all of them stay TypeScript.
 *
 * A polled call's reply is the FINAL status payload, not the start payload. The start
 * reply is a receipt — a job id and nothing else — and handing that back would give the
 * events table a handle where it expected the answer.
 */
import type { ComposedNode } from "../../compose.js";
import type { RunContext } from "../context.js";
import { evaluate } from "../templating.js";
import { sendRequest } from "../http/request.js";
import { readSettled, assertOk } from "../http/response.js";

/**
 * A hard ceiling on polls, independent of anything the manifest says.
 *
 * Same reasoning as pagination's page cap: `maxAttempts` is the author's bound, and this
 * is the platform's, because the author's can be wrong. A vendor stuck on "running"
 * forever would otherwise hold a workflow slot until the process died.
 */
const HARD_POLL_CAP = 300;

/** Longest a single poll may wait between attempts. Guards a typo'd intervalMs. */
const MAX_INTERVAL_MS = 60_000;

export async function fetchPolled(
  node: ComposedNode,
  call: any,
  ctx: RunContext,
  label: string,
): Promise<any> {
  const p = call.poll;
  const scope = (payload: unknown) => ({ ...ctx, response: payload }) as unknown as Record<string, unknown>;

  /**
   * Terminal? Asked of the START reply as well as of every poll.
   *
   * This is not defensiveness, it is the documented behaviour of at least one vendor we
   * migrate: Hyperbrowser's unified /web/fetch may finish INLINE and return the completed
   * result on the POST, with no job id to poll. A manifest that assumed a handle always
   * came back would try to build a status URL out of `undefined` and fail on exactly the
   * fast path it was hoping for.
   */
  const settled = async (payload: any, where: string): Promise<boolean> => {
    if (p.failed && (await evaluate(p.failed, scope(payload)))) {
      const why = p.message ? await evaluate(p.message, scope(payload)) : "no reason given";
      throw new Error(`${label}: the job failed upstream (${where}) — ${why}`);
    }
    return !!(await evaluate(p.until, scope(payload)));
  };

  // ── Start the job ────────────────────────────────────────────────────────────────
  const startRes = await sendRequest(node, call, ctx, `${label} (start)`);
  const start = await readSettled(startRes, call.transport, call.encoding);
  await assertOk(node, call, start, `${label} (start)`);

  if (await settled(start, "on the start reply")) return start;

  // ── Where to ask ─────────────────────────────────────────────────────────────────
  // Resolved ONCE, against the start reply, because that is the only place the job id
  // exists. Re-resolving per attempt against the latest status would work for vendors
  // that echo the id back and break for the ones that do not.
  const url = String((await evaluate(p.url, scope(start))) ?? "");

  /**
   * A MISSING HANDLE IS NOT AN EMPTY STRING, and checking for empty alone misses it.
   *
   * A status URL is nearly always built by concatenation, so a job id the vendor did not
   * send produces ".../jobs/undefined" — a perfectly non-empty URL that 404s on every one
   * of the next ninety polls and then reports a timeout. The same trap as an auth header
   * going out as the literal "undefined": the string form of nothing looks like a value.
   *
   * So the check is for a path segment that is the WORD undefined or null, which no real
   * job id ever is.
   */
  if (!url.trim() || /\/(undefined|null)(\/|\?|$)/.test(url))
    throw new Error(
      `${label}: the job did not finish on the start reply, and poll.url did not resolve to a real URL ` +
        `(got ${url.trim() ? `"${url}"` : "nothing"}). The start reply was ${JSON.stringify(start).slice(0, 200)}.`,
    );

  /**
   * The STATUS CHECK. Auth, headers, retry, transport and error carry over from the call — a status
   * check is the same conversation with the same vendor — but the start request's method, body and
   * query do NOT: they described starting work.
   *
   * A GET by default, because most vendors put the job id in the path. AWS does not: Textract's
   * `GetDocumentAnalysis` is a POST carrying `{ JobId }`, signed like any other, and every AWS batch
   * job is shaped the same way. Hardcoding GET is what kept that whole family in TypeScript.
   *
   * `poll.body` is an EXPRESSION over the start reply, exactly like `poll.url`, and resolved here
   * ONCE for the same reason: the job id exists only in that first response. Resolving it per
   * attempt against the latest status would work for vendors that echo the id back and quietly
   * break for the ones that do not — the identical trap the url comment above describes.
   */
  const statusBody = p.body ? await evaluate(p.body, scope(start)) : undefined;
  const statusCall = {
    ...call,
    poll: undefined,
    method: p.method ?? "GET",
    url,
    body: statusBody,
    query: undefined,
  };

  // RESOLVED, not read: how long to wait is often a dial a person sets, so both may be an
  // expression over config rather than a constant the manifest bakes in. Same treatment as
  // toolExchange's turn budget, and for the same reason.
  const dial = async (v: unknown, fallback: number): Promise<number> => {
    if (v === undefined || v === null) return fallback;
    const n = typeof v === "string" ? Number(await evaluate(v, ctx as unknown as Record<string, unknown>)) : Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  const interval = Math.min(await dial(p.intervalMs, 2000), MAX_INTERVAL_MS);
  const attempts = Math.min(await dial(p.maxAttempts, 90), HARD_POLL_CAP);

  /**
   * THE WAIT NARRATES ITSELF — by STATUS CHANGE, with a heartbeat, never per request.
   * A job is minutes of silence in the engine log otherwise, and silence gets read as a
   * hang. Per-attempt logging is the other failure: 300 lines of "still RUNNING" bury the
   * one line that mattered. The query is cut from the url for the same reason it is cut in
   * sendRequest: signatures and filters live there.
   */
  const startedAt = Date.now();
  const elapsed = () => Math.round((Date.now() - startedAt) / 1000);
  const heartbeat = Math.max(1, Math.round(30_000 / interval));
  let lastStatus: string | undefined;
  console.log(
    `[manifests] ${label}: job started — polling ${url.split("?")[0]} every ${Math.round(interval / 1000)}s (up to ${attempts} attempts)`,
  );

  for (let attempt = 1; attempt <= attempts; attempt++) {
    await new Promise((r) => setTimeout(r, interval));

    const res = await sendRequest(node, statusCall, ctx, `${label} (poll ${attempt}/${attempts})`);
    const payload = await readSettled(res, call.transport, call.encoding);
    await assertOk(node, call, payload, `${label} (poll ${attempt}/${attempts})`);

    const status = typeof payload?.status === "string" ? payload.status : undefined;
    if (status !== lastStatus || attempt % heartbeat === 0)
      console.log(`[manifests] ${label}: poll ${attempt}/${attempts} — ${status ?? "(no status field)"} after ${elapsed()}s`);
    lastStatus = status;

    if (await settled(payload, `poll ${attempt}`)) {
      console.log(`[manifests] ${label}: job finished after ${attempt} polls (${elapsed()}s)`);
      return payload;
    }
  }

  // Timing out is a real outcome, and the message says how long we actually waited rather
  // than just "timed out": the fix is nearly always a bigger maxAttempts, and a reader
  // cannot judge that without knowing what the current bound bought them.
  throw new Error(
    `${label}: the job was still unfinished after ${attempts} polls ` +
      `(~${Math.round((attempts * interval) / 1000)}s). Raise poll.maxAttempts if this job is legitimately slow.`,
  );
}
