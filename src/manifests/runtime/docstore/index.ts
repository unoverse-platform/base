/**
 * THE DOC STORE, as a call form: `docstore: <op>` in a node's call list.
 *
 * What smart-document actually needed from code, extracted to where computation belongs
 * (DECLARATIVE_NODES.md §2 — the awsSigV4 rule: the executor computes, the manifest
 * describes). A long markdown document lives in Redis, sectioned so an agent edits it
 * hash-checked section by section instead of rewriting a blob; the design rationale is
 * _legacy/nodes/smart-document/CLAUDE.md.
 *
 * The ops are exactly the retired node's methods plus `render`, which is what its
 * graph-triggered executeNode did: initialise from config if cold, then hand back the
 * whole doc as markdown for a renderer.
 */
import type { SectionLevel, ServiceResult } from "./types.js";
import { getDoc, initDoc, keyFor } from "./store.js";
import { renderMarkdown } from "./sectionizer.js";
import {
  handleOutline,
  handleReadSection,
  handleUpdateSection,
  handleAppendToSection,
  handleReplaceInSection,
  handleInsertSection,
  handleDeleteSection,
  handleMoveSection,
  handleResetDoc,
} from "./handlers.js";

/**
 * Ops that CHANGE the doc — the set the hybrid contract keys on: after any of these arrives
 * over the service channel, the node's workflow channel re-fires so a downstream renderer
 * receives the fresh markdown. Read ops must NOT re-fire: re-rendering on reads re-emitted
 * the full document on every navigation call and flooded the renderer (the retired node
 * learned this live — its MUTATING_METHODS guard exists for exactly this).
 */
export const MUTATING_DOC_OPS = new Set([
  "updateSection",
  "appendToSection",
  "replaceInSection",
  "insertSection",
  "deleteSection",
  "moveSection",
  "resetDoc",
]);

export interface DocScope {
  userId?: string;
  workflowId?: string;
  conversationId?: string;
  nodeId?: string;
}

/**
 * The doc's identity, derived by the EXECUTOR from the run's own ids — never by the
 * manifest, which could otherwise read another conversation's document by naming its key.
 *
 * Same derivation as the retired node's resolveKey: scoped to user + workflow +
 * conversation + node instance so the doc persists across runs and chats while staying
 * isolated; conversationId falls back to workflowId because on this platform it tracks the
 * workflow and is reused across chats.
 */
export function docKeyFor(scope: DocScope | undefined): string | null {
  const userId = scope?.userId ?? "";
  const workflowId = scope?.workflowId ?? "";
  const nodeId = scope?.nodeId ?? "";
  const conversationId = scope?.conversationId || workflowId;
  if (!userId || !workflowId || !nodeId) return null;
  return keyFor(userId, workflowId, conversationId, nodeId);
}

function level(config: Record<string, any> | undefined): SectionLevel {
  return config?.sectionizeAt === 1 ? 1 : 2;
}

/**
 * One docstore op. Errors come back STRUCTURED, never thrown, for the same reason the
 * retired node shaped them: the caller is usually a MODEL, and `{ ok: false, error, hint }`
 * is a recoverable instruction where an exception would end the turn.
 */
export async function performDoc(
  op: string,
  params: Record<string, any>,
  redis: any,
  scope: DocScope | undefined,
  config: Record<string, any> | undefined,
): Promise<ServiceResult | { ok: true; version: number; markdown: string }> {
  if (!redis) {
    // The one non-recoverable case: a platform with no Redis has nowhere to keep a doc.
    throw new Error("docstore requires Redis, and the platform has none configured");
  }
  const key = docKeyFor(scope);
  if (!key) {
    return {
      ok: false,
      error: "NOT_INITIALISED",
      hint: "docstore has no userId/workflowId on the execution context to derive its state key.",
    };
  }

  const at = level(config);
  const initial = String(config?.initialMarkdown ?? "");
  await initDoc(redis, key, initial, at);

  switch (op) {
    case "render": {
      // The workflow channel's op: the WHOLE doc as markdown, for a downstream renderer.
      const doc = await getDoc(redis, key, at);
      return { ok: true, version: doc?.version ?? 0, markdown: doc ? renderMarkdown(doc.sections) : "" };
    }
    case "outline":
      return handleOutline(redis, key, at);
    case "readSection":
      return handleReadSection(redis, key, params, at);
    case "updateSection":
      return handleUpdateSection(redis, key, params, at);
    case "appendToSection":
      return handleAppendToSection(redis, key, params, at);
    case "replaceInSection":
      return handleReplaceInSection(redis, key, params, at);
    case "insertSection":
      return handleInsertSection(redis, key, params, at);
    case "deleteSection":
      return handleDeleteSection(redis, key, params, at);
    case "moveSection":
      return handleMoveSection(redis, key, params, at);
    case "resetDoc":
      return handleResetDoc(redis, key, initial, at);
    default:
      return {
        ok: false,
        error: "UNKNOWN_METHOD",
        hint: `Unknown docstore op '${op}'. Available: render, outline, readSection, updateSection, appendToSection, replaceInSection, insertSection, deleteSection, moveSection, resetDoc.`,
      };
  }
}
