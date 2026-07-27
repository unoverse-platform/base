/**
 * Expressions and templates — the two ways a manifest or a workflow turns data into a value.
 *
 * LIVES HERE, not in the engine, because neither file knows anything about workflows,
 * XState or the database: one is a sandboxed expression evaluator, the other a Handlebars
 * wrapper. They sat under `engine/` only because that is where they were first needed,
 * before manifests existed, and the manifest runtime then had to reach five directories
 * upward by SOURCE URL to get at them. That path resolved inside this monorepo and nowhere
 * else, which was the single thing keeping this package unpublishable.
 *
 * Three consumers now, and all three import it the same way: the manifest runtime, the
 * engine's own template resolution, and node config validation.
 */
export { evaluateSafeExpression, assertParsableExpression, UnsafeExpressionError } from "./SafeExpression.js";
export { resolveStringTemplate, type TemplateContext } from "./StringTemplateResolver.js";
