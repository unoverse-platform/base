/**
 * THE LAST CALL — the one whose reply becomes the node's answer.
 *
 * Separate from `runCalls` because it is the only call that may STREAM. Every earlier call
 * settles and exists so a later one can read it; this one is framed onto the output connectors,
 * so it is the single place that has to know about every shape a reply can take: a settled body,
 * an SSE stream, a duplex session, a walked pagination, a polled job, a chunked write, a state
 * write, a loop step. A node that makes one call is just this, with nothing before it.
 *
 * ONE DISPATCH, in this order, and the order matters in one place: `transport: ws` is tested
 * BEFORE `sendRequest`, because a socket handshake is not an HTTP request and issuing one would
 * open a second connection to the vendor and pay for it.
 *
 * `base` is the emitter's shared scope, and every branch records its reply into it under the
 * call's own name BEFORE any row fires. Without that, `calls.<name>` held the earlier calls only
 * and the last one was reachable as `response` alone. That asymmetry was silent and it bit
 * immediately: a service method and a graph run sharing ONE $ref'd expression behaved
 * differently, because the service channel puts every call through `runCalls` and had the name
 * while the graph run did not. An expression written once must mean one thing.
 */
import type { ComposedNode } from "../../compose.js";
import type { RunContext } from "../context.js";
import { evaluate, render } from "../templating.js";
import { sendRequest, buildRequest, performPresign } from "../http/request.js";
import { readSse, readSettled, assertOk } from "../http/response.js";
import { runDuplexSession } from "../duplex/session.js";
import type { AudioLane } from "../duplex/audioLane.js";
import { performState, type StateStore } from "../state.js";
import { fetchPaginated } from "../loops/paginate.js";
import { fetchPolled } from "../loops/poll.js";
import { sendChunked } from "../loops/chunk.js";
import { performLoop } from "../loops/loop.js";
import { performDoc } from "../docstore/index.js";
import type { Emitter } from "../events.js";
import type { ToolBridge } from "../tools/toolloop.js";
import { makeUsageCollector } from "../usage.js";

export async function runFinal(
  node: ComposedNode,
  call: any,
  ctx: RunContext,
  emitter: Emitter,
  base: Record<string, unknown>,
  store?: StateStore,
  lane?: AudioLane | null,
  tools?: ToolBridge,
): Promise<number> {
  /** Every branch settles the same way: name the reply, then let the events table shape it. */
  const settle = async (payload: unknown): Promise<number> => {
    (base.calls as Record<string, unknown>)[call.name] = payload;
    await emitter.response(payload);
    return 200;
  };

  // A DOCSTORE op as the last (often only) call — SmartDocument's whole workflow channel is
  // one `docstore: render`. Same defaulting as the runCalls branch: arguments are the
  // caller's params unless the call names its own, and the doc's key derives from the run's
  // ids inside performDoc.
  if (call.docstore) {
    const args = call.params
      ? ((await evaluate(call.params, ctx as unknown as Record<string, unknown>)) as Record<string, any>)
      : ctx.params;
    return settle(await performDoc(String(call.docstore), args ?? {}, store?.raw, ctx.scope, ctx.config));
  }

  // A node whose LAST act is a state write settles on that write, so the events table can
  // emit what was stored.
  if (call.state) {
    const value = call.value ? await evaluate(call.value, ctx as unknown as Record<string, unknown>) : undefined;
    return settle(await performState(call.state, String(render(call.key, ctx)), value, call.max, store, ctx.scope));
  }

  // A LOOP step. LoopStart settles on the pass it opened or read, LoopEnd on the step it
  // advanced, and each one's events table shapes its connectors from that single payload.
  if (call.loop) {
    const value = call.value ? await evaluate(call.value, ctx as unknown as Record<string, unknown>) : undefined;
    return settle(await performLoop(call.loop, ctx.scope?.executionId, String(render(call.key, ctx)), value, store?.loop));
  }

  // Presign: no request at all — the node settles on the minted urls, always a list.
  // S3Files ends on one when links are asked for: list, then mint a link per object found.
  if (call.presign) return settle(await performPresign(node, call, ctx));

  // Chunked: many requests over one collection, one summary reply.
  if (call.chunk) return settle(await sendChunked(node, call, ctx, node.type));

  // Paginated: many requests, one accumulated reply, so the events table sees the whole set.
  if (call.paginate) return settle(await fetchPaginated(node, call, ctx, node.type));

  // Polled: a job, started and waited on, settling as the final status payload.
  if (call.poll) return settle(await fetchPolled(node, call, ctx, node.type));

  // DUPLEX, and it must come BEFORE sendRequest, because a socket handshake is not an HTTP
  // request and issuing one would open a second connection to the vendor and pay for it.
  //
  // `buildRequest` is reused only to RESOLVE the url and the credential headers: a ws
  // handshake carries the credential in a header exactly as a request does, so the schemes
  // and the template resolution should be the same code rather than a second implementation
  // that drifts. Its body and method are discarded, because a session has neither.
  if (call.transport === "ws") {
    const built = await buildRequest({ request: call }, ctx);
    const headers = Object.fromEntries(
      Object.entries((built.init.headers ?? {}) as Record<string, string>).filter(([k]) => k.toLowerCase() !== "content-type"),
    );
    // The audio lane keys everything by conversation, and the events already carry it. Falls
    // back to the execution id so a node with no conversation still holds a valid session and
    // still emits transcripts — it simply has nowhere to send audio.
    const conversationId = String(
      (ctx as any).scope?.conversationId ?? (ctx as any).config?.conversationId ?? (ctx as any).scope?.executionId ?? node.type,
    );
    // Every other transport builds one of these; the socket built none, so voice calls reported
    // no tokens at all. `usage.save()` sits BEFORE the throw: a call that ended badly still
    // burned what it spoke.
    const usage = makeUsageCollector(node, ctx);
    const result = await runDuplexSession({
      node,
      call,
      ctx,
      emitter,
      url: built.url,
      headers,
      lane: lane ?? null,
      conversationId,
      tools,
      usage,
      onError: (message) => {
        // Surfaced rather than thrown: one bad frame mid-call must not end a conversation the
        // person is still having.
        void emitter.narrator(message);
      },
    });
    usage.save();
    if (result.reason === "error") throw new Error(`${node.type}: duplex session failed: ${result.error}`);
    return 200;
  }

  const res = await sendRequest(node, call, ctx, node.type);
  const transport = call.transport;

  if (transport === "json" || transport === "text") {
    const payload = await readSettled(res, transport, call.encoding);
    await assertOk(node, call, payload, node.type);
    // Token usage: a settled vendor body carries it inline (Chat Completions puts it
    // top-level). One payload, so see + save in one breath.
    const usage = makeUsageCollector(node, ctx);
    usage.see(payload);
    usage.save();
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
    const usage = makeUsageCollector(node, ctx);
    await readSse(res, call.terminator, async (payload) => {
      await assertOk(node, call, payload, node.type);
      usage.see(payload);
      await emitter.response(payload, payload.type);
    });
    usage.save();
    return res.status;
  }

  throw new Error(`transport "${transport}" is declared in the schema but not implemented in the executor`);
}
