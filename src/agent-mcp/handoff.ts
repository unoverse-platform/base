/**
 * DOES THIS TOOL CALL END THE TURN?
 *
 * Decided by PROVENANCE and RESULT SHAPE, never by a hardcoded list of tool names. A tool
 * wired in up front keeps the conversation going; one spatial surfaced mid-loop is a handoff
 * candidate, and whether it actually ends the turn depends on what came back.
 */
import type { AgentToolExchange } from "./types.js";

/** Parse a tool result content string to JSON; non-JSON comes back verbatim. */
export function parseToolResult(content: string): any {
  try {
    return JSON.parse(content || "{}");
  } catch {
    return content;
  }
}

/**
 * Whether any tool call is a dynamically-discovered workflow handoff.
 *
 * Provenance, not a hardcoded name list: a tool keeps the conversation going if it
 * was wired in up front (`coreToolNames`, the getSchema set — SpatialSearch, memory,
 * connector MCPs). Only tools spatial surfaced mid-loop are handoff candidates.
 * With no wired-tool info we can't identify a handoff, so we keep going.
 */
export function hasDynamicHandoff(toolNames: string[], coreToolNames?: Set<string>): boolean {
  if (!coreToolNames || coreToolNames.size === 0) return false;
  return toolNames.some((name) => !coreToolNames.has(name));
}

/**
 * Whether this batch of tool calls ENDS the agent's turn.
 *
 * Refined by RESULT shape: a dynamically-discovered tool whose result carries
 * `output` (or an explicit completed/error status) is an interactive app's SLOW
 * CALL — the user completed it and the answers ARE the result; the conversation
 * CONTINUES with them. Only the fire-and-forget handoff signature
 * ({ status: "started" } / unparseable) ends the turn.
 */
export function isTurnEndingHandoff(calls: AgentToolExchange[], coreToolNames?: Set<string>): boolean {
  if (
    !hasDynamicHandoff(
      calls.map((c) => c.name),
      coreToolNames,
    )
  ) {
    return false;
  }
  return calls.some((c) => {
    if (coreToolNames?.has(c.name)) return false;
    const res = parseToolResult(c.resultContent);
    if (res && typeof res === "object" && (res.output || res.status === "completed" || res.status === "error")) return false;
    return true;
  });
}
