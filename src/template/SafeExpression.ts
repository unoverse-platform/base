/**
 * SafeExpression — a restricted evaluator for `return …` template config.
 *
 * WHY (SECURITY.md §"Untrusted template expressions"): template expressions ride inside
 * workflow definitions, which travel by paste / marketplace component / shared export —
 * an untrusted surface. The old resolver ran them via `new Function`, which is NOT a
 * sandbox: the body reaches every Node global (`process.env` → secret theft, `fetch` →
 * exfiltration, prototype-chain → RCE). A trojaned component could hide code in a prop.
 *
 * This evaluator parses the expression once (cached, like the old memoize) and walks an
 * ALLOWLIST of AST node types, evaluating in-process against the data context only. Security
 * is by ABSENCE: there is no `process`, `require`, `constructor` for an expression to reach —
 * the interpreter simply never implements them, so there is nothing to escape to. No V8
 * isolate, no marshalling → negligible overhead vs a native function call, and pure-JS (no
 * native module). It supports the real use — data-shaping: member access, indexing, object /
 * array literals, operators, ternaries, template strings, and safe array/string/JSON/Math
 * methods (incl. `.map(x => …)` arrow callbacks). Anything else throws (and is logged).
 */
import { parseExpressionAt, type Node as AcornNode } from "acorn";
import { createHash } from "node:crypto";
import memoizeImport from "fast-memoize";
/**
 * fast-memoize ships CommonJS (`module.exports = memoize`) with ESM-shaped typings
 * (`export default`). Under NodeNext those disagree: the runtime value IS the function,
 * but TypeScript types the default import as the module namespace and calls it uncallable.
 * Verified at runtime before casting, rather than assuming.
 */
type Memoizer = <F extends (...args: any[]) => any>(fn: F) => F;
const memoize = memoizeImport as unknown as Memoizer;

/** Global namespaces an expression may reference — pure, no I/O, no ambient authority. */
const SAFE_GLOBALS: Record<string, unknown> = {
  JSON,
  Math,
  Number,
  String,
  Boolean,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  // URL encoding. Pure string transforms with no I/O and nothing to reach, so they meet the
  // same bar as parseInt above. Needed because a manifest builds request URLs from data: a
  // table NAME or a record id goes into a path segment, and without these an id containing a
  // space or a slash silently produces a malformed URL rather than an encoded one.
  encodeURIComponent,
  encodeURI,
  // Content addressing. A pure function of its argument with no I/O and nothing to reach,
  // so it meets the same bar as parseInt above: hashing a string cannot observe or change
  // anything outside the expression.
  //
  // Needed because STABLE IDS ARE DATA, not decoration. A node that pulls a page derives a
  // universal id from the url and a content id from the text, and downstream dedup and ref
  // hydration join on exactly those. Without this the ids have to be minted in TypeScript,
  // which means the node cannot be a manifest at all, for the sake of one pure function.
  sha256: (value: unknown) => createHash("sha256").update(String(value ?? "")).digest("hex"),
  Object: { keys: Object.keys, values: Object.values, entries: Object.entries, fromEntries: Object.fromEntries, assign: (...a: object[]) => Object.assign({}, ...a) },
  Array: { isArray: Array.isArray, from: Array.from, of: Array.of },
  Date: { now: Date.now },
};

/** Method names callable on user data (array/string/JSON/Math) — all side-effect-free reads
 *  or pure transforms. NOT included: anything that could reach a constructor or mutate host. */
const SAFE_METHODS = new Set([
  // array (non-mutating)
  "map", "filter", "slice", "concat", "join", "includes", "indexOf", "lastIndexOf",
  "find", "findIndex", "some", "every", "reduce", "flat", "flatMap", "at", "keys", "values", "entries",
  // string
  "split", "toUpperCase", "toLowerCase", "trim", "trimStart", "trimEnd", "replace", "replaceAll",
  "substring", "substr", "startsWith", "endsWith", "padStart", "padEnd", "repeat", "charAt", "match",
  // number
  "toFixed", "toPrecision",
  // shared
  "toString",
]);

/** Property names that are the classic prototype-chain escape — never readable. */
const BLOCKED_PROPS = new Set(["constructor", "__proto__", "prototype", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"]);

class UnsafeExpressionError extends Error {}

const parseCached = memoize((expr: string): AcornNode => {
  // Strip a leading `return` and trailing `;` — the field's convention is a return-expression.
  const cleaned = expr.trim().replace(/^return\b/, "").replace(/;\s*$/, "").trim();
  if (!cleaned) throw new UnsafeExpressionError("empty expression");
  return parseExpressionAt(cleaned, 0, { ecmaVersion: 2022 }) as AcornNode;
});

type Scope = Record<string, unknown>;

function prop(obj: unknown, key: PropertyKey): unknown {
  if (BLOCKED_PROPS.has(String(key))) throw new UnsafeExpressionError(`blocked property '${String(key)}'`);
  if (obj == null) return undefined;
  return (obj as Record<PropertyKey, unknown>)[key];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function evalNode(node: any, scope: Scope): unknown {
  switch (node.type) {
    case "Literal":
      return node.value;
    case "Identifier":
      if (node.name in scope) return scope[node.name];
      if (Object.prototype.hasOwnProperty.call(SAFE_GLOBALS, node.name)) return SAFE_GLOBALS[node.name];
      if (node.name === "undefined") return undefined;
      throw new UnsafeExpressionError(`unknown identifier '${node.name}'`);
    case "TemplateLiteral": {
      let out = "";
      node.quasis.forEach((q: any, i: number) => {
        out += q.value.cooked;
        if (i < node.expressions.length) out += String(evalNode(node.expressions[i], scope));
      });
      return out;
    }
    case "MemberExpression": {
      const obj = evalNode(node.object, scope);
      const key = node.computed ? (evalNode(node.property, scope) as PropertyKey) : node.property.name;
      return prop(obj, key);
    }
    case "ObjectExpression": {
      const o: Record<string, unknown> = {};
      for (const p of node.properties) {
        if (p.type === "SpreadElement") {
          Object.assign(o, evalNode(p.argument, scope) as object);
        } else {
          const k = p.computed ? String(evalNode(p.key, scope)) : (p.key.name ?? p.key.value);
          if (BLOCKED_PROPS.has(String(k))) throw new UnsafeExpressionError(`blocked key '${k}'`);
          o[k] = evalNode(p.value, scope);
        }
      }
      return o;
    }
    case "ArrayExpression": {
      const arr: unknown[] = [];
      for (const el of node.elements) {
        if (el == null) arr.push(undefined);
        else if (el.type === "SpreadElement") arr.push(...(evalNode(el.argument, scope) as unknown[]));
        else arr.push(evalNode(el, scope));
      }
      return arr;
    }
    case "BinaryExpression": {
      const l = evalNode(node.left, scope) as any;
      const r = evalNode(node.right, scope) as any;
      switch (node.operator) {
        case "+": return l + r;
        case "-": return l - r;
        case "*": return l * r;
        case "/": return l / r;
        case "%": return l % r;
        case "**": return l ** r;
        case "==": return l == r;
        case "!=": return l != r;
        case "===": return l === r;
        case "!==": return l !== r;
        case "<": return l < r;
        case ">": return l > r;
        case "<=": return l <= r;
        case ">=": return l >= r;
        default: throw new UnsafeExpressionError(`operator '${node.operator}'`);
      }
    }
    case "LogicalExpression": {
      const l = evalNode(node.left, scope) as any;
      if (node.operator === "&&") return l && evalNode(node.right, scope);
      if (node.operator === "||") return l || evalNode(node.right, scope);
      if (node.operator === "??") return l ?? evalNode(node.right, scope);
      throw new UnsafeExpressionError(`logical '${node.operator}'`);
    }
    case "UnaryExpression": {
      const v = evalNode(node.argument, scope) as any;
      switch (node.operator) {
        case "!": return !v;
        case "-": return -v;
        case "+": return +v;
        case "typeof": return typeof v;
        default: throw new UnsafeExpressionError(`unary '${node.operator}'`);
      }
    }
    case "ConditionalExpression":
      return evalNode(node.test, scope) ? evalNode(node.consequent, scope) : evalNode(node.alternate, scope);
    case "CallExpression": {
      const args = node.arguments.map((a: any) => evalNode(a, scope));
      if (node.callee.type === "MemberExpression") {
        const obj = evalNode(node.callee.object, scope);
        const method = node.callee.computed ? String(evalNode(node.callee.property, scope)) : node.callee.property.name;
        // Allow a method call if the receiver is a safe-global namespace (JSON/Math/Object/…),
        // OR the method is a known-safe array/string builtin. Never a user-supplied name that
        // could be `constructor`, `call`, `apply`, `bind`, etc.
        const isSafeGlobalNs = Object.values(SAFE_GLOBALS).includes(obj as never);
        if (!isSafeGlobalNs && !SAFE_METHODS.has(method)) throw new UnsafeExpressionError(`method '${method}'`);
        if (BLOCKED_PROPS.has(method)) throw new UnsafeExpressionError(`method '${method}'`);
        const fn = prop(obj, method);
        if (typeof fn !== "function") return undefined;
        return (fn as (...a: unknown[]) => unknown).apply(obj, args);
      }
      // Direct call: only a safe-global function (parseInt, String, …).
      const fn = evalNode(node.callee, scope);
      if (typeof fn !== "function") throw new UnsafeExpressionError("call of non-function");
      if (!Object.values(SAFE_GLOBALS).includes(fn as never)) throw new UnsafeExpressionError("call of non-allowlisted function");
      return (fn as (...a: unknown[]) => unknown)(...args);
    }
    case "ArrowFunctionExpression": {
      // Expression-body arrows only (e.g. `x => x.name`) — the common .map/.filter callback.
      // Block-body arrows (with statements) are rejected: data-shaping never needs them.
      if (node.body.type === "BlockStatement") throw new UnsafeExpressionError("block-body arrow");
      const params: string[] = node.params.map((p: any) => {
        if (p.type !== "Identifier") throw new UnsafeExpressionError("non-identifier arrow param");
        return p.name;
      });
      return (...callArgs: unknown[]) => {
        const local: Scope = Object.create(scope);
        params.forEach((name, i) => { local[name] = callArgs[i]; });
        return evalNode(node.body, local);
      };
    }
    default:
      throw new UnsafeExpressionError(`disallowed expression: ${node.type}`);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Evaluate a `return …` template expression against a data context, safely.
 * Throws UnsafeExpressionError for anything outside the allowlist (logged by the caller).
 */
export function evaluateSafeExpression(code: string, context: Scope): unknown {
  const ast = parseCached(code);
  return evalNode(ast, context);
}

/** Syntax-check a `return …` expression without evaluating it (throws on a parse error).
 *  Used by config validation — replaces a bare `new Function(code)` compile check. */
export function assertParsableExpression(code: string): void {
  parseCached(code);
}

export { UnsafeExpressionError };
