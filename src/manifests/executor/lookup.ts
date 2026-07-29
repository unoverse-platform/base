/**
 * HOW AN EXECUTOR FINDS ITS MANIFEST. The two executor classes are stateless with respect
 * to which node they are running: the manifest is looked up by nodeType at execution time
 * rather than closed over at registration, which is what keeps the platform at two classes
 * instead of one per manifest — and what makes a reload swap behaviour with no
 * re-registration: the class stays, the data moves.
 */
import type { ComposedNode } from "../compose.js";

/** Set by the loader so both executors can resolve their manifest by node type. */
let lookup: (type: string) => ComposedNode | undefined = () => undefined;

export function setManifestLookup(fn: (type: string) => ComposedNode | undefined): void {
  lookup = fn;
}

export function manifestFor(type: string): ComposedNode {
  const node = lookup(type);
  if (!node) throw new Error(`No manifest loaded for node type "${type}" — it may have been unloaded mid-run.`);
  return node;
}
