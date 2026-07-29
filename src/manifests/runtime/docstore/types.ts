/**
 * THE DOC STORE'S SHAPES, transcribed from the retired smart-document package
 * (util/types.ts). The design rationale lives in _legacy/nodes/smart-document/CLAUDE.md and
 * is worth reading whole: every field here exists to defeat one of the two failure modes of
 * LLM-edited long documents — hallucinated addressing and stale addressing.
 */

export type SectionLevel = 1 | 2;

export interface Section {
  /** Random, server-generated, never positional and never reused. */
  id: string;
  level: SectionLevel;
  /** No leading #. */
  heading: string;
  /** Raw markdown. May contain H3+ freely; must never contain a heading at or above the sectionize level. */
  body: string;
  parentId: string | null;
  /** Sibling position. Server-managed, never an agent input. */
  order: number;
  /** sha256 of heading + "\n\n" + body, first 12 hex chars — the staleness check on every edit. */
  hash: string;
}

export interface Doc {
  sections: Section[];
  /** Bumped on every mutation; agents detect drift by comparing across calls. */
  version: number;
  updatedAt: string;
}

export type ErrorCode =
  | "STALE_SECTION"
  | "STALE_DOC"
  | "CONCURRENT_UPDATE"
  | "NOT_FOUND"
  | "NOT_UNIQUE"
  | "INVALID_STRUCTURE"
  | "INVALID_PLACEMENT"
  | "INVALID_PARAMS"
  | "NOT_INITIALISED"
  | "UNKNOWN_METHOD";

export interface ServiceError {
  ok: false;
  error: ErrorCode;
  hint?: string;
  currentHash?: string;
  currentBody?: string;
  currentVersion?: number;
  matches?: number;
}

export interface ServiceSuccess {
  ok: true;
  version: number;
  [key: string]: any;
}

export type ServiceResult = ServiceSuccess | ServiceError;
