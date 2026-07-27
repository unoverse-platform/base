/**
 * Where node manifests come from.
 *
 * A SOURCE is deliberately an interface with one method, because the manifest
 * format only pays off if a node can be installed and updated without restarting a
 * universe. Disk is the source today; Postgres is the one that matters, and it must
 * be able to arrive without touching anything downstream of here.
 *
 * Everything past this file works on the composed definition and never learns where
 * it came from.
 *
 * See docs/architecture/DECLARATIVE_NODES.md.
 */
import * as fs from "fs";
import * as path from "path";

/** One node folder's raw files, before composition. */
export interface RawNode {
  /** Folder name. Should equal the node's `type`. */
  dir: string;
  /** Absolute path, or a synthetic id for non-disk sources. Used for $ref bases and errors. */
  origin: string;
  /**
   * The node's yaml, flat. A section split across a folder appears with its path
   * kept: "api/run.yaml". One level only, since a section has keys, not a tree.
   */
  files: Record<string, string>;
  /**
   * The content hash recorded when this node was PUBLISHED, if the source has one.
   *
   * Absent for disk, and that is correct rather than a gap: manifests in the monorepo are
   * governed by git, which beats a hash file living beside the thing it protects. The
   * check exists for rows, where there is no commit history and no review (SECURITY.md
   * §"Manifest integrity").
   */
  hash?: string;
}

export interface RawPackage {
  /** Package id, e.g. "openai". */
  name: string;
  origin: string;
  /** package.yaml, if present. */
  packageFile?: string;
  /** credentials/<name>.yaml → contents. */
  credentials: Record<string, string>;
  /** shared/<name>.yaml → contents, for $ref resolution. */
  shared: Record<string, string>;
  nodes: RawNode[];
}

export interface ManifestSource {
  /** For logs: "disk", "postgres". */
  readonly name: string;
  listPackages(): Promise<RawPackage[]>;
}

const YAML_RE = /\.ya?ml$/;
const read = (p: string) => fs.readFileSync(p, "utf-8");

/**
 * Manifests from the `items` table: the source that makes installing a node an EFFECT
 * rather than a record.
 *
 * A row stores the raw manifest exactly as authored (its files, plus the package
 * envelope its $refs resolve against), so composition downstream is bit-for-bit the
 * same work it does for disk. That is the point: one composition path means a node
 * installed from a row and the same node read from a folder cannot diverge.
 *
 * Rows arrive grouped by package, because a package's credentials and shared fragments
 * are shared by its nodes and composing one without them would fail on a $ref.
 */
export interface ItemRow {
  name: string;
  /**
   * The hash recorded at publish. A COLUMN, not a key inside `definition`: the whole job
   * of this value is to be compared against a hash computed from `definition`, so it must
   * not be part of what is hashed.
   */
  hash?: string | null;
  definition: {
    package?: { name?: string; packageFile?: string | null; credentials?: Record<string, string>; shared?: Record<string, string> };
    dir?: string;
    files?: Record<string, string>;
  };
}

export function rowsSource(fetchRows: () => Promise<ItemRow[]>): ManifestSource {
  return {
    name: "postgres",
    async listPackages(): Promise<RawPackage[]> {
      const rows = await fetchRows();
      const byPackage = new Map<string, RawPackage>();

      for (const row of rows) {
        const d = row.definition;
        if (!d?.files?.["node.yaml"]) continue; // not a manifest node row
        const pkgName = d.package?.name ?? "unknown";

        let pkg = byPackage.get(pkgName);
        if (!pkg) {
          pkg = {
            name: pkgName,
            origin: `postgres:${pkgName}`,
            packageFile: d.package?.packageFile ?? undefined,
            credentials: d.package?.credentials ?? {},
            shared: d.package?.shared ?? {},
          nodes: [],
          };
          byPackage.set(pkgName, pkg);
        }

        pkg.nodes.push({
          dir: d.dir ?? row.name,
          origin: `postgres:${pkgName}/${row.name}`,
          files: d.files,
          hash: row.hash ?? undefined,
        });
      }

      return [...byPackage.values()];
    },
  };
}

/**
 * Manifests on disk: <home>/<package>/nodes/<Node>/*.yaml
 *
 * A package with no `nodes/` folder is skipped entirely, so a pure-code package
 * costs nothing here. A MIXED package (some manifest nodes, some code) is normal
 * during migration and loads through both paths.
 */
export function diskSource(home: string): ManifestSource {
  return {
    name: "disk",
    async listPackages(): Promise<RawPackage[]> {
      if (!fs.existsSync(home)) return [];
      const packages: RawPackage[] = [];

      for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
        const pkgDir = path.join(home, entry.name);
        const nodesDir = path.join(pkgDir, "nodes");
        // A package earns a look if it has manifest nodes OR credential manifests.
        // Credentials are declared per package and are NOT conditional on any node
        // being migrated: skipping on `nodes/` alone would drop a package's
        // credential types the moment its last manifest node was removed.
        if (!fs.existsSync(nodesDir) && !fs.existsSync(path.join(pkgDir, "credentials"))) continue;

        const pkg: RawPackage = {
          name: entry.name,
          origin: pkgDir,
          packageFile: fs.existsSync(path.join(pkgDir, "package.yaml")) ? read(path.join(pkgDir, "package.yaml")) : undefined,
          credentials: {},
          shared: {},
          nodes: [],
        };

        for (const [folder, into] of [["credentials", pkg.credentials], ["shared", pkg.shared]] as const) {
          const dir = path.join(pkgDir, folder);
          if (!fs.existsSync(dir)) continue;
          for (const f of fs.readdirSync(dir).filter((f) => YAML_RE.test(f))) into[f] = read(path.join(dir, f));
        }

        for (const nodeEntry of fs.existsSync(nodesDir) ? fs.readdirSync(nodesDir, { withFileTypes: true }) : []) {
          if (!nodeEntry.isDirectory()) continue;
          const nodeDir = path.join(nodesDir, nodeEntry.name);
          const files: Record<string, string> = {};
          for (const f of fs.readdirSync(nodeDir, { withFileTypes: true })) {
            // A section may be ONE file or a FOLDER of one file per key. A big api.yaml
            // is several independent calls stacked in a single file; splitting them is
            // how a person edits one call without reading the other three.
            if (f.isDirectory()) {
              for (const inner of fs.readdirSync(path.join(nodeDir, f.name)).filter((i) => YAML_RE.test(i)))
                files[`${f.name}/${inner}`] = read(path.join(nodeDir, f.name, inner));
            } else if (YAML_RE.test(f.name)) files[f.name] = read(path.join(nodeDir, f.name));
          }
          if (!files["node.yaml"]) continue; // not a manifest node
          pkg.nodes.push({ dir: nodeEntry.name, origin: nodeDir, files });
        }

        if (pkg.nodes.length || Object.keys(pkg.credentials).length) packages.push(pkg);
      }
      return packages;
    },
  };
}
