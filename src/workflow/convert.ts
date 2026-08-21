/**
 * Legacy workflow ⇄ the two-document split — the encode/decode boundary.
 * Design record: docs/architecture/WORKFLOW_DOCUMENT.md §5–§6.
 *
 * `split` turns today's interleaved shape (React-Flow nodes with embedded positions, edges
 * with styling, a viewport column) into the workflow document + layout overlay. `merge`
 * reverses it exactly. `verifyLosslessSplit` is the migration gate: a workflow may leave
 * the legacy read path only when split → merge reproduces its normalized form deep-equal.
 *
 * THE LOSSLESS CONTRACT — three field classes, nothing silent:
 *   - CONVERTED  known fields, carried into one of the two documents.
 *   - NOISE      React-Flow runtime state (selected, dragging, measured …). Dropped and
 *                REPORTED by path. It describes a live editor session, not the workflow,
 *                and is excluded from the round-trip comparison by `normalizeLegacy`.
 *   - UNKNOWN    anything else. The split REFUSES (a problem, not a drop) — an
 *                unconvertible workflow is flagged and stays legacy, never mangled.
 *
 * Row-level columns (id, active, timestamps) stay row columns; this converts the CONTENT.
 * `umap_settings` / `mcp_schema` stay row columns pending their classification (§7).
 */
import { isDeepStrictEqual } from "node:util";
import type {
  WorkflowDocument,
  WorkflowDocumentEdge,
  WorkflowDocumentNode,
  LayoutDocument,
  DocumentProblem,
} from "./document.js";
import { validateWorkflowDocument, validateLayoutDocument } from "./document.js";

// ---------------------------------------------------------------------------
// Legacy content shape (loose on purpose — real rows carry editor residue)
// ---------------------------------------------------------------------------

export interface LegacyContent {
  name: string;
  description?: string;
  executionMode?: string;
  memoryConfig?: Record<string, unknown> | null;
  testInputs?: unknown;
  viewport?: { x: number; y: number; zoom: number } | null;
  nodes: any[];
  edges: any[];
}

/** React-Flow runtime state on a NODE: a live editor session's residue, never the workflow. */
const NODE_NOISE = new Set([
  "selected",
  "dragging",
  "positionAbsolute",
  "measured",
  "resizing",
  "deletable",
  "selectable",
  "connectable",
  "focusable",
  "sourcePosition",
  "targetPosition",
  "zIndex",
  "className",
]);
/**
 * Authored presentation the save path deliberately persists (nodeCleanup.ts): a resized
 * Note's dimensions, a Note's zIndex style, a pinned node's draggable. Not noise — losing
 * them visibly changes the canvas — so they travel in the layout document's placement.
 */
const NODE_PRESENTATION = new Set(["width", "height", "style", "draggable"]);
const NODE_CONVERTED = new Set(["id", "type", "position", "data"]);
const NODE_DATA_CONVERTED = new Set(["label", "config", "credentials", "testInputs", "unoManaged", "measuredSize"]);

/**
 * Run residue inside node.data — the engine's own nodeCleanup.ts names these as "runtime
 * fields [that] bloat the workflow JSON and contain stale data": status (visual run state),
 * outputs / executedOutput (stale run results, regenerated every run; UI-component
 * previews re-render on the next run), serviceConnectors (rebuilt from the node
 * definition). Dropped and reported, excluded from the round-trip equivalence.
 *
 * executedOutput is the exception the save path already carves out: on a design-system
 * node it is the canvas preview, and nodeCleanup keeps it for exactly that reason. It
 * travels as the placement's `preview` rather than being dropped.
 */
const NODE_DATA_NOISE = new Set(["status", "outputs", "serviceConnectors"]);
const NODE_DATA_PRESENTATION = new Set(["executedOutput"]);

/** Presentation and runtime state on an EDGE. */
const EDGE_NOISE = new Set(["style", "animated", "selected", "zIndex", "markerEnd", "markerStart", "label", "labelStyle", "className", "deletable", "focusable"]);
const EDGE_CONVERTED = new Set(["id", "source", "target", "sourceHandle", "targetHandle", "type", "serviceType", "methods", "data"]);

export interface SplitResult {
  workflow: WorkflowDocument;
  layout: LayoutDocument;
  /** Paths of NOISE fields that were dropped. Never empty silently — callers log these. */
  dropped: string[];
  /** UNKNOWN fields or structural refusals. Non-empty = do not convert this workflow. */
  problems: DocumentProblem[];
}

// ---------------------------------------------------------------------------
// split — legacy content → the two documents
// ---------------------------------------------------------------------------

export function splitWorkflow(content: LegacyContent): SplitResult {
  const dropped: string[] = [];
  const problems: DocumentProblem[] = [];

  if (!content?.name) problems.push({ path: "name", message: "the workflow has no name (the row column is the name — pass it in)" });

  const nodes: WorkflowDocumentNode[] = [];
  const layoutNodes: Record<string, { x: number; y: number }> = {};

  for (const [i, node] of (content.nodes ?? []).entries()) {
    const at = `nodes/${i}`;
    for (const key of Object.keys(node)) {
      if (NODE_CONVERTED.has(key) || NODE_PRESENTATION.has(key)) continue;
      if (NODE_NOISE.has(key)) dropped.push(`${at}/${key}`);
      else problems.push({ path: `${at}/${key}`, message: `unknown node field "${key}" — refusing rather than dropping` });
    }
    const data = node.data ?? {};
    for (const key of Object.keys(data)) {
      if (NODE_DATA_CONVERTED.has(key) || NODE_DATA_PRESENTATION.has(key)) continue;
      if (NODE_DATA_NOISE.has(key)) dropped.push(`${at}/data/${key}`);
      else problems.push({ path: `${at}/data/${key}`, message: `unknown node data field "${key}" — refusing rather than dropping` });
    }

    const out: WorkflowDocumentNode = { id: node.id, type: node.type };
    if (data.label !== undefined) out.label = data.label;
    if (data.config !== undefined) out.config = data.config;
    if (data.credentials !== undefined) out.credentials = data.credentials;
    if (data.testInputs !== undefined) out.testInputs = data.testInputs;
    if (data.unoManaged !== undefined) out.unoManaged = data.unoManaged;
    nodes.push(out);

    if (node.position && typeof node.position.x === "number" && typeof node.position.y === "number") {
      const placement: any = { x: node.position.x, y: node.position.y };
      if (typeof data.measuredSize?.width === "number") placement.width = data.measuredSize.width;
      if (typeof data.measuredSize?.height === "number") placement.height = data.measuredSize.height;

      const size: { width?: number; height?: number } = {};
      if (typeof node.width === "number") size.width = node.width;
      if (typeof node.height === "number") size.height = node.height;
      if (size.width !== undefined || size.height !== undefined) placement.size = size;

      if (node.style !== undefined) placement.style = node.style;
      if (node.draggable !== undefined) placement.draggable = node.draggable;
      if (data.executedOutput !== undefined) placement.preview = data.executedOutput;

      layoutNodes[node.id] = placement;
    } else {
      // No position means no placement, and a placement is the only home the presentation
      // fields have. Refuse rather than silently drop authored sizing or preview content.
      for (const key of [...NODE_PRESENTATION, "data/executedOutput"]) {
        const present = key === "data/executedOutput" ? data.executedOutput !== undefined : node[key] !== undefined;
        if (present) {
          problems.push({
            path: `${at}/${key}`,
            message: `node carries presentation ("${key}") but no position, so it has no layout placement to travel in`,
          });
        }
      }
    }
  }

  const edges: WorkflowDocumentEdge[] = [];
  const layoutEdges: Record<string, { renderer?: string; points?: Array<{ x: number; y: number }> }> = {};
  for (const [i, edge] of (content.edges ?? []).entries()) {
    const at = `edges/${i}`;
    for (const key of Object.keys(edge)) {
      if (EDGE_CONVERTED.has(key)) continue;
      if (EDGE_NOISE.has(key)) dropped.push(`${at}/${key}`);
      else problems.push({ path: `${at}/${key}`, message: `unknown edge field "${key}" — refusing rather than dropping` });
    }
    const out: WorkflowDocumentEdge = { source: edge.source, target: edge.target };
    if (edge.id !== undefined) out.id = edge.id;
    if (edge.sourceHandle != null) out.sourceHandle = edge.sourceHandle;
    if (edge.targetHandle != null) out.targetHandle = edge.targetHandle;

    const presentation: { renderer?: string; points?: Array<{ x: number; y: number }> } = {};
    if (edge.type === "service") {
      out.kind = "service";
      if (edge.serviceType !== undefined) out.serviceType = edge.serviceType;
      if (edge.methods !== undefined) out.methods = edge.methods;
    } else if (edge.type !== undefined && edge.type !== "data") {
      // Legacy `type` conflates semantics with the canvas edge RENDERER (smoothstep,
      // orthogonal, …). Anything that is not "service" is a data edge whose renderer
      // name is presentation.
      presentation.renderer = edge.type;
    }
    // "data" is the omitted default in the document — legacy `type: "data"` folds away.

    // edge.data carries routed waypoints ({points}) — presentation. An empty {} is noise.
    if (edge.data !== undefined) {
      const keys = Object.keys(edge.data ?? {});
      if (keys.length === 0) dropped.push(`${at}/data`);
      else if (keys.every((k) => k === "points")) presentation.points = edge.data.points;
      else {
        for (const k of keys.filter((k) => k !== "points"))
          problems.push({ path: `${at}/data/${k}`, message: `unknown edge data field "${k}" — refusing rather than dropping` });
      }
    }

    if (presentation.renderer !== undefined || presentation.points !== undefined) {
      if (edge.id === undefined) {
        problems.push({ path: at, message: "an edge with presentation (renderer/points) needs an id to join the layout document" });
      } else {
        layoutEdges[edge.id] = presentation;
      }
    }
    edges.push(out);
  }

  const workflow: WorkflowDocument = { schemaVersion: 1, name: content.name, nodes, edges };
  if (content.description != null) workflow.description = content.description;
  if (content.executionMode != null) workflow.executionMode = content.executionMode as any;
  if (content.memoryConfig != null) workflow.memoryConfig = content.memoryConfig;
  if (content.testInputs != null) workflow.testInputs = content.testInputs;

  const layout: LayoutDocument = { schemaVersion: 1, nodes: layoutNodes };
  if (content.viewport != null) layout.viewport = content.viewport;
  if (Object.keys(layoutEdges).length > 0) layout.edges = layoutEdges;

  // Belt and braces: what we produced must pass the document schema.
  if (problems.length === 0) {
    for (const result of [validateWorkflowDocument(workflow), validateLayoutDocument(layout)]) {
      problems.push(...result.problems);
    }
  }

  return { workflow, layout, dropped, problems };
}

// ---------------------------------------------------------------------------
// merge — the two documents → legacy content
// ---------------------------------------------------------------------------

/** Reconstruct the legacy interleaved shape. A node the layout does not place sits at the
 *  origin — the canvas's computed (ELK) layout is the real answer for unplaced nodes. */
export function mergeWorkflow(workflow: WorkflowDocument, layout?: LayoutDocument): LegacyContent {
  const nodes = workflow.nodes.map((node) => {
    const data: Record<string, unknown> = {};
    if (node.label !== undefined) data.label = node.label;
    if (node.config !== undefined) data.config = node.config;
    if (node.credentials !== undefined) data.credentials = node.credentials;
    if (node.testInputs !== undefined) data.testInputs = node.testInputs;
    if (node.unoManaged !== undefined) data.unoManaged = node.unoManaged;
    const placement = layout?.nodes[node.id];
    if (placement?.width !== undefined || placement?.height !== undefined) {
      const measuredSize: Record<string, number> = {};
      if (placement.width !== undefined) measuredSize.width = placement.width;
      if (placement.height !== undefined) measuredSize.height = placement.height;
      data.measuredSize = measuredSize;
    }
    if (placement?.preview !== undefined) data.executedOutput = placement.preview;
    const out: Record<string, unknown> = {
      id: node.id,
      type: node.type,
      position: placement ? { x: placement.x, y: placement.y } : { x: 0, y: 0 },
    };
    if (placement?.size?.width !== undefined) out.width = placement.size.width;
    if (placement?.size?.height !== undefined) out.height = placement.size.height;
    if (placement?.style !== undefined) out.style = placement.style;
    if (placement?.draggable !== undefined) out.draggable = placement.draggable;
    out.data = data;
    return out;
  });

  const edges = workflow.edges.map((edge) => {
    const presentation = edge.id !== undefined ? layout?.edges?.[edge.id] : undefined;
    const type = edge.kind === "service" ? "service" : (presentation?.renderer ?? "data");
    const out: Record<string, unknown> = { source: edge.source, target: edge.target, type };
    if (edge.id !== undefined) out.id = edge.id;
    if (edge.sourceHandle !== undefined) out.sourceHandle = edge.sourceHandle;
    if (edge.targetHandle !== undefined) out.targetHandle = edge.targetHandle;
    if (edge.serviceType !== undefined) out.serviceType = edge.serviceType;
    if (edge.methods !== undefined) out.methods = edge.methods;
    if (presentation?.points !== undefined) out.data = { points: presentation.points };
    return out;
  });

  const content: LegacyContent = { name: workflow.name, nodes, edges };
  if (workflow.description !== undefined) content.description = workflow.description;
  if (workflow.executionMode !== undefined) content.executionMode = workflow.executionMode;
  if (workflow.memoryConfig !== undefined) content.memoryConfig = workflow.memoryConfig;
  if (workflow.testInputs !== undefined) content.testInputs = workflow.testInputs;
  if (layout?.viewport !== undefined) content.viewport = layout.viewport;
  return content;
}

// ---------------------------------------------------------------------------
// normalize + the migration gate
// ---------------------------------------------------------------------------

/**
 * The canonical comparison form of legacy content — the equivalence `verifyLosslessSplit`
 * judges against. Strips NOISE fields, folds `type: "data"` to the default, drops
 * null/undefined optionals. This IS the deep-equal definition the migration doc requires.
 */
export function normalizeLegacy(content: LegacyContent): LegacyContent {
  const nodes = (content.nodes ?? []).map((node) => {
    const data: Record<string, unknown> = {};
    const d = node.data ?? {};
    if (d.label !== undefined) data.label = d.label;
    if (d.config !== undefined) data.config = d.config;
    if (d.credentials !== undefined) data.credentials = d.credentials;
    if (d.testInputs !== undefined) data.testInputs = d.testInputs;
    if (d.unoManaged !== undefined) data.unoManaged = d.unoManaged;
    if (d.measuredSize?.width !== undefined || d.measuredSize?.height !== undefined) {
      const measuredSize: Record<string, number> = {};
      if (d.measuredSize.width !== undefined) measuredSize.width = d.measuredSize.width;
      if (d.measuredSize.height !== undefined) measuredSize.height = d.measuredSize.height;
      data.measuredSize = measuredSize;
    }
    // Authored presentation now round-trips through the layout placement, so the
    // equivalence has to hold it to account: dropping it here would let a lost Note
    // size or preview pass as lossless.
    if (d.executedOutput !== undefined) data.executedOutput = d.executedOutput;
    const out: any = { id: node.id, type: node.type, data };
    if (node.position && typeof node.position.x === "number") out.position = { x: node.position.x, y: node.position.y };
    else out.position = { x: 0, y: 0 };
    if (typeof node.width === "number") out.width = node.width;
    if (typeof node.height === "number") out.height = node.height;
    if (node.style !== undefined) out.style = node.style;
    if (node.draggable !== undefined) out.draggable = node.draggable;
    return out;
  });
  const edges = (content.edges ?? []).map((edge) => {
    // The renderer name in legacy `type` is preserved by the round-trip (it lives in the
    // layout document), so the equivalence keeps it; only absent/data folds to "data".
    const type = edge.type === undefined || edge.type === "data" ? "data" : edge.type;
    const out: any = { source: edge.source, target: edge.target, type };
    if (edge.id !== undefined) out.id = edge.id;
    if (edge.sourceHandle != null) out.sourceHandle = edge.sourceHandle;
    if (edge.targetHandle != null) out.targetHandle = edge.targetHandle;
    if (edge.serviceType !== undefined) out.serviceType = edge.serviceType;
    if (edge.methods !== undefined) out.methods = edge.methods;
    if (edge.data !== undefined && Object.keys(edge.data).length > 0) out.data = { points: edge.data.points };
    return out;
  });
  const out: LegacyContent = { name: content.name, nodes, edges };
  if (content.description != null) out.description = content.description;
  if (content.executionMode != null) out.executionMode = content.executionMode;
  if (content.memoryConfig != null) out.memoryConfig = content.memoryConfig;
  if (content.testInputs != null) out.testInputs = content.testInputs;
  if (content.viewport != null) out.viewport = content.viewport;
  return out;
}

export interface LosslessResult {
  ok: boolean;
  problems: DocumentProblem[];
  dropped: string[];
}

/**
 * THE MIGRATION GATE. A workflow passes only when splitting and merging reproduces its
 * normalized self exactly. A failure here means the converter does not understand this
 * workflow — the workflow stays on the legacy path and is flagged; it is never converted.
 */
export function verifyLosslessSplit(content: LegacyContent): LosslessResult {
  const { workflow, layout, dropped, problems } = splitWorkflow(content);
  if (problems.length > 0) return { ok: false, problems, dropped };

  const rebuilt = mergeWorkflow(workflow, layout);
  const original = normalizeLegacy(content);
  if (!isDeepStrictEqual(rebuilt, original)) {
    return {
      ok: false,
      dropped,
      problems: [{ path: "(round-trip)", message: "split → merge did not reproduce the normalized workflow" }],
    };
  }
  return { ok: true, problems: [], dropped };
}
