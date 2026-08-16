/**
 * `api.events` — everything that leaves a node, in one ordered table.
 *
 * ONE ROW PER OUTPUT CONNECTOR, in the same order the connectors are declared, so reading
 * the table tells you the node's entire outward behaviour without opening another file.
 * Lint enforces both the coverage and the order.
 *
 * This replaced four separate mechanisms (`response.events`, `response.finalize`,
 * `response.map`, and `narrate.output`), which between them meant a five-output node
 * declared its outputs in four places under three different key names. That is also how
 * a real bug got in: the tool RESULT is produced by our tool loop and never appears in
 * the HTTP stream, but `response.events` was the only list available, so it was wired to
 * the nearest wrong thing (the tool CALL, fired before the tool had even run).
 *
 * A row says WHERE it fires from:
 *
 *   from: response   streaming: each event whose type equals `match`
 *                    settling:  once, over the whole body
 *   from: narrator   each line the narrator produces
 *   from: tool       after each tool call returns, with its result
 *   from: complete   once, at the end, over everything emitted
 *
 * The executor owns what data cannot express: accumulating, throttling, and flushing what
 * throttling held back. `accumulate` and the two throttles exist because a delta-per-event
 * stream is not what a consumer wants. It wants the text so far, at a readable rate.
 */
import type { ComposedNode } from "../compose.js";
import { evaluate, render } from "./templating.js";
import type { Emission } from "./http/response.js";

export type EventSource = "response" | "narrator" | "tool" | "complete";

/** Per-row state. Throttling and accumulation are stateful across a run, so rows own it. */
interface RowState {
  /** Running total, for `accumulate: true`. */
  acc: string;
  /** Held back by a throttle and not yet emitted. */
  pending?: unknown;
  /** Characters added since the last emission, for `throttleChars`. */
  chars: number;
  /** When we last emitted, for `throttleMs`. */
  lastAt: number;
  /** Resolved `send` target held alongside `pending`: it is known at fire time, not at flush. */
  to?: string;
}

/**
 * The emitter for ONE run. Holds every emission it made, because `from: complete` is
 * defined over them and because a node's settled outputs are the last value per connector.
 */
export function makeEmitter(node: ComposedNode, onEmit: (e: Emission) => void, base: Record<string, unknown> = {}) {
  const rows: any[] = node.api?.events ?? [];
  const state = new Map<number, RowState>();
  const emissions: Emission[] = [];

  const stateFor = (i: number) => {
    let s = state.get(i);
    if (!s) state.set(i, (s = { acc: "", chars: 0, lastAt: 0 }));
    return s;
  };

  /**
   * The row's destination. `emit` names an output CONNECTOR; `send` names another NODE.
   *
   * A send row is how one node hands something to a named node without a wire: the loop-back
   * is the first case (LoopEnd already names its partner in `loopStartNodeId`, so an edge would
   * be the same fact stated twice), and it is deliberately not loop-specific.
   */
  const destination = (row: any, to?: string) =>
    row.send ? { to, handle: row.handle ?? "input" } : { emit: row.emit };

  /** Apply accumulate + throttle, then emit or hold. */
  const deliver = (row: any, i: number, raw: unknown, to?: string) => {
    if (raw === undefined || raw === null) return;
    const s = stateFor(i);

    let value = raw;
    if (row.accumulate) {
      s.acc += String(raw);
      value = s.acc;
    }

    // Throttled: remember the newest value and let a later tick or the flush send it.
    // Never DROP it, or the last words of an answer go missing.
    if (row.throttleMs) {
      const now = Date.now();
      if (now - s.lastAt < row.throttleMs) {
        s.pending = value;
        s.to = to;
        return;
      }
      s.lastAt = now;
    }
    if (row.throttleChars) {
      s.chars += String(raw).length;
      if (s.chars < row.throttleChars) {
        s.pending = value;
        s.to = to;
        return;
      }
      s.chars = 0;
    }

    s.pending = undefined;
    const emission = { ...destination(row, to), value };
    emissions.push(emission);
    onEmit(emission);
  };

  /**
   * END OF A TURN: flush what the throttle holds, then start the accumulator over.
   *
   * `accumulate` runs for the length of a RUN, which is one answer over HTTP and a whole
   * CONVERSATION over a socket — so without this every turn carries every turn before it.
   * Flush BEFORE clearing, or the turn's closing words go with it.
   */
  const resetTurn = (match?: string) => {
    if (match === undefined) return;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row.resetOn) continue;
      const hit = Array.isArray(row.resetOn) ? row.resetOn.includes(match) : row.resetOn === match;
      if (!hit) continue;
      const s = state.get(i);
      if (!s) continue;
      if (s.pending !== undefined) {
        const emission = { emit: row.emit, value: s.pending };
        s.pending = undefined;
        emissions.push(emission);
        onEmit(emission);
      }
      s.acc = "";
      s.chars = 0;
      s.lastAt = 0;
    }
  };

  // `base` is what every row sees regardless of where it fired: config, the signed-in
  // user, and (for a chained call) each step's reply. A row's own source keys are layered
  // on top, so `response` still means the thing that just arrived.
  const fire = async (source: EventSource, sourceScope: Record<string, unknown>, match?: string) => {
    const scope = { ...base, ...sourceScope };
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if ((row.from ?? "response") !== source) continue;
      // `match` applies to streaming rows only; a settling row has no event type to match.
      // A row may name SEVERAL event types (a list) when one connector accumulates from
      // more than one wire event — e.g. reasoning summary deltas plus the part-done
      // marker that separates summary sections. The value expression reads
      // `response.type` to tell them apart.
      if (match !== undefined && row.match !== undefined) {
        const hit = Array.isArray(row.match) ? row.match.includes(match) : row.match === match;
        if (!hit) continue;
      }
      if (row.when && !(await evaluate(row.when, scope))) continue;
      // A send row's target is a TEMPLATE over the same scope (`{{ config.loopStartNodeId }}`),
      // rendered here rather than in deliver() because only the fire has the scope. Empty means
      // the author's config field is unset: fail loudly, exactly as a missing loop state does,
      // rather than dropping the message and leaving a loop that silently stops after one pass.
      let to: string | undefined;
      if (row.send) {
        to = String(render(row.send, scope as any) ?? "").trim();
        if (!to) {
          throw new Error(
            `${node.type}: events row ${i} sends to "${row.send}", which resolved to nothing. ` +
              `Set that config field to the target node's id.`,
          );
        }
      }
      deliver(row, i, await evaluate(row.value, scope), to);
      // First match wins per event, which is what keeps a chatty API readable.
      if (match !== undefined) break;
    }
  };

  return {
    emissions,

    /**
     * One streamed event, or one settled body when `match` is undefined.
     *
     * `extra` carries the replies of earlier calls, which only the caller that ran them
     * knows about.
     */
    response: async (payload: any, match?: string, extra: Record<string, unknown> = {}) => {
      await fire("response", { ...extra, response: payload }, match);
      // AFTER the rows have seen it. A turn-ending event may itself be something a row emits
      // on, and resetting first would clear the accumulator the row is about to read.
      resetTurn(match);
    },
    narrator: (line: string) => fire("narrator", { narrator: { line } }),
    tool: (call: { name: string; args: unknown; output: unknown }) => fire("tool", { call }),

    /**
     * Send anything a throttle held back, then run the `complete` rows over the whole run.
     * Flushing first matters: `complete` is usually defined over what was emitted.
     */
    async finish() {
      for (let i = 0; i < rows.length; i++) {
        const s = state.get(i);
        if (s?.pending === undefined) continue;
        const emission = { ...destination(rows[i], s.to), value: s.pending };
        s.pending = undefined;
        emissions.push(emission);
        onEmit(emission);
      }
      await fire("complete", { events: emissions.slice() });
      return emissions;
    },

    /** A node's settled outputs are the LAST value seen on each connector. */
    outputs(): Record<string, unknown> {
      const out: Record<string, unknown> = {};
      // A send row addresses a node, not a connector, so it is NOT one of this node's outputs.
      // Including it would put a phantom handle in __outputs, and the engine's routing decides
      // which edges fire from exactly that set.
      for (const e of emissions) if (e.emit) out[e.emit] = e.value;
      return out;
    },
  };
}

export type Emitter = ReturnType<typeof makeEmitter>;
