/**
 * THE DISCOVERY ABSORBER IS CALLED, AND IT IS ONE CALL.
 *
 * `handleDiscoveryResult` unlocks a discovered app, SHELL-OPENS its page, and leans the rows.
 * The manifest bridge re-implemented two of those three as separate methods, and the step
 * between them went missing — the empty native invoke that paints the page skeleton.
 *
 * NOTHING FAILED when it went. The tool was minted, the model answered, the workflow went
 * green, and the page never appeared until the model composed it. The bug's signature is
 * silence, so the only thing that catches it is asserting the call is still made.
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
  assert.ok(/harness\.handleDiscoveryResult\(/.test(src("../src/manifests/executor/toolBridge.ts")), "the bridge no longer absorbs — the shell-open is gone again");

  const loop = src("../src/manifests/runtime/tools/toolloop.ts");
  assert.ok(/bridge\.absorb\(/.test(loop), "the HTTP tool loop does not absorb");
  assert.ok(!/mintFrom\(|lean\(resultContent: string\): string;/.test(loop), "the split mint/lean pair is back on the ToolBridge");
  assert.ok(/tools\.absorb\(/.test(src("../src/manifests/runtime/duplex/session.ts")), "the duplex session does not absorb");
});

test("the shell-open and its draft refs still ride the absorber", () => {
  // Guard the guard. Move these out and the assertions above keep passing while the
  // behaviour they protect is gone.
  const discovery = src("../src/agent-mcp/discovery.ts");
  assert.ok(/invokeComponentAppNative\(/.test(discovery), "the shell-open left discovery.ts");
  assert.ok(/__draftRefs/.test(discovery), "the draft refs left discovery.ts — the page opens empty");
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
