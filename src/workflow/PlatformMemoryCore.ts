/**
 * Platform Memory Tools — the REGISTRY-FREE core (schemas, gating, execution).
 *
 * Split from PlatformMemoryTools.ts (import-graph only, zero behavior change): everything here
 * depends only on the logger + GetMemoryService + fetch, so the Unoverse Runtime can import it
 * without dragging the engine's node/service registries (and through them Prisma + the XState
 * actors) into its bundle — measured 148KB → 1MB before this split. PlatformMemoryTools.ts stays
 * the engine-facing module: it re-exports all of this and adds the one registry-coupled step
 * (setAvailableTools trace sync) inside injectPlatformMemoryTools. Engine callers are unchanged.
 *
 * BOTH memory faculties are PER-AGENT toggles on the agent node's own config
 * (resolved from the calling node via memoryFlagsForNode), never canvas-wide:
 *   - data.config.enableUserMemory  → queryMemory   (who is this user)
 *   - data.config.enableAgentMemory → getGoalContext, writeNote,
 *       updateGoalState, searchHistory, resumeGoal, archiveGoal  (goal-scoped working memory)
 *
 * Per-agent (not canvas-wide) so memory never leaks into worker agents UNO
 * builds inside the workflows it creates — those default off. Still a TOGGLE,
 * not a connector: a bare agent with the toggle on still gets its schema with
 * zero service edges. Errors return as data ({success:false, error}) — a thrown
 * error becomes a 500 and the agent never sees the message.
 */

import { createLogger } from "../logger.js";
import { GetMemoryService } from "./GetMemoryService.js";

const logger = createLogger("PlatformMemoryTools");
// Server-to-server MEMORY_SERVICE_URL means the PLATFORM LANE (:4114, asserted identity)
// — the docker-compose doctrine, and what every other engine/server caller defaults to.
// The old :4104 default sent tokenless callers (debug runs, the builder MCP's goal tools)
// to the public JWT door, where every write 401'd silently.
const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || "http://localhost:4114";

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

// The ONE user-memory tool (MEMORY_SPEC v3 § Serving). The standing snapshot is no
// longer a tool at all — the agent HARNESS injects who-the-user-is + current state
// into the system context at init (zero calls). queryMemory remains as the single
// depth door: search the user's remembered facts when a topic needs prior context.
export const USER_MEMORY_METHODS: Record<string, any> = {
  queryMemory: {
    description:
      "Search the user's remembered facts by topic (semantic + keyword). Use mid-conversation when a specific topic needs prior context — budget, preferences, past decisions about X, or where an earlier plan got to. Returns claims with certainty scores — weight stronger evidence higher. This is evidence about the user specifically, not a knowledge-base search. (A summary of who the user is was already provided in your context — query only for depth beyond it.)",
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Topic to search in user memory" },
      },
      required: ["query"],
    },
  },
};

export const AGENT_MEMORY_METHODS: Record<string, any> = {
  getGoalContext: {
    description:
      "Your wake-up briefing: the active goal (description, acceptance criteria), your last saved goal-state (plan, current step, blockers), recent journal notes, durable environment facts, and recent past-goal summaries. Call FIRST when starting or resuming work — it replaces re-reading history. Read-only, cheap.",
    input: { type: "object", additionalProperties: false, properties: {} },
  },
  writeNote: {
    description:
      "Append one note to your persistent journal (survives context resets and restarts). Write decisions WITH the why (category 'decision'), surprises/failures with cause ('error'), durable environment facts like rate limits or schema quirks ('fact' — these outlive the goal), step completions ('progress'). Never write transcripts or tool output that can be re-fetched. Be specific: numbers, names, ids.",
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        content: { type: "string", description: "The note. Specific and self-contained." },
        category: {
          type: "string",
          enum: ["progress", "result", "pending", "error", "note", "decision", "fact"],
          description: "decision = choice + why; fact = durable environment learning; pending = blocked/waiting",
        },
      },
      required: ["content", "category"],
    },
  },
  updateGoalState: {
    description:
      "Overwrite your compact goal-state object — the FIRST thing future-you reads after a reset. Keep it current after each meaningful step: the goal description, the plan (short steps with status), the current step, and blockers. Supplied fields merge over the existing state; it is also snapshotted to durable storage. (The acceptance bar is NOT set here — lockCriteria authors and locks it independently, so you cannot grade your own homework.)",
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        description: { type: "string", description: "The goal in one sentence (sets/updates the goal description)" },
        plan: { type: "array", items: { type: "string" }, description: "Short step list, each prefixed with its status, e.g. '[done] fetch schema'" },
        currentStep: { type: "string", description: "What is being worked on right now" },
        blockers: { type: "array", items: { type: "string" }, description: "Open blockers; empty array clears them" },
      },
    },
  },
  searchHistory: {
    description:
      "Summaries of previously completed goals on this canvas, most recent first. Use at plan time — before starting something that may have been attempted before, and before retrying a failed approach.",
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "number", description: "Max summaries to return (default 10)" },
      },
    },
  },
  resumeGoal: {
    description:
      "Continue a goal you previously CLOSED — pick up where you left off instead of starting over. getGoalContext lists your recent goals with progress (done/total) and status; if the work isn't actually finished (or was archived prematurely), call resumeGoal to reopen it: the goal goes back to active and its saved plan/current-step/blockers are restored so you continue from the last state. Omit goalId to resume the most recently closed goal, or pass a specific goalId from getGoalContext's recentGoals. (Journal notes were promoted to durable memory on archive; the plan state is what's restored.) For a brand-new objective, do NOT resume — just start working and the platform opens a fresh goal.",
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        goalId: {
          type: "string",
          description: "Which closed goal to reopen (from getGoalContext.recentGoals). Omit for the most recent.",
        },
      },
    },
  },
  archiveGoal: {
    description:
      "Declare the CURRENT goal complete — the CLOSING step, not a fire-and-forget. Before calling it, REVIEW and reconcile: confirm the produced output meets EACH locked acceptance criterion (re-run checkAcceptance if unsure), then call updateGoalState one last time to mark every finished plan step '[done] …' and set currentStep to a one-line closing statement (a goal archived with its plan still unchecked reads as half-done in the dashboard). Then archiveGoal: it archives a permanent summary, promotes your 'fact' notes to durable environment memory, and clears the journal for the next goal. Call ONLY when the goal is fully achieved or explicitly abandoned. The summary must be specific — what was built/decided/produced, with names and outcomes, and how it was verified against the criteria. Future sessions rely on it.",
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string", description: "Specific summary of the completed goal" },
      },
      required: ["summary"],
    },
  },
};

export const USER_MEMORY_INSTRUCTIONS =
  "User memory is available. A background summary of who this user is (identity + current state) was injected into your context at start — do not re-fetch it. queryMemory(topic) searches deeper when a specific topic needs prior context.";

export const AGENT_MEMORY_INSTRUCTIONS =
  "You have persistent goal memory that survives restarts and context resets. On wake: getGoalContext before doing work — it shows the active goal AND your recent goals with their progress (done/total). If an earlier goal is unfinished or was closed too soon, resumeGoal reopens it so you continue from where you left off instead of starting over. While working: record decisions, failures, environment facts, and progress with writeNote, and keep updateGoalState accurate after each meaningful step (mark steps '[done] …' as you finish them — don't leave the plan frozen on step 1). On completion: REVIEW first — verify the output meets the locked acceptance criteria, mark the remaining plan steps done and set a closing currentStep via updateGoalState, then archiveGoal with a specific summary. The journal is for future-you — write what re-hydration needs, nothing else.";

// A harness BUILDER runs under an external gate (Define→build→Verdict→Deliver). It must NOT
// close or complete the goal itself — the harness's Deliver node owns archiving, and only when
// an independent Verdict passed. So the builder gets the read/journal memory tools WITHOUT the
// goal-lifecycle tools (archiveGoal/resumeGoal), and an instruction that forbids self-completion.
export const AGENT_MEMORY_INSTRUCTIONS_BUILDER =
  "You have persistent goal memory that survives restarts and context resets. On wake: getGoalContext BEFORE doing work — it shows the active goal AND any revision feedback (blockers) from a prior attempt. If blockers are present, your last build was REJECTED by the independent harness: address those exact gaps before rebuilding, and do not re-submit the same build. While working: record decisions, failures, environment facts, and progress with writeNote, and keep updateGoalState accurate (plan, currentStep, blockers). You do NOT complete, archive, or close the goal — an external harness independently judges the result and owns completion. Build the best workflow, produce its real output, then stop and report; never declare the goal done yourself.";

// UnoverseMCP authoring methods. An agent whose toolset contains any of these IS a harness
// builder — used to strip its goal-completion authority (see mergePlatformMemorySchema).
const UNOVERSE_BUILDER_METHODS = new Set([
  "saveWorkflow",
  "getCanvas",
  "getNodeCatalog",
  "getNodeSchema",
  "runTest",
  "startTestRun",
  "stepNode",
  "readNodeTrace",
  "removeEdges",
  "tidyLayout",
  "readBuilderSkill",
]);

/** Is this agent a harness builder (wired to UnoverseMCP)? Detected from its own aggregated tools. */
function isHarnessBuilder(baseSchema: any | null): boolean {
  const methods = baseSchema?.methods;
  if (!methods) return false;
  for (const name of Object.keys(methods)) {
    if (UNOVERSE_BUILDER_METHODS.has(name)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Toggle gating
// ---------------------------------------------------------------------------

export interface MemoryFlags {
  userMemoryEnabled: boolean;
  agentMemoryEnabled: boolean;
}

/**
 * BOTH memory faculties are PER-AGENT toggles on the agent node's own config
 * (`data.config.enableUserMemory` / `enableAgentMemory`) — never canvas-wide.
 * This stops memory leaking into worker agents UNO builds inside the workflows
 * it creates (they default off). Resolve from the calling node in the cache.
 */
export function memoryFlagsForNode(cachedWorkflow: any, nodeId: string): MemoryFlags {
  const nodes = cachedWorkflow?.workflow?.nodes;
  const node = Array.isArray(nodes) ? nodes.find((n: any) => n?.id === nodeId) : null;
  const cfg = node?.data?.config || {};
  return {
    userMemoryEnabled: cfg.enableUserMemory === true,
    agentMemoryEnabled: cfg.enableAgentMemory === true,
  };
}

/** Is this method a platform memory tool enabled for the calling agent? */
export function isPlatformMemoryMethod(method: string, flags: MemoryFlags): boolean {
  if (USER_MEMORY_METHODS[method]) return flags.userMemoryEnabled === true;
  if (AGENT_MEMORY_METHODS[method]) return flags.agentMemoryEnabled === true;
  return false;
}

/**
 * Merge the enabled platform memory toolsets into a (possibly null) aggregated
 * MCP schema — the pure half of injectPlatformMemoryTools (no registry, no trace
 * sync). Returns baseSchema untouched when no toggle is on. Platform methods win
 * on name collision.
 */
export function mergePlatformMemorySchema(baseSchema: any | null, flags: MemoryFlags): any | null {
  const methods: Record<string, any> = {};
  const instructions: string[] = [];

  if (flags.userMemoryEnabled === true) {
    Object.assign(methods, USER_MEMORY_METHODS);
    instructions.push(USER_MEMORY_INSTRUCTIONS);
  }
  if (flags.agentMemoryEnabled === true) {
    if (isHarnessBuilder(baseSchema)) {
      // Builder under a harness: read + journal memory, but NO goal-lifecycle (close/reopen)
      // tools. The harness's Deliver node is the sole archiver, and only on an independent pass —
      // this stops the builder self-certifying via archiveGoal (the false "COMPLETED 5/5").
      const { archiveGoal: _a, resumeGoal: _r, ...readWriteMethods } = AGENT_MEMORY_METHODS;
      Object.assign(methods, readWriteMethods);
      instructions.push(AGENT_MEMORY_INSTRUCTIONS_BUILDER);
    } else {
      Object.assign(methods, AGENT_MEMORY_METHODS);
      instructions.push(AGENT_MEMORY_INSTRUCTIONS);
    }
  }

  if (Object.keys(methods).length === 0) return baseSchema;

  const merged = baseSchema
    ? {
        ...baseSchema,
        methods: { ...baseSchema.methods, ...methods },
        instructions: [baseSchema.instructions, ...instructions].filter(Boolean).join("\n\n"),
      }
    : {
        name: "Unoverse",
        version: "1.0.0",
        methods,
        instructions: instructions.join("\n\n"),
        metadata: { source: "PlatformMemoryTools" },
      };

  logger.info("Injected platform memory tools", {
    userMemory: flags.userMemoryEnabled === true,
    agentMemory: flags.agentMemoryEnabled === true,
    totalMethods: Object.keys(merged.methods).length,
    hadBaseSchema: !!baseSchema,
  });

  return merged;
}

// ---------------------------------------------------------------------------
// Execution (core-side, against memory-server)
// ---------------------------------------------------------------------------

interface MemoryCallIdentity {
  userId: string;
  workflowId: string;
  agentId: string;
  agentName?: string;
  accessToken?: string;
  conversationId?: string;
  executionId?: string;
}

function resolveIdentity(params: any, context: any): MemoryCallIdentity | { error: string } {
  const userId =
    params?.userId || context?.workflow?.variables?.userId || context?.publishingContext?.userId;
  const workflowId = context?.workflowId || context?.workflow?.id;
  if (!userId) return { error: "No user identity in execution context — cannot access memory" };
  if (!workflowId) return { error: "No workflow id in execution context — cannot access memory" };

  // Shared per-workflow agent memory: all agents on a canvas share ONE goal drawer.
  // The pointer is agent_goal:{user}:{workflowId}:shared — the workflowId is unique
  // per canvas, so "shared" gives exactly one goal per workflow. The Agent Memory
  // toggle is the access switch: any agent with memory enabled reads/writes the SAME
  // goal, so a harness Define node and the worker agent share the goal automatically.
  // A caller may still pass an explicit `agentId` to target a specific drawer instead
  // (e.g. isolated builder scratch for a future tournament).
  const agentId = params?.agentId || "shared";
  const agentNode =
    agentId === "shared"
      ? null
      : (context?.workflow?.nodes || context?.cachedWorkflow?.nodes || []).find((n: any) => n?.id === agentId);
  const agentName = agentNode?.data?.label || (agentId === "shared" ? "Canvas" : undefined);

  return {
    userId,
    workflowId,
    agentId,
    agentName,
    accessToken: context?.auth?.accessToken,
    conversationId: context?.workflow?.variables?.conversationId || context?.publishingContext?.conversationId,
    executionId: context?.executionId,
  };
}

function authHeaders(accessToken?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  return headers;
}

async function memoryServerGet(path: string, query: Record<string, string>, accessToken?: string): Promise<any> {
  const params = new URLSearchParams(query);
  const res = await fetch(`${MEMORY_SERVICE_URL}${path}?${params}`, { headers: authHeaders(accessToken) });
  if (!res.ok) throw new Error(`memory-server ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function memoryServerPost(path: string, body: any, accessToken?: string): Promise<any> {
  const res = await fetch(`${MEMORY_SERVICE_URL}${path}`, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`memory-server ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Serve search results LEAN (MEMORY_SPEC v3): claim + certainty + domain only —
 * NO premises, NO content dupe, NO ids/timestamps/reinforcement bookkeeping.
 * Deduped by normalized claim so paraphrase clusters read as one line. The raw
 * retrieval is unchanged; the dashboard still gets full rows.
 */
function leanEvidence(evidence: any[]): Array<{ claim: string; certainty?: number; domain?: string }> {
  const out: Array<{ claim: string; certainty?: number; domain?: string }> = [];
  const seen = new Set<string>();
  for (const e of evidence || []) {
    const claim = String(e?.claim ?? e?.content?.claim ?? "").trim();
    if (!claim) continue;
    const key = claim.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const item: { claim: string; certainty?: number; domain?: string } = { claim };
    if (typeof e?.certainty === "number") item.certainty = e.certainty;
    if (typeof e?.domain === "string") item.domain = e.domain;
    out.push(item);
  }
  return out;
}

/**
 * Execute a platform memory tool. Always resolves — errors come back as
 * {success:false, error} so the agent can read and react to them.
 */
export async function executePlatformMemoryMethod(method: string, params: any, context: any): Promise<any> {
  const identity = resolveIdentity(params, context);
  if ("error" in identity) {
    logger.warn(`Memory tool ${method} refused`, { error: identity.error });
    return { success: false, method, error: identity.error };
  }
  const { userId, workflowId, agentId, agentName, accessToken, conversationId, executionId } = identity;

  try {
    switch (method) {
      // ---- user memory (the ONE depth tool; the standing snapshot is harness-injected) ----
      case "queryMemory": {
        const evidence = await GetMemoryService.search({
          userId,
          workflowId,
          query: params?.query,
          limit: 15,
          accessToken,
        });
        const lean = leanEvidence(evidence);
        return { evidence: lean, count: lean.length };
      }

      // ---- agent memory (goal-scoped) ----
      case "getGoalContext": {
        return await memoryServerGet("/agent/goal-context", { userId, workflowId, agentId }, accessToken);
      }
      case "writeNote": {
        return await memoryServerPost(
          "/agent/note",
          {
            userId,
            workflowId,
            agentId,
            agentName,
            content: params?.content,
            category: params?.category || "note",
            executionId,
            conversationId,
          },
          accessToken,
        );
      }
      case "updateGoalState": {
        // acceptanceCriteria is a first-class column on the goal (the checkAcceptance
        // judge reads it from goal.acceptanceCriteria), NOT part of the free-form state
        // blob — pull it out so it routes to its own field, or it never reaches the checker.
        const { description, acceptanceCriteria, ...stateFields } = params || {};
        const state = Object.keys(stateFields).length > 0 ? stateFields : undefined;
        return await memoryServerPost(
          "/agent/state",
          { userId, workflowId, agentId, agentName, description, acceptanceCriteria, state },
          accessToken,
        );
      }
      case "searchHistory": {
        return await memoryServerGet(
          "/agent/history",
          { userId, workflowId, limit: String(params?.limit || 10) },
          accessToken,
        );
      }
      case "resumeGoal": {
        return await memoryServerPost(
          "/agent/resume",
          { userId, workflowId, agentId, goalId: params?.goalId },
          accessToken,
        );
      }
      case "archiveGoal": {
        return await memoryServerPost(
          "/agent/archive",
          { userId, workflowId, agentId, summary: params?.summary, conversationId },
          accessToken,
        );
      }

      default:
        return { success: false, method, error: `Unknown platform memory method: ${method}` };
    }
  } catch (error: any) {
    logger.error(`Memory tool ${method} failed`, { error: error.message });
    return { success: false, method, error: error.message };
  }
}
