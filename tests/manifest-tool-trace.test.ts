/**
 * EVERY TOOL CALL RECORDS A TRACE, which is what draws the nested bar on the execution
 * timeline (`findIntent MCP (1 of 5 tools) 1.51s`).
 *
 * The AGENT records it, not the tool. Every legacy agent did — OpenAIAgent, Grok, Realtime —
 * and the manifest loop that replaced them did not, so the bar disappeared the day `openai`
 * migrated to YAML. The symptom appeared under whichever node was being CALLED, which is
 * where two separate investigations went looking before anyone checked the caller.
 *
 * `success` is the field that matters. A failed tool still returns a string to the model (a
 * JSON error object), so from outside, a broken tool and an empty result are identical: the
 * workflow completes green and the model answers from its own knowledge. That happened three
 * times in one session before it was visible. This is the flag that turns it red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/manifests/runtime/tools/toolloop.ts", import.meta.url), "utf8");
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("the tool loop records a trace for every tool call", () => {
  assert.ok(/saveMCPTraceToWorkflow/.test(CODE), "the loop no longer records MCP traces — the timeline bar is gone");
  assert.ok(/recordToolTrace\(/.test(CODE), "recordToolTrace is not called");
});

test("the trace is recorded on FAILURE as well as success", () => {
  /**
   * The whole point. Recording only successes would restore the bar and keep the invisible
   * failure, which is the worse half of the bug: a tool that returns `{}` looks exactly like
   * a tool with nothing to say.
   *
   * Asserted structurally: the call must sit AFTER the try/catch, so both paths reach it,
   * rather than inside the `try` where a throw would skip it.
   */
  const loop = CODE.slice(CODE.indexOf("const startedAt"));
  const catchAt = loop.indexOf("catch");
  const recordAt = loop.indexOf("recordToolTrace(");
  assert.ok(catchAt > 0 && recordAt > 0, "could not find the try/catch and the record call");
  assert.ok(
    recordAt > catchAt,
    "recordToolTrace runs inside the try, so a thrown tool call is never recorded — the failure stays invisible",
  );
  assert.ok(/ok = false/.test(loop), "the catch does not mark the trace unsuccessful");
});

test("tracing cannot slow or fail a run", () => {
  // Fire and forget: observability must never hold up a tool loop, and an analytics hop
  // that is down must never fail the workflow it is watching.
  assert.ok(/void saveMCPTraceToWorkflow/.test(CODE), "the trace is awaited — a slow analytics hop would stall the loop");
  assert.ok(/\.catch\(/.test(CODE.slice(CODE.indexOf("saveMCPTraceToWorkflow"))), "a failed trace post is not swallowed");
});

test("no execution id means no trace, rather than an orphan row", () => {
  // The node-test and headless case. There is no execution to attach a bar to, and a trace
  // with no parent would create a row nothing renders.
  assert.ok(
    /if \(!executionId \|\| !parentNodeId\) return;/.test(CODE),
    "a trace is posted even with no execution to attach it to",
  );
});

test("the recorded result is an OBJECT, not an escaped string", () => {
  /**
   * A tool result crosses MCP as text, so the loop holds a string. Stored raw, the trace
   * viewer showed `"[{\"universal_id\":\"...` — technically the result, and unreadable,
   * which defeats the reason for recording it at all.
   *
   * Best-effort: a tool that legitimately returns prose must keep its string rather than
   * being dropped or mangled.
   */
  assert.ok(/JSON\.parse\(result\)/.test(CODE), "the tool result is stored without being parsed");
  assert.ok(/result: parsed/.test(CODE), "the trace still posts the raw string");
  assert.ok(/parsed = result/.test(CODE), "a non-JSON result is not preserved as-is");
});
