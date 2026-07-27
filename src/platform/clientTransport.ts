/**
 * THE WAY BACK TO A CONNECTED PERSON. Injected, never imported.
 *
 * A running node sometimes has to reach the browser that is waiting on it: a realtime node
 * streams audio down, and a component node pushes a rendered piece of interface. Both are
 * genuinely needed, and neither belongs in this package.
 *
 * The reason is not taste. The audio path is a uWebSockets socket and the component path is
 * an MCP stream with its own session registry: both are the SERVER's connections, owned by
 * the process that accepted them. This package reached across and imported them directly,
 * which meant it could not be installed anywhere else — the imports pointed at a folder that
 * only exists in that one repo.
 *
 * So it is inverted. This file says WHAT the runtime needs, in four functions; the server
 * hands in HOW at boot, exactly as it already does for Redis (`setRedisClient`).
 *
 * DEFAULTS ARE NO-OPS, deliberately. A box that runs nodes with nobody watching (a cron, a
 * queue worker, a test) has no client to push to, and that is a normal state rather than a
 * failure. A node that emits audio into a run nobody is watching should carry on, not throw.
 */

export interface ClientTransport {
  /**
   * Push a message to a client over the data plane. Rendered components travel this way.
   * Keyed by userId AND conversationId, because one person may have several open.
   * Returns false when nobody is listening.
   */
  pushToClient(userId: string, conversationId: string, message: Record<string, any>): boolean;

  /** Stream audio bytes down to a connected client. False when nobody is listening. */
  sendAudioToClient(conversationId: string, audioData: Buffer | ArrayBuffer): boolean;

  /** Tell a client the audio session changed state (started, ended, interrupted). */
  sendAudioStateToClient(conversationId: string, state: string, metadata?: Record<string, unknown>): boolean;

  /** Register the handler for audio arriving FROM a client. */
  setAudioDataHandler(handler: (conversationId: string, audioData: ArrayBuffer) => Promise<void>): void;

  /** Register the handler for audio control messages from a client. */
  setAudioControlHandler(handler: (conversationId: string, message: Record<string, unknown>) => Promise<void>): void;
}

/**
 * `false` from the send functions, not `true`: with no transport there IS no listener, and
 * saying otherwise would have a caller believe audio reached someone.
 */
const NONE: ClientTransport = {
  pushToClient: () => false,
  sendAudioToClient: () => false,
  sendAudioStateToClient: () => false,
  setAudioDataHandler: () => {},
  setAudioControlHandler: () => {},
};

let transport: ClientTransport = NONE;

/** Called once by the host at boot, with its own websocket and data-plane implementations. */
export function setClientTransport(impl: Partial<ClientTransport>): void {
  transport = { ...NONE, ...impl };
}

/** The transport in force. Never null, so no caller has to guard. */
export function clientTransport(): ClientTransport {
  return transport;
}
