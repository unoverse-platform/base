/**
 * Memory ingest — the agent saves its own conversation turns.
 *
 * Harness-level (model-agnostic): when an agent node's User Memory toggle
 * (config.enableUserMemory) is ON, each completed turn (original user input +
 * final agent answer — never intermediate iterations or tool chatter) is
 * POSTed to the memory server's /memory/ingest, which feeds the L1→L4
 * cascade (see docs/architecture/MEMORY_SPEC.md). Replaces the retired
 * GravityMemoryStore canvas node.
 *
 * Every agent family calls this at turn completion with its own node type;
 * fire-and-forget — memory must never block or fail the conversation.
 */

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || "http://localhost:4104";

export interface ConversationTurn {
  userMessage: string;
  agentResponse: string;
  reasoning?: string;
}

/**
 * Save one completed conversation turn to the memory server.
 * Resolves identity from the node's execution context; silently no-ops when
 * the toggle is off or identity is incomplete (e.g. canvas test runs with no
 * conversation). Never throws.
 */
export function ingestConversationTurn(
  config: { enableUserMemory?: boolean },
  executionContext: any,
  turn: ConversationTurn,
  logger: any,
  sourceNodeType: string,
): void {
  if (config?.enableUserMemory !== true) return;
  if (!turn.userMessage && !turn.agentResponse) return;

  const pubCtx = executionContext?.publishingContext;
  const userId = pubCtx?.userId;
  const workflowId = executionContext?.workflow?.id;
  const conversationId = pubCtx?.conversationId;
  if (!userId || !workflowId || !conversationId) {
    logger?.debug?.("[MemoryIngest] Skipped — incomplete identity", {
      hasUserId: !!userId,
      hasWorkflowId: !!workflowId,
      hasConversationId: !!conversationId,
    });
    return;
  }

  const payload: Record<string, any> = {
    userId,
    workflowId,
    conversationId,
    executionId: executionContext?.executionId || "",
    sourceNodeId: executionContext?.nodeId,
    sourceNodeType,
    timestamp: new Date().toISOString(),
  };
  // Only include fields with content — /memory/ingest rejects all-empty events
  if (turn.userMessage) payload.userMessage = turn.userMessage;
  if (turn.agentResponse) payload.agentResponse = turn.agentResponse;
  if (turn.reasoning) payload.reasoning = turn.reasoning;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const accessToken = executionContext?.auth?.accessToken;
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

  fetch(`${MEMORY_SERVICE_URL}/memory/ingest`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })
    .then((res) => {
      if (!res.ok) {
        logger?.warn?.(`[MemoryIngest] Ingest rejected: ${res.status}`);
      } else {
        logger?.info?.("[MemoryIngest] Turn saved to memory", {
          userMsg: turn.userMessage.length,
          agentResp: turn.agentResponse.length,
        });
      }
    })
    .catch((err) => {
      logger?.warn?.(`[MemoryIngest] Ingest failed (non-blocking): ${err.message}`);
    });
}
