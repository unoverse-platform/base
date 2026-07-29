/**
 * Plugin Base Types and Classes
 *
 * These are copied from @unoverse-platform/plugin-base to remove the
 * compile-time dependency. This allows node-service to start without
 * packages/ being mounted.
 *
 * SINCE 2026-07-29 THIS IS THE ONLY IN-REPO COPY: the plugin-base source retired to
 * _legacy/plugin-base once the last code node (postgres-toolkit) did, and everything
 * in-repo that still speaks the plugin protocol — packages/marketplace, the server's
 * component runtime — imports from here. The PUBLISHED @unoverse-platform/plugin-base
 * stays on npm, frozen, for externally installed plugins; the loader still names it by
 * that string.
 *
 * A FAITHFUL transcription, including its loosest part: plugin-base's own index exported
 * `export type EnhancedNodeDefinition = any` (and friends) as LOCAL declarations, which
 * SHADOW its `export * from "./types"` star export — so every consumer's "typed" imports
 * were `any` all along. The aliases below reproduce that, rather than pretending the old
 * package gave marketplace type-safety it never had.
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

/** The loose compile-time aliases plugin-base actually exported (see the header). */
export type EnhancedNodeDefinition = any;
export type ValidationResult = any;
export type NodeExecutionContext = any;

/** Plugin interface that packages implement. Transcribed from plugin-base index.ts. */
export interface GravityPlugin {
  name: string;
  version?: string;
  description?: string;
  setup(api: GravityPluginAPI): void | Promise<void>;
}

/** The API the platform hands a plugin's setup(). Transcribed from plugin-base index.ts. */
export interface GravityPluginAPI {
  registerNode(node: PluginNodeDefinition): void;
  registerService(name: string, service: any): void;
  registerCredential(credential: any): void;
  registerComponentPath?(packagePath: string): void;
  createLogger(name: string): any;
  getConfig(): any;
  saveTokenUsage(usage: any): Promise<void>;
  saveMCPTrace(trace: any): Promise<string>;
  getNodeCredentials(context: any, credentialName: string): Promise<any>;
  callService(method: string, params: any, context: any): Promise<any>;
  getRedisClient(): any;
  gravityPublish(channel: string, message: any): Promise<void>;
  getAudioWebSocketManager?: () => any;
  getWebSocketManager?: () => any;
  publishStreamingUpdate?: (config: { componentType: string; props: Record<string, any> }) => void;
  executeNodeWithRouting?: (
    executeNode: (inputs: any, config: any, context: any) => Promise<any>,
    params: any,
    config: any,
    context: any,
  ) => Promise<any>;
  classes: { PromiseNode: any; CallbackNode: any };
  types: { NodeInputType: any; NodeConcurrency: any };
}

export interface PluginNodeDefinition {
  definition: any;
  executor: any;
}

/** Helper to create a plugin — the identity function plugin-base always was. */
export function createPlugin(config: {
  name: string;
  version?: string;
  description?: string;
  setup: (api: GravityPluginAPI) => void | Promise<void>;
}): GravityPlugin {
  return config;
}

/**
 * Initialize platform dependencies from the plugin API — transcribed from plugin-base
 * index.ts, the same field mapping, so a plugin moving its import here behaves
 * identically at setup time.
 */
export function initializePlatformFromAPI(api: GravityPluginAPI) {
  setPlatformDependencies({
    PromiseNode: api.classes.PromiseNode,
    CallbackNode: api.classes.CallbackNode,
    NodeInputType: api.types.NodeInputType,
    NodeConcurrency: api.types.NodeConcurrency,
    getNodeCredentials: api.getNodeCredentials,
    getConfig: api.getConfig,
    createLogger: api.createLogger,
    saveTokenUsage: api.saveTokenUsage,
    saveMCPTrace: api.saveMCPTrace,
    callService: api.callService,
    getRedisClient: api.getRedisClient,
    gravityPublish: api.gravityPublish,
    executeNodeWithRouting: api.executeNodeWithRouting,
    getAudioWebSocketManager: api.getAudioWebSocketManager,
  } as PlatformDependencies);
}

// The prop-key reader marketplace's synthesizer uses — base's own copy, re-exported so a
// plugin needs ONE import root here rather than knowing base's internal layout.
export { inputPropKeys, type InputPropLike } from "./definitions/inputs.js";

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
