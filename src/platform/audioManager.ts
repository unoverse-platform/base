/**
 * Distributed Audio Manager
 * Provides the audio WebSocket manager interface voice plugins (aws-nova /
 * openai-realtime) use. Live audio now streams DIRECTLY from this process to the
 * channel SDK over the in-process `/ws/gravity` WS (UNOVERSE_MCP_TEMPLATE_PROTOCOL
 * §5a-refined) — NOT relayed through the legacy gateway. Component publishing
 * (publishToClient / SERVICE_PUBLISH) still goes to the gateway and is untouched.
 */

import { clientTransport } from "./clientTransport.js";

export interface AudioWebSocketManager {
  setAudioDataHandler(handler: (conversationId: string, audioData: ArrayBuffer, metadata?: any) => Promise<void>): void;
  setControlMessageHandler(handler: (conversationId: string, message: any) => Promise<void>): void;
  startAudioSession(conversationId: string, novaSessionId?: string): void;
  endAudioSession(conversationId: string): void;
  isConnected(conversationId: string): boolean;
  sendAudio(conversationId: string, audioData: Buffer | ArrayBuffer): boolean;
  sendControl(conversationId: string, message: Record<string, any>): boolean;
}

class DistributedAudioManager implements AudioWebSocketManager {
  private audioSessions: Map<string, { novaSessionId?: string; active: boolean }> = new Map();

  /**
   * Set audio data handler (called by WebSocketAudioSubscriber)
   */
  setAudioDataHandler(
    handler: (conversationId: string, audioData: ArrayBuffer, metadata?: any) => Promise<void>
  ): void {
    clientTransport().setAudioDataHandler(async (conversationId, audioData) => {
      const session = this.audioSessions.get(conversationId);
      if (session?.active) {
        await handler(conversationId, audioData, { novaSessionId: session.novaSessionId });
      }
    });
    // Wiring, not news.
  }

  /**
   * Set control message handler (called by WebSocketAudioSubscriber)
   */
  setControlMessageHandler(handler: (conversationId: string, message: any) => Promise<void>): void {
    clientTransport().setAudioControlHandler(handler);
    // Wiring, not news.
  }

  /**
   * Start audio session
   */
  startAudioSession(conversationId: string, novaSessionId?: string): void {
    this.audioSessions.set(conversationId, { novaSessionId, active: true });
    console.log(`[DistributedAudioManager] Audio session started: ${conversationId}`);
  }

  /**
   * End audio session
   */
  endAudioSession(conversationId: string): void {
    const session = this.audioSessions.get(conversationId);
    if (session) {
      session.active = false;
    }
    console.log(`[DistributedAudioManager] Audio session ended: ${conversationId}`);
  }

  /**
   * Check if connected (always true if WebSocket is connected)
   */
  isConnected(conversationId: string): boolean {
    return this.audioSessions.has(conversationId);
  }

  /**
   * Send audio to client via server
   */
  sendAudio(conversationId: string, audioData: Buffer | ArrayBuffer): boolean {
    return clientTransport().sendAudioToClient(conversationId, audioData);
  }

  /**
   * Send control/state message to client via server
   */
  sendControl(conversationId: string, message: Record<string, any>): boolean {
    if (message.type === "AUDIO_STATE" || message.state) {
      return clientTransport().sendAudioStateToClient(conversationId, message.state || message.type, message.metadata);
    }
    return false;
  }
}

// Singleton instance
let distributedAudioManager: DistributedAudioManager | null = null;

export function getDistributedAudioManager(): AudioWebSocketManager {
  if (!distributedAudioManager) {
    distributedAudioManager = new DistributedAudioManager();
  }
  return distributedAudioManager;
}
