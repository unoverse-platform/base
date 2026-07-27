/**
 * Plugin State — in-memory cache sourced from PostgreSQL
 */

import { persistPluginState, removePluginState, fetchPluginState } from "../platform/serviceCalls.js";
import { boot } from "../boot.js";

export type PluginStateEntry = {
  enabled: boolean;
  version: string;
  source: string;
  metadata?: any;
};

let PLUGIN_STATE: Map<string, PluginStateEntry> = new Map();

export function getPluginState(name: string): PluginStateEntry | undefined {
  return PLUGIN_STATE.get(name);
}

export function setPluginState(name: string, state: PluginStateEntry): void {
  PLUGIN_STATE.set(name, state);
}

export function isPluginEnabled(name: string): boolean {
  const state = PLUGIN_STATE.get(name);
  if (!state) return true;
  return state.enabled;
}

export async function loadStateFromPostgres(): Promise<void> {
  const pgState = await fetchPluginState();
  PLUGIN_STATE.clear();
  if (pgState.length > 0) {
    boot.pluginStates(pgState.length);
    for (const plugin of pgState) {
      PLUGIN_STATE.set(plugin.name, {
        enabled: plugin.enabled,
        version: plugin.version,
        source: plugin.source,
        metadata: plugin.metadata,
      });
    }
  }
}

export function getNpmPluginsFromState(): string[] {
  const names: string[] = [];
  for (const [name, state] of PLUGIN_STATE) {
    if (state.source === "npm") names.push(name);
  }
  return names;
}

/** All state entries (the in-memory mirror of installed_plugins). Used by the
 *  registry-toggle routes to read enable/spatial state for skills/templates/nodes. */
export function listPluginState(): Array<{ name: string } & PluginStateEntry> {
  return [...PLUGIN_STATE.entries()].map(([name, state]) => ({ name, ...state }));
}

export { persistPluginState, removePluginState };
