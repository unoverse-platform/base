/**
 * Execution Context Builder
 * Builds the execution context for node execution in node-service
 */

import { clientTransport } from "./clientTransport.js";
import { callServiceViaWorkflow, saveTokenUsageToWorkflow, saveMCPTraceToWorkflow } from "./serviceCalls.js";
import { getRedisClient } from "./redis.js";

/**
 * Build execution context for a node
 */
export function buildExecutionContext(nodeType: string, inputs: any, config: any, context: any) {
  const credentials = context.credentials || {};
  const publishingContext = context.publishingContext;
  const serviceNodeId = context.serviceNodeId;

  // Extract workflow variables - they come from context.variables (passed from CallbackNodeActor)
  const workflowVariables = context.variables || {};

  // Build execution context first so we can reference it in callService
  const executionContext: any = {
    nodeId: context.nodeId || `node-service-${Date.now()}`,
    executionId: context.executionId || `exec-${Date.now()}`,
    workflowId: context.workflowId || "node-service",
    nodeType,
    config,
    inputs,
    credentials,
    serviceNodeId,
    // Preserve workflow definition for service calls (node lookups) AND add variables for MCP discovery
    workflow: context.workflow
      ? { ...context.workflow, variables: workflowVariables }
      : {
          id: context.workflowId || "node-service",
          runId: context.executionId || `exec-${Date.now()}`,
          variables: workflowVariables,
        },
    publishingContext,
    activeLoop: context.activeLoop,
    logger: console,
    auth: context.auth,
  };

  // Build API with callService that routes to workflow-service
  executionContext.api = {
    gravityPublish: async () => {},
    createLogger: (name: string) => {
      const log = (level: string, ...args: any[]) => {
        const msg = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
        console.log(JSON.stringify({ level, nodeType: name, msg, service: "node-service" }));
      };
      return {
        info: (...args: any[]) => log("info", ...args),
        error: (...args: any[]) => log("error", ...args),
        debug: (...args: any[]) => log("debug", ...args),
        warn: (...args: any[]) => log("warn", ...args),
      };
    },
    getNodeCredentials: async (ctx: any, credentialName: string) => {
      return credentials[credentialName] || {};
    },
    saveTokenUsage: saveTokenUsageToWorkflow,
    saveMCPTrace: saveMCPTraceToWorkflow,
    getRedisClient,
    callService: async (method: string, params: any) => {
      return callServiceViaWorkflow(method, params, executionContext);
    },
    getWebSocketManager: () => {
      if (!publishingContext) {
        return null;
      }
      return {
        get: (userId: string, conversationId: string) => ({
          mountedComponents: new Set<string>(),
          currentTemplate: null as string | null,
          send: (data: string) => {
            const message = JSON.parse(data);
            // §5/§5a data plane — components/data + template state go ONLY to the native MCP
            // SSE stream. The legacy WS is AUDIO-ONLY now (the SDK reads components from MCP).
            clientTransport().pushToClient(userId, conversationId, message);
          },
        }),
      };
    },
    publishStreamingUpdate: (streamConfig: { componentType: string; props: Record<string, any> }) => {
      if (!publishingContext) {
        return;
      }
      const { chatId, conversationId, userId } = publishingContext;
      const nodeId = context.nodeId;
      const workflowId = context.workflowId;

      const componentKey = `${chatId}_${nodeId}`;
      const event = {
        id: `stream_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: new Date().toISOString(),
        type: "COMPONENT_INIT",
        nodeId,
        chatId,
        conversationId,
        userId,
        providerId: "streaming",
        component: {
          type: streamConfig.componentType,
          // §4a: address the component on the Unoverse definition server, not a legacy
          // `/components/<x>.js` bundle. The SDK resolves it by type over MCP.
          componentUrl: `unoverse://components/${streamConfig.componentType}`,
          props: streamConfig.props,
        },
        metadata: {
          workflowId,
          componentKey,
          streaming: true,
        },
      };

      clientTransport().pushToClient(userId, conversationId, event);
    },
  };

  return executionContext;
}
