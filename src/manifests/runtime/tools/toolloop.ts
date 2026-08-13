/**
 * The tool loop. Counting and stopping, nothing else.
 *
 * NOTHING HERE IS VENDOR-SPECIFIC, and that is now literally true rather than a claim I
 * made while hardcoding one vendor's protocol. How a tool is offered, how a call arrives,
 * how a result goes back, how turns chain: all of it describes an API, so all of it lives
 * in the node's api.yaml. A different vendor is a different manifest, not another adapter
 * file in the platform.
 *
 * What is left is the part data cannot express:
 *   - how many turns, and stopping at the bound
 *   - spotting a stuck loop (the same call with the same arguments)
 *   - minting what discovery unlocks, via the harness
 *   - narrator timing: a line at 0ms, never awaited, fall back, drop late ones
 *
 * Every MCP judgement belongs to plugin-base/agent-mcp and arrives through the
 * ToolBridge. That is the harness, and the reason agent families drifted apart is that
 * each one re-made those judgements itself.
 */
import { saveMCPTraceToWorkflow } from "../../../platform/serviceCalls.js";
import type { ComposedNode } from "../../compose.js";
import type { RunContext } from "../context.js";
import { evaluate, render } from "../templating.js";
import { sendRequest } from "../http/request.js";
import { readSse, assertOk } from "../http/response.js";
import type { Emitter } from "../events.js";
import { makeUsageCollector } from "../usage.js";

/** How the loop reaches MCP tools. Injected, so the loop never touches a platform global. */
export interface ToolBridge {
  /** Core tools from the provider's getSchema, as { name, description, parameters }. */
  discover(): Promise<any[]>;
  /** Execute one call; returns the raw result content. */
  call(name: string, args: any): Promise<string>;
  /**
   * Absorb one tool reply: unlock + shell-open any apps it discovered, and hand back the
   * MODEL-FACING form of it plus any tools to register.
   *
   * ONE method, not a mint call and a lean call, because they are one step. Splitting them
   * is what let the shell-open between them go missing without anything noticing.
   */
  absorb(toolName: string, resultContent: string): Promise<{ content: string; minted: any[] }>;
  /** Does this exchange end the turn? Depends on which tools were WIRED. */
  endsTurn(calls: { name: string; resultContent: string }[]): boolean;
}

/**
 * Best-effort parse of a tool result. MCP carries results as TEXT, so `bridge.call`
 * hands back a string even when the tool returned structured data. Anywhere a HUMAN
 * or a template reads the result (the execution trace, the `from: tool` connector
 * emissions), the parsed object is the readable form; a tool that legitimately
 * returns prose keeps its string. The MODEL-facing lanes (toolExchange /
 * function_call_output) must stay strings per the vendor wire — never feed them this.
 */
export function parseMaybeJson(result: unknown): unknown {
  if (typeof result !== "string") return result;
  try {
    return JSON.parse(result);
  } catch {
    return result;
  }
}

/**
 * ONE TOOL CALL, recorded for the execution timeline.
 *
 * FIRE AND FORGET. Observability must never slow a tool loop or fail a run because the
 * analytics hop was busy, so nothing here is awaited and every error is swallowed to a warn.
 *
 * SKIPPED without an executionId, which is the node-test and headless case: there is no
 * execution to attach a bar to, and posting a trace with no parent would create an orphan
 * row nothing renders.
 *
 * EXPORTED so the duplex session draws the same bar. Shared, not copied: two implementations
 * of "what a tool call looks like on a timeline" drift the first time either is touched.
 */
export function recordToolTrace(
  node: ComposedNode,
  ctx: RunContext,
  toolName: string,
  args: unknown,
  result: unknown,
  startTime: number,
  success: boolean,
): void {
  const executionId = (ctx as any)?.scope?.executionId;
  const parentNodeId = (ctx as any)?.scope?.nodeId;
  if (!executionId || !parentNodeId) return;

  /**
   * PARSED, so the trace viewer shows a readable object rather than one escaped string.
   *
   * A tool result crosses MCP as text, so `bridge.call` hands back a string. Storing it as
   * one made the timeline's output pane a wall of `"[{\"universal_id\":\"...` that nobody
   * can read — which defeats the point of recording it. The parse is best-effort: a tool
   * that legitimately returns prose keeps its string.
   */
  const parsed = parseMaybeJson(result);

  const endTime = Date.now();
  void saveMCPTraceToWorkflow({
    executionId,
    parentNodeId,
    toolName,
    arguments: args,
    result: parsed,
    startTime,
    endTime,
    duration: endTime - startTime,
    success,
  }).catch((err: any) => console.warn(`[manifests] ${node.type}: could not save MCP trace: ${err?.message ?? err}`));
}

export async function runToolLoop(
  node: ComposedNode,
  ctx: RunContext,
  bridge: ToolBridge,
  /** The one path out. The loop emits a tool RESULT through it; the rest is the stream. */
  emitter: Emitter,
  /** Narration is owned by the caller: it fires on every run, tools or not. */
  narrate: (event: Record<string, unknown>) => void = () => {},
  /**
   * The call the loop drives, which is the node's LAST one. Passed in rather than read off
   * the node, because any earlier calls have already been made once and their replies are
   * in `ctx.calls`: a tool loop re-sends the model call, never the lookups that set it up.
   *
   * Named modelCall and not `call`, because `call` below is one TOOL call in a turn. Two
   * unrelated things with one name in one function is how a wrong-variable bug gets in.
   */
  modelCall: any = node.api?.run?.[node.api.run.length - 1],
): Promise<number> {
  const api = node.api!;
  // Rendered: the turn budget is what makes a node an agent rather than a one-shot
  // generator, so it is a dial a person sets, not a constant the manifest bakes in.
  const te = render(api.toolExchange, ctx);
  const maxTurns = Number(te.maxTurns) || 10;
  const stuckAfter = Number(te.stuckAfterRepeats) || 3;
  const connector = te.from ?? "mcpService";

  // Grows during the run: a later turn sees what an earlier turn unlocked.
  const offer = (t: any) => evaluate(te.tool, { tool: t });
  const live: any[] = await offerDiscovered(te, bridge);

  const seen = new Map<string, number>();
  let chainId: string | undefined;
  let results: unknown[] | null = null;
  let turn = 0;

  /**
   * THE TRANSCRIPT, for vendors that have no chain id.
   *
   * OpenAI's Responses API hands back a `previous_response_id` and the next turn just names it, which
   * is what `continuity` models. Chat Completions — GLM, Grok, and most OpenAI-COMPATIBLE vendors —
   * has no such thing: the whole `messages` array is resent every turn, growing by the assistant's
   * tool-call turn and one message per result.
   *
   * So the loop keeps that array and exposes it to the request as `transcript`. The manifest spreads
   * it into its own messages, which keeps the vendor's shape in the manifest where it belongs:
   *
   *     messages: [{ role: 'system', … }, { role: 'user', … }, ...transcript]
   *
   * Empty on turn one, so a node that never calls a tool sends exactly what it always did.
   */
  const transcript: unknown[] = [];

  // Token usage across ALL turns of this run — each turn is its own model call with its
  // own usage block; the collector sums them and posts once when the loop settles.
  const usage = makeUsageCollector(node, ctx);

  for (turn = 1; turn <= maxTurns; turn++) {
    const scoped: RunContext = {
      ...ctx,
      services: { ...ctx.services, [connector]: { tools: live } },
      // Read by the body expression as `...transcript`. A copy, so a manifest cannot mutate the loop's.
      transcript: [...transcript],
    } as RunContext;

    const extra: Record<string, unknown> = { [te.toolsInto ?? "tools"]: live };
    if (te.choiceInto) extra[te.choiceInto] = te.choice ?? "auto";
    if (chainId && te.continuity) extra[te.continuity.into] = chainId;
    // A TRANSCRIPT vendor carries its results INSIDE the transcript, so injecting them separately
    // would send each result twice — once as a message and once in a field the vendor ignores.
    if (results && !te.transcript) extra[te.resultsInto ?? "input"] = results;

    const res = await sendRequest(node, withExtra(modelCall, extra), scoped, `${node.type} (turn ${turn})`);

    // Two readers of one stream: the events table decides what leaves the node, and the
    // loop separately watches for a tool call and a continuity id, neither of which is an
    // output. Collected by event TYPE here; the manifest's expressions read them below.
    const raw: any[] = [];
    let chainPayload: any;
    /**
     * The assistant's OWN WORDS this turn, for the transcript.
     *
     * A model with preambles enabled explains why before it calls a tool, and that explanation belongs
     * in the history it is sent next turn — drop it and the model loses its own reasoning thread. Read
     * by an expression because which field carries text is the vendor's business (`delta.content` for
     * Chat Completions), and accumulated because it arrives a token at a time.
     */
    let spoken = "";
    await readSse(res, modelCall.terminator, async (payload) => {
      await assertOk(node, modelCall, payload, `${node.type} (turn ${turn})`);
      usage.see(payload);
      await emitter.response(payload, payload.type);
      if (te.transcript?.text) {
        const piece = await evaluate(te.transcript.text, { response: payload });
        if (piece) spoken += String(piece);
      }
      // `match` is OPTIONAL. It selects by event TYPE, which only works for a vendor whose SSE
      // events carry one — the Responses API does. A Chat Completions chunk has no `type` at all, so
      // with no match declared every payload is considered and `when` does the filtering.
      if (te.call.match === undefined || payload.type === te.call.match) raw.push(payload);
      if (te.continuity && payload.type === te.continuity.match) chainPayload = payload;
    });
    if (chainPayload) chainId = String(await evaluate(te.continuity.from, { response: chainPayload }));

    const calls = await readCalls(te, raw);

    // Answered rather than called. Done.
    if (!calls.length) break;

    const exchanges: { name: string; resultContent: string }[] = [];
    /**
     * The MODEL-FACING form of each result, alongside the raw one.
     *
     * Two arrays because two consumers want different things. `exchanges` keeps the RAW
     * reply, which is what handoff detection reads. `absorbed` holds what the harness leaned,
     * which is what goes into the conversation. Leaning `exchanges` in place would silently
     * change what `endsTurn` sees.
     */
    const absorbed: string[] = [];
    let stuck = false;

    for (const call of calls) {
      const signature = `${call.name}:${call.arguments}`;
      const count = (seen.get(signature) ?? 0) + 1;
      seen.set(signature, count);
      if (count >= stuckAfter) {
        console.warn(`[manifests] ${node.type}: "${call.name}" repeated ${count}x with identical arguments — stopping`);
        stuck = true;
        break;
      }

      const args = JSON.parse(call.arguments || "{}");
      narrate({ kind: "toolCall", toolName: call.name, args });

      let content: string;
      /**
       * THE TIMELINE BAR, and it is the AGENT's job to record it, not the tool's.
       *
       * Every legacy agent did this — OpenAIAgent, Grok, Realtime — and the manifest loop
       * that replaced them did not, so the nested `findIntent MCP (1 of 5 tools) 1.51s` row
       * vanished the day `openai` migrated. It looked like a fault in whichever node was
       * being called, which is where I went looking, twice.
       *
       * `success` is the part that matters most. A tool that fails still returns a string to
       * the model (see the catch below), so from the outside a broken tool and an empty
       * result are identical: the workflow completes, four green bars, and the model answers
       * from its own knowledge. That happened three times in one session before anyone could
       * see it. This flag is what turns it red.
       */
      const startedAt = Date.now();
      let ok = true;
      try {
        content = await bridge.call(call.name, args);
      } catch (err: any) {
        // A failed tool is information for the model, not a crash: it can try another.
        ok = false;
        content = JSON.stringify({ error: err?.message ?? String(err) });
      }
      recordToolTrace(node, ctx, call.name, args, content, startedAt, ok);
      exchanges.push({ name: call.name, resultContent: content });
      // The RESULT, and only now that it exists. It is never in the HTTP stream: our loop
      // produced it, which is why it cannot be a `from: response` row. PARSED for the
      // connector lane (humans and templates read it there — same reason the trace above
      // parses); the model-facing lane below reads `absorbed`, untouched strings.
      await emitter.tool({ name: call.name, args, output: parseMaybeJson(content) });

      /**
       * ONE ABSORBER, which is the harness's own rule and the one this loop used to break.
       *
       * `handleDiscoveryResult` does three things to a discovery reply — UNLOCK the app,
       * SHELL-OPEN its page, and LEAN the rows — and its comment says, in as many words,
       * that it is "never re-implemented in an adapter". This loop re-implemented two of the
       * three (a mint call here, a lean call after the loop) and dropped the middle one.
       *
       * The dropped step was the shell-open: an empty native invoke that paints the page
       * skeleton the moment an app is discovered, seeded with `__draftRefs` — the ids of the
       * image-carrying rows the search just returned — so the guest watches a real page
       * hydrate instead of waiting on a blank panel while the model composes. Nothing failed
       * when it went missing. The tool was minted, the model answered, and the page simply
       * never appeared until the model got round to it.
       *
       * Every legacy agent called this (runOpenAIAgent.ts:580). After `openai` migrated to
       * YAML, nothing did: the function stayed exported, and dead.
       */
      const { content: forModel, minted } = await bridge.absorb(call.name, content);
      absorbed.push(forModel);
      for (const tool of minted)
        if (tool?.name && !live.some((t) => t?.name === tool.name)) {
          live.push(await offer(tool));
          console.log(`[manifests] ${node.type}: minted "${tool.name}" from ${call.name}`);
        }
    }

    if (stuck) break;
    // A handoff ends the turn even though tools were called.
    if (bridge.endsTurn(exchanges)) break;

    // Already leaned, by the absorber above. A search result carries far more than the model
    // needs, and the full rows were consumed by the card lane and the unlock pass first.
    results = [];
    for (let i = 0; i < calls.length; i++)
      results.push(await evaluate(te.result, { call: { ...calls[i], output: absorbed[i] ?? "{}" } }));

    /**
     * GROW THE TRANSCRIPT, for a vendor that has no chain id.
     *
     * ORDER MATTERS AND IS NOT NEGOTIABLE: the assistant's tool-call turn must precede its results, or
     * the vendor rejects the request — a tool message with no preceding tool_call is an error, not a
     * warning. That is why this appends both here rather than letting the manifest assemble it.
     *
     * `te.transcript.assistant` builds that turn from the calls, because its shape is the vendor's:
     * Chat Completions wants { role: 'assistant', tool_calls: [...] }. The results are already in the
     * vendor's message shape — `te.result` produced them — so they go in as they are.
     */
    if (te.transcript) {
      if (te.transcript.assistant) transcript.push(await evaluate(te.transcript.assistant, { calls, text: spoken }));
      transcript.push(...results);
    }
  }

  usage.save();
  return 200;
}

/**
 * The tool calls a turn asked for, from however many events carried them.
 *
 * TWO SHAPES, because vendors genuinely differ and the difference is not cosmetic:
 *
 *   WHOLE     one event carries one complete call. OpenAI's Responses API does this — a
 *             `response.output_item.done` has the name and the full arguments string.
 *   FRAGMENTS one call arrives across MANY events, keyed by an index, with `arguments`
 *             concatenated. Chat Completions does this — GLM sends
 *             `{ index: 0, function: { arguments: '{"qu' } }` then `'ery":"x"}' }` — so reading
 *             `arguments` off any single event yields a fragment of JSON that cannot be parsed.
 *
 * A manifest picks by declaring `call.each`: an expression returning the partial calls in one
 * event. Without it nothing changes and the whole-call path runs exactly as before.
 *
 * Merging by INDEX and not by id is deliberate: the id arrives on the first fragment only, so a
 * later fragment has nothing else to join on. Parallel tool calls are precisely why the vendor
 * sends an index at all.
 */
async function readCalls(te: any, raw: any[]): Promise<{ id: string; name: string; arguments: string }[]> {
  if (!te.call.each) {
    const out: { id: string; name: string; arguments: string }[] = [];
    for (const payload of raw) {
      if (te.call.when && !(await evaluate(te.call.when, { response: payload }))) continue;
      out.push({
        id: String(await evaluate(te.call.id, { response: payload })),
        name: String(await evaluate(te.call.name, { response: payload })),
        arguments: String((await evaluate(te.call.arguments, { response: payload })) ?? "{}"),
      });
    }
    return out;
  }

  // FRAGMENTS. `each` yields the partials in this event; id/name/arguments are read PER PARTIAL,
  // with `part` in scope, and any of them may be absent on any given fragment.
  const acc = new Map<string, { id: string; name: string; arguments: string }>();
  const order: string[] = [];
  for (const payload of raw) {
    if (te.call.when && !(await evaluate(te.call.when, { response: payload }))) continue;
    const parts = (await evaluate(te.call.each, { response: payload })) as any[];
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const scope = { response: payload, part };
      const key = String(te.call.index ? await evaluate(te.call.index, scope) : 0);
      if (!acc.has(key)) {
        acc.set(key, { id: "", name: "", arguments: "" });
        order.push(key);
      }
      const cur = acc.get(key)!;
      const id = te.call.id ? await evaluate(te.call.id, scope) : undefined;
      const name = te.call.name ? await evaluate(te.call.name, scope) : undefined;
      const args = te.call.arguments ? await evaluate(te.call.arguments, scope) : undefined;
      if (id) cur.id = String(id);
      if (name) cur.name = String(name);
      // CONCATENATED, which is the whole point. `=` here would keep only the last fragment and
      // produce a JSON.parse error on a truncated object.
      if (args) cur.arguments += String(args);
    }
  }
  // A slot with no NAME never became a call: some vendors open an index before naming the function.
  return order.map((k) => acc.get(k)!).filter((c) => c.name).map((c) => ({ ...c, arguments: c.arguments || "{}" }));
}

/** Merge the loop's fields into the request body, object or expression alike. */
function withExtra(request: any, extra: Record<string, unknown>): any {
  return typeof request.body === "string"
    ? { ...request, body: `return Object.assign({}, (${request.body.replace(/^return\s+/, "")}), ${JSON.stringify(extra)})` }
    : { ...request, body: { ...request.body, ...extra } };
}

/**
 * The discovered tools, in the VENDOR'S ENVELOPE, shared by the HTTP loop and the socket.
 *
 * `te.tool` is the description half — OpenAI wants { type: 'function', name, ... } — and this
 * applies it to whatever the provider discovered. Extracted so a duplex session offers tools the
 * same way an HTTP turn does: the alternative was the socket hand-writing the envelope in its
 * handshake, which is the same protocol described twice, free to drift the moment a vendor changes.
 *
 * Returns [] when nothing is wired, which is the normal case and must degrade rather than fail.
 */
export async function offerDiscovered(te: any, bridge: ToolBridge): Promise<any[]> {
  const out: any[] = [];
  for (const t of await bridge.discover()) out.push(await evaluate(te.tool, { tool: t }));
  return out;
}
