/**
 * Token usage — restored for the manifest runtime (2026-08-07).
 *
 * Every LEGACY agent reported its vendor usage block to the engine
 * (`POST /analytics/tokens` → the `token_usage` table → the execution's Token Usage
 * tab). The YAML migration replaced those agents with this runtime and nothing here
 * reported usage, so the tab read "No token usage data" for every migrated node while
 * the route, the table, and the UI all sat working.
 *
 * WHERE usage lives is the vendor's business, but every wire this runtime speaks puts
 * it in one of three homes:
 *   payload.usage             Chat Completions (final chunk / settled body), LlamaParse-style REST
 *   payload.response.usage    OpenAI Responses API (`response.completed` event)
 *   payload.metadata.usage    Bedrock converse stream (`metadata` event)
 * Sniffing those three is a wire-format rule, not a per-node rule — no manifest changes.
 *
 * A run may hold SEVERAL model calls (the tool loop's turns), each with its own usage
 * block; the collector SUMS numeric fields across them, which is what "this execution
 * cost N tokens" means. Fire-and-forget on save, same contract as the MCP trace:
 * observability must never slow a run or fail it.
 */
import type { ComposedNode } from "../compose.js";
import type { RunContext } from "./context.js";
import { saveTokenUsageToWorkflow } from "../../platform/serviceCalls.js";

/** The vendor's usage block, wherever this wire puts it. */
export function sniffUsage(payload: any): Record<string, unknown> | undefined {
  const u = payload?.usage ?? payload?.response?.usage ?? payload?.metadata?.usage;
  return u && typeof u === "object" && !Array.isArray(u) ? (u as Record<string, unknown>) : undefined;
}

export interface UsageCollector {
  /** Look at one payload (streamed event or settled body); remember any usage block. */
  see(payload: any): void;
  /** Post the summed usage to the engine. No usage seen, or no execution scope → no-op. */
  save(): void;
}

/**
 * Add one usage block into the running totals, field by field, AT ANY DEPTH.
 *
 * Summing one level down dropped `input_token_details.cached_tokens_details.*` — the split that
 * says how cached tokens divide across text and audio. Without it a cached token cannot be
 * priced, and Canvas billed them all at the full fresh rate (found 2026-08-12). Depth limits
 * here are bugs waiting for the next vendor to nest a field.
 */
function addInto(totals: Record<string, any>, block: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(block)) {
    if (typeof v === "number") totals[k] = ((totals[k] as number) ?? 0) + v;
    // Arrays excluded deliberately: a list in a usage block is not a quantity to add up.
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      addInto((totals[k] = (totals[k] as Record<string, any>) ?? {}), v as Record<string, unknown>);
    }
  }
}

export function makeUsageCollector(node: ComposedNode, ctx: RunContext): UsageCollector {
  const totals: Record<string, number | Record<string, number>> = {};
  let seen = false;
  let model: string | undefined;

  return {
    see(payload: any) {
      const u = sniffUsage(payload);
      if (!u) return;
      seen = true;
      // Numeric fields sum across calls; detail objects sum field by field, at ANY depth.
      addInto(totals, u);
      model ??= payload?.response?.model ?? payload?.model ?? undefined;
    },
    save() {
      if (!seen) return;
      const { workflowId, executionId, nodeId } = ctx.scope ?? {};
      // Node-test / headless: no execution to attach to (same rule as the MCP trace).
      if (!workflowId || !executionId || !nodeId) return;
      void saveTokenUsageToWorkflow({
        workflowId,
        executionId,
        nodeId,
        nodeType: node.type,
        model: model ?? (ctx.config as any)?.model ?? "unknown",
        usage: totals,
        timestamp: new Date().toISOString(),
      });
    },
  };
}
