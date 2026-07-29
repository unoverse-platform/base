/**
 * WHAT THE EXECUTOR ASSEMBLES FROM THE EXECUTION CONTEXT and hands to PLATFORM code —
 * never to the manifest. `context.ts` builds what a manifest may READ; these build what
 * the runtime's own capabilities need, and the difference is exactly the token rule:
 * `sessionFor` carries the caller's JWT because the platform calling its own surface on
 * the user's behalf is not data deciding where a secret goes.
 */
import { makeStateStore } from "../runtime/index.js";

/**
 * WHO IS WATCHING, for a service method that renders content cards onto a live screen or
 * a node that publishes template data.
 *
 * Kept out of `contextFor` on purpose (§9.4): a manifest that could read the token could
 * forward it anywhere its allowedHosts allows.
 *
 * `publishingContext` is the trigger-supplied identity of the conversation the run belongs
 * to. Absent for builder, test and headless callers, which is exactly when card rendering
 * should no-op rather than needing a flag.
 */
export function sessionFor(executionContext: any) {
  const pub = executionContext?.publishingContext;
  return {
    userId: pub?.userId,
    conversationId: pub?.conversationId,
    chatId: pub?.chatId,
    accessToken: executionContext?.auth?.accessToken,
  };
}

/**
 * The platform's audio lane, through the same handle a code node already gets.
 *
 * `null` when the platform has no lane, and that is NOT an error: a voice node with nowhere to
 * send audio still holds a valid conversation with the vendor, and its transcripts still reach
 * the workflow over the events table. Only the audio is lost, which is the correct degradation
 * for a headless run.
 */
export function audioLaneFor(executionContext: any) {
  return executionContext?.api?.getAudioWebSocketManager?.() ?? null;
}

/** Redis, through the handle the plugin library already provides to a code node. */
export function stateStoreFor(executionContext: any) {
  return makeStateStore(executionContext?.api?.getRedisClient?.() ?? null, process.env.REDIS_NAMESPACE);
}
