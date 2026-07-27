/**
 * Node Execution - Handles executing nodes (PromiseNode, CallbackNode, ServiceCall)
 */

import type { NodeDefinition } from "./types.js";
import { getNode } from "./registry.js";
import { buildExecutionContext } from "./platform/index.js";

/**
 * Create a logger for a node type - outputs structured JSON for Loki/Promtail
 */
function createLogger(nodeType: string) {
  const log = (level: string, ...args: any[]) => {
    const msg = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
    console.log(JSON.stringify({ level, nodeType, msg, service: "node-service" }));
  };
  return {
    info: (...args: any[]) => log("info", ...args),
    error: (...args: any[]) => log("error", ...args),
    debug: (...args: any[]) => log("debug", ...args),
    warn: (...args: any[]) => log("warn", ...args),
  };
}

/**
 * Execute a PromiseNode (single execution, returns result)
 */
async function executePromiseNode(nodeDef: NodeDefinition, inputs: any, config: any, context: any) {
  const ExecutorClass = nodeDef.executor.executor || nodeDef.executor;
  const executor = new ExecutorClass(nodeDef.type);

  // Inject logger into executor (base classes expect this.logger)
  executor.logger = createLogger(nodeDef.type);

  // Ensure base class methods are available (some executors call this.validateAndGetContext)
  if (!executor.validateAndGetContext) {
    executor.validateAndGetContext = (ctx: any) => ({
      workflowId: ctx?.workflowId || ctx?.workflow?.id || "",
      executionId: ctx?.executionId || ctx?.workflow?.runId || "",
      nodeId: ctx?.nodeId || "",
    });
  }

  if (!executor.execute || typeof executor.execute !== "function") {
    throw new Error(`Node ${nodeDef.type} executor does not have an execute method`);
  }

  const executionContext = buildExecutionContext(nodeDef.type, inputs, config, context);
  return await executor.execute(inputs, config, executionContext);
}

/**
 * Execute a CallbackNode (generator, emits multiple outputs)
 * Returns an async generator that yields outputs
 */
export async function* executeCallbackNode(nodeDef: NodeDefinition, inputs: any, config: any, context: any) {
  const ExecutorClass = nodeDef.executor.executor || nodeDef.executor;
  const executor = new ExecutorClass(nodeDef.type);

  // Inject logger into executor (base classes expect this.logger)
  executor.logger = createLogger(nodeDef.type);

  // Ensure base class methods are available (some executors call this.validateAndGetContext)
  if (!executor.validateAndGetContext) {
    executor.validateAndGetContext = (ctx: any) => ({
      workflowId: ctx?.workflowId || ctx?.workflow?.id || "",
      executionId: ctx?.executionId || ctx?.workflow?.runId || "",
      nodeId: ctx?.nodeId || "",
    });
  }

  if (!executor.initializeState || !executor.handleEvent) {
    throw new Error(`Node ${nodeDef.type} is a CallbackNode but missing initializeState or handleEvent`);
  }

  const executionContext = buildExecutionContext(nodeDef.type, inputs, config, context);

  // Set executionContext on executor for nodes that need it (e.g., OpenAIStream)
  executor.executionContext = executionContext;

  // Initialize state
  let state = executor.initializeState(inputs);

  // Queue-based streaming: emit() pushes to queue, generator yields from queue
  const outputQueue: any[] = [];
  const state_: { resolver: ((v: { value: any; done: boolean }) => void) | null; done: boolean } = {
    resolver: null,
    done: false,
  };

  // emit() either resolves a waiting consumer or queues the output
  let emitCount = 0;
  const emit = (output: any) => {
    emitCount++;
    if (state_.resolver) {
      const resolve = state_.resolver;
      state_.resolver = null;
      resolve({ value: output, done: false });
    } else {
      outputQueue.push(output);
    }
  };

  // Run execution in background - don't await it
  const executionPromise = (async () => {
    try {
      // Pass executionContext as 4th parameter for nodes that need it (e.g., AWSNovaSpeech)
      state = await executor.handleEvent({ type: "EXECUTE", inputs, config }, state, emit, executionContext);

      // Only auto-continue if node is NOT yielding for user input (focusInputRequired).
      // Guard against a node that never completes and makes no progress: a signal-driven
      // node (e.g. Loop) run standalone takes "no action" on CONTINUE and never sets
      // isComplete, which would spin forever and flood logs. Break after repeated
      // no-progress iterations (no new emit AND unchanged state), plus a hard backstop.
      const stateSig = (s: any) => {
        try {
          return JSON.stringify(s ?? null);
        } catch {
          return String(emitCount); // uncomparable state → fall back to emit progress
        }
      };
      // The signature is consulted ONLY when emits have stalled: stringifying the full
      // node state per iteration is O(state size) per chunk — O(n²) over a long stream
      // for a state-accumulating node (message history, streamed text). Emit progress
      // alone proves progress on the common path, so skip the stringify entirely there.
      let prevSig: string | null = null;
      let prevEmit = emitCount;
      let stalls = 0;
      let total = 0;
      while (!state.isComplete && !state.focusInputRequired) {
        if (++total > 100000) break; // hard backstop
        state = await executor.handleEvent(
          { type: "CONTINUE", inputs: { continue: true }, config },
          state,
          emit,
          executionContext,
        );
        if (emitCount !== prevEmit) {
          stalls = 0;
          prevSig = null; // stale — recompute only if emits stall again
        } else {
          const sig = stateSig(state);
          if (prevSig !== null && sig !== prevSig) {
            stalls = 0;
          } else if (prevSig !== null && ++stalls >= 3) {
            // No new emit and unchanged state across a few CONTINUEs → the node is
            // signal-driven (e.g. Loop) and won't advance standalone. Stop quietly.
            break;
          }
          prevSig = sig;
        }
        prevEmit = emitCount;
      }
    } finally {
      state_.done = true;
      // Signal completion to any waiting consumer
      if (state_.resolver) {
        const resolve = state_.resolver;
        state_.resolver = null;
        resolve({ value: undefined, done: true });
      }
    }
  })();

  // Yield outputs as they arrive
  try {
    while (true) {
      // First drain the queue
      if (outputQueue.length > 0) {
        yield outputQueue.shift();
        continue;
      }

      // If execution is done, drain any remaining queue items before finishing
      if (state_.done) {
        // CRITICAL: Yield any remaining queued outputs before exiting
        // This ensures the final emit() is always sent to the client
        while (outputQueue.length > 0) {
          yield outputQueue.shift();
        }
        break;
      }

      // Wait for next output or completion
      const result = await new Promise<{ value: any; done: boolean }>((resolve) => {
        state_.resolver = resolve;
      });

      if (result.done) {
        break;
      }

      yield result.value;
    }
  } finally {
    // Ensure execution completes even if generator is abandoned
    await executionPromise;
  }
}

/**
 * Execute a service call on a node (calls handleServiceCall method)
 * Used for service nodes like OpenAIEmbeddingService, BedrockEmbeddingService
 */
export async function executeServiceCall(
  nodeType: string,
  method: string,
  params: any,
  config: any,
  context: any,
): Promise<any> {
  const nodeDef = getNode(nodeType);

  if (!nodeDef) {
    throw new Error(`Node type not found: ${nodeType}`);
  }

  if (!nodeDef.executor) {
    throw new Error(`No executor found for node type: ${nodeType}`);
  }

  const ExecutorClass = nodeDef.executor.executor || nodeDef.executor;
  const executor = new ExecutorClass();

  // Inject logger into executor (base classes expect this.logger)
  executor.logger = createLogger(nodeType);

  if (!executor.handleServiceCall || typeof executor.handleServiceCall !== "function") {
    throw new Error(`Node ${nodeType} executor does not have a handleServiceCall method`);
  }

  const executionContext = buildExecutionContext(nodeType, {}, config, context);
  return await executor.handleServiceCall(method, params, config, executionContext);
}

/**
 * Execute a node (dispatches to correct executor based on type)
 */
export async function executeNode(nodeType: string, inputs: any, config: any, context: any) {
  const nodeDef = getNode(nodeType);

  if (!nodeDef) {
    throw new Error(`Node type not found: ${nodeType}`);
  }

  if (!nodeDef.executor) {
    throw new Error(`No executor found for node type: ${nodeType}`);
  }

  // PromiseNode - single execution
  if (nodeDef.executionMode === "single") {
    return await executePromiseNode(nodeDef, inputs, config, context);
  }

  // CallbackNode - collect all outputs and return final result
  const outputs: any[] = [];
  for await (const output of executeCallbackNode(nodeDef, inputs, config, context)) {
    outputs.push(output);
  }

  // Return the last output (final result)
  return outputs[outputs.length - 1] || {};
}
