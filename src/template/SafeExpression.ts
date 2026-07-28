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
  /**
   * TIME, readable and formattable, but never constructible.
   *
   * `now` alone was not enough to be useful. Half the APIs a node talks to take a date RANGE —
   * "transactions since", "runs between" — and every one of them wants `YYYY-MM-DD` or a full ISO
   * string. An expression could do the arithmetic (`Date.now() - 30 * 86400000`) and then had no way
   * to render the answer: `new Date(...)` is a NewExpression and refused, and `toISOString` is not a
   * safe method, so the number stayed a number. A node needing a date range therefore could not be a
   * manifest at all, for want of one pure formatter.
   *
   * ONE function, not a family. `iso` returns the full ISO string and `.split("T")[0]` — already
   * allowed — gives the date part, so "YYYY-MM-DD" needs no second primitive. Fewer things to learn
   * and fewer to keep consistent.
   *
   * It meets the same bar as `sha256` above: a pure function of its argument, no I/O, nothing
   * reachable through it. `Date.now` was already exposed, so nothing new is observable — this only
   * formats what an expression could already read.
   */
  Date: {
    now: Date.now,
    iso: (ms?: unknown) => {
      const t = ms === undefined || ms === null ? Date.now() : Number(ms);
      // A clear message beats `new Date(NaN)`'s RangeError, which names neither the value nor the
      // field it came from. Getting a string where a timestamp was meant is the likely mistake.
      if (!Number.isFinite(t))
        throw new UnsafeExpressionError(`Date.iso needs a timestamp in milliseconds, got ${JSON.stringify(ms)}`);
      return new Date(t).toISOString();
    },
  },
};

/** Method names callable on user data (array/string/JSON/Math) — all side-effect-free reads
 *  or pure transforms. NOT included: anything that could reach a constructor or mutate host. */
const SAFE_METHODS = new Set([
  // array (non-mutating)
  "map", "filter", "slice", "concat", "join", "includes", "indexOf", "lastIndexOf",
  "find", "findIndex", "some", "every", "reduce", "flat", "flatMap", "at", "keys", "values", "entries",
  // `toSorted`, and deliberately NOT `sort`. Both order an array; only one of them is a pure
  // transform. `sort` reorders its receiver IN PLACE, and the receiver here is live run data — an
  // expression doing `signal.items.sort()` would permanently reorder the upstream node's own output
  // for every other reader of it, which is a side effect this evaluator is supposed to make
  // impossible. `toSorted` returns a new array and leaves the original alone.
  //
  // Needed because CANONICAL ORDER IS PART OF A CONTENT HASH. A content id is
  // `sha256(JSON.stringify(value, Object.keys(value).toSorted()))`, and without the sort the same
  // object hashes differently depending on the order its keys happened to be built in — so dedup
  // and ref hydration, which join on exactly those ids, would miss.
  "toSorted",
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

/**
 * STATEMENTS, inside a block-body arrow. The Code node's contract is "any JS return statement", and
 * for two days it could not honour it.
 *
 * Replacing `new Function` with this interpreter (2026-07-25) closed a real hole, but it also
 * rejected block-body arrows on the reasoning that "data-shaping never needs them". The Code node
 * disproves that: real extraction code declares locals, matches, branches, and returns — the exact
 * shape of every `return (() => { ... })()` anyone had written. Worse, the rejection was INVISIBLE.
 * `TemplateResolver` catches a throw and never reassigns, so the raw SOURCE TEXT stayed as the
 * field's value and the node emitted its own code as data.
 *
 * WHAT THIS DOES NOT CHANGE, which is the whole point: no new globals, no `new`, no `constructor`,
 * no `require`, no `process`, no property outside BLOCKED_PROPS. Security here is by ABSENCE, and
 * absence is untouched — statements are evaluated by this interpreter, not handed to the host.
 *
 * NO LOOPS, deliberately. `while`/`for` would let a pasted expression hang the engine, and iteration
 * is already covered by `.map`/`.filter`/`.reduce`, which are bounded by their input. A denial of
 * service is a smaller hole than RCE but it is still a hole, and nothing needs it.
 */

/** Names DECLARED in a given scope, so an assignment can find the right one to write. */
const DECLARED = Symbol("declared");

/** A fresh block scope. Declarations land here; assignment walks up to where the name was declared. */
function childScope(parent: Scope): Scope {
  const s: Scope = Object.create(parent);
  Object.defineProperty(s, DECLARED, { value: new Set<string>(), enumerable: false });
  return s;
}

function declare(scope: Scope, name: string, value: unknown): void {
  const set = (scope as any)[DECLARED] as Set<string> | undefined;
  set?.add(name);
  scope[name] = value;
}

/**
 * Assign to the nearest scope that DECLARED the name.
 *
 * Undeclared assignment throws rather than creating a binding. That is what keeps the injected data
 * context read-only: without it, `signal = whatever` would either mutate the caller's object or
 * silently shadow it, and a template must never be able to rewrite the run's own data.
 */
function assign(scope: Scope, name: string, value: unknown): void {
  for (let s: any = scope; s; s = Object.getPrototypeOf(s)) {
    const own = Object.getOwnPropertyDescriptor(s, DECLARED)?.value as Set<string> | undefined;
    if (own?.has(name)) {
      s[name] = value;
      return;
    }
  }
  throw new UnsafeExpressionError(`assignment to undeclared '${name}'`);
}

/**
 * Functions THIS interpreter created, i.e. arrows written in the expression itself.
 *
 * Calling one has to be allowed for an IIFE — `(() => { ... })()` is the only way an expression
 * language gets a statement body — but the allowlist for a DIRECT call was "is it a safe global?",
 * so the interpreter refused to call its own arrow with "call of non-allowlisted function".
 *
 * A WeakSet and not a flag on the function: nothing a template can reach may add to it, because the
 * only place that registers is the arrow case below. A host function that arrived through the data
 * context is still not callable, which is the property that matters.
 */
const OURS = new WeakSet<Function>();

/** Marks a `return`, so it unwinds through nested blocks without using a host exception. */
const RETURNED = Symbol("returned");
type Completion = { [RETURNED]: true; value: unknown } | undefined;

function execStatement(node: any, scope: Scope): Completion {
  switch (node.type) {
    case "VariableDeclaration":
      for (const d of node.declarations) {
        if (d.id.type !== "Identifier") throw new UnsafeExpressionError("destructuring declaration");
        declare(scope, d.id.name, d.init ? evalNode(d.init, scope) : undefined);
      }
      return undefined;

    case "ExpressionStatement":
      evalNode(node.expression, scope);
      return undefined;

    case "ReturnStatement":
      return { [RETURNED]: true, value: node.argument ? evalNode(node.argument, scope) : undefined };

    case "IfStatement":
      if (evalNode(node.test, scope)) return execStatement(node.consequent, scope);
      return node.alternate ? execStatement(node.alternate, scope) : undefined;

    case "BlockStatement": {
      // Its own scope, so a `const` inside an if-block cannot leak out — and an assignment to an
      // OUTER `let` still reaches it, via `assign` walking the chain. Getting that backwards would
      // silently drop every `if (m) title = ...`, which is the commonest shape there is.
      const inner = childScope(scope);
      for (const s of node.body) {
        const done = execStatement(s, inner);
        if (done) return done;
      }
      return undefined;
    }

    case "EmptyStatement":
      return undefined;

    default:
      throw new UnsafeExpressionError(`disallowed statement: ${node.type}`);
  }
}

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
      // A safe global (parseInt, String, …) OR an arrow this expression itself defined — the latter
      // is what makes `(() => { ... })()` work. Anything else, including a function that arrived on
      // the data context, is still refused.
      if (!Object.values(SAFE_GLOBALS).includes(fn as never) && !OURS.has(fn as Function))
        throw new UnsafeExpressionError("call of non-allowlisted function");
      return (fn as (...a: unknown[]) => unknown)(...args);
    }
    case "ArrowFunctionExpression": {
      // BOTH BODY FORMS. `x => x.name` is the common .map/.filter callback; the block form is what
      // every `return (() => { ... })()` in a Code node is made of, and rejecting it made that node
      // emit its own source text instead of running (see the statement section above).
      const params: string[] = node.params.map((p: any) => {
        if (p.type !== "Identifier") throw new UnsafeExpressionError("non-identifier arrow param");
        return p.name;
      });
      const isBlock = node.body.type === "BlockStatement";
      const fn = (...callArgs: unknown[]) => {
        // A DECLARING scope, not a bare Object.create: parameters and any `const` inside the body
        // must be assignable, and `assign` only writes where a name was declared.
        const local = childScope(scope);
        params.forEach((name, i) => declare(local, name, callArgs[i]));
        if (!isBlock) return evalNode(node.body, local);
        // Falling off the end with no `return` is undefined, exactly as in JS.
        const done = execStatement(node.body, local);
        return done ? done.value : undefined;
      };
      OURS.add(fn);
      return fn;
    }

    /**
     * Assignment, and ONLY to a name this expression declared.
     *
     * `let title = ''; if (m) title = m[1]` is the shape of nearly every extraction, so without this
     * the block form would parse and then quietly do nothing. `assign` throws for an undeclared
     * name, which is what keeps the run's own data (`signal`, `config`, `calls`) read-only: a
     * template may compute from them and may never rewrite them.
     *
     * Member assignment (`obj.x = 1`) is NOT allowed. It is the one form that could reach through to
     * a caller's object, and building a new object literal expresses the same thing without it.
     */
    case "AssignmentExpression": {
      if (node.left.type !== "Identifier")
        throw new UnsafeExpressionError(`assignment to ${node.left.type === "MemberExpression" ? "a property" : node.left.type}`);
      const name = node.left.name;
      const right = evalNode(node.right, scope) as any;
      if (node.operator === "=") {
        assign(scope, name, right);
        return right;
      }
      const current = evalNode(node.left, scope) as any;
      const next =
        node.operator === "+=" ? current + right
        : node.operator === "-=" ? current - right
        : node.operator === "*=" ? current * right
        : node.operator === "/=" ? current / right
        : node.operator === "%=" ? current % right
        : node.operator === "??=" ? (current ?? right)
        : node.operator === "||=" ? (current || right)
        : node.operator === "&&=" ? (current && right)
        : (() => { throw new UnsafeExpressionError(`assignment operator '${node.operator}'`); })();
      assign(scope, name, next);
      return next;
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
