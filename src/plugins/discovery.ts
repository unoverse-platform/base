/**
 * Plugin Discovery — finds plugins from /packages folder
 */

import * as fs from "fs";
import * as path from "path";
import type { PluginMetadata } from "../types.js";
import { PACKAGES_PATH, PLUGINS_DIR, NODES_HOME } from "../paths.js";

let ALL_PLUGINS: string[] = [];

export function getAllPlugins(): string[] {
  return ALL_PLUGINS;
}

export function setAllPlugins(plugins: string[]): void {
  ALL_PLUGINS = plugins;
}

/** Scan a directory for plugin packages (a package.json whose name is in `scopes` and has an entry). */
function scanPluginDir(dir: string, scopes: string[]): string[] {
  const plugins: string[] = [];
  if (!fs.existsSync(dir)) return plugins;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = path.join(dir, entry.name, "package.json");
    if (!fs.existsSync(pkgJsonPath)) continue;
    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
      const pkgName = pkgJson.name;
      if (!pkgName || pkgName.includes("/docs")) continue;
      if (scopes.some((s) => pkgName.startsWith(s)) && (pkgJson.main || pkgJson.exports)) {
        plugins.push(pkgName);
      }
    } catch {
      // Skip invalid package.json files
    }
  }
  return plugins;
}

/** Nodes that have been moved INTO Unoverse (apps/unoverse/nodes). */
export function discoverNodesHome(): string[] {
  return scanPluginDir(NODES_HOME, ["@unoverse-platform/"]);
}

/**
 * LEGACY starter-kit packages. The fallback from before nodes moved to `nodes/`.
 *
 * Absent is the NORMAL state now, so its absence is not worth a line at boot. It used to
 * warn, which was right when the folder was expected and missing meant something was wrong.
 */
export function discoverPlugins(): string[] {
  return scanPluginDir(PACKAGES_PATH, ["@unoverse-platform/"]);
}

export async function getPluginMetadata(pluginName: string): Promise<PluginMetadata> {
  try {
    const packagesPath = PACKAGES_PATH;
    const shortName = pluginName.replace("@unoverse-platform/", "");
    const pkgJsonPath = path.join(packagesPath, shortName, "package.json");

    const pluginsDir = PLUGINS_DIR;
    const npmPkgJsonPath = path.join(pluginsDir, "node_modules", pluginName, "package.json");

    let pkg: any;
    if (fs.existsSync(pkgJsonPath)) {
      pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    } else if (fs.existsSync(npmPkgJsonPath)) {
      pkg = JSON.parse(fs.readFileSync(npmPkgJsonPath, "utf-8"));
    } else {
      pkg = await import(`${pluginName}/package.json`);
    }

    const gravity = pkg.gravity || {};
    return {
      version: pkg.version || "1.0.0",
      description: pkg.description || "",
      category: gravity.category || undefined,
      displayName: gravity.displayName || undefined,
      features: gravity.features || undefined,
      credentials: gravity.credentials || undefined,
    };
  } catch {
    return { version: "1.0.0", description: "" };
  }
}
