/**
 * `send` rows — one node handing a payload to a NAMED node, with no connector and no edge.
 *
 * WHY THIS EXISTS. LoopEnd already names its partner in `loopStartNodeId`. Requiring an edge as
 * well made the same fact true in two places, and the two could disagree: the canonical loop
 * pattern shipped without the edge for months, which builds a loop that runs exactly one pass and
 * looks like it worked. A row that addresses a node removes the second place.
 *
 * It is deliberately NOT loop-specific. "Deliver this to that node" is the general primitive;
 * the loop is its first caller.
 *
 * DELIVERY HAPPENS HERE, at the executor boundary, and not in events.ts. The events table
 * DESCRIBES what leaves a node; performing a side effect needs the execution context, which only
 * an executor holds. Keeping the split means a manifest still cannot reach the engine directly.
 *
 * FAILURE IS LOUD. A send that silently does nothing is a loop that stops after one pass while
 * reporting success, which is the exact failure this replaced. An unresolvable target or an
 * absent host raises, in the same spirit as `loop: advance` raising "loop state not found"
 * rather than returning done.
 */
import type { Emission } from "../runtime/http/response.js";

/**
 * The host's delivery bridge. Absent in tests and headless runs.
 *
 * SAME RUN ONLY, and that is the point of the leading `executionId`: it is the SENDER's own,
 * taken from its execution context, so a node can only ever reach nodes in the workflow it is
 * running in. There is no addressing scheme that reaches another execution.
 */
type DeliverToNode = (
  executionId: string,
  targetNodeId: string,
  handle: string,
  value: unknown,
) => Promise<void> | void;

/**
 * Deliver every `send` emission this run produced. A no-op for a node that declares none, which
 * is every node but LoopEnd today, so this costs nothing on the common path.
 */
export async function deliverSends(node: any, emissions: Emission[], executionContext: any): Promise<void> {
  const sends = emissions.filter((e) => e.to);
  if (sends.length === 0) return;

  const deliver: DeliverToNode | undefined = executionContext?.api?.deliverToNode;
  if (typeof deliver !== "function") {
    throw new Error(
      `${node?.type ?? "node"}: an events row sends to another node, but this runtime provides no ` +
        `deliverToNode bridge, so the message would be dropped. The run is stopped rather than ` +
        `continuing with a message nobody received.`,
    );
  }

  const executionId = executionContext?.executionId ?? executionContext?.scope?.executionId;
  if (!executionId) {
    throw new Error(
      `${node?.type ?? "node"}: an events row sends to another node, but this run has no executionId, ` +
        `so the delivery could not be confined to this workflow.`,
    );
  }

  for (const s of sends) {
    await deliver(String(executionId), String(s.to), s.handle ?? "input", s.value);
  }
}
