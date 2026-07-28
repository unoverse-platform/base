/**
 * THE NARRATOR — the running commentary a node gives while it works.
 *
 * Its own module, and NOT part of the tool loop, because narration is a property of the NODE
 * rather than of having tools. It used to live inside the loop, which meant a node with no MCP
 * provider wired silently never narrated at all.
 *
 * The manifest describes the whole of it — endpoint, model, instructions, copy. The only part
 * that cannot be data is the timing, which is why there is any code here:
 *
 *   a local line at 0ms, because the round trip has a ~1s floor and the first token beats it
 *   never awaited, so narration cannot delay the work it describes
 *   fall back on any failure, so a missing narrator never fails a turn
 *   drop late lines, since one arriving after the answer reads as still working
 */
import type { ComposedNode } from "../compose.js";
import type { RunContext } from "./context.js";
import { evaluate, render } from "./templating.js";
import { sendRequest } from "./http/request.js";
import type { Emitter } from "./events.js";

/** Bound for one run. `fire` on each thing worth narrating, `settle` when the answer lands. */
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

export type Narrator = ReturnType<typeof makeNarrator>;
