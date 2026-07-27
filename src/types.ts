/**
 * Type definitions for node-service
 */

export interface NodeDefinition {
  type: string;
  name: string;
  description: string;
  /** Spatial-discovery selection text embedded by the catalog ranker (CatalogService);
   *  falls back to `description` when absent. Registered per node in pluginAPI. */
  whenToUse?: string;
  category: string;
  version: string;
  configSchema: object;
  inputs: object[];
  outputs: object[];
  // Visual properties
  color: string;
  logoUrl: string | null;
  template: string | null;
  nodeSize: { width: number; height: number };
  // Service properties
  isService: boolean;
  serviceConnectors: object | null;
  // Component template for UI nodes
  componentTemplate: object | null;
  // Per-component render URLs for the generic `Component` node (org-aware); the Canvas
  // resolves an instance's URL from config.component. null for every other node.
  componentUrls?: Record<string, string> | null;
  // Credentials
  credentials: object[];
  // Test data
  testData: object | null;
  // Author-declared capabilities (e.g. cacheable) — passed through to Redis so
  // the workflow engine can read them (memoization gate, etc.).
  capabilities?: object | null;
  executor: any;
  executionMode: "single" | "generator"; // PromiseNode = single, CallbackNode = generator
}

export interface PluginMetadata {
  version: string;
  description: string;
  category?: string;
  displayName?: string;
  features?: string[];
  credentials?: { name: string; type: string; required: boolean; description: string }[];
}
