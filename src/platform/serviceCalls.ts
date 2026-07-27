/**
 * Service Calls
 * HTTP calls to workflow-service for core node services and analytics
 */

import { boot } from "../boot.js";

const WORKFLOW_SERVICE_URL = process.env.WORKFLOW_SERVICE_URL || "http://localhost:4101";

/**
 * Call a service on a core node via workflow service
 * This enables package nodes (node-service) to call core node services (workflow-service)
 * Example: OpenAIStream calls GetActiveMCPs.getSchema
 */
export async function callServiceViaWorkflow(method: string, params: any, executionContext: any): Promise<any> {
  // No wired provider is NOT a reason to skip: workflow-service serves platform
  // tools (memory toolsets gated by workflow memory_config) and re-routes methods
  // to their real owner by name. The sentinel just satisfies the nodeId field;
  // calls that nothing can serve fail server-side and return {} as before.
  const serviceNodeId = executionContext?.serviceNodeId || "__platform";

  try {
    const response = await fetch(`${WORKFLOW_SERVICE_URL}/service-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodeId: serviceNodeId,
        method,
        params,
        context: {
          workflowId: executionContext?.workflowId,
          executionId: executionContext?.executionId,
          nodeId: executionContext?.nodeId,
          credentials: executionContext?.credentials,
          workflow: executionContext?.workflow,
          auth: executionContext?.auth,
          publishingContext: executionContext?.publishingContext,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[node-service] callService failed: ${response.status} ${errorText}`);
      return {};
    }

    return await response.json();
  } catch (error: any) {
    console.error("[node-service] callService error:", error.message);
    return {};
  }
}

/**
 * Save token usage by calling workflow service
 */
export async function saveTokenUsageToWorkflow(usage: any): Promise<void> {
  try {
    const response = await fetch(`${WORKFLOW_SERVICE_URL}/analytics/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(usage),
    });
    if (!response.ok) {
      console.error(`[node-service] Failed to save token usage: ${response.status}`);
    }
  } catch (error) {
    console.error("[node-service] Error saving token usage:", error);
  }
}

/**
 * Emit NODE_OUTPUT to workflow service so downstream nodes fire.
 * Used by package hybrid nodes (SmartDocument etc.) whose xstate actor
 * lives in the workflow-service process.
 */
export async function emitNodeOutputToWorkflow(payload: {
  executionId: string;
  nodeId: string;
  output: any;
}): Promise<void> {
  try {
    const response = await fetch(`${WORKFLOW_SERVICE_URL}/emit-node-output`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      console.error(`[node-service] emitNodeOutput failed: ${response.status}`);
    }
  } catch (error: any) {
    console.error("[node-service] emitNodeOutput error:", error.message);
  }
}

/**
 * Save MCP trace by calling workflow service
 */
export async function saveMCPTraceToWorkflow(trace: any): Promise<string> {
  try {
    const response = await fetch(`${WORKFLOW_SERVICE_URL}/analytics/mcp-trace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(trace),
    });
    if (!response.ok) {
      console.error(`[node-service] Failed to save MCP trace: ${response.status}`);
      return "";
    }
    const result = (await response.json()) as { traceId?: string };
    return result.traceId || "";
  } catch (error) {
    console.error("[node-service] Error saving MCP trace:", error);
    return "";
  }
}

/**
 * Persist plugin state to PostgreSQL via workflow-service
 */
export async function persistPluginState(plugin: {
  name: string;
  version: string;
  source: "local" | "npm";
  enabled: boolean;
  metadata?: any;
}): Promise<void> {
  try {
    const response = await fetch(`${WORKFLOW_SERVICE_URL}/plugins/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(plugin),
    });
    if (!response.ok) {
      console.error(`[node-service] Failed to persist plugin state: ${response.status}`);
    }
  } catch (error: any) {
    console.error("[node-service] Error persisting plugin state:", error.message);
  }
}

/**
 * Remove plugin state from PostgreSQL (on uninstall)
 */
export async function removePluginState(name: string): Promise<void> {
  try {
    const response = await fetch(
      `${WORKFLOW_SERVICE_URL}/plugins/state/${encodeURIComponent(name)}`,
      { method: "DELETE", headers: { "Content-Type": "application/json" } },
    );
    if (!response.ok) {
      console.error(`[node-service] Failed to remove plugin state: ${response.status}`);
    }
  } catch (error: any) {
    console.error("[node-service] Error removing plugin state:", error.message);
  }
}

/**
 * Fetch all plugin state from PostgreSQL (for Redis recovery on startup)
 */
export async function fetchPluginState(): Promise<Array<{
  name: string;
  version: string;
  source: string;
  enabled: boolean;
  metadata: any;
}>> {
  try {
    const response = await fetch(`${WORKFLOW_SERVICE_URL}/plugins/state`);
    if (!response.ok) return [];
    const data: any = await response.json();
    return data.plugins || [];
  } catch (error: any) {
    // EXPECTED once in merged mode: the runtime asks :4101 for plugin state before the
    // in-process engine has bound it, and index.ts re-runs the whole load after the
    // engine is up. Shouting about a failure that self-heals seconds later is how a log
    // teaches people to ignore it. Remembered instead, and surfaced by the boot report
    // only if the retry ALSO came back with nothing.
    if (boot.isBooting()) boot.pluginStateFetchFailed(error.message);
    else console.error("[node-service] Error fetching plugin state:", error.message);
    return [];
  }
}
