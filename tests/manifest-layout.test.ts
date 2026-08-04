/**
 * LAYOUT GUARD — a node folder's shape must not change what the node IS.
 *
 * `api` is the exception and is ALWAYS a folder, so every node reads the same way: one
 * file per call, plus the events table. That is asserted here too.
 *
 * A section can be written three ways (inline in node.yaml, `api.yaml`, or `api/<key>.yaml`
 * one file per key) and all three must compose to the identical document. The moment they
 * do not, source layout becomes a behavioural choice, and a node would mean something
 * different depending on how its author happened to file it.
 *
 * The second half is the exclusion rule: defining a section twice is an ERROR, never a
 * merge. Silently merging would make a stale file invisible, which is the failure mode
 * that costs an afternoon.
 *
 * See DECLARATIVE_NODES.md §5.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { composeNode } from "@unoverse-platform/base/manifests/compose.js";
import type { RawNode, RawPackage } from "@unoverse-platform/base/manifests/source.js";

/** The same node, filed three different ways. */
const NODE = {
  node: `type: LayoutProbe\nkind: PromiseNode\nname: Layout Probe\ncategory: test\n`,
  run: `- name: fetch\n  method: POST\n  url: https://api.example.com/v1/thing\n  transport: json\n  body:\n    q: "{{ config.q }}"\n`,
  events: `- emit: text\n  value: "return response.text"\n`,
  configSchema: `type: object\nproperties:\n  q:\n    type: string\n`,
  uiOrder: `- q\n`,
};

/** Every node has the same api shape, so every fixture carries it. */
const API = {
  "api/run.yaml": `- name: fetch\n  method: POST\n  url: https://api.example.com/v1/thing\n  transport: json\n  body:\n    q: "{{ config.q }}"\n`,
  "api/events.yaml": `- emit: text\n  value: "return response.text"\n`,
};

const PKG: RawPackage = { name: "probe", origin: "/probe", credentials: {}, shared: {}, nodes: [] };

const compose = (files: Record<string, string>) =>
  composeNode({ dir: "LayoutProbe", origin: "/probe/nodes/LayoutProbe", files } as RawNode, PKG);

test("layout: the three ways to define a section compose identically", () => {
  const asFolder = compose({
    "node.yaml": NODE.node,
    ...API,
    "config/configSchema.yaml": NODE.configSchema,
    "config/ui:order.yaml": NODE.uiOrder,
  });

  const asFile = compose({
    "node.yaml": NODE.node,
    ...API,
    "config.yaml": `configSchema:\n${indent(NODE.configSchema)}ui:order:\n${indent(NODE.uiOrder)}`,
  });

  const asInline = compose({
    "node.yaml": `${NODE.node}config:\n  configSchema:\n${indent(NODE.configSchema, 4)}  ui:order:\n${indent(NODE.uiOrder, 4)}`,
    ...API,
  });

  // A section lands in the registry-shaped `definition`, so that is what must match.
  assert.deepEqual(asFolder.definition, asFile.definition, "config/ folder must equal config.yaml");
  assert.deepEqual(asFolder.definition, asInline.definition, "config/ folder must equal inline config");
  // Not just equal to each other: actually the right shape.
  assert.equal(asFolder.definition?.configSchema?.type, "object");
  assert.equal(asFolder.api?.run?.[0]?.method, "POST");
});

test("layout: api is ALWAYS a folder, so every node reads the same way", () => {
  const inline = `${NODE.node}api:\n  run:\n${indent(NODE.run, 4)}`;
  assert.throws(() => compose({ "node.yaml": NODE.node, "api.yaml": `run:\n${indent(NODE.run)}` }), /api must be a FOLDER/);
  assert.throws(() => compose({ "node.yaml": inline }), /api must be a FOLDER/);
  // And the folder form is accepted.
  assert.equal(compose({ "node.yaml": NODE.node, ...API }).api?.run?.[0]?.method, "POST");
});

test("layout: the filename is the key, so nothing nests twice", () => {
  const n = compose({ "node.yaml": NODE.node, ...API });
  assert.equal(n.api?.run?.[0]?.method, "POST", "api/run.yaml holds the CONTENTS of run");
  assert.equal((n.api?.run as any)?.run, undefined, "and must not nest run.run");
});

test("layout: defining a section twice is an error, never a merge", () => {
  const both = [
    { name: "folder and file", files: { "node.yaml": NODE.node, ...API, "config.yaml": "configSchema: {}", "config/configSchema.yaml": "type: object" } },
    { name: "file and inline", files: { "node.yaml": `${NODE.node}config:\n  configSchema: {}\n`, ...API, "config.yaml": "configSchema: {}" } },
    { name: "folder and inline", files: { "node.yaml": `${NODE.node}config:\n  configSchema: {}\n`, ...API, "config/configSchema.yaml": "type: object" } },
  ];
  for (const c of both)
    assert.throws(() => compose(c.files), /pick one/, `${c.name} must be rejected`);
});

function indent(yaml: string, by = 2) {
  return yaml.replace(/^(?=.)/gm, " ".repeat(by));
}
