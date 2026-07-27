/**
 * Plugin Base Types and Classes
 * 
 * These are copied from @unoverse-platform/plugin-base to remove the
 * compile-time dependency. This allows node-service to start without
 * packages/ being mounted.
 * 
 * Customer plugins still import from @unoverse-platform/plugin-base,
 * which is loaded at runtime from the mounted packages/ directory.
 */

/**
 * Platform dependencies for internal use
 */
export interface PlatformDependencies {
  PromiseNode: any;
  CallbackNode: any;
  NodeInputType: any;
  NodeConcurrency: any;
  getNodeCredentials: (context: any, credentialName: string) => Promise<any>;
  getConfig: () => any;
  createLogger: (name: string) => any;
  saveTokenUsage: (usage: any) => Promise<void>;
  callService: (method: string, params: any, context: any) => Promise<any>;
  getRedisClient: () => any;
  gravityPublish: (channel: string, message: any) => Promise<void>;
  executeNodeWithRouting?: (
    executeNode: (inputs: any, config: any, context: any) => Promise<any>,
    params: any,
    config: any,
    context: any
  ) => Promise<any>;
  getAudioWebSocketManager?: () => any;
  [key: string]: any;
}

/**
 * Base class for Promise-based nodes
 */
export class PromiseNode {
  nodeType: string;
  logger: any = { info: () => {}, error: () => {}, debug: () => {} };

  constructor(name: string) {
    this.nodeType = name || "stub";
  }

  protected async validateConfig(config: any): Promise<any> {
    return { success: true };
  }

  protected async executeNode(inputs: any, config: any, context: any): Promise<any> {
    return {};
  }

  protected validateAndGetContext(context: any) {
    return {
      workflowId: context?.workflowId || context?.workflow?.id || "",
      executionId: context?.executionId || context?.workflow?.runId || "",
      nodeId: context?.nodeId || "",
    };
  }

  protected getExecutionContext(context: any) {
    return {
      workflowId: context?.workflowId || context?.workflow?.id || "",
      executionId: context?.executionId || context?.workflow?.runId || "",
      nodeId: context?.nodeId || "",
      nodeType: context?.nodeType || this.nodeType || "",
      config: context?.config || {},
      credentials: context?.credentials || {},
    };
  }

  async execute(inputs: any, config: any, context: any): Promise<any> {
    return this.executeNode(inputs, config, context);
  }
}

/**
 * Base class for Callback-based nodes
 */
export class CallbackNode {
  constructor(name: string) {}
}

/**
 * Node input type enum
 */
export const NodeInputType = {
  STRING: "string",
  OBJECT: "object",
  ARRAY: "array",
  NUMBER: "number",
  BOOLEAN: "boolean",
};

// Global platform instance
let platformDeps: PlatformDependencies | null = null;

/**
 * Set platform dependencies (called by plugin setup)
 */
export function setPlatformDependencies(deps: PlatformDependencies) {
  if (platformDeps !== null) {
    return;
  }
  platformDeps = deps;
}

/**
 * Get platform dependencies
 */
export function getPlatformDependencies(): PlatformDependencies {
  if (!platformDeps) {
    return {
      packageVersion: "1.1.1",
      PromiseNode,
      CallbackNode,
      NodeInputType,
      NodeConcurrency: {},
      getConfig: () => ({}),
      createLogger: () => ({ info: () => {}, error: () => {}, debug: () => {}, warn: () => {} }),
      saveTokenUsage: () => Promise.resolve(),
      saveMCPTrace: () => Promise.resolve(),
      callService: () => Promise.resolve(null),
      getRedisClient: () => null,
      gravityPublish: async () => {},
      executeNodeWithRouting: async () => ({}),
      getAudioWebSocketManager: () => null,
      getNodeCredentials: async (context: any, credentialName: string) => {
        if (platformDeps?.getNodeCredentials) {
          return platformDeps.getNodeCredentials(context, credentialName);
        }
        return context?.credentials?.[credentialName] || {};
      },
    } as any;
  }
  return platformDeps;
}
