/**
 * Node Registry - In-memory storage for loaded node definitions
 */

import type { NodeDefinition } from "./types.js";
import { boot } from "./boot.js";

// In-memory node registry (loaded from packages)
const nodeRegistry: Map<string, NodeDefinition> = new Map();

// In-memory credential type registry (loaded from packages)
const credentialRegistry: Map<string, any> = new Map();

// Track which plugins are loaded and their node types
const pluginNodeMap: Map<string, string[]> = new Map();

export function getNodeRegistry(): Map<string, NodeDefinition> {
  return nodeRegistry;
}

export function getPluginNodeMap(): Map<string, string[]> {
  return pluginNodeMap;
}

export function getNode(nodeType: string): NodeDefinition | undefined {
  return nodeRegistry.get(nodeType);
}

export function setNode(nodeType: string, definition: NodeDefinition): void {
  nodeRegistry.set(nodeType, definition);
}

export function deleteNode(nodeType: string): boolean {
  return nodeRegistry.delete(nodeType);
}

export function clearRegistry(): void {
  nodeRegistry.clear();
  pluginNodeMap.clear();
}

export function getNodeCount(): number {
  return nodeRegistry.size;
}

export function getPluginCount(): number {
  return pluginNodeMap.size;
}

export function getAllNodes(): NodeDefinition[] {
  return Array.from(nodeRegistry.values());
}

export function getAllNodeTypes(): string[] {
  return Array.from(nodeRegistry.keys());
}

// Credential registry functions
export function getCredentialRegistry(): Map<string, any> {
  return credentialRegistry;
}

export function registerCredentialType(credentialType: any): void {
  if (credentialRegistry.has(credentialType.name)) {
    // Shared on purpose (several AWS packages declare awsCredential), so first-wins is
    // the design and not an incident. Counted, not announced.
    boot.credential(credentialType.name, true);
    return;
  }
  credentialRegistry.set(credentialType.name, credentialType);
  boot.credential(credentialType.name);
}

export function getAllCredentialTypes(): any[] {
  return Array.from(credentialRegistry.values());
}

/**
 * Replace a credential type outright, for owners that can be RELOADED.
 *
 * registerCredentialType is deliberately first-wins-and-skip, which is right for code
 * plugins: they load once and a duplicate is a mistake. A declarative manifest is
 * different — it can be installed, updated and removed while the process runs, and a
 * package that adds a field to its credential must be able to land that change. With
 * only the skipping path, the old shape would win forever and the new field would
 * never appear in the UI or reach decryption.
 */
export function replaceCredentialType(credentialType: any): void {
  credentialRegistry.set(credentialType.name, credentialType);
}

/** Retract a credential type. Returns false if it was not registered. */
export function unregisterCredentialType(name: string): boolean {
  return credentialRegistry.delete(name);
}
