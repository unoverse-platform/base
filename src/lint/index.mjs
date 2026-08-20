/**
 * The linters. TWO of them, because there are two things to validate and they share
 * almost nothing.
 *
 *   nodes/  node manifests: JSON Schema per part, plus the cross-file rules a schema
 *           cannot express (events matching output connectors, calls reachable by name,
 *           credentials declared in the package that needs them)
 *   design/ definitions: a CLOSED primitive set, a closed style vocabulary, token-only
 *           values, Switch discriminants, layouts reachable from a case
 *
 * They share `context.mjs` and nothing else. One reports on `api/run.yaml`, the other on
 * whether a colour is a raw hex. Merging them would produce a linter that is worse at both.
 *
 * WHY THEY LIVE HERE rather than in scripts/. The same rules are needed by four callers,
 * and only one of them is a terminal:
 *
 *   `unoverse lint` / `lint nodes`  coloured lines (scripts/lib/*.mjs, thin formatters)
 *   Studio                          findings beside the definition being edited
 *   POST /publish                   a refusal, so a broken definition never reaches the DB
 *   CI                              a non-zero exit
 *
 * Publishing without them is the gap LOCAL_STUDIO.md:246 names: "a malformed definition is
 * one restart from a broken server". A published row does not even need the restart.
 */

export { lintNodes, hasErrors as nodesHaveErrors } from "./nodes/index.mjs";
export { lintDefinitions, hasErrors as definitionsHaveErrors } from "./design/index.mjs";
export { problems, report, rel, reset } from "./context.mjs";
