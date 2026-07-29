/**
 * THE WORKFLOW CHANNEL: what a node does when the GRAPH triggers it.
 *
 * One of the two ways a node is reached, and they never cross (08-mcp-services.md). This one
 * fires the node's output connectors and answers nobody; `service.ts` answers a caller and
 * fires no connectors.
 *
 * What lives here is the SHAPE OF A RUN and nothing else — which calls lead, which one settles
 * the node, what an events row may see. The individual capabilities are elsewhere: `final.ts`
 * dispatches the last call, `../http/request.ts` runs the leading ones, `../narrate.ts` talks
 * while it works.
 */
import type { ComposedNode } from "../../compose.js";
import type { RunContext } from "../context.js";
import { evaluate } from "../templating.js";
import { runCalls } from "../http/request.js";
import type { Emission } from "../http/response.js";
import type { AudioLane } from "../duplex/audioLane.js";
import type { StateStore } from "../state.js";
import { makeEmitter } from "../events.js";
import { makeNarrator } from "../narrate.js";
import { runToolLoop, type ToolBridge } from "../tools/toolloop.js";
import { runFinal } from "./final.js";
import { withHelpers } from "../helpers.js";
import { clientTransport } from "../../../platform/clientTransport.js";
import type { CallerSession } from "./service.js";

export interface RunResult {
  outputs: Record<string, unknown>;
  emissions: Emission[];
  status: number;
}

/**
 * `onEmit` receives every streamed emission as it happens, which is what a CallbackNode
 * forwards to its output connectors in real time.
 */
export async function performApi(
  node: ComposedNode,
  ctx: RunContext,
  onEmit: (e: Emission) => void = () => {},
  tools?: ToolBridge,
  store?: StateStore,
  lane?: AudioLane | null,
  session?: CallerSession,
): Promise<RunResult> {
  // The package's named helpers, bound for the whole run — see the same wrapper on the
  // service channel. Every expression this run evaluates, in a call or an events row or a
  // tool exchange, sees the same bag.
  return withHelpers(node, () => runApi(node, ctx, onEmit, tools, store, lane, session));
}

async function runApi(
  node: ComposedNode,
  ctx: RunContext,
  onEmit: (e: Emission) => void = () => {},
  tools?: ToolBridge,
  store?: StateStore,
  lane?: AudioLane | null,
  session?: CallerSession,
): Promise<RunResult> {
  const api = node.api;
  if (!api) throw new Error(`Node "${node.type}" has no api block, so there is nothing to perform`);

  /**
   * A NODE MAY MAKE NO REQUEST AT ALL.
   *
   * Two different things used to fail on the same check, and only one of them should:
   *
   *   service-only   `service` methods and nothing else. The graph must NOT run it — it
   *                  answers a caller over a service edge, and has no inputs to reach it by.
   *                  Still refused, below.
   *   events-only    an `events` table and no calls. LEGITIMATE. `IfElse` picks which output
   *                  dot the data lands on; `Relay` passes its input through; `Note` does
   *                  nothing at all. There is no url, so `run` would be a fiction.
   *
   * NOT AN ESCAPE HATCH, which is the only reason this is allowed (§2, §10). The safety
   * property is that a manifest cannot EXECUTE — and an events-only node executes nothing. It
   * is an events table over already-resolved config and the incoming signal, evaluated by the
   * same sandbox as every other expression. Nothing new is reachable; there is simply no
   * request in front of it.
   *
   * The distinction is `events`, not the absence of `run`, so a service-only node is still
   * refused with the message it always had.
   */
  const eventsOnly = !api.run?.length && !!api.events?.length;
  if (!api.run?.length && !eventsOnly)
    throw new Error(`Node "${node.type}" has only service methods — the graph cannot run it`);

  // LEAD then FINAL. Every call but the last settles and just fills `calls.<name>`; the
  // last is the one whose reply becomes the node's answer, so it alone may stream. A node
  // that makes one call is the ordinary case and takes this path with an empty lead.
  const lead = eventsOnly ? [] : api.run.slice(0, -1);
  const final = eventsOnly ? undefined : api.run[api.run.length - 1];

  /**
   * WHAT AN EVENTS ROW MAY SEE. Mutated rather than copied: `base` is spread at each fire, so filling
   * in `calls` after the lead runs makes it visible to every row, including the `complete` ones.
   *
   * `signal` and `scope` were MISSING, and both are documented roots. That is not theoretical:
   * `aws-s3/S3FileContent` reads `signal.key`, `signal.universalId` and `signal.etag` in its events
   * row, and `flow/Context` reads `scope.*` — so both threw "unknown identifier" on every run. The
   * sandbox refuses an undeclared identifier outright, so the row failed rather than reading empty.
   *
   * Kept in step with the roots `context.ts` documents; a row seeing less than a body template can is
   * a trap, because the same expression works in one file and not the other.
   */
  const base: Record<string, unknown> = {
    config: ctx.config,
    user: ctx.user,
    scope: ctx.scope,
    signal: ctx.signal,
    calls: {},
  };
  const emitter = makeEmitter(node, onEmit, base);

  /**
   * EVENTS-ONLY: there is no reply, so the rows fire over the SIGNAL.
   *
   * `response` is the incoming signal rather than a body, which is the only honest thing it
   * can be: `IfElse` routes what arrived, and `Relay` passes it through. A row's `when` is
   * what makes routing work — two rows, one per output dot, each testing the same condition.
   *
   * Returns before the request machinery, so nothing below it can reach for a `final` that
   * does not exist.
   */
  if (eventsOnly) {
    await emitter.response(ctx.signal ?? {});
    const emissions = await emitter.finish();
    const outputs = emitter.outputs();
    await publishTemplateData(node, api, { ...base, output: outputs }, session);
    return { outputs, emissions, status: 200 };
  }

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
      /**
       * `runToolLoop` is the HTTP tool loop and must NOT take a duplex node.
       *
       * It works by TURNS — send a request, read the tool calls out of the reply, send another —
       * and a socket has no turns: the conversation never ended, so a tool result goes back down
       * the same connection. A ws node declaring a toolExchange therefore stays on the duplex
       * path, which resolves its calls inline. Without this check, declaring tools on the voice
       * node would silently route it through HTTP and never open the socket at all.
       */
      const duplex = final.transport === "ws";
      status = api.toolExchange && tools && !duplex
        ? await runToolLoop(node, scoped, tools, emitter, narrator.fire, final)
        : await runFinal(node, final, scoped, emitter, base, store, lane, tools);
    }

    const emissions = await emitter.finish();
    const outputs = withSaveFlag(emitter.outputs(), api, base);
    await publishTemplateData(node, api, { ...base, output: outputs }, session);
    return { outputs, emissions, status };
  } finally {
    narrator.settle();
  }
}

/**
 * `publish` — A GENERIC WRITE INTO THE CALLER'S TEMPLATE STATE, the workflow channel's
 * sibling of the service channel's `renderCards`: both reach the person watching rather
 * than answer the graph, and both no-op when nobody is (builder, tests, headless, cron).
 *
 * AFTER the emitter settles, over `output`, deliberately: the pushed value derives from what
 * the node actually emitted, so the screen and the graph cannot drift apart — a Suggestions
 * whose connector carried one object and whose push carried another would be exactly the
 * half-working that takes an afternoon to see.
 *
 * The frame is the one the retired Suggestions node sent and the client already handles
 * (`connection.ts` TEMPLATE_DATA): the client merges `data` opaquely into template state and
 * knows no key names — the PRODUCER names them (UNOVERSE_STATE_MODEL §2/§8).
 *
 * SAY WHAT HAPPENED, always, for the same reason the card lane learned to: this no-ops three
 * different ways (no session, nothing evaluated, nobody listening) and silence must not read
 * as success.
 */
async function publishTemplateData(
  node: ComposedNode,
  api: NonNullable<ComposedNode["api"]>,
  scope: Record<string, unknown>,
  session?: CallerSession,
): Promise<void> {
  const spec = api.publish;
  if (!spec) return;
  if (spec.when && !(await evaluate(spec.when, scope))) return;
  const data = await evaluate(spec.data, scope);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    console.log(`[manifests] ${node.type}: publish evaluated to ${Array.isArray(data) ? "an array" : typeof data} — template state merges OBJECTS, nothing pushed`);
    return;
  }
  if (!session?.userId || !session?.conversationId) {
    console.log(`[manifests] ${node.type}: template data not pushed — no live session on this run`);
    return;
  }
  const delivered = clientTransport().pushToClient(session.userId, session.conversationId, {
    type: "TEMPLATE_DATA",
    chatId: session.chatId,
    conversationId: session.conversationId,
    userId: session.userId,
    data,
    timestamp: new Date().toISOString(),
  });
  console.log(
    `[manifests] ${node.type}: template data ${delivered ? "pushed" : "found NO listener"} — keys: ${Object.keys(data as object).join(", ") || "(none)"}`,
  );
}

/**
 * `__saveToContext`, which the ENGINE reads off the output envelope.
 *
 * Two halves make one behaviour and both must happen or neither is any use: the `save` state op
 * writes `saved:<executionId>` for a LATER run of the template resolver, and this flag tells
 * `executingState` to put the same value into the in-memory cache so THIS run can see it too. The
 * retired Code node set both by hand. Here the flag is DERIVED rather than declared, so a manifest
 * cannot write the value and forget the flag — the value would be reachable next node but not this
 * one, which is the sort of half-working that takes an afternoon to see.
 *
 * Derived from `base.calls`, not from the declaration: a call records its name there only if it
 * actually RAN, so a save gated `when: config.saveToContext` correctly sets no flag when the toggle
 * is off. That also makes it work the same whether the save is the last call or an earlier one,
 * with nothing threaded through.
 */
function withSaveFlag(
  outputs: Record<string, unknown>,
  api: NonNullable<ComposedNode["api"]>,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const ran = base.calls as Record<string, unknown>;
  const saved = (api.run ?? []).some((c: any) => c.state === "save" && ran[c.name] !== undefined);
  return saved ? { ...outputs, __saveToContext: true } : outputs;
}
