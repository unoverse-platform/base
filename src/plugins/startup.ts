/**
 * Marketplace Startup — load the ONE library the boot needs: the component bridge.
 *
 * THIS FILE USED TO BE THE NPM-PLUGIN PLANE: read installed_plugins from Postgres, seed
 * a core-package row, allowlist-check every entry, keep-latest converge versions, npm
 * install into the plugins volume, then setup() each package. All of it existed to load
 * CODE node packages — and there are none. Every node is a manifest (2026-07-29), and
 * marketplace ITEMS (nodes, components, skills, blocks, recipes) install per item as DB
 * rows and load dynamically; nothing about them is an npm install at boot.
 *
 * What genuinely remains is @unoverse-platform/marketplace itself — the bridge that
 * turns rx/ component definitions into the ONE canvas Component node. It is a LIBRARY,
 * an ordinary dependency of the unoverse app, resolved by Node like any other: the
 * workspace in dev, the image's node_modules in prod. It keeps the plugin setup(api)
 * protocol only because that is how it hands the platform its executor wiring.
 *
 * The function keeps its old name because the reload/reconcile routes call it for
 * "pick up what changed" — the act survives even though the npm machinery did not.
 */

import * as path from "path";
import { getNodeRegistry, getPluginNodeMap } from "../registry.js";
import { createNodeServiceAPI } from "../platform/index.js";
import { clearModuleCache, importPluginModule } from "./loader.js";
import { warnMissingNodeMeta } from "./redis.js";
import { boot } from "../boot.js";

const MARKETPLACE = "@unoverse-platform/marketplace";

export async function loadInstalledNpmPlugins(): Promise<void> {
  const nodeRegistry = getNodeRegistry();
  const pluginNodeMap = getPluginNodeMap();

  let dir: string;
  try {
    const { createRequire } = await import("node:module");
    dir = path.dirname(createRequire(import.meta.url).resolve(`${MARKETPLACE}/package.json`));
  } catch {
    // No resolution means the dependency is missing from the install — a build problem,
    // not a state problem, and npm-installing at runtime would only paper over it.
    boot.notice("error", `${MARKETPLACE} is not resolvable — the Component bridge did not load, no marketplace component exists as a node`);
    return;
  }

  clearModuleCache(dir);
  const nodesBefore = new Set(nodeRegistry.keys());
  try {
    const pkg = await importPluginModule(dir);
    const plugin = pkg.default || pkg;
    if (plugin && typeof plugin.setup === "function") await plugin.setup(createNodeServiceAPI());
    const nodeTypes = [...nodeRegistry.keys()].filter((t) => !nodesBefore.has(t));
    // A reload sees every type as pre-existing (empty diff) — keep the richer entry
    // rather than erasing the package→types provenance.
    const existing = pluginNodeMap.get(MARKETPLACE);
    if (nodeTypes.length || !existing?.length) pluginNodeMap.set(MARKETPLACE, nodeTypes);
    boot.pluginFromNpm(MARKETPLACE, "direct dependency");
  } catch (error: any) {
    boot.notice("error", `${MARKETPLACE} failed to load: ${error.message}`);
  }

  warnMissingNodeMeta([...nodeRegistry.values()], "marketplace-startup");
}
