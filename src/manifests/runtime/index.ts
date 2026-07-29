/**
 * THE MANIFEST RUNTIME — the half that COMPUTES what a manifest DESCRIBES.
 *
 * The split (DECLARATIVE_NODES.md §2): every enum value in api.schema.json must have an
 * implementation somewhere in this folder and NOWHERE else, which is what makes accepting a
 * manifest from someone else safe. `manifest-capabilities.test.ts` enforces that parity by
 * walking the schema and this tree, so a capability offered without code fails the build rather
 * than a stranger's workflow.
 *
 * Nothing in here is per-vendor. Adding an auth scheme or a transport makes it available to
 * every node that will ever be written.
 *
 * THIS FILE IS A BARREL and should stay one. It held the two channels, the narrator and the
 * last-call dispatch until it reached 425 lines of four unrelated concerns, which is the shape
 * of file nobody reads and everybody appends to. One import surface, no logic:
 *
 *   context.ts     what a manifest may see, and the resolvers applied first
 *   templating.ts  {{ }} and `return ...`, both borrowed from the platform
 *   events.ts      the events table: everything that LEAVES a node, in one ordered list
 *   narrate.ts     the running commentary while it works
 *   state.ts       platform storage, and the run's saved context
 *   channels/      the two ways a node is reached, which never cross
 *     workflow.ts  the GRAPH runs it: the shape of a run, start to finish
 *     final.ts     the last call, the only one that may stream — one dispatch per reply shape
 *     service.ts   an AGENT calls it: one method, one value handed straight back
 *   http/          building and sending. One fetch, one allowedHosts check
 *   auth/          the schemes, per scheme
 *   loops/         many requests, or many passes, for one node: paginate, poll, chunk, loop
 *   duplex/        a socket that stays open. Two of them: the vendor's and the audio lane
 *   tools/         the HTTP tool exchange, by turns
 */
export type { RunContext } from "./context.js";
export type { Emission } from "./http/response.js";
export { emptyContext, applyResolvers, RESOLVERS } from "./context.js";
export { render, evaluate, primeTemplating } from "./templating.js";
export { assertAllowedHost } from "./http/allowedHosts.js";
export { buildRequest, resolveBody, sendRequest, runCalls } from "./http/request.js";
export { readSse, readSettled, assertOk } from "./http/response.js";
export { makeStateStore, performState, type StateStore } from "./state.js";
export { fetchPaginated } from "./loops/paginate.js";
export { fetchPolled } from "./loops/poll.js";
export { sendChunked } from "./loops/chunk.js";
// Iteration bookkeeping for the LoopStart/LoopEnd pair. ONE capability rather than the seven raw
// Redis commands the retired nodes reached for — see loops/loop.ts for why that distinction is
// the whole point.
export { performLoop, normaliseItems, makeLoopOps, type LoopOps, type LoopPass, type LoopStep } from "./loops/loop.js";
export { makeEmitter, type Emitter, type EventSource } from "./events.js";
export { makeNarrator, type Narrator } from "./narrate.js";
export { runToolLoop, type ToolBridge } from "./tools/toolloop.js";
export { performDoc, MUTATING_DOC_OPS, docKeyFor } from "./docstore/index.js";
export { runDuplexSession } from "./duplex/session.js";
// The audio lane is its own module: session.ts owns the VENDOR socket, audioLane.ts owns the bytes
// and the browser. Two sockets, two files.
export { resamplePcm16, makeAudioBuffer, CLIENT_RATE, type AudioLane } from "./duplex/audioLane.js";
export { performApi, type RunResult } from "./channels/workflow.js";
export { runFinal } from "./channels/final.js";
export { performService } from "./channels/service.js";
