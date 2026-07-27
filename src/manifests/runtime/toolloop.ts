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
import type { ComposedNode } from "../compose.js";
import type { RunContext } from "./context.js";
import { evaluate, render } from "./templating.js";
import { sendRequest } from "./request.js";
import { readSse, assertOk } from "./response.js";
import type { Emitter } from "./events.js";

/** How the loop reaches MCP tools. Injected, so the loop never touches a platform global. */
export interface ToolBridge {
  /** Core tools from the provider's getSchema, as { name, description, parameters }. */
  discover(): Promise<any[]>;
  /** Execute one call; returns the raw result content. */
  call(name: string, args: any): Promise<string>;
  /** Tools a DISCOVERY result unlocked. The harness reads the rows and mints them. */
  mintFrom(toolName: string, resultContent: string): Promise<any[]>;
  /** Does this exchange end the turn? Depends on which tools were WIRED. */
  endsTurn(calls: { name: string; resultContent: string }[]): boolean;
  /** Project a result down to what the model needs before it goes back. */
  lean(resultContent: string): string;
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
  const live: any[] = [];
  for (const t of await bridge.discover()) live.push(await offer(t));

  const seen = new Map<string, number>();
  let chainId: string | undefined;
  let results: unknown[] | null = null;
  let turn = 0;

  for (turn = 1; turn <= maxTurns; turn++) {
    const scoped: RunContext = { ...ctx, services: { ...ctx.services, [connector]: { tools: live } } };

    const extra: Record<string, unknown> = { [te.toolsInto ?? "tools"]: live };
    if (te.choiceInto) extra[te.choiceInto] = te.choice ?? "auto";
    if (chainId && te.continuity) extra[te.continuity.into] = chainId;
    if (results) extra[te.resultsInto ?? "input"] = results;

    const res = await sendRequest(node, withExtra(modelCall, extra), scoped, `${node.type} (turn ${turn})`);

    // Two readers of one stream: the events table decides what leaves the node, and the
    // loop separately watches for a tool call and a continuity id, neither of which is an
    // output. Collected by event TYPE here; the manifest's expressions read them below.
    const raw: any[] = [];
    let chainPayload: any;
    await readSse(res, modelCall.terminator, async (payload) => {
      await assertOk(node, modelCall, payload, `${node.type} (turn ${turn})`);
      await emitter.response(payload, payload.type);
      if (payload.type === te.call.match) raw.push(payload);
      if (te.continuity && payload.type === te.continuity.match) chainPayload = payload;
    });
    if (chainPayload) chainId = String(await evaluate(te.continuity.from, { response: chainPayload }));

    const calls: { id: string; name: string; arguments: string }[] = [];
    for (const payload of raw) {
      if (te.call.when && !(await evaluate(te.call.when, { response: payload }))) continue;
      calls.push({
        id: String(await evaluate(te.call.id, { response: payload })),
        name: String(await evaluate(te.call.name, { response: payload })),
        arguments: String((await evaluate(te.call.arguments, { response: payload })) ?? "{}"),
      });
    }

    // Answered rather than called. Done.
    if (!calls.length) break;

    const exchanges: { name: string; resultContent: string }[] = [];
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
      try {
        content = await bridge.call(call.name, args);
      } catch (err: any) {
        // A failed tool is information for the model, not a crash: it can try another.
        content = JSON.stringify({ error: err?.message ?? String(err) });
      }
      exchanges.push({ name: call.name, resultContent: content });
      // The RESULT, and only now that it exists. It is never in the HTTP stream: our loop
      // produced it, which is why it cannot be a `from: response` row.
      await emitter.tool({ name: call.name, args, output: content });

      for (const minted of await bridge.mintFrom(call.name, content))
        if (minted?.name && !live.some((t) => t?.name === minted.name)) {
          live.push(await offer(minted));
          console.log(`[manifests] ${node.type}: minted "${minted.name}" from ${call.name}`);
        }
    }

    if (stuck) break;
    // A handoff ends the turn even though tools were called.
    if (bridge.endsTurn(exchanges)) break;

    // Leaned first: a search result carries far more than the model needs, and the full
    // rows were already used for minting above.
    results = [];
    for (let i = 0; i < calls.length; i++)
      results.push(
        await evaluate(te.result, { call: { ...calls[i], output: bridge.lean(exchanges[i]?.resultContent ?? "{}") } }),
      );
  }

  return 200;
}

/** Merge the loop's fields into the request body, object or expression alike. */
function withExtra(request: any, extra: Record<string, unknown>): any {
  return typeof request.body === "string"
    ? { ...request, body: `return Object.assign({}, (${request.body.replace(/^return\s+/, "")}), ${JSON.stringify(extra)})` }
    : { ...request, body: { ...request.body, ...extra } };
}
