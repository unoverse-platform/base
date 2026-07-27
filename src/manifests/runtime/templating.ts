/**
 * Templates and expressions, both borrowed from the platform rather than rebuilt.
 *
 * Part of the manifest runtime (DECLARATIVE_NODES.md §2): the manifest DESCRIBES the
 * service, this half COMPUTES it. Split by concern so each piece stays readable.
 */
import type { RunContext } from "./context.js";

/**
 * ORDINARY IMPORTS, at last.
 *
 * These two were reached by SOURCE URL, five directories up into the engine tree, because
 * they lived there and this package could not name them. Such a path is a STRING, so
 * TypeScript could not check either one: moving a folder broke both and every node failed
 * at run time while the build stayed green. Only a test asserting the paths still resolved
 * caught it.
 *
 * They live in this package now (`../../template/`), so they are checked like anything else,
 * and nothing here has to be lazily loaded to work around a path.
 *
 * Neither is a copy, and neither may become one. `SafeExpression` is the sandbox every
 * `return ...` in every manifest runs inside — security by ABSENCE, with no
 * process/require/fetch/eval/new/constructor for an expression to reach. And the Handlebars
 * resolver memoizes compilation, sets noEscape (a prompt with backticks must not arrive
 * HTML-escaped) and registers the helpers a manifest may use (eq, toJSON, filter, contains);
 * calling Handlebars directly here would silently lack all four while the linter went on
 * checking manifests against them.
 */
import { evaluateSafeExpression } from "../../template/SafeExpression.js";
import { resolveStringTemplate } from "../../template/StringTemplateResolver.js";

/**
 * Kept as a no-op rather than deleted. It existed to await a dynamic import, and there is
 * nothing left to await — but every caller and test in the tree awaits it, and removing it
 * would be a wide, purely mechanical change for no behaviour.
 */
export async function primeTemplating(): Promise<void> {}

/**
 * A string that is EXACTLY one plain reference, e.g. "{{ config.maxTokens }}".
 *
 * Handlebars always produces a string, so rendering this through it sends "2048"
 * where the vendor demands 2048 and rejects the request. When a template IS the whole
 * value rather than part of a sentence, the value keeps its type.
 *
 * Deliberately only a dotted path: anything with a helper or a block is genuinely
 * text assembly and belongs in Handlebars.
 */
const WHOLE_VALUE = /^\s*\{\{\s*([a-zA-Z_$][\w$]*(?:\.[\w$]+)*)\s*\}\}\s*$/;

function lookup(path: string, ctx: RunContext): unknown {
  return path.split(".").reduce<any>((a, k) => (a == null ? a : a[k]), ctx as any);
}

/** Resolve every {{ }} in a value, recursively. Non-strings pass through. */
export function render(value: any, ctx: RunContext): any {
  if (typeof value === "string") {
    if (!value.includes("{{")) return value;
    const whole = value.match(WHOLE_VALUE);
    if (whole) return lookup(whole[1], ctx);
    return resolveStringTemplate(value, ctx, console);
  }
  if (Array.isArray(value)) return value.map((v) => render(v, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = render(v, ctx);
      // A key whose template resolved to nothing is OMITTED rather than sent as an
      // empty string: vendors reject "" where they accept absence.
      if (r !== undefined && r !== "") out[k] = r;
    }
    return out;
  }
  return value;
}

/**
 * Evaluate a `return ...` expression from a manifest against a scope.
 *
 * Still async, for the same reason primeTemplating still exists: every call site awaits it,
 * and the evaluation itself is synchronous now that the sandbox is imported rather than
 * fetched.
 */
export async function evaluate(expr: string, scope: Record<string, unknown>): Promise<unknown> {
  return evaluateSafeExpression(expr.replace(/^return\s+/, ""), scope);
}
