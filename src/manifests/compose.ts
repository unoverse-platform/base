/**
 * Compose a node folder into ONE definition.
 *
 * A node is authored as up to five files split by rate of change (node, interface,
 * config, api, test). Nothing downstream should know or care: this turns them into
 * the single object the registry already stores, so a manifest node and a code node
 * are indistinguishable to the catalog, the canvas and the engine.
 *
 * Any section may instead be inlined into node.yaml. Defined in BOTH places is an
 * error, never a merge — silently merging would make a stale file invisible.
 *
 * NOTE: the $ref and section rules here are also implemented in
 * scripts/lib/lint-nodes.mjs, which must run without the server (it ships in the
 * starter kit). Keep the two in step; the linter is the one developers see first.
 *
 * See docs/architecture/DECLARATIVE_NODES.md §5.
 */
import * as YAML from "yaml";
import type { RawNode, RawPackage } from "./source.js";

/** The sections that may live in their own file OR inline in node.yaml. */
const SECTIONS = ["interface", "config", "api", "test"] as const;
type Section = (typeof SECTIONS)[number];

export interface ComposedNode {
  type: string;
  kind: "PromiseNode" | "CallbackNode";
  packageName: string;
  /**
   * Hosts this node may call, from its package's `allowedHosts`. Empty means NONE: a
   * package that declares no allowedHosts cannot reach the network at all.
   *
   * SECURITY.md treats a node as trusted code bounded by provenance, and a template
   * expression as untrusted data bounded by having no credentials in scope. A
   * manifest node is neither: it arrives as data yet holds a credential and a URL.
   * This is its boundary.
   */
  allowedHosts: string[];
  origin: string;
  /** The registry-shaped definition. */
  definition: Record<string, any>;
  /** The api block, carried for the executor. Absent means the node does nothing yet. */
  api: Record<string, any> | null;
  /** The version the package declares, so /plugins need not trust a stale row. */
  packageVersion?: string;
  /**
   * `sha256:<hex>` over this composed document, filled in by the loader.
   *
   * Set after composition rather than inside it, because the hash is OVER the composed
   * result and a field cannot be part of what it summarises.
   */
  hash?: string;
}

export class ManifestError extends Error {}

function parse(yaml: string, where: string): any {
  let doc: any;
  try {
    doc = YAML.parse(yaml);
  } catch (err: any) {
    throw new ManifestError(`${where} is not valid YAML: ${String(err?.message ?? err).split("\n")[0]}`);
  }
  if (doc && typeof doc === "object") delete doc.$schema;
  return doc ?? {};
}

/**
 * Resolve a `$ref` against the package's `shared/` folder.
 *
 * SHORT FORM, and the one to write:
 *     url:  { $ref: endpoints#responses }
 *     enum: { $ref: models#enum }
 *     toolExchange:
 *       $ref: tools          # whole file
 *       maxTurns: 5          # local keys layer on top and win
 *
 * No path, because there was never a real path: shared fragments are package-scoped and
 * the directory part was always thrown away. `../../shared/endpoints.yaml#/responses`
 * still works, but it is arithmetic that buys nothing.
 *
 * A LONE $ref REPLACES. A $ref WITH SIBLINGS MERGES, local winning, which is what lets a
 * node import a whole shared block and adjust one field.
 */
function resolveRefs(value: any, pkg: RawPackage, where: string, depth = 0): any {
  if (depth > 10) throw new ManifestError(`${where}: $ref nested more than 10 deep, probably a cycle`);
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, pkg, where, depth));
  if (!value || typeof value !== "object") return value;

  const keys = Object.keys(value);
  if (typeof value.$ref === "string") {
    const [target, frag = ""] = value.$ref.split("#");
    // `endpoints`, `endpoints.yaml`, or `../../shared/endpoints.yaml` — all the same file.
    const stem = (target.split("/").pop() ?? "").replace(/\.ya?ml$/, "");
    const body = pkg.shared[`${stem}.yaml`] ?? pkg.shared[`${stem}.yml`];
    if (body === undefined)
      throw new ManifestError(`${where}: $ref "${value.$ref}" — no shared/${stem}.yaml in package "${pkg.name}"`);
    const doc = parse(body, `${pkg.name}/shared/${stem}.yaml`);
    const hit = frag
      .replace(/^\//, "")
      .split("/")
      .filter(Boolean)
      .reduce((a: any, k: string) => (a == null ? a : a[k]), doc);
    if (hit === undefined) throw new ManifestError(`${where}: $ref "${value.$ref}" resolved to nothing`);
    const imported = resolveRefs(hit, pkg, where, depth + 1);
    if (keys.length === 1) return imported;

    // Siblings present: merge, local wins.
    const local = Object.fromEntries(
      keys.filter((k) => k !== "$ref").map((k) => [k, resolveRefs(value[k], pkg, where, depth)]),
    );
    if (imported === null || typeof imported !== "object" || Array.isArray(imported))
      throw new ManifestError(`${where}: $ref "${value.$ref}" is not an object, so it cannot be merged with sibling keys`);
    return { ...(imported as object), ...local };
  }
  return Object.fromEntries(keys.map((k) => [k, resolveRefs(value[k], pkg, where, depth)]));
}

/**
 * Who published the package. Absent means unknown, which the UI must show as third
 * party rather than assume: "we could not tell" and "we vouch for it" are different
 * answers and only one of them is safe to guess.
 */
function packagePublisher(pkg: RawPackage): string | null {
  if (!pkg.packageFile) return null;
  const doc: any = parse(pkg.packageFile, `${pkg.name}/package.yaml`) ?? {};
  return typeof doc.publisher === "string" && doc.publisher.trim() ? doc.publisher.trim() : null;
}

/** A package's declared allowedHosts hosts. Absent or empty means the package cannot call out. */
export function packageAllowedHosts(pkg: RawPackage): string[] {
  if (!pkg.packageFile) return [];
  const doc = parse(pkg.packageFile, `${pkg.name}/package.yaml`);
  return Array.isArray(doc.allowedHosts) ? doc.allowedHosts.map((h: string) => String(h).toLowerCase()) : [];
}

/** The version a package declares for itself, so state does not keep reporting an old npm one. */
/**
 * The hosts THIS node may call: its own list when it declares one, else the package's.
 *
 * The package sets the CEILING and a node may only narrow it. A node that named a host its
 * package did not would otherwise be a way to widen the boundary from inside the thing the
 * boundary contains, which is the mistake this codebase has now made twice.
 *
 * Why it matters in practice: `gtm` calls two vendors, so its package list holds both, and
 * without this every Apollo node is also permitted to reach Hunter. One node, one vendor is
 * what a reviewer expects when they read a node's page.
 */
export function nodeAllowedHosts(node: any, fromPackage: string[], where: string): string[] {
  const own = node.allowedHosts;
  if (!Array.isArray(own) || !own.length) return fromPackage;

  const narrowed = own.map((h: string) => String(h).toLowerCase());
  const widened = narrowed.filter((h) => !fromPackage.includes(h));
  if (widened.length)
    throw new ManifestError(
      `${where}: node.yaml allows ${widened.map((h) => `"${h}"`).join(", ")}, which package.yaml does not. ` +
        `A node may only NARROW its package's allowedHosts, never widen them.`,
    );
  return narrowed;
}

export function packageVersion(pkg: RawPackage): string | undefined {
  if (!pkg.packageFile) return undefined;
  const doc = parse(pkg.packageFile, `${pkg.name}/package.yaml`);
  return doc.version ? String(doc.version) : undefined;
}

/**
 * A package's display envelope: what the marketplace shows ABOUT the package rather
 * than about its nodes.
 *
 * Manifest packages have no plugin-state row to carry this, so without it the Installed
 * list falls back to the bare folder name and no mark: "airtable" with an empty square
 * instead of "Airtable" with its logo. The information was always in package.yaml; it
 * just had no route out.
 */
export interface PackageMeta {
  displayName?: string;
  description?: string;
  category?: string;
  logoUrl?: string;
  features?: string[];
  publisher?: string | null;
  version?: string;
}

export function packageMeta(pkg: RawPackage): PackageMeta {
  if (!pkg.packageFile) return {};
  const doc: any = parse(pkg.packageFile, `${pkg.name}/package.yaml`) ?? {};
  return {
    displayName: doc.displayName ? String(doc.displayName) : undefined,
    description: doc.description ? String(doc.description) : undefined,
    category: doc.category ? String(doc.category) : undefined,
    logoUrl: doc.logoUrl ? String(doc.logoUrl) : undefined,
    features: Array.isArray(doc.features) ? doc.features.map(String) : undefined,
    publisher: packagePublisher(pkg),
    version: doc.version ? String(doc.version) : undefined,
  };
}

export function composeNode(raw: RawNode, pkg: RawPackage): ComposedNode {
  const where = `${pkg.name}/${raw.dir}`;
  // The package envelope, so a node can inherit what belongs to the whole package.
  const pkgMeta = packageMeta(pkg);

  const nodeFile = raw.files["node.yaml"];
  if (!nodeFile) throw new ManifestError(`${where}: no node.yaml`);
  const node = parse(nodeFile, `${where}/node.yaml`);

  const parts: Partial<Record<Section, any>> = {};
  for (const s of SECTIONS) {
    // Two ways to say the same thing, and exactly one may be used:
    //   inline in node.yaml    small sections that are not worth a file
    //   <s>.yaml               the common case
    //   <s>/<key>.yaml         one file per top-level key
    // The FILENAME IS THE KEY: api/request.yaml is what sat under `request:`. That
    // leaves no merge order to reason about and no way to define a key twice.
    //
    // `api` is ALWAYS the folder form, no exceptions, so every node reads the same way:
    // one file per call, plus the events table. Enforced below and by lint.
    const folder = Object.keys(raw.files).filter((f) => f.startsWith(`${s}/`)).sort();
    const onDisk = raw.files[`${s}.yaml`];
    const inline = node[s];

    const ways = [folder.length ? `${s}/` : null, onDisk !== undefined ? `${s}.yaml` : null, inline !== undefined ? "node.yaml" : null].filter(Boolean);
    if (ways.length > 1)
      throw new ManifestError(`${where}: "${s}" is defined in ${ways.join(" and ")} — pick one, this is never a merge`);

    let doc: any;
    if (folder.length) {
      doc = {};
      for (const f of folder) {
        const key = f.slice(s.length + 1).replace(/\.ya?ml$/, "");
        doc[key] = parse(raw.files[f], `${where}/${f}`);
      }
    } else doc = onDisk !== undefined ? parse(onDisk, `${where}/${s}.yaml`) : inline;

    if (doc !== undefined) parts[s] = resolveRefs(doc, pkg, `${where}/${s}.yaml`);
    delete node[s];
  }

  if (parts.api !== undefined && !Object.keys(raw.files).some((f) => f.startsWith("api/")))
    throw new ManifestError(
      `${where}: api must be a FOLDER (api/request.yaml, api/events.yaml, ...), not api.yaml or an inline api block — every node has the same shape`,
    );

  // RETIRED SHAPES, refused at composition.
  //
  // Lint catches these while authoring, but an already-PUBLISHED package does not get
  // linted: it arrives as a row and goes straight here. Without this, an older marketplace
  // version composes to an api block with no `run`, so a PromiseNode registers happily and
  // then dies on first execution with "has only service methods", while a CallbackNode
  // fails on a kind mismatch that names neither the cause nor the fix.
  //
  // Failing here instead says what to do, at the moment the universe loads the package.
  for (const [old, now] of [["request", "run (a LIST of calls)"], ["steps", "run"], ["provides", "service"]] as const)
    if (parts.api && (parts.api as any)[old] !== undefined)
      throw new ManifestError(
        `${where}: api/${old}.yaml is from an older manifest format and cannot be loaded — it is now api/${now}. ` +
          `Re-publish this package from a current source tree (DECLARATIVE_NODES.md §5).`,
      );

  if (!node.type) throw new ManifestError(`${where}: node.yaml has no type`);
  if (node.kind !== "PromiseNode" && node.kind !== "CallbackNode")
    throw new ManifestError(`${where}: node.yaml kind must be PromiseNode or CallbackNode, got ${JSON.stringify(node.kind)}`);

  const iface = parts.interface ?? {};
  const config = parts.config ?? {};
  const api = parts.api ?? null;

  // A tool exchange or a streaming transport makes this a CallbackNode. The manifest
  // DECLARES kind so it is visible on the node; this refuses the declaration when it
  // contradicts what the node actually does, which used to surface only at run time.
  // The LAST step is the one whose reply becomes the node's answer, so it is the only one
  // whose transport can make the node stream. Every earlier step settles by definition.
  const finalCall = api?.run?.[api.run.length - 1];
  const streams = ["sse", "ndjson", "awsEventStream"].includes(finalCall?.transport);
  const hasContinue = (iface.inputs ?? []).some((i: any) => ["CONTINUE", "SPAWN"].includes(i?.signal));
  const derived = streams || hasContinue || api?.toolExchange ? "CallbackNode" : "PromiseNode";
  if (node.kind !== derived)
    throw new ManifestError(
      `${where}: declares kind "${node.kind}" but is a ${derived} (` +
        (streams ? `its last step's transport "${finalCall.transport}" streams` : api?.toolExchange ? "it declares a toolExchange" : "an input carries a CONTINUE/SPAWN signal") +
        `)`,
    );

  return {
    type: node.type,
    kind: node.kind,
    packageName: pkg.name,
    origin: raw.origin,
    allowedHosts: nodeAllowedHosts(node, packageAllowedHosts(pkg), where),
    api,
    // Shaped for the registry (see platform/pluginAPI.ts registerNode), so a manifest
    // node is indistinguishable from a code node everywhere downstream.
    definition: {
      type: node.type,
      name: node.name ?? node.type,
      description: node.description ?? "",
      // The catalog ranker embeds this; losing it here would make the node invisible
      // to the building agent no matter how well it works.
      whenToUse: node.whenToUse ?? "",
      // Trust surface, carried on the definition so it travels with the node into the
      // catalog and needs no second lookup: WHO shipped it, and WHAT it may call.
      // A manifest node arrives as data yet holds a credential and a URL, so these two
      // answer "what am I accepting" without opening the YAML.
      publisher: packagePublisher(pkg),
      allowedHosts: nodeAllowedHosts(node, packageAllowedHosts(pkg), where),
      category: node.category ?? "general",
      version: node.version ?? "1.0.0",
      color: node.color ?? "#6366f1",
      // INHERITED from the package unless the node overrides it. A logo is a property
      // of the vendor, not of one endpoint, so repeating it per node is 25 copies of
      // one string that drift the moment a URL changes (Airtable shipped a dead one in
      // four files). Declare it once in package.yaml; a node only names its own if it
      // genuinely differs.
      logoUrl: node.logoUrl ?? pkgMeta.logoUrl ?? null,
      // How the canvas draws it. Absent means the ordinary node card.
      template: node.template ?? null,
      visibility: node.visibility ?? "public",
      capabilities: node.capabilities ?? null,
      inputs: iface.inputs ?? [],
      outputs: iface.outputs ?? [],
      credentials: iface.credentials ?? [],
      serviceConnectors: iface.serviceConnectors ?? null,
      isService: (iface.serviceConnectors ?? []).some((s: any) => s?.isService === true),
      configSchema: config.configSchema ?? {},
      testData: parts.test?.testData ?? null,
    },
  };
}

export function composeCredentials(pkg: RawPackage): Record<string, any>[] {
  return Object.entries(pkg.credentials).map(([file, body]) => {
    const doc = parse(body, `${pkg.name}/credentials/${file}`);
    if (!doc.name) throw new ManifestError(`${pkg.name}/credentials/${file}: no name`);
    return { name: doc.name, displayName: doc.displayName ?? doc.name, description: doc.description ?? "", properties: doc.properties ?? [] };
  });
}
