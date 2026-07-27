/**
 * Performing a manifest's `api` block. The entry point of the manifest runtime.
 *
 * The split (DECLARATIVE_NODES.md §2): the manifest DESCRIBES the service, this half
 * COMPUTES it. Every enum value in api.schema.json must have an implementation in here
 * and nowhere else, which is what makes accepting a manifest from someone else safe.
 * `manifest-capabilities.test.ts` enforces that parity.
 *
 * Nothing here is per-vendor. Adding an auth scheme or a transport makes it available to
 * every node that will ever be written.
 *
 *   context.ts     what a manifest may see, and the resolvers applied first
 *   templating.ts  {{ }} and `return ...`, both borrowed from the platform
 *   allowedHosts.ts      the security boundary, alone so it is easy to audit
 *   request.ts     building and sending. One fetch, one allowedHosts check
 *   response.ts    reading it back onto the node's outputs
 *   this file      the two CHANNELS: workflow (performApi) and service (performService)
 */
import type { ComposedNode } from "../compose.js";
import type { RunContext } from "./context.js";
import { evaluate, render } from "./templating.js";
import { sendRequest, resolveBody, buildRequest, runCalls } from "./request.js";
import { readSse, readSettled, assertOk, type Emission } from "./response.js";
import { performState, type StateStore } from "./state.js";
import { fetchPaginated } from "./paginate.js";
import { fetchPolled } from "./poll.js";
import { sendChunked } from "./chunk.js";
import { makeEmitter, type Emitter } from "./events.js";
import { runToolLoop, type ToolBridge } from "./toolloop.js";

export type { RunContext, Emission };
export { emptyContext, applyResolvers, RESOLVERS } from "./context.js";
export { render, evaluate, primeTemplating } from "./templating.js";
export { assertAllowedHost } from "./allowedHosts.js";
export { buildRequest, resolveBody, sendRequest, runCalls } from "./request.js";
export { readSse, readSettled, assertOk } from "./response.js";
export { makeStateStore, performState, type StateStore } from "./state.js";
export { fetchPaginated } from "./paginate.js";
export { fetchPolled } from "./poll.js";
export { sendChunked } from "./chunk.js";
export { makeEmitter, type Emitter, type EventSource } from "./events.js";
export { runToolLoop, type ToolBridge } from "./toolloop.js";

/**
 * The narrator, bound for one run.
 *
 * Lives HERE and not in the tool loop, because narration is a property of the node, not
 * of having tools. It fires on every run, with or without a tool wired, exactly as the
 * agent it replaces does. (It used to sit inside the loop, so a node with no MCP provider
 * silently never narrated.)
 *
 * The manifest describes the whole thing — endpoint, model, instructions, copy. The only
 * part that cannot be data is the timing:
 *   a local line at 0ms, because the round trip has a ~1s floor and the first token beats it
 *   never awaited, so narration cannot delay the work it describes
 *   fall back on any failure, so a missing narrator never fails a turn
 *   drop late lines, since one arriving after the answer reads as still working
 */
export function makeNarrator(node: ComposedNode, ctx: RunContext, emitter: Emitter) {
  const n = node.api?.narrate;
  let settled = false;
  let firstLine = false;

  // Through the table like everything else: the narrator does not know which connector
  // it lands on, only that it produced a line. `from: narrator` in api/events.yaml says.
  const say = (line: unknown) => {
    if (line && !settled) void emitter.narrator(String(line));
  };

  const fire = (event: Record<string, unknown>) => {
    if (!n) return;
    if (!firstLine && n.instant?.length) {
      firstLine = true;
      say(n.instant[Math.floor(Math.random() * n.instant.length)]);
    }
    void (async () => {
      try {
        const res = await sendRequest(node, n.request, { ...ctx, event } as any, `${node.type} narrator`);
        say(await evaluate(n.response.line, { response: await res.json() }));
      } catch {
        say(render(n.fallback, ctx));
      }
    })();
  };

  return { fire, settle: () => { settled = true; } };
}

export interface RunResult {
  outputs: Record<string, unknown>;
  emissions: Emission[];
  status: number;
}

/**
 * The WORKFLOW channel: what this node does when the graph triggers it.
 *
 * `onEmit` receives every streamed emission as it happens, which is what a CallbackNode
 * forwards to its output connectors in real time.
 */
export async function performApi(
  node: ComposedNode,
  ctx: RunContext,
  onEmit: (e: Emission) => void = () => {},
  tools?: ToolBridge,
  store?: StateStore,
): Promise<RunResult> {
  const api = node.api;
  if (!api) throw new Error(`Node "${node.type}" has no api block, so there is nothing to perform`);
  if (!api.run?.length)
    throw new Error(`Node "${node.type}" has only service methods — the graph cannot run it`);

  // LEAD then FINAL. Every call but the last settles and just fills `calls.<name>`; the
  // last is the one whose reply becomes the node's answer, so it alone may stream. A node
  // that makes one call is the ordinary case and takes this path with an empty lead.
  const lead = api.run.slice(0, -1);
  const final = api.run[api.run.length - 1];

  // MUTATED, not copied: `base` is spread at each fire, so filling in `calls` after the
  // lead runs makes it visible to every row, including the `complete` ones at the end.
  const base: Record<string, unknown> = { config: ctx.config, user: ctx.user, calls: {} };
  const emitter = makeEmitter(node, onEmit, base);

  // Narration first, and on BOTH paths: it is a property of the node, not of tools.
  const narrator = makeNarrator(node, ctx, emitter);
  narrator.fire({ kind: "turnStart", userMessage: ctx.config?.prompt ?? "" });

  try {
    const { results, last } = lead.length
      ? await runCalls(node, lead, ctx, node.type, store)
      : { results: {} as Record<string, any>, last: undefined as any };
    base.calls = results;
    const scoped: RunContext = { ...ctx, calls: results };

    // THE LAST CALL HONOURS ITS `when` LIKE EVERY OTHER ONE.
    //
    // It did not, and the failure was live rather than theoretical: HubSpot's last call
    // writes queued notes to the CRM and is gated on a config toggle, so with that toggle
    // OFF the node still POSTed to the notes endpoint on every run. Nothing errored,
    // because the vendor accepted an empty write. A conditional call that fires anyway is
    // worse than one that never fires, because the wrongness is invisible.
    //
    // Skipped, the node settles on the last call that DID run, which is what a reader
    // expects of a list whose tail is optional.
    const skipFinal = !!final.when && !(await evaluate(final.when, scoped as unknown as Record<string, unknown>));

    let status = 200;
    if (skipFinal) {
      await emitter.response(last);
    } else {
      // No bridge means nothing granted this node tools. Normal (an mcp connector nobody
      // wired), so it degrades to one ordinary call rather than failing.
      status = api.toolExchange && tools
        ? await runToolLoop(node, scoped, tools, emitter, narrator.fire, final)
        : await runFinal(node, final, scoped, emitter, base, store);
    }

    const emissions = await emitter.finish();
    return { outputs: emitter.outputs(), emissions, status };
  } finally {
    narrator.settle();
  }
}

/**
 * The LAST call: the one whose reply is the node's answer.
 *
 * It alone may stream, which is why it is framed here rather than by `runCalls`. A node
 * that makes a single call is just this, with nothing before it.
 *
 * `base` is the emitter's shared scope, and this records the final reply into it under the
 * call's own name BEFORE any row fires. Without that, `calls.<name>` held the earlier calls
 * only and the last one was reachable as `response` alone. That asymmetry was silent and it
 * bit immediately: a service method and the graph run sharing ONE $ref'd expression behaved
 * differently, because the service channel puts every call through `runCalls` and had the
 * name while the graph run did not. An expression written once must mean one thing.
 */
async function runFinal(
  node: ComposedNode,
  call: any,
  ctx: RunContext,
  emitter: Emitter,
  base: Record<string, unknown>,
  store?: StateStore,
): Promise<number> {
  // A node whose LAST act is a state write settles on that write, so the events table can
  // emit what was stored.
  if (call.state) {
    const value = call.value ? ((await evaluate(call.value, ctx as unknown as Record<string, unknown>)) as any) : undefined;
    const payload = await performState(call.state, String(render(call.key, ctx)), value, call.max, store);
    (base.calls as Record<string, unknown>)[call.name] = payload;
    await emitter.response(payload);
    return 200;
  }

  // Chunked: many requests over one collection, one summary reply.
  if (call.chunk) {
    const written = await sendChunked(node, call, ctx, node.type);
    (base.calls as Record<string, unknown>)[call.name] = written;
    await emitter.response(written);
    return 200;
  }

  // Paginated: many requests, one accumulated reply, so the events table sees the whole set.
  if (call.paginate) {
    const walked = await fetchPaginated(node, call, ctx, node.type);
    (base.calls as Record<string, unknown>)[call.name] = walked;
    await emitter.response(walked);
    return 200;
  }

  // Polled: a job, started and waited on, settling as the final status payload.
  if (call.poll) {
    const finished = await fetchPolled(node, call, ctx, node.type);
    (base.calls as Record<string, unknown>)[call.name] = finished;
    await emitter.response(finished);
    return 200;
  }

  const res = await sendRequest(node, call, ctx, node.type);
  const transport = call.transport;

  if (transport === "json" || transport === "text") {
    const payload = await readSettled(res, transport, call.encoding);
    await assertOk(node, call, payload, node.type);
    // Named BEFORE emitting, so a row reading calls.<name> sees it.
    //
    // Settling only. A streaming call has no single reply to name: it is a sequence, and
    // each event arrives as `response`. Inventing a value for `calls.<name>` there would be
    // a guess about which event counted.
    (base.calls as Record<string, unknown>)[call.name] = payload;
    // No `match`: a settled body is one event, so every `from: response` row fires over it.
    await emitter.response(payload);
    return res.status;
  }

  if (transport === "sse") {
    await readSse(res, call.terminator, async (payload) => {
      await assertOk(node, call, payload, node.type);
      await emitter.response(payload, payload.type);
    });
    return res.status;
  }

  throw new Error(`transport "${transport}" is declared in the schema but not implemented in the executor`);
}


/**
 * The SERVICE channel: a method this node offers over a service edge, exposed as MCP.
 *
 * Called ad-hoc by an agent rather than run by the graph, and it hands back ONE value
 * rather than emitting on output connectors, which is why the manifest says `returns` and
 * why no events row is involved. The two channels never cross (08-mcp-services.md).
 */
export async function performService(
  node: ComposedNode,
  method: string,
  params: Record<string, any>,
  ctx: RunContext,
  store?: StateStore,
): Promise<unknown> {
  const spec = node.api?.service?.[method];
  if (!spec) {
    const known = Object.keys(node.api?.service ?? {});
    throw new Error(
      `${node.type} has no service method "${method}"${known.length ? ` — it has ${known.join(", ")}` : " — it has none"}`,
    );
  }

  const scoped: RunContext = { ...ctx, params };

  // Every call settles here, including the last: a method hands back ONE value, so there
  // is no connector for a stream to emit onto.
  const { results, last } = await runCalls(node, spec.calls, scoped, `${node.type}.${method}`, store);

  // `params`, `config` and `user` are in scope so a method can shape its result from what
  // it was asked for and who asked, not only from what came back.
  return evaluate(spec.returns, {
    response: last,
    calls: results,
    params,
    config: ctx.config,
    user: ctx.user,
  });
}
