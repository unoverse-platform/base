/**
 * Plugin API Factory
 * Creates the minimal Plugin API for node-service plugin registration
 */

import { PromiseNode, CallbackNode, NodeInputType } from "../pluginBase.js";
import { getNodeRegistry, registerCredentialType } from "../registry.js";
import { getDistributedAudioManager } from "./audioManager.js";
import {
  saveTokenUsageToWorkflow,
  saveMCPTraceToWorkflow,
  emitNodeOutputToWorkflow,
} from "./serviceCalls.js";
import { getRedisClient } from "./redis.js";
import { boot } from "../boot.js";

/**
 * Create a minimal Plugin API for node-service
 * Collects registered nodes without needing full platform dependencies
 */
export function createNodeServiceAPI() {
  const nodeRegistry = getNodeRegistry();

  return {
    registerNode(node: any) {
      const def = node.definition;
      const executor = node.executor;

      // Determine execution mode by checking if executor has initializeState
      let executionMode: "single" | "generator" = "single";
      try {
        const proto = executor.prototype;
        if (proto && typeof proto.initializeState === "function") {
          executionMode = "generator";
        }
      } catch (e) {}

      nodeRegistry.set(def.type, {
        type: def.type,
        name: def.name,
        description: def.description || "",
        // whenToUse is the field the catalog ranker (CatalogService) embeds for
        // semantic node search. Omitting it here drops it for EVERY node at
        // registration — Redis stores "", ranking falls back to description, and
        // discovery degrades platform-wide. It must survive into the registry.
        whenToUse: def.whenToUse || "",
        category: def.category || "general",
        version: def.version || "1.0.0",
        configSchema: def.configSchema || {},
        inputs: def.inputs || [],
        outputs: def.outputs || [],
        color: def.color || "#6366f1",
        logoUrl: def.logoUrl || null,
        template: def.template || null,
        nodeSize: def.nodeSize || { width: 200, height: 100 },
        isService: def.isService || false,
        serviceConnectors: def.serviceConnectors || null,
        componentTemplate: def.componentTemplate || null,
        // Per-component render-URL map for the generic `Component` node (org-aware).
        // The Canvas resolves an instance's URL from config.component against this.
        componentUrls: def.componentUrls || null,
        credentials: def.credentials || [],
        testData: def.testData || null,
        // Author-declared capabilities (e.g. cacheable) must survive into the
        // registry so the engine's memoization gate can read them — without this
        // the field is lost at load and isCacheable() is always false.
        capabilities: def.capabilities || null,
        executor,
        executionMode,
      });

      boot.node(def.type);
    },
    registerService: () => {},
    registerCredential: (credentialType: any) => {
      registerCredentialType(credentialType);
    },
    registerComponentPath: () => {},
    createLogger: () => console,
    getConfig: () => ({}),
    saveTokenUsage: saveTokenUsageToWorkflow,
    saveMCPTrace: saveMCPTraceToWorkflow,
    getNodeCredentials: async (context: any, credentialName: string) => {
      const cred = context?.credentials?.[credentialName];
      if (!cred) {
        console.error(
          `[node-service] Credential ${credentialName} not found. Available: ${Object.keys(
            context?.credentials || {},
          ).join(", ")}`,
        );
      }
      return cred || null;
    },
    callService: async () => ({}),
    getRedisClient,
    gravityPublish: async () => {},
    getAudioWebSocketManager: () => getDistributedAudioManager(),
    getWebSocketManager: () => null,
    executeNodeWithRouting: async (
      executeNode: (inputs: any, config: any, context: any) => Promise<any>,
      params: any,
      config: any,
      context: any,
    ) => {
      // Run the node locally (package hybrid nodes run in node-service).
      const result = await executeNode(params, config, context);

      // Bridge to workflow-service so the xstate actor emits NODE_OUTPUT
      // and downstream nodes fire. Same contract as the in-process
      // executeNodeWithRouting in workflow-service.
      const executionId = context?.executionId;
      const nodeId = context?.nodeId;
      if (executionId && nodeId) {
        await emitNodeOutputToWorkflow({ executionId, nodeId, output: result });
      } else {
        console.warn(
          "[node-service] executeNodeWithRouting: missing executionId or nodeId — NODE_OUTPUT not emitted",
        );
      }

      return result;
    },
    classes: {
      PromiseNode,
      CallbackNode,
    },
    types: {
      NodeInputType,
      NodeConcurrency: {},
    },
  };
}
