/**
 * The workflow document schema — the contract for the YAML split
 * (docs/architecture/WORKFLOW_DOCUMENT.md).
 *
 * The load-bearing assertions are the REJECTIONS: the workflow schema refuses
 * presentation fields (position, viewport, edge styling), which is what makes the
 * logic/presentation split structural rather than a convention someone can drift past.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import {
  validateWorkflowDocument,
  validateLayoutDocument,
  validateLayoutAgainstWorkflow,
  type WorkflowDocument,
  type LayoutDocument,
} from "@unoverse-platform/base/workflow/document.js";

const VALID_WORKFLOW_YAML = `
schemaVersion: 1
name: dealReview
description: Reviews an incoming deal and drafts a summary.
executionMode: experience
nodes:
  - id: trigger1
    type: InputTrigger
    label: Deal arrives
  - id: agent1
    type: OpenAIAgent
    label: Reviewer
    config:
      model: gpt-4o
    credentials:
      openAICredential: openAICredential
  - id: search1
    type: SpatialSearch
    label: Related deals
edges:
  - source: trigger1
    target: agent1
    sourceHandle: output
    targetHandle: input
  - source: search1
    target: agent1
    kind: service
    serviceType: search
    methods: [searchDeals]
`;

const VALID_LAYOUT_YAML = `
schemaVersion: 1
viewport: { x: 0, y: 120, zoom: 0.8 }
nodes:
  trigger1: { x: 0, y: 0 }
  agent1: { x: 320, y: 0 }
  search1: { x: 320, y: 240 }
`;

function workflow(mutate?: (doc: any) => void): any {
  const doc = parse(VALID_WORKFLOW_YAML);
  mutate?.(doc);
  return doc;
}

test("a valid workflow document parses from YAML and validates clean", () => {
  const result = validateWorkflowDocument(workflow());
  assert.deepEqual(result, { ok: true, problems: [] });
});

test("a valid layout document validates clean, alone and against its workflow", () => {
  const layout = parse(VALID_LAYOUT_YAML) as LayoutDocument;
  assert.equal(validateLayoutDocument(layout).ok, true);
  const against = validateLayoutAgainstWorkflow(layout, workflow() as WorkflowDocument);
  assert.deepEqual(against, { ok: true, problems: [] });
});

// ---------------------------------------------------------------------------
// The split is enforced by the schema
// ---------------------------------------------------------------------------

test("REJECTED: a position on a workflow node — presentation cannot enter the logic document", () => {
  const result = validateWorkflowDocument(workflow((d) => (d.nodes[0].position = { x: 10, y: 20 })));
  assert.equal(result.ok, false);
});

test("REJECTED: a viewport on the workflow document", () => {
  const result = validateWorkflowDocument(workflow((d) => (d.viewport = { x: 0, y: 0, zoom: 1 })));
  assert.equal(result.ok, false);
});

test("REJECTED: edge styling on a workflow edge", () => {
  const result = validateWorkflowDocument(workflow((d) => (d.edges[0].animated = true)));
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// Shape rules
// ---------------------------------------------------------------------------

test("REJECTED: a missing schemaVersion, and a version the schema does not know", () => {
  assert.equal(validateWorkflowDocument(workflow((d) => delete d.schemaVersion)).ok, false);
  assert.equal(validateWorkflowDocument(workflow((d) => (d.schemaVersion = 2))).ok, false);
});

test("REJECTED: a node without a type", () => {
  assert.equal(validateWorkflowDocument(workflow((d) => delete d.nodes[1].type)).ok, false);
});

test("an empty canvas is a valid document — a new workflow starts empty", () => {
  const result = validateWorkflowDocument({ schemaVersion: 1, name: "fresh", nodes: [], edges: [] });
  assert.deepEqual(result, { ok: true, problems: [] });
});

// ---------------------------------------------------------------------------
// Graph rules
// ---------------------------------------------------------------------------

test("REJECTED: duplicate node ids", () => {
  const result = validateWorkflowDocument(workflow((d) => (d.nodes[2].id = "agent1")));
  assert.equal(result.ok, false);
  assert.match(result.problems[0].message, /duplicate node id/);
});

test("REJECTED: an edge referencing a node the document does not contain", () => {
  const result = validateWorkflowDocument(workflow((d) => (d.edges[0].target = "ghost")));
  assert.equal(result.ok, false);
  assert.match(result.problems[0].message, /not a node in this document/);
});

test("a bare service edge is valid (real grants carry no serviceType/methods); service fields on a data edge are REJECTED", () => {
  // Verified against production rows + the compiler: the grant is the edge itself.
  const bare = validateWorkflowDocument(
    workflow((d) => {
      delete d.edges[1].serviceType;
      delete d.edges[1].methods;
    }),
  );
  assert.deepEqual(bare, { ok: true, problems: [] });

  const onData = validateWorkflowDocument(workflow((d) => (d.edges[0].serviceType = "search")));
  assert.equal(onData.ok, false);
  assert.match(onData.problems[0].message, /service edge/);
});

test("REJECTED: a stale overlay — layout positioning a node the workflow lost", () => {
  const layout = parse(VALID_LAYOUT_YAML) as LayoutDocument;
  const shrunk = workflow((d) => (d.nodes = d.nodes.filter((n: any) => n.id !== "search1")));
  const result = validateLayoutAgainstWorkflow(layout, shrunk as WorkflowDocument);
  assert.equal(result.ok, false);
  assert.match(result.problems[0].message, /which the workflow does not contain/);
});
