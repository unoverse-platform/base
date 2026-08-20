/**
 * THE RUNTIME KERNEL LIVES IN THIS PACKAGE.
 *
 * These modules moved here from the engine and server trees so that base — the open
 * package — is everything needed to RUN a compiled workflow: routing over a frozen
 * route table, the default-deny auth gate, the registry-free memory core, and the
 * uWS ↔ Web-Fetch transport adapter. The engine and server keep re-export shims at
 * the old addresses; the Unoverse Runtime imports these subpaths directly.
 *
 * Two layers of guard:
 *  1. consumer surface — every subpath resolves BY PACKAGE NAME (the route a consumer
 *     takes), so a file move can't go silently missing the way the Studio loads once did.
 *  2. behavior — the routing filter, the auth gate's default-deny, and the memory
 *     toggle gating, exercised directly.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { SignalRoutingEngine, type RouteTable } from "@unoverse-platform/base/workflow/routing.js";
import {
  memoryFlagsForNode,
  isPlatformMemoryMethod,
  mergePlatformMemorySchema,
} from "@unoverse-platform/base/workflow/PlatformMemoryCore.js";
import { authorize, authorizeBuilder } from "@unoverse-platform/base/auth/auth.js";
import { isAuthEnabled, devIdentity } from "@unoverse-platform/base/auth/authConfig.js";

// ---------------------------------------------------------------------------
// Consumer surface — the kernel subpaths resolve by name
// ---------------------------------------------------------------------------

test("every runtime-kernel subpath resolves by package name and exports what its callers destructure", async () => {
  const routing = await import("@unoverse-platform/base/workflow/routing.js");
  assert.equal(typeof routing.SignalRoutingEngine.getSignalsForCompletedNode, "function");

  const memory = await import("@unoverse-platform/base/workflow/PlatformMemoryCore.js");
  for (const name of [
    "memoryFlagsForNode",
    "isPlatformMemoryMethod",
    "mergePlatformMemorySchema",
    "executePlatformMemoryMethod",
  ])
    assert.equal(typeof (memory as any)[name], "function", `PlatformMemoryCore exports ${name}`);

  const memoryClient = await import("@unoverse-platform/base/workflow/GetMemoryService.js");
  assert.equal(typeof memoryClient.GetMemoryService.search, "function");

  const auth = await import("@unoverse-platform/base/auth/auth.js");
  for (const name of ["authorize", "authorizeBuilder", "validateJWT", "unauthorizedResponse"])
    assert.equal(typeof (auth as any)[name], "function", `auth exports ${name}`);

  const adapter = await import("@unoverse-platform/base/http/uwsFetchAdapter.js");
  assert.equal(typeof adapter.handleFetch, "function");
});

// ---------------------------------------------------------------------------
// Routing behavior
// ---------------------------------------------------------------------------

function table(routing: Array<[string, any[]]>): RouteTable {
  return {
    routing: new Map(routing),
    dependencies: new Map(),
    connectorDependencies: new Map(),
    triggerNodes: [],
  };
}

test("routing: a flat output fires every outgoing edge with the pre-computed signal type", () => {
  const rt = table([
    [
      "a",
      [
        { targetNodeId: "b", signalType: "EXECUTE", targetHandle: "input" },
        { targetNodeId: "c", signalType: "SPAWN" },
      ],
    ],
  ]);
  const signals = SignalRoutingEngine.getSignalsForCompletedNode("a", { value: 1 }, rt);
  assert.deepEqual(
    signals.map((s) => [s.targetNodeId, s.signal, s.sourceNodeId]),
    [
      ["b", "EXECUTE", "a"],
      ["c", "SPAWN", "a"],
    ],
  );
  assert.equal(signals[0].targetHandle, "input");
});

test("routing: __outputs gates each edge on its sourceHandle having data (the branch filter)", () => {
  const rt = table([
    [
      "if1",
      [
        { targetNodeId: "then1", signalType: "EXECUTE", sourceHandle: "true" },
        { targetNodeId: "else1", signalType: "EXECUTE", sourceHandle: "false" },
      ],
    ],
  ]);
  const signals = SignalRoutingEngine.getSignalsForCompletedNode("if1", { __outputs: { true: { hit: 1 } } }, rt);
  assert.deepEqual(
    signals.map((s) => s.targetNodeId),
    ["then1"],
    "only the connector that produced data fires",
  );
});

test("routing: legacy multi-output (no __outputs) gates on the key existing in the output object", () => {
  const rt = table([
    [
      "sw",
      [
        { targetNodeId: "hasKey", signalType: "EXECUTE", sourceHandle: "match" },
        { targetNodeId: "noKey", signalType: "EXECUTE", sourceHandle: "miss" },
      ],
    ],
  ]);
  const signals = SignalRoutingEngine.getSignalsForCompletedNode("sw", { match: "x" }, rt);
  assert.deepEqual(
    signals.map((s) => s.targetNodeId),
    ["hasKey"],
  );
});

test("routing: a missing route table yields no signals, never a throw", () => {
  assert.deepEqual(SignalRoutingEngine.getSignalsForCompletedNode("a", {}, {} as any), []);
});

// ---------------------------------------------------------------------------
// Auth gate behavior (AUTH_ENABLED manipulated per test, restored after)
// ---------------------------------------------------------------------------

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("auth: default is ENABLED — a missing flag never opens the gate", async () => {
  await withEnv({ AUTH_ENABLED: undefined, DISABLE_AUTH: undefined }, async () => {
    assert.equal(isAuthEnabled(), true);
    const res = await authorize(null);
    assert.equal(res.ok, false, "no bearer + auth enabled = denied");
  });
});

test("auth: disabled admits the fixed dev identity, which carries NO permissions", async () => {
  await withEnv({ AUTH_ENABLED: "false" }, async () => {
    const res = await authorize(null);
    assert.deepEqual(res, { ok: true, userId: devIdentity().id });
    assert.deepEqual(devIdentity().permissions, [], "dev identity must not escalate permission gates");
  });
});

test("auth: the builder gate FAILS CLOSED when auth is disabled (never a dev pass-through)", async () => {
  await withEnv({ AUTH_ENABLED: "false" }, async () => {
    const res = await authorizeBuilder(null);
    assert.deepEqual(res, { ok: false, reason: "forbidden" });
  });
});

// ---------------------------------------------------------------------------
// Memory core gating behavior
// ---------------------------------------------------------------------------

const cachedWorkflow = {
  workflow: {
    nodes: [
      { id: "agentOn", data: { config: { enableUserMemory: true, enableAgentMemory: true } } },
      { id: "agentOff", data: { config: {} } },
    ],
  },
};

test("memory: flags resolve from the CALLING node's own config, never canvas-wide", () => {
  assert.deepEqual(memoryFlagsForNode(cachedWorkflow, "agentOn"), {
    userMemoryEnabled: true,
    agentMemoryEnabled: true,
  });
  assert.deepEqual(memoryFlagsForNode(cachedWorkflow, "agentOff"), {
    userMemoryEnabled: false,
    agentMemoryEnabled: false,
  });
});

test("memory: a memory method is only a memory method for an agent whose toggle is on", () => {
  const on = memoryFlagsForNode(cachedWorkflow, "agentOn");
  const off = memoryFlagsForNode(cachedWorkflow, "agentOff");
  assert.equal(isPlatformMemoryMethod("queryMemory", on), true);
  assert.equal(isPlatformMemoryMethod("queryMemory", off), false);
  assert.equal(isPlatformMemoryMethod("notATool", on), false);
});

test("memory: schema merge injects toolsets for enabled flags and returns base untouched otherwise", () => {
  const off = mergePlatformMemorySchema(null, { userMemoryEnabled: false, agentMemoryEnabled: false });
  assert.equal(off, null, "no toggle on → schema unchanged");

  const merged = mergePlatformMemorySchema(null, { userMemoryEnabled: true, agentMemoryEnabled: true });
  assert.ok(merged.methods.queryMemory, "user memory tool present");
  assert.ok(merged.methods.getGoalContext && merged.methods.archiveGoal, "goal toolset present");
});

test("memory: a harness BUILDER (UnoverseMCP tools present) is stripped of goal-lifecycle authority", () => {
  const builderBase = { name: "X", version: "1", methods: { saveWorkflow: {}, runTest: {} }, instructions: "" };
  const merged = mergePlatformMemorySchema(builderBase, { userMemoryEnabled: false, agentMemoryEnabled: true });
  assert.ok(merged.methods.writeNote && merged.methods.getGoalContext, "read + journal tools kept");
  assert.equal(merged.methods.archiveGoal, undefined, "builder cannot self-certify via archiveGoal");
  assert.equal(merged.methods.resumeGoal, undefined, "builder cannot reopen goals");
});
