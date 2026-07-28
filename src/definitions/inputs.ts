/**
 * THE single derivation of "which definition props are workflow INPUTS".
 *
 * A node's `configSchema` is derived FROM the component's `props`, and that derivation has
 * to live in ONE place so node synthesis, the workbench CONTROLS panel and the server never
 * disagree. Consumers do not re-decide what an input is.
 *
 * IMPLEMENTED HERE, not re-exported. This file used to be a single line pulling it out of
 * `@unoverse-platform/plugin-base`, which made the new runtime depend on the legacy node
 * library it exists to replace. Backwards, and it would have travelled into every consumer
 * of this package as a real npm dependency.
 *
 * `plugin-base` still carries its own copy, for the TypeScript nodes that import it. A
 * knowing duplicate: eight lines of a rule that has not changed, and that copy dies with the
 * last code node. THIS is the canonical one.
 *
 * The rule (mirroring the design system's `workflowInput`): a prop is an input when it
 * declares `input: true`. A definition declaring NO `input` flags at all makes every prop an
 * input, which is back-compat for the single-object components that legitimately expose all
 * of them.
 */
export interface InputPropLike {
  input?: boolean;
}

export function inputPropKeys(props: Record<string, InputPropLike> | undefined): string[] {
  const entries = Object.entries(props ?? {});
  const explicit = entries.some(([, p]) => p?.input !== undefined);
  return entries.filter(([, p]) => (explicit ? p?.input === true : true)).map(([k]) => k);
}
