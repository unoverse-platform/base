/**
 * THE DISCOVERY ABSORBER IS CALLED, IT IS ONE CALL, AND IT NEVER CALLS THE APP.
 *
 * `handleDiscoveryResult` unlocks a discovered app and leans the rows. It does NOT invoke
 * it. Finding a component in search results is not someone asking for it; only the model's
 * own tool call is, and native MCP is one call, one render, one elicitation, answers back
 * (MCP_TEMPLATE_PROTOCOL §3.3).
 *
 * REVERSED 2026-08-10. Two fire-and-forget invocations lived here to paint a composed
 * page's frame early: a shell-open on unlock, and a draft top-up when a later search
 * carried image rows. Both went through `invokeComponentAppNative`, which on an app whose
 * component declares `outputs` renders the component AND opens an elicitation. Observed
 * live: THREE renders and three concurrent forms in ONE turn, of which the channel can
 * hold one (connection.tsx keeps a single pending resolver), so two hung and the guest's
 * submit landed on nothing. The earlier version of this file asserted those calls were
 * present; it is inverted below rather than deleted, because the failure it guarded
 * against (a step silently going missing) is real in both directions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("both agent paths call the harness absorber, and it is ONE method", () => {
  /**
   * Two methods is what let a step vanish between them: each half looked complete alone, and
   * no call site owned the middle. HTTP and voice both, because "shared by every agent
   * family" is the harness's claim about itself.
   */
  assert.ok(/harness\.handleDiscoveryResult\(/.test(src("../src/manifests/executor/toolBridge.ts")), "the bridge no longer absorbs");

  const loop = src("../src/manifests/runtime/tools/toolloop.ts");
  assert.ok(/bridge\.absorb\(/.test(loop), "the HTTP tool loop does not absorb");
  assert.ok(!/mintFrom\(|lean\(resultContent: string\): string;/.test(loop), "the split mint/lean pair is back on the ToolBridge");
  assert.ok(/tools\.absorb\(/.test(src("../src/manifests/runtime/duplex/session.ts")), "the duplex session does not absorb");
});

test("DISCOVERY NEVER CALLS THE APP", () => {
  /**
   * The absorber reads rows, unlocks the tool, and returns the lean projection. One wire
   * call to an app exists in this harness (`invoke.ts`) and the MODEL drives it. Any
   * invocation from here is a render the guest did not ask for, and on an outputs-declaring
   * component it is a second form competing for the one pending elicitation the channel can
   * hold. An "early frame", if it comes back, cannot be an app invocation.
   */
  const discovery = src("../src/agent-mcp/discovery.ts");
  assert.ok(!/invokeComponentAppNative\(/.test(discovery), "discovery invokes an app again — every unlock is now a render + an elicitation");
  assert.ok(!/__draftRefs/.test(discovery), "the draft top-up is back — a second invocation per search that carries images");
  /**
   * And discovery does not REWRITE the model's search either. `anchorSearchArgs` forced the
   * turn's raw ask in as queries[0] on every discovery call. Every entry in `queries` is a
   * separate search, so pinning the opening ask there re-runs the search that unlocked the
   * app, on every later turn, for the life of the conversation. It was written, exported and
   * never called; deleted 2026-08-10 rather than left one import away from being switched on.
   */
  assert.ok(!/anchorSearchArgs/.test(discovery), "the ask anchor is back — every search re-runs the opening ask");
});

test("the harness projection is a FLOOR, not the only one", () => {
  /**
   * It keeps `app`, and it is generic: any search-shaped tool result, any node. It does NOT
   * know that spatial's `bodyCopy` belongs behind readResult, or that a plain need keeps no
   * metadata at all. Deleting a node's own projection because this one exists shipped the
   * full rows — jsonLd, openGraph, UMAP coordinates, every bodyCopy — about 100k tokens per
   * search. The two compose; neither replaces the other.
   */
  const LEAN = readFileSync(new URL("../src/agent-mcp/lean.ts", import.meta.url), "utf8");
  assert.ok(/"app",/.test(LEAN), "the harness projection no longer keeps `app`");
  assert.ok(
    /Array\.isArray\(parsed\.results\)/.test(LEAN),
    "the harness projection no longer requires {results} — it silently no-ops on a bare array",
  );
});
