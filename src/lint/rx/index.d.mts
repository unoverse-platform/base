/**
 * Types for the rx linter, which is plain JavaScript.
 *
 * The linters stayed .mjs so the CLIs can run them under bare node with no build step.
 * TypeScript consumers (the publish pipeline, and eventually the publish route) need a
 * shape, and a hand-written declaration is the honest way to give them one: the alternative
 * is `any` at every call site, which hides a real contract.
 *
 * Kept beside the implementation so a change to one is visibly a change to the other.
 */

export interface Finding {
  level: "error" | "warn" | "hint";
  file: string;
  line?: number;
  msg: string;
}

export interface DefinitionsResult {
  problems: Finding[];
  homes: Array<{ dir: string }>;
  rxHome?: string;
  designSystem?: string;
}

/** Lint every definition under `rxHome`. Prints nothing, throws nothing for a lint failure. */
export function lintDefinitions(rxHome?: string): DefinitionsResult;

/** True when anything would fail a build. */
export function hasErrors(result: DefinitionsResult): boolean;
