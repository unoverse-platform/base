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
import { evaluate } from "./templating.js";
import type { Emission } from "./response.js";

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

  /** Apply accumulate + throttle, then emit or hold. */
  const deliver = (row: any, i: number, raw: unknown) => {
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
        return;
      }
      s.lastAt = now;
    }
    if (row.throttleChars) {
      s.chars += String(raw).length;
      if (s.chars < row.throttleChars) {
        s.pending = value;
        return;
      }
      s.chars = 0;
    }

    s.pending = undefined;
    const emission = { emit: row.emit, value };
    emissions.push(emission);
    onEmit(emission);
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
      if (match !== undefined && row.match !== undefined && row.match !== match) continue;
      if (row.when && !(await evaluate(row.when, scope))) continue;
      deliver(row, i, await evaluate(row.value, scope));
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
    response: (payload: any, match?: string, extra: Record<string, unknown> = {}) =>
      fire("response", { ...extra, response: payload }, match),
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
        const emission = { emit: rows[i].emit, value: s.pending };
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
      for (const e of emissions) out[e.emit] = e.value;
      return out;
    },
  };
}

export type Emitter = ReturnType<typeof makeEmitter>;
