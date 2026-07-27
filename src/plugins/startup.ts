/**
 * Plugin Startup — load npm-installed marketplace packages at boot.
 *
 * Redis-free, Postgres-backed: the set of installed packages is the source of truth
 * in Postgres (state.ts → workflow /plugins/state). Home nodes (apps/unoverse/nodes)
 * load separately via loadNodesIntoMemory; this layers the marketplace-installed
 * packages on top, installing any that are missing from disk (self-healing the
 * plugins volume on a fresh VM — Postgres says "what should be installed").
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { getNodeRegistry, getPluginNodeMap } from "../registry.js";
import { createNodeServiceAPI } from "../platform/index.js";
import { loadStateFromPostgres, isPluginEnabled, getNpmPluginsFromState, getPluginState, setPluginState, persistPluginState } from "./state.js";
import { getPluginsDir, ensurePluginsDir, clearModuleCache, importPluginModule } from "./loader.js";
import { isAllowedPackage } from "./install.js";
import { warnMissingNodeMeta } from "./redis.js";
import { MARKETPLACE_PATH, NODES_HOME } from "../paths.js";
import { boot } from "../boot.js";

/**
 * CORE PACKAGES — standard equipment, installed by default on every platform.
 * @unoverse-platform/marketplace is the definition-backed bridge that turns rx/
 * component definitions into the ONE canvas Component node; without it no marketplace
 * component exists as a node. It is platform IP and no longer ships as starter source: a
 * fresh platform seeds its row here and the normal self-heal installs it from npm.
 * A home copy (apps/unoverse/nodes/<pkg> — monorepo dev) wins: loadNodesIntoMemory
 * already loaded it, so seeding is skipped to avoid loading the same nodes twice.
 */
const CORE_PACKAGES = ["@unoverse-platform/marketplace"];

async function seedCorePackages(): Promise<void> {
  for (const core of CORE_PACKAGES) {
    const short = core.replace(/@[^/]+\//, "");
    if (fs.existsSync(path.join(NODES_HOME, short))) continue; // home copy wins (dev)
    if (getPluginState(core)) continue; // a row exists — Postgres stays authoritative
    boot.notice("warn", `seeded the core package row for ${core}, which had none`);
    const entry = { enabled: true, version: "latest", source: "npm" as const };
    setPluginState(core, entry);
    try {
      await persistPluginState({ name: core, ...entry });
    } catch (err: any) {
      boot.notice("warn", `could not persist the core package row for ${core}: ${err.message}`);
    }
  }
}

export async function loadInstalledNpmPlugins(): Promise<void> {
  // Postgres is the source of truth for what's installed.
  await loadStateFromPostgres();
  await seedCorePackages();
  const npmPlugins = getNpmPluginsFromState();
  if (npmPlugins.length === 0) return;

  // Counted into the boot report; per-package lines only at LOG_LEVEL=debug.
  const api = createNodeServiceAPI();
  const nodeRegistry = getNodeRegistry();
  const pluginNodeMap = getPluginNodeMap();
  const PLUGINS_DIR = getPluginsDir();

  // Self-heal the shared plugin-base ONCE, up front — UNCONDITIONALLY. The plugin-base
  // upgrade lives inside ensurePluginsDir(), but the only other call was buried in the
  // per-node install branch below, so it ran only when some node needed (re)installing.
  // When every node is already on disk at its state version (the common steady-state
  // deploy), that branch is skipped for all of them and plugin-base never gets upgraded —
  // leaving a volume seeded with an old copy that lacks the API the current nodes call
  // (the ingestConversationTurn "is not a function" prod outage). Running it here means
  // every boot reconciles plugin-base to REQUIRED_PLUGIN_BASE regardless of node state.
  ensurePluginsDir();

  for (const pluginName of npmPlugins) {
    if (!isPluginEnabled(pluginName)) {
      boot.pluginDisabled(pluginName);
      continue;
    }

    // We only install from the @unoverse-platform npm scope (same allowlist as the
    // install endpoint). Any other-scoped row is skipped — never self-heal-installed —
    // so a stale/foreign row can't spam boot with doomed npm installs.
    if (!isAllowedPackage(pluginName)) {
      boot.notice("warn", `${pluginName} is outside @unoverse-platform, so it was not loaded`);
      continue;
    }

    const shortName = pluginName.replace(/@[^/]+\//, "");

    // LOCAL WINS: a package present in the home nodes dir (apps/unoverse/nodes) was already
    // loaded from local source by loadNodesIntoMemory. NEVER let the npm-installed copy
    // override it — the rule is local-first, npm is only the fallback for packages with NO
    // local source. (Bug fixed 2026-07-25: the npm copy silently overrode a newer local
    // build — a renamed connector kept showing its old name because the stale installed
    // copy won.) The installed npm version is surfaced so it can be flagged for update.
    if (fs.existsSync(path.join(NODES_HOME, shortName))) {
      const installed = getPluginState(pluginName)?.version;
      boot.pluginLocalWin(pluginName, installed);
      continue;
    }

    // Prefer local packages-marketplace source over npm (dev).
    const localPath = path.join(MARKETPLACE_PATH, shortName);
    let pluginPath: string;

    if (fs.existsSync(localPath)) {
      pluginPath = localPath;
      boot.pluginFromNpm(pluginName, "local marketplace path");
    } else {
      pluginPath = path.join(PLUGINS_DIR, "node_modules", pluginName);
      // Self-heal to the STATE's version — KEEP-LATEST convergence: the shared
      // installed_plugins row is "the newest version anyone chose" (writes are
      // monotonic, see install.ts); every environment converges UP to it at boot.
      // Covers both missing-from-disk AND disk-older-than-state (the July 2026
      // outage: a published upgrade was recorded but the disk copy never moved,
      // so deployed source built against a stale plugin surface).
      const stateVersion = getPluginState(pluginName)?.version || "latest";
      const diskVersion = (() => {
        try {
          return JSON.parse(fs.readFileSync(path.join(pluginPath, "package.json"), "utf-8")).version as string;
        } catch {
          return null;
        }
      })();
      const isOlder = (a: string, b: string): boolean => {
        // a < b, numeric semver compare; non-semver states ("latest") never force it.
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        if (pa.some(isNaN) || pb.some(isNaN)) return false;
        for (let i = 0; i < 3; i++) {
          if ((pa[i] ?? 0) < (pb[i] ?? 0)) return true;
          if ((pa[i] ?? 0) > (pb[i] ?? 0)) return false;
        }
        return false;
      };
      if (!diskVersion || (stateVersion !== "latest" && isOlder(diskVersion, stateVersion))) {
        // An install at boot is NOT routine: it means the disk copy was missing or
        // behind the version Postgres records, which is exactly the drift that caused
        // the July 2026 outage. It stays in the readout even though it succeeded.
        const why = diskVersion ? `disk had ${diskVersion}` : "it was missing from disk";
        try {
          ensurePluginsDir();
          const spec = stateVersion !== "latest" ? `${pluginName}@${stateVersion}` : pluginName;
          execSync(`npm install ${spec}`, { cwd: PLUGINS_DIR, stdio: "pipe" });
          boot.notice("warn", `${pluginName} installed at ${stateVersion} because ${why}`);
        } catch (installErr: any) {
          boot.notice("error", `${pluginName} failed to install: ${installErr.message}`);
          if (!diskVersion) continue; // nothing usable on disk — skip; an older disk copy still loads below
        }
      }
      boot.pluginFromNpm(pluginName);
    }

    clearModuleCache(pluginPath);
    const nodesBefore = new Set(nodeRegistry.keys());

    try {
      const pkg = await importPluginModule(pluginPath);
      const plugin = pkg.default || pkg;
      const nodeTypes: string[] = [];
      if (plugin && typeof plugin.setup === "function") {
        await plugin.setup(api);
        for (const [type] of nodeRegistry) {
          if (!nodesBefore.has(type)) nodeTypes.push(type);
        }
      }
      // A home copy (apps/unoverse/nodes) loaded this package's types FIRST and
      // recorded them under the same name — this npm pass then sees every type as
      // pre-existing (empty diff). Overwriting would erase the package→types
      // provenance (packageOfType → null: no `package` on /nodes, nodeCount 0 on
      // /plugins). Keep the richer entry.
      const existing = pluginNodeMap.get(pluginName);
      if (nodeTypes.length || !existing?.length) pluginNodeMap.set(pluginName, nodeTypes);
    } catch (error: any) {
      boot.notice("error", `${pluginName} failed to load: ${error.message}`);
    }
  }

  warnMissingNodeMeta([...nodeRegistry.values()], "marketplace-startup");
}
