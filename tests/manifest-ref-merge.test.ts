/**
 * $ref WITH SIBLINGS MERGES DEEPLY, and this file exists because it did not.
 *
 * The documented promise has always been "import a shared block and adjust one field". The
 * implementation was `{ ...imported, ...local }`, a SHALLOW spread, so adjusting one field
 * INSIDE a nested block replaced that whole block:
 *
 *     - $ref: search#call          # body: { mode, maxResults, workflowId, 6 filters, query }
 *       body:
 *         mode: "return 'intent'"  # ← every other body key silently vanished
 *
 * The request still went out. A body with fewer keys is a legal body, so there was no error
 * anywhere: the search simply ran with no filters, no result cap and NO QUERY. Found by
 * resolving the body and reading it, which is the only thing that shows it.
 *
 * The general shape is the one this format is most prone to: a manifest that is valid,
 * accepted, and quietly means something narrower than it says.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { composeNode } from "../src/manifests/compose.js";

/** A package with one shared fragment and one node, assembled in memory. */
function pkg(shared: string, api: string) {
  return {
    name: "t",
    shared: { "frag.yaml": shared },
    packageFile: "name: t\ndisplayName: T\nversion: 1.0.0\nallowedHosts: [api.example.com]\n",
  } as any;
}

const NODE = `
type: T
kind: PromiseNode
name: T
category: AI
description: d
whenToUse: w
auth: { required: false }
`;

function compose(shared: string, api: string) {
  return composeNode(
    { origin: "test", dir: "T", files: { "node.yaml": NODE, "api/run.yaml": api } } as any,
    pkg(shared, api),
  );
}

test("overriding one key inside a nested block keeps its siblings", () => {
  const node = compose(
    `call:
  name: search
  method: POST
  url: https://api.example.com/s
  transport: json
  body:
    mode: "return 'unset'"
    maxResults: "return 10"
    workflowId: "return scope.workflowId"
    includeSkills: "return true"
`,
    `- $ref: frag#call
  body:
    mode: "return 'intent'"
`,
  );

  const body = node.api!.run[0].body;
  assert.equal(body.mode, "return 'intent'", "the override must win");
  // THE ASSERTION THAT WAS FAILING. A shallow merge leaves ONLY mode here.
  assert.deepEqual(
    Object.keys(body).sort(),
    ["includeSkills", "maxResults", "mode", "workflowId"],
    "overriding one body key deleted its siblings — the request would go out valid and wrong",
  );
  assert.equal(body.maxResults, "return 10");
  assert.equal(body.workflowId, "return scope.workflowId");
});

test("a top-level sibling still replaces, and does not disturb the rest", () => {
  const node = compose(
    `call:
  name: search
  method: POST
  url: https://api.example.com/s
  transport: json
  body: { a: "return 1" }
`,
    `- $ref: frag#call
  method: GET
`,
  );
  assert.equal(node.api!.run[0].method, "GET");
  assert.equal(node.api!.run[0].url, "https://api.example.com/s");
  assert.deepEqual(node.api!.run[0].body, { a: "return 1" });
});

test("an ARRAY is replaced, never concatenated", () => {
  // A list is an ordered whole. Merging two would leave an author no way to SHORTEN one,
  // which matters most for retry.on: you could add a status code but never remove one.
  const node = compose(
    `call:
  name: search
  method: POST
  url: https://api.example.com/s
  transport: json
  retry: { attempts: 3, on: [429, 500, 502, 503, 504] }
`,
    `- $ref: frag#call
  retry:
    on: [429]
`,
  );
  const retry = node.api!.run[0].retry;
  assert.deepEqual(retry.on, [429], "the array must be replaced, not merged");
  assert.equal(retry.attempts, 3, "its sibling must survive");
});

test("a key the shared block does not have is added", () => {
  const node = compose(
    `call:
  name: search
  method: POST
  url: https://api.example.com/s
  transport: json
  body: { a: "return 1" }
`,
    `- $ref: frag#call
  body:
    b: "return 2"
`,
  );
  assert.deepEqual(node.api!.run[0].body, { a: "return 1", b: "return 2" });
});

test("a LONE $ref still replaces outright", () => {
  // Unchanged behaviour, asserted so the merge work above cannot quietly alter it.
  const node = compose(
    `call:
  name: search
  method: POST
  url: https://api.example.com/s
  transport: json
`,
    `- $ref: frag#call
`,
  );
  assert.equal(node.api!.run[0].name, "search");
  assert.equal(node.api!.run[0].method, "POST");
});
