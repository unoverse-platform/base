/**
 * RUN-AUTHORIZATION CONTROLS ARE CHROME (UNOVERSE_NODE_ACCESS_CHROME.md, 2026-08-21).
 *
 * The builder's two access fields used to be compulsory boilerplate in every node's
 * config.yaml, held byte-identical across 76 files by a lint rule. They are now injected
 * ONCE, at compose time, into the schema every host renders, and the lint rule inverted:
 * the names are reserved and a manifest must not declare them.
 *
 * What this pins, and why each assertion exists:
 *
 *   INJECTION IS UNCONDITIONAL for a runnable node. The hole this closes is the original
 *   SpatialSearch one: a node nobody thought about looking exactly like a node with no
 *   access control. With injection, "forgot" is not a reachable state.
 *
 *   A STALE AUTHORED COPY IS SUPERSEDED, never merged. Packages published before the flip
 *   still carry the fields; if their copy won the merge it could reword the contract or
 *   flip a default, and the canonical definition would be canonical in name only.
 *
 *   AN ANNOTATION GETS NO SECTION. It is never run, so there is nobody to authorize, and
 *   drawing an access toggle on canvas furniture would claim a gate that cannot exist.
 *
 * The RULE is asserted (fields present, canonical, ordered last), not the exact wording
 * of titles or descriptions: copy is free to improve without a test edit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { composeNode } from "@unoverse-platform/base/manifests/compose.js";

const PKG: any = { name: "t", package: { name: "t", allowedHosts: ["api.example.com"] }, credentials: {}, shared: {} };

/** A RawNode: YAML text keyed by filename, exactly as the disk source hands it over. */
const raw = (over: Record<string, string | undefined> = {}): any => ({
  origin: "local",
  dir: "T",
  files: Object.fromEntries(
    Object.entries({
      "node.yaml": "type: T\nkind: PromiseNode\nauth:\n  required: false\n",
      "interface.yaml":
        "inputs:\n  - name: signal\n    type: object\noutputs:\n  - name: out\n    type: string\n",
      "api/run.yaml":
        "- name: call\n  method: GET\n  url: https://api.example.com/x\n  transport: json\n",
      "api/events.yaml": "- emit: out\n  value: \"return response\"\n",
      ...over,
    }).filter(([, v]) => v !== undefined),
  ),
});

test("every runnable node's composed schema carries the two controls, even with no config.yaml", () => {
  const node = composeNode(raw(), PKG);
  const props = (node.definition.configSchema as any).properties ?? {};
  assert.equal(props.authRequired?.type, "boolean");
  assert.equal(props.authRequired?.["ui:widget"], "toggle");
  assert.equal(props.authRequired?.default, false);
  assert.equal(props.authRole?.type, "string");
  assert.equal(props.authRole?.default, "");
  assert.deepEqual(props.authRole?.["ui:dependencies"], { authRequired: true });
});

test("an authored ui:order gets the controls appended last, as access settings, not job settings", () => {
  const node = composeNode(
    raw({ "config.yaml": 'configSchema:\n  type: object\n  properties:\n    city: { type: string }\n"ui:order": [city]\n' }),
    PKG,
  );
  assert.deepEqual(node.definition["ui:order"], ["city", "authRequired", "authRole"]);
});

test("a stale authored copy is superseded by the canonical definition, not merged", () => {
  // A pre-flip package could ship authRequired defaulting true, which would gate every
  // existing workflow. The injected definition must win wholesale.
  const node = composeNode(
    raw({
      "config.yaml":
        'configSchema:\n  type: object\n  properties:\n    authRequired: { type: boolean, default: true }\n    authRole: { type: string, default: x }\n"ui:order": [authRequired, authRole]\n',
    }),
    PKG,
  );
  const props = (node.definition.configSchema as any).properties ?? {};
  assert.equal(props.authRequired.default, false);
  assert.equal(props.authRole.default, "");
  assert.deepEqual(node.definition["ui:order"], ["authRequired", "authRole"]);
});

test("an annotation (no inputs, no outputs, no api) gets no access section: it is never run", () => {
  const node = composeNode(
    raw({
      "node.yaml": "type: Note\nkind: PromiseNode\nauth:\n  required: false\n",
      "interface.yaml": undefined,
      "api/run.yaml": undefined,
      "api/events.yaml": undefined,
    }),
    PKG,
  );
  const props = (node.definition.configSchema as any).properties ?? {};
  assert.equal(props.authRequired, undefined);
  assert.equal(props.authRole, undefined);
});
