/**
 * The split/merge boundary and the migration gate (WORKFLOW_DOCUMENT.md §6).
 *
 * The property under test is LOSSLESSNESS: split → merge reproduces the normalized
 * legacy shape exactly, noise is dropped LOUDLY (reported by path), and anything the
 * converter does not understand REFUSES rather than converts. Real workflows ride this
 * gate one at a time during the migration, so the refusal paths matter as much as the
 * happy path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  splitWorkflow,
  mergeWorkflow,
  normalizeLegacy,
  verifyLosslessSplit,
  type LegacyContent,
} from "@unoverse-platform/base/workflow/convert.js";

/** A realistic legacy row content: interleaved positions, RF editor residue, a service edge. */
function legacy(): LegacyContent {
  return {
    name: "dealReview",
    description: "Reviews an incoming deal.",
    executionMode: "experience",
    viewport: { x: 12, y: -40, zoom: 0.75 },
    memoryConfig: { enableUserMemory: true },
    nodes: [
      {
        id: "trigger1",
        type: "InputTrigger",
        position: { x: 0, y: 0 },
        data: { label: "Deal arrives" },
        selected: false, // RF noise
        width: 180, // RF noise
      },
      {
        id: "agent1",
        type: "OpenAIAgent",
        position: { x: 320, y: 40 },
        data: { label: "Reviewer", config: { model: "gpt-4o" }, credentials: { openAICredential: "openAICredential" } },
        dragging: false, // RF noise
      },
      {
        id: "tool1",
        type: "SpatialSearch",
        position: { x: 320, y: 280 },
        data: { label: "Related deals" },
      },
    ],
    edges: [
      {
        id: "e1",
        source: "trigger1",
        target: "agent1",
        sourceHandle: "output",
        targetHandle: "input",
        type: "data",
        animated: true, // presentation noise
        style: { stroke: "#888" }, // presentation noise
      },
      { id: "e2", source: "tool1", target: "agent1", type: "service", serviceType: "search", methods: ["searchDeals"] },
    ],
  };
}

test("split: positions and viewport land in the layout, logic in the workflow, noise reported by path", () => {
  const { workflow, layout, dropped, problems } = splitWorkflow(legacy());
  assert.deepEqual(problems, []);

  assert.deepEqual(layout.nodes.agent1, { x: 320, y: 40 });
  assert.deepEqual(layout.viewport, { x: 12, y: -40, zoom: 0.75 });
  assert.equal((workflow.nodes[1] as any).position, undefined);

  assert.equal(workflow.nodes[1].label, "Reviewer");
  assert.deepEqual(workflow.nodes[1].config, { model: "gpt-4o" });
  assert.equal(workflow.edges[0].kind, undefined, "data is the omitted default");
  assert.equal(workflow.edges[1].kind, "service");

  assert.deepEqual(
    dropped.sort(),
    ["edges/0/animated", "edges/0/style", "nodes/0/selected", "nodes/0/width", "nodes/1/dragging"],
    "every dropped field is named — nothing vanishes silently",
  );
});

test("merge: reconstructs the legacy shape; an unplaced node sits at the origin for ELK to place", () => {
  const { workflow, layout } = splitWorkflow(legacy());
  delete layout.nodes.tool1;
  const rebuilt = mergeWorkflow(workflow, layout);
  assert.deepEqual(rebuilt.nodes[2].position, { x: 0, y: 0 });
  assert.equal(rebuilt.edges[0].type, "data", "legacy edge type restored from the omitted default");
});

test("THE GATE: a realistic workflow round-trips lossless", () => {
  const result = verifyLosslessSplit(legacy());
  assert.equal(result.ok, true, JSON.stringify(result.problems));
});

test("THE GATE: an unknown node field REFUSES — flagged, never converted", () => {
  const content = legacy();
  (content.nodes[0] as any).mysteryField = { important: "maybe" };
  const result = verifyLosslessSplit(content);
  assert.equal(result.ok, false);
  assert.match(result.problems[0].message, /refusing rather than dropping/);
  assert.match(result.problems[0].path, /mysteryField/);
});

test("THE GATE: an unknown node data field REFUSES too — data is where real workflows hide surprises", () => {
  const content = legacy();
  (content.nodes[1] as any).data.customNotes = "do not lose me";
  const result = verifyLosslessSplit(content);
  assert.equal(result.ok, false);
  assert.match(result.problems[0].path, /data\/customNotes/);
});

test("a non-service edge type is a canvas RENDERER — presentation, preserved via the layout doc", () => {
  // Real rows carry smoothstep/orthogonal in edge.type: the legacy field conflated
  // semantics with the renderer. The renderer round-trips through layout.edges.
  const content = legacy();
  (content.edges[0] as any).type = "smoothstep";
  (content.edges[0] as any).data = { points: [{ x: 1, y: 2 }] };

  const { workflow, layout, problems } = splitWorkflow(content);
  assert.deepEqual(problems, []);
  assert.equal(workflow.edges[0].kind, undefined, "still a data edge semantically");
  assert.deepEqual(layout.edges?.e1, { renderer: "smoothstep", points: [{ x: 1, y: 2 }] });

  assert.equal(verifyLosslessSplit(content).ok, true, "renderer + waypoints survive the round-trip");
  const rebuilt = mergeWorkflow(workflow, layout);
  assert.equal(rebuilt.edges[0].type, "smoothstep");
});

test("THE GATE: edge presentation without an edge id REFUSES (no join key to the layout doc)", () => {
  const content = legacy();
  delete (content.edges[0] as any).id;
  (content.edges[0] as any).type = "smoothstep";
  const result = verifyLosslessSplit(content);
  assert.equal(result.ok, false);
  assert.match(result.problems[0].message, /needs an id/);
});

test("run residue in node data (status, outputs, executedOutput, serviceConnectors) drops loudly", () => {
  const content = legacy();
  (content.nodes[1] as any).data.status = "success";
  (content.nodes[1] as any).data.outputs = { output: { big: "blob" } };
  (content.nodes[1] as any).data.executedOutput = { stale: true };
  (content.nodes[1] as any).data.serviceConnectors = [{ derived: true }];
  const result = verifyLosslessSplit(content);
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.deepEqual(
    result.dropped.filter((p) => p.includes("nodes/1/data")).sort(),
    ["nodes/1/data/executedOutput", "nodes/1/data/outputs", "nodes/1/data/serviceConnectors", "nodes/1/data/status"],
  );
});

test("authored per-node testInputs and the unoManaged marker ride the WORKFLOW document", () => {
  const content = legacy();
  (content.nodes[1] as any).data.testInputs = { message: "authored test prompt" };
  (content.nodes[1] as any).data.unoManaged = true;
  (content.nodes[1] as any).data.measuredSize = { width: 240, height: 128 };

  const { workflow, layout } = splitWorkflow(content);
  assert.deepEqual(workflow.nodes[1].testInputs, { message: "authored test prompt" });
  assert.equal(workflow.nodes[1].unoManaged, true);
  assert.deepEqual(layout.nodes.agent1, { x: 320, y: 40, width: 240, height: 128 }, "user sizing is presentation");
  assert.equal(verifyLosslessSplit(content).ok, true);
});

test("normalizeLegacy is the equivalence: noise-only differences compare equal", () => {
  const a = normalizeLegacy(legacy());
  const noisier = legacy();
  (noisier.nodes[2] as any).selected = true;
  (noisier.edges[1] as any).animated = false;
  const b = normalizeLegacy(noisier);
  assert.deepEqual(a, b);
});

test("an empty canvas round-trips (new workflows start empty)", () => {
  const result = verifyLosslessSplit({ name: "fresh", nodes: [], edges: [] });
  assert.equal(result.ok, true);
});
