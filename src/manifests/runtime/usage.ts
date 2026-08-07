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

export function makeUsageCollector(node: ComposedNode, ctx: RunContext): UsageCollector {
  const totals: Record<string, number | Record<string, number>> = {};
  let seen = false;
  let model: string | undefined;

  return {
    see(payload: any) {
      const u = sniffUsage(payload);
      if (!u) return;
      seen = true;
      // Numeric fields sum across calls. Detail objects (`output_tokens_details.
      // reasoning_tokens`, `input_tokens_details.cached_tokens`) sum ONE level deep —
      // the Token Usage view reads the reasoning burn and the cache hits from exactly
      // those nested fields, so dropping them showed thinking as zero.
      for (const [k, v] of Object.entries(u)) {
        if (typeof v === "number") totals[k] = ((totals[k] as number) ?? 0) + v;
        else if (v && typeof v === "object" && !Array.isArray(v)) {
          const nest = (totals[k] = (totals[k] as Record<string, number>) ?? {});
          for (const [nk, nv] of Object.entries(v)) if (typeof nv === "number") nest[nk] = (nest[nk] ?? 0) + nv;
        }
      }
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
