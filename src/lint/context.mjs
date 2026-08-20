/**
 * The state one lint run accumulates, and the only thing every rule module shares.
 *
 * It is MUTABLE and RESET per run, deliberately. The linter began as a CLI that ran once
 * and exited, so module-level arrays were harmless; Studio and the publish route lint over
 * and over in one process, and findings from the previous run would silently accumulate
 * into the next. `reset()` is what makes a second call return the same answer as the first.
 */
import { relative } from "node:path";

/** Every finding, in discovery order. Sorted for presentation by the caller. */
export const problems = [];

/** Fragment path -> the set of nodes referencing it. Powers the shared/ pruning rules. */
export const refCounts = new Map();

/** Node -> the executor kind derived for it, shown as a summary rather than a finding. */
export const derivedKinds = new Map();

/** Credential name -> where it was declared, for cross-package collision rules. */
export const allCredentials = new Map();

/** Where this run is reading. Set by lintNodes(), read by rel() and the loaders. */
export const state = { nodesHome: "", schemaDir: "", schemas: {} };

export function reset(nodesHome, schemaDir) {
  problems.length = 0;
  seen.clear();
  refCounts.clear();
  derivedKinds.clear();
  allCredentials.clear();
  state.nodesHome = nodesHome;
  state.schemaDir = schemaDir;
  state.schemas = {};
}

/**
 * One finding. `error` fails a build; `warn` and `hint` inform.
 *
 * DEDUPED. The design linter walks a definition and its expansions, so the same rule can fire
 * on the same line twice; a caller seeing it twice would think there were two problems.
 * `line` is optional: the design linter knows where in the file, the node linter reports per file.
 */
const seen = new Set();
export const report = (level, file, msg, line) => {
  const key = `${level}|${file}|${line ?? ""}|${msg}`;
  if (seen.has(key)) return;
  seen.add(key);
  problems.push(line === undefined ? { level, file, msg } : { level, file, msg, line });
};

/** Shortest readable form: a walk out of the tree is worse than the absolute path. */
export const rel = (p) => {
  const r = relative(process.cwd(), p);
  return r.startsWith("..") ? p : r;
};
