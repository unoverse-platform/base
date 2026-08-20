/**
 * Signal routing over a frozen route table — the runtime half of the workflow contract.
 *
 * The types here are the WIRE CONTRACT for a compiled workflow: the engine's compiler
 * (RouteTableBuilder, engine-side — it needs the node metadata registry and must never
 * enter this package) produces a RouteTable; anything that runs one consumes these shapes.
 * The compiler's own declarations stay structurally identical — the runtime round-trip
 * tests hold the two in parity.
 *
 * SignalRoutingEngine is pure routing logic: given a completed node's output and the
 * route table, which downstream signals fire. No signal management, no execution.
 */

import { createLogger } from "../logger.js";

/** One compiled edge: source → target with its signal type and connector handles. */
export interface RouteEntry {
  targetNodeId: string;
  signalType: string; // "EXECUTE" | "SPAWN" | "RESET" etc.
  targetHandle?: string; // Which input connector this edge connects to
  sourceHandle?: string; // Which output connector this edge comes from
}

/** The frozen routing derived from a workflow's nodes + edges. */
export interface RouteTable {
  routing: Map<string, RouteEntry[]>; // Source → [RouteEntries with signal types]
  dependencies: Map<string, string[]>; // Target → [Source Node IDs] (for execution order)
  connectorDependencies?: Map<string, Map<string, string[]>>; // Target → Connector → [Source Node IDs]
  triggerNodes: string[]; // Nodes that start execution
  nodeTriggerMap?: Map<string, string>; // nodeId → upstream InputTrigger ID (Focus Mode routing)
}

/** A signal the router decided to send. */
export interface SignalRoute {
  targetNodeId: string;
  signal: string;
  sourceNodeId: string;
  targetHandle?: string; // Which input connector this signal targets
}

const logger = createLogger("SignalRoutingEngine");

export class SignalRoutingEngine {
  /**
   * Get signals to send when a node completes execution - ROUTE TABLE VERSION
   * Ultra-fast O(1) lookup using pre-computed route table
   * Now with multi-output support - filters based on active output connectors
   */
  static getSignalsForCompletedNode(nodeId: string, nodeOutput: any, routeTable: RouteTable): SignalRoute[] {
    const signals: SignalRoute[] = [];

    if (!routeTable?.routing) {
      logger.warn(`No route table provided for node completion`, { nodeId });
      return signals;
    }

    const routeEntries = routeTable.routing.get(nodeId) || [];

    for (const routeEntry of routeEntries) {
      // For nodes using __outputs pattern, check if the specific output exists
      if (nodeOutput?.__outputs) {
        // If there's a sourceHandle, check if that specific output exists
        if (routeEntry.sourceHandle) {
          const hasOutput =
            routeEntry.sourceHandle in nodeOutput.__outputs &&
            nodeOutput.__outputs[routeEntry.sourceHandle] !== undefined;

          if (!hasOutput) {
            // Debug level - this is normal for streaming nodes that emit partial outputs
            logger.debug(`No signal - output connector has no data`, {
              from: nodeId,
              to: routeEntry.targetNodeId,
              sourceHandle: routeEntry.sourceHandle,
            });
            continue; // Skip this route
          }
        }
        // If no sourceHandle specified, node should have a default output
      }
      // For legacy multi-output nodes (IfElse, etc), check if the specific output exists
      else if (routeEntry.sourceHandle && nodeOutput && typeof nodeOutput === "object") {
        const hasOutput = routeEntry.sourceHandle in nodeOutput;

        if (!hasOutput) {
          logger.debug(`No signal - output connector has no data`, {
            from: nodeId,
            to: routeEntry.targetNodeId,
            sourceHandle: routeEntry.sourceHandle,
          });
          continue; // Skip this route
        }
      }
      // For flat output nodes or nodes with data, always send signal

      signals.push({
        targetNodeId: routeEntry.targetNodeId,
        signal: routeEntry.signalType, // Use pre-computed signal type!
        sourceNodeId: nodeId,
        targetHandle: routeEntry.targetHandle, // Include target connector
      });

      if (routeEntry.signalType === "SPAWN") {
        logger.debug(`Routing SPAWN signal`, {
          from: nodeId,
          to: routeEntry.targetNodeId,
          targetHandle: routeEntry.targetHandle,
          sourceHandle: routeEntry.sourceHandle,
        });
      }

      logger.debug(`Using route table to add active signal`, {
        from: nodeId,
        to: routeEntry.targetNodeId,
        signal: routeEntry.signalType,
        targetHandle: routeEntry.targetHandle,
        sourceHandle: routeEntry.sourceHandle,
      });
    }

    return signals;
  }
}
