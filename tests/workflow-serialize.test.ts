/**
 * YAML serialization + the dual-write helper (WORKFLOW_DOCUMENT.md §5–§6).
 *
 * The properties that matter: the stored text round-trips through parse+validate,
 * serialization is STABLE (same workflow → same text, the canonical-form hardening),
 * and dualWriteDocuments refuses exactly when the converter refuses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  toWorkflowYaml,
  fromWorkflowYaml,
  toLayoutYaml,
  fromLayoutYaml,
  dualWriteDocuments,
} from "@unoverse-platform/base/workflow/serialize.js";
import { splitWorkflow, type LegacyContent } from "@unoverse-platform/base/workflow/convert.js";

function legacy(): LegacyContent {
  return {
    name: "dealReview",
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: "trigger1", type: "InputTrigger", position: { x: 0, y: 0 }, data: { label: "Start" } },
      {
        id: "agent1",
        type: "OpenAIAgent",
        position: { x: 300, y: 0 },
        data: { label: "Reviewer", config: { model: "gpt-4o", prompt: "A long prompt that must never be line-wrapped by the serializer because a wrapped string is a diff lie." } },
      },
    ],
    edges: [{ id: "e1", source: "trigger1", target: "agent1", type: "smoothstep", data: { points: [{ x: 1, y: 2 }] } }],
  };
}

test("both documents round-trip: serialize → parse → validate → deep-equal", () => {
  const { workflow, layout } = splitWorkflow(legacy());
  assert.deepEqual(fromWorkflowYaml(toWorkflowYaml(workflow)), workflow);
  assert.deepEqual(fromLayoutYaml(toLayoutYaml(layout)), layout);
});

test("serialization is stable: the same workflow yields byte-identical text every time", () => {
  const a = splitWorkflow(legacy());
  const b = splitWorkflow(legacy());
  assert.equal(toWorkflowYaml(a.workflow), toWorkflowYaml(b.workflow));
  assert.equal(toLayoutYaml(a.layout), toLayoutYaml(b.layout));
});

test("long strings are never line-wrapped", () => {
  const { workflow } = splitWorkflow(legacy());
  const text = toWorkflowYaml(workflow);
  assert.ok(text.includes("diff lie."), "the long prompt survives on one logical line");
  assert.ok(!/never be\n\s+line-wrapped/.test(text), "no soft wrap inside the string");
});

test("fromWorkflowYaml THROWS on a document that does not validate — never limps past", () => {
  assert.throws(() => fromWorkflowYaml("schemaVersion: 1\nname: broken\nnodes: []\n"), /invalid workflow document/);
});

test("dualWriteDocuments: ok carries both YAMLs; a refusing workflow refuses here too", () => {
  const ok = dualWriteDocuments(legacy());
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.match(ok.workflowYaml, /^schemaVersion: 1/);
    assert.match(ok.layoutYaml, /viewport:/);
  }

  const content = legacy();
  (content.nodes[0] as any).mysteryField = true;
  const refused = dualWriteDocuments(content);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.problems[0].message, /refusing/);
});
