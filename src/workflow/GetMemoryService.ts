/**
 * The engine's HTTP client for the DEDICATED MEMORY SERVER (:4104) — thin
 * wrappers over its API (/compose, /evidence, /evidence/recent,
 * /evidence/search). No logic lives here; memory is owned by the server.
 *
 * Used by the intrinsic agent memory tools (PlatformMemoryTools — the Memory
 * toggles) and the Universe Copilot harness. NOT used by spatial search —
 * "SpatialSearch serves knowledge tools only" (MEMORY_SPEC.md); the old
 * includeMemory-in-search path is dead.
 */

import { createLogger } from "../logger.js";

const logger = createLogger("GetMemoryService");
const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || "http://localhost:4104";

export interface GetMemoryInput {
  userId: string;
  workflowId: string;
  query?: string;
  domains?: string[];
  minCertainty?: number;
  limit?: number;
  accessToken?: string;
}

export interface MemoryEvidence {
  memory_id: string;
  content: { claim: string; premises?: string[] };
  type: string; // inductive | deductive | abductive
  domain: string;
  certainty: number;
  reinforcement_count: number;
  created_at: string;
}

export class GetMemoryService {
  /**
   * Retrieve composed understanding for a user (uses /compose endpoint)
   */
  static async compose(input: GetMemoryInput): Promise<any> {
    const { userId, workflowId, query, domains, accessToken } = input;

    try {
      const params = new URLSearchParams({ userId, workflowId, mode: "full" });
      if (domains?.length) params.set("domains", domains.join(","));
      if (query) params.set("context", query);

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

      const res = await fetch(`${MEMORY_SERVICE_URL}/compose?${params}`, { headers });

      if (!res.ok) {
        logger.warn("Memory compose failed", { status: res.status });
        return null;
      }

      const data: any = await res.json();
      return data.composed || null;
    } catch (err: any) {
      logger.debug("Memory compose unavailable", { error: err.message });
      return null;
    }
  }

  /**
   * Get recent evidence snapshot (recency-ordered, no query)
   */
  static async recent(input: { userId: string; workflowId: string; limit?: number; accessToken?: string }): Promise<MemoryEvidence[]> {
    const { userId, workflowId, limit, accessToken } = input;

    try {
      const params = new URLSearchParams({ userId, workflowId });
      if (limit) params.set("limit", String(limit));

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

      const res = await fetch(`${MEMORY_SERVICE_URL}/evidence/recent?${params}`, { headers });

      if (!res.ok) {
        logger.warn("Memory recent failed", { status: res.status });
        return [];
      }

      const data: any = await res.json();
      return data.evidence || [];
    } catch (err: any) {
      logger.debug("Memory recent unavailable", { error: err.message });
      return [];
    }
  }

  /**
   * Search user evidence by query (uses /evidence/search endpoint)
   */
  static async search(input: GetMemoryInput): Promise<MemoryEvidence[]> {
    const { userId, workflowId, query, domains, minCertainty, limit, accessToken } = input;

    if (!query) {
      return this.retrieve(input);
    }

    try {
      const params = new URLSearchParams({ userId, workflowId, query });
      if (domains?.length) params.set("domains", domains.join(","));
      if (minCertainty !== undefined) params.set("minCertainty", String(minCertainty));
      if (limit) params.set("limit", String(limit));

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

      const res = await fetch(`${MEMORY_SERVICE_URL}/evidence/search?${params}`, { headers });

      if (!res.ok) {
        logger.warn("Memory search failed", { status: res.status });
        return [];
      }

      const data: any = await res.json();
      return data.evidence || [];
    } catch (err: any) {
      logger.debug("Memory search unavailable", { error: err.message });
      return [];
    }
  }

  /**
   * Retrieve raw evidence (structured, no query needed — uses /evidence endpoint)
   */
  static async retrieve(input: GetMemoryInput): Promise<MemoryEvidence[]> {
    const { userId, workflowId, domains, minCertainty, limit, accessToken } = input;

    try {
      const params = new URLSearchParams({ userId, workflowId });
      if (domains?.length) params.set("domains", domains.join(","));
      if (minCertainty !== undefined) params.set("minCertainty", String(minCertainty));
      if (limit) params.set("limit", String(limit || 20));

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

      const res = await fetch(`${MEMORY_SERVICE_URL}/evidence?${params}`, { headers });

      if (!res.ok) {
        logger.warn("Memory retrieve failed", { status: res.status });
        return [];
      }

      const data: any = await res.json();
      return data.evidence || [];
    } catch (err: any) {
      logger.debug("Memory retrieve unavailable", { error: err.message });
      return [];
    }
  }
}
