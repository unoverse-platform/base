/**
 * Manifest node loading.
 *
 * Reads declarative node manifests from a SOURCE, composes each folder into one
 * definition, and registers it through exactly the same path a code plugin uses. A
 * manifest node is therefore indistinguishable downstream: same registry, same
 * /nodes payload, same catalog ranking, same canvas.
 *
 * RELOADABLE BY DESIGN. `loadManifests` can be called again at any time and will
 * replace what it loaded before. That is the point of the format: installing or
 * updating a node should never restart a universe. When the source becomes Postgres,
 * an install is a row write followed by this call.
 *
 * See docs/architecture/DECLARATIVE_NODES.md.
 */
import {
  getNodeRegistry,
  getPluginNodeMap,
  getCredentialRegistry,
  replaceCredentialType,
  unregisterCredentialType,
  deleteNode,
} from "../registry.js";
import { composeNode, composeCredentials, packageVersion, packageMeta, ManifestError, type ComposedNode, type PackageMeta } from "./compose.js";
import { hashNode, assertUnchanged, IntegrityError } from "./integrity.js";
import { executorForKind, setManifestLookup } from "./executor/index.js";
import { diskSource, rowsSource, type ManifestSource, type RawPackage } from "./source.js";
import { fetchNodeRows } from "./rows.js";
import { isPluginEnabled } from "../plugins/state.js";
import { NODES_HOME, databaseOnly } from "../paths.js";
import { boot } from "../boot.js";

/** Marketplace name for a manifest package, so it shares one row with its code half. */
export const packageIdFor = (name: string) => `@unoverse-platform/${name}`;

/** Packages the current source offers, whether enabled or not. */
export async function listManifestPackages(source: ManifestSource = diskSource(NODES_HOME)): Promise<string[]> {
  return (await source.listPackages()).map((p) => packageIdFor(p.name));
}

export async function isManifestPackage(name: string, source?: ManifestSource): Promise<boolean> {
  return (await listManifestPackages(source)).includes(name);
}

/**
 * Display metadata per manifest package, keyed by marketplace name.
 *
 * A manifest package has no plugin-state row, so /plugins had nothing to show for it.
 * Populated on every load and read by routePlugins.
 */
const packageMetas = new Map<string, PackageMeta>();

export function getManifestPackageMeta(name: string): PackageMeta | undefined {
  return packageMetas.get(name);
}

/** Node types this loader owns, so a reload can retract exactly what it added. */
const loadedTypes = new Map<string, ComposedNode>();

/**
 * Credential types this loader owns.
 *
 * Tracked separately from the registry because retraction must be SURGICAL: a
 * credential registered by a code plugin is not ours to remove, and clearing the whole
 * registry on reload would take those with it. Only names in here are ever replaced or
 * deleted.
 */
const loadedCredentials = new Set<string>();

export function getLoadedManifestCredentials(): string[] {
  return [...loadedCredentials];
}

// The two shared executors resolve their manifest by node type through this, which is
// what keeps them at two classes rather than one per node, and lets a reload swap a
// node's behaviour without re-registering anything.
setManifestLookup((type) => loadedTypes.get(type));

export function getManifestNode(type: string): ComposedNode | undefined {
  return loadedTypes.get(type);
}

export function getLoadedManifestTypes(): string[] {
  return [...loadedTypes.keys()];
}

export interface LoadResult {
  nodes: number;
  credentials: number;
  errors: string[];
}

/**
 * Where each loaded manifest package came from. Derived, never stored.
 *
 * A stored row goes stale: a package that moved from npm to manifests on disk kept
 * rendering as installed, with a Remove button that would have disabled the manifest.
 * `postgres:` origin means installed and removable; anything else is a folder on disk.
 */
export function manifestPackageOrigins(): Map<string, { source: "local" | "npm"; version: string }> {
  const out = new Map<string, { source: "local" | "npm"; version: string }>();
  for (const node of loadedTypes.values())
    out.set(packageIdFor(node.packageName), {
      source: node.origin.startsWith("postgres:") ? "npm" : "local",
      version: node.packageVersion ?? "1.0.0",
    });
  return out;
}

/**
 * Load (or reload) every manifest node from `source`.
 *
 * A broken node is skipped with a named error and never takes the others down: one
 * bad YAML file must not cost a universe its whole catalog.
 */
export async function loadManifests(source?: ManifestSource): Promise<LoadResult> {
  const registry = getNodeRegistry();
  const pluginNodeMap = getPluginNodeMap();
  const result: LoadResult = { nodes: 0, credentials: 0, errors: [] };

  // TWO sources, in precedence order, FIRST ONE WINS. An explicit source (tests, a
  // one-off load) wins outright; otherwise DISK beats rows, because a manifest present
  // in the monorepo is being authored right now and must beat whatever was installed.
  // Same local-wins first-principle the node loader already applies to npm copies.
  // Under UNOVERSE_DATABASE_ONLY the disk half is dropped, so a developer sees the node
  // set a deployed universe would have: whatever is installed, and nothing else.
  const sources: ManifestSource[] = source
    ? [source]
    : databaseOnly()
      ? [rowsSource(fetchNodeRows)]
      : [diskSource(NODES_HOME), rowsSource(fetchNodeRows)];

  const packages: RawPackage[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    let batch: RawPackage[];
    try {
      batch = await s.listPackages();
    } catch (err: any) {
      result.errors.push(`source "${s.name}" failed: ${err?.message ?? err}`);
      continue;
    }
    for (const pkg of batch) {
      // Merge by node type rather than by package: a MIXED package can have some nodes
      // on disk and others only installed, and dropping the whole package because its
      // name was seen would lose the ones that are only in the database.
      const nodes = pkg.nodes.filter((n) => !seen.has(n.dir));
      for (const n of nodes) seen.add(n.dir);
      const existing = packages.find((p) => p.name === pkg.name);
      if (existing) existing.nodes.push(...nodes);
      else if (nodes.length || Object.keys(pkg.credentials).length) packages.push({ ...pkg, nodes });
    }
  }
  if (!packages.length) return result;

  // Retract what a previous load added, so a reload cannot leave a deleted node or
  // credential behind. Anything no longer present simply disappears.
  const previous = new Set(loadedTypes.keys());
  const previousCredentials = new Set(loadedCredentials);
  loadedTypes.clear();
  loadedCredentials.clear();

  const credentialRegistry = getCredentialRegistry();
  const disabledPackages: string[] = [];

  packageMetas.clear();
  for (const pkg of packages) {
    packageMetas.set(packageIdFor(pkg.name), packageMeta(pkg));
    // Disabled in the marketplace means GONE, not hidden: its nodes and credential
    // types are retracted below exactly as if the package had been removed from the
    // source. That is what makes uninstall work without a restart.
    if (!isPluginEnabled(packageIdFor(pkg.name))) {
      disabledPackages.push(pkg.name);
      continue;
    }

    try {
      for (const cred of composeCredentials(pkg)) {
        // A credential a CODE plugin registered is not ours to overwrite: local source
        // wins over a manifest, the same rule as for nodes.
        if (credentialRegistry.has(cred.name) && !previousCredentials.has(cred.name)) {
          result.errors.push(`${pkg.name}/credentials/${cred.name}: already registered by code — manifest skipped`);
          continue;
        }
        // REPLACE, not register: a package that adds a field to its credential must be
        // able to land that change without a restart, and the first-wins path would
        // keep the old shape forever.
        replaceCredentialType(cred);
        loadedCredentials.add(cred.name);
        result.credentials++;
      }
    } catch (err: any) {
      result.errors.push(err instanceof ManifestError ? err.message : `${pkg.name}/credentials: ${err?.message ?? err}`);
    }

    const types: string[] = [];
    for (const raw of pkg.nodes) {
      try {
        const node = composeNode(raw, pkg);
        node.hash = hashNode(node);
        node.packageVersion = packageVersion(pkg);

        // TAMPER CHECK, before the node reaches the registry. A source that recorded a
        // hash at publish gets it verified now; disk records none and is governed by git
        // instead. Failing here rather than at first execution is deliberate: a node that
        // does not match what was approved must never become callable, not even once.
        assertUnchanged(node, raw.hash, `${pkg.name}/${raw.dir}`);

        // A code node of the same type already loaded. Never override it: local
        // source wins over a manifest exactly as it wins over an npm copy, so a
        // half-migrated package cannot silently swap a working executor for one that
        // refuses to run.
        if (registry.has(node.type) && !previous.has(node.type)) {
          result.errors.push(`${pkg.name}/${raw.dir}: type "${node.type}" is already registered by code — manifest skipped`);
          continue;
        }

        registry.set(node.type, {
          ...(node.definition as any),
          // ONE of two shared classes, never a class per node.
          executor: executorForKind(node.kind),
          executionMode: node.kind === "CallbackNode" ? "generator" : "single",
        });
        loadedTypes.set(node.type, node);
        types.push(node.type);
        result.nodes++;
      } catch (err: any) {
        // An integrity failure is not the same class of problem as a malformed manifest,
        // so it says so and is never folded into the quiet "skipped" count below.
        if (err instanceof IntegrityError) console.error(`[unoverse:manifests] TAMPER: ${err.message}`);
        result.errors.push(
          err instanceof ManifestError || err instanceof IntegrityError
            ? err.message
            : `${pkg.name}/${raw.dir}: ${err?.message ?? err}`,
        );
      }
    }

    if (types.length) {
      // Merge rather than replace: a MIXED package has code nodes here already, and
      // dropping them would lose the package→types provenance /plugins reads.
      const existing = pluginNodeMap.get(`@unoverse-platform/${pkg.name}`) ?? [];
      pluginNodeMap.set(`@unoverse-platform/${pkg.name}`, [...new Set([...existing, ...types])]);

    }
  }

  // Anything this loader owned last time and no longer produces is gone. Surgical on
  // purpose: only names this loader registered are ever retracted, so uninstalling a
  // manifest package cannot take a code plugin's node or credential with it.
  for (const stale of previous) if (!loadedTypes.has(stale)) deleteNode(stale);
  for (const stale of previousCredentials)
    if (!loadedCredentials.has(stale) && unregisterCredentialType(stale))
      console.log(`[unoverse:manifests] retracted credential type ${stale}`);  // a real change of state

  // At boot this is one row in the readout. A LATER reload (the watcher, an install,
  // an uninstall) is an event on an otherwise quiet screen, so it still speaks.
  if (boot.isBooting()) {
    boot.manifests({
      nodes: result.nodes,
      credentials: result.credentials,
      // "already registered by code" is the local-wins rule working, not a fault, so it
      // is reported as a shadow with its type named rather than as an error.
      shadowed: result.errors.flatMap((e) => {
        const m = /type "([^"]+)" is already registered by code/.exec(e);
        return m ? [m[1]] : [];
      }),
      disabled: disabledPackages,
    });
    for (const e of result.errors)
      if (!/already registered by code/.test(e)) boot.notice("warn", `manifest skipped: ${e}`);
  } else {
    console.log(
      `[unoverse:manifests] ${result.nodes} node(s), ${result.credentials} credential type(s) from ${sources.map((s) => s.name).join(" + ")}` +
        (result.errors.length ? `, ${result.errors.length} skipped` : ""),
    );
    for (const e of result.errors) console.warn(`  ! ${e}`);
  }
  return result;
}
