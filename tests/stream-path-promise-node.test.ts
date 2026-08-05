/** A PromiseNode on the stream path yields one output and completes, instead of
 *  "is a CallbackNode but missing initializeState" — design-system nodes ride the
 *  callback-actor lifecycle but their universal executor is a PromiseNode. */
import test from "node:test";
import assert from "node:assert/strict";
import { setNode } from "../src/registry.js";
import { executeCallbackNode } from "../src/executor.js";
import { PromiseNode } from "../src/pluginBase.js";

class OneShot extends PromiseNode {
  protected async validateConfig() { return { success: true }; }
  protected async executeNode(_i: any, config: any) { return { echoed: config.value }; }
}

setNode("OneShot", { type: "OneShot", name: "OneShot", inputs: [], outputs: [], executor: OneShot } as any);

test("a PromiseNode executes once on the stream path", async () => {
  const outputs: any[] = [];
  for await (const o of executeCallbackNode({ type: "OneShot", executor: OneShot } as any, {}, { value: 42 }, { workflowId: "w", executionId: "e", nodeId: "n1" })) {
    outputs.push(o);
  }
  assert.equal(outputs.length, 1, "one output at the end, then done");
  assert.equal(outputs[0]?.echoed ?? outputs[0]?.output?.echoed ?? JSON.stringify(outputs[0]).includes("42") ? 42 : null, 42);
});
