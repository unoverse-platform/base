/**
 * THE SERVICE CHANNEL: a method this node offers over a service edge, exposed as MCP.
 *
 * The other of the two ways a node is reached, and they never cross (08-mcp-services.md).
 * Called ad-hoc by an agent rather than run by the graph, and it hands back ONE value rather
 * than emitting on output connectors — which is why the manifest says `returns` and why no
 * events row is involved anywhere in here.
 */
import type { ComposedNode } from "../../compose.js";
import type { RunContext } from "../context.js";
import { evaluate } from "../templating.js";
import { runCalls } from "../http/request.js";
import type { StateStore } from "../state.js";
import { contentCardsFromResults, renderContentCards } from "../../../agent-mcp/cards.js";
import { withHelpers } from "../helpers.js";

/**
 * THE CALLER'S LIVE SESSION, supplied by the EXECUTOR and never by the manifest.
 *
 * `accessToken` is the deliberate omission from RunContext (§9.4): a manifest is data that
 * can arrive by paste or database row, and one that could read the token could forward it to
 * any host its allowedHosts allows. It is threaded here instead, the same way the tool bridge
 * already uses it — the platform calling its own surface on the user's behalf, rather than
 * data deciding where a secret goes.
 */
export interface CallerSession {
  userId?: string;
  conversationId?: string;
  chatId?: string;
  accessToken?: string;
}

/**
 * The package's named helpers are bound around the WHOLE method, not around `returns` alone:
 * a call's `when`, a url, an error message and the projection are all expressions, and a
 * helper that some of them could call and others could not would be a rule with no reason
 * behind it.
 */
export async function performService(
  node: ComposedNode,
  method: string,
  params: Record<string, any>,
  ctx: RunContext,
  store?: StateStore,
  session?: CallerSession,
): Promise<unknown> {
  return withHelpers(node, () => serviceMethod(node, method, params, ctx, store, session));
}

async function serviceMethod(
  node: ComposedNode,
  method: string,
  params: Record<string, any>,
  ctx: RunContext,
  store?: StateStore,
  session?: CallerSession,
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

  /**
   * CONTENT CARDS, rendered from the rows this method surfaced.
   *
   * BEFORE `returns`, and that ordering is the whole reason this lives here rather than in
   * the executor: `returns` is where a node projects its reply down to what a model should
   * read, and a card needs the FULL row (the component uri, the images, the authored copy)
   * that the projection strips. Rendering after it would draw cards from data that no longer
   * has what a card is made of.
   *
   * DATA-DRIVEN, never a model tool: a row that carries a component renders it the moment it
   * surfaces, so the model cannot forget to show it, describe one that is not there, or
   * decide not to bother. No prompt is involved anywhere.
   *
   * Fire-and-forget and deliberately not awaited: a card is a side channel to a screen, and
   * a slow render must not hold up the answer the caller is waiting on. With no live session
   * (builder, tests, headless) `renderContentCards` no-ops on the missing userId, so a
   * manifest declaring this stays pure everywhere it is not wanted, with no flag to juggle.
   */
  if (spec.renderCards) {
    const rows = await evaluate(spec.renderCards, { response: last, calls: results, params, config: ctx.config });
    const cards = contentCardsFromResults(rows);
    /**
     * SAY WHAT HAPPENED, always. This lane no-ops in three different ways — no rows carry a
     * component, no live session, or a card already rendered this conversation — and it
     * originally shipped with no logging at all, so all four outcomes looked identical from
     * outside: silence. Hours went into asking "are the cards broken?" with nothing to read.
     *
     * `renderContentCards` logs its own success through the callback; this covers the cases
     * where it is never reached.
     */
    if (!cards.length) {
      const n = Array.isArray(rows) ? rows.length : 0;
      console.log(`[manifests] ${node.type}: no content cards in ${n} row(s) — none carry metadata.app`);
    } else if (!session?.userId) {
      console.log(`[manifests] ${node.type}: ${cards.length} content card(s) not rendered — no live session on this run`);
    }
    renderContentCards(
      cards,
      {
        userId: session?.userId,
        conversationId: session?.conversationId,
        chatId: session?.chatId,
        accessToken: session?.accessToken,
      },
      (m: string) => console.log(`[manifests] ${node.type}: ${m}`),
    );
  }

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
