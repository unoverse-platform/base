/**
 * THE CODE NODE'S CONTRACT: any JS return statement.
 *
 * `SafeExpression` replaced `new Function` on 2026-07-25 and closed a real hole — a template
 * expression travels by paste and by marketplace install, and `new Function` handed it `process.env`
 * and `fetch`. But it also rejected block-body arrows, on the reasoning that "data-shaping never
 * needs them", and that reasoning was wrong: every Code node ever written is a
 * `return (() => { ... })()` that declares locals, matches, branches and returns.
 *
 * THE FAILURE WAS SILENT, which is why it took a screenshot to find. `TemplateResolver` catches a
 * throw and never reassigns the field, so the raw SOURCE TEXT survived as the config value and the
 * node emitted its own code as `output`. It looked like a working node producing wrong data.
 *
 * So this file pins BOTH halves: the statements that must work, and the escapes that must not. The
 * second half matters more — widening an interpreter is exactly where a sandbox springs a leak, and
 * a test that only proved the feature works would be the more dangerous of the two.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSafeExpression, UnsafeExpressionError } from "../src/template/SafeExpression.js";

/** The real thing, near enough verbatim from the node that exposed this. */
const EXTRACTION = `return (() => {
  const text = signal.openai1.text;
  let title = '';
  let brand = '';
  const titleMatch = text.match(/\\*\\*Song Title:\\*\\*\\s*"?([^"\\n]+)"?/);
  if (titleMatch) title = titleMatch[1].trim();
  const brandMatch = text.match(/\\*\\*Artist\\/Brand Name:\\*\\*\\s*"?([^"\\n]+)"?/);
  if (brandMatch) brand = brandMatch[1].trim();
  return { title, brand, fullText: text };
})();`;

const TEXT = '**Song Title:** "Glass-Box Horizon"\n**Artist/Brand Name:** "Signal Lantern"\nrest';

test("a real Code node script runs, statements and all", () => {
  const out: any = evaluateSafeExpression(EXTRACTION, { signal: { openai1: { text: TEXT } } });
  assert.equal(out.title, "Glass-Box Horizon");
  assert.equal(out.brand, "Signal Lantern");
  assert.equal(out.fullText, TEXT);
});

test("an assignment inside an if-block reaches the OUTER let", () => {
  // The commonest shape there is. Get the scoping backwards and every `if (m) x = ...` silently
  // does nothing, which reads as "the regex did not match" rather than as a bug in the evaluator.
  const out = evaluateSafeExpression(`return (() => { let v = 'no'; if (true) { v = 'yes'; } return v; })();`, {});
  assert.equal(out, "yes");
});

test("a const declared inside a block does NOT leak out of it", () => {
  assert.throws(
    () => evaluateSafeExpression(`return (() => { if (true) { const inner = 1; } return inner; })();`, {}),
    (e: Error) => e instanceof UnsafeExpressionError && /unknown identifier 'inner'/.test(e.message),
  );
});

test("falling off the end without a return is undefined, as in JS", () => {
  assert.equal(evaluateSafeExpression(`return (() => { const a = 1; })();`, {}), undefined);
});

test("compound assignment works on a declared local", () => {
  assert.equal(evaluateSafeExpression(`return (() => { let n = 1; n += 4; n *= 2; return n; })();`, {}), 10);
});

test("expression-body arrows still work, so every existing .map callback is unaffected", () => {
  assert.deepEqual(evaluateSafeExpression(`return [1,2,3].map(x => x * 2)`, {}), [2, 4, 6]);
});

/**
 * THE ESCAPES. Each of these is a way out of the sandbox that statements might plausibly have
 * opened. Security here is by ABSENCE, so every one of them must fail on a MISSING thing rather than
 * on a check that could be forgotten.
 */
const ESCAPES: Array<[string, string, RegExp]> = [
  ["process", `return (() => { const p = process; return p.env; })();`, /unknown identifier 'process'/],
  ["require", `return (() => { return require('fs'); })();`, /unknown identifier 'require'/],
  // Refused as a METHOD rather than as a property, because the escape goes through a CALL:
  // `constructor` is not in SAFE_METHODS, so the call is rejected before the property is ever read.
  // Both doors are shut; asserting only the property message would have missed which one closed.
  ["constructor (via call)", `return (() => { return (()=>{}).constructor('return process')(); })();`, /method 'constructor'/],
  ["constructor (via read)", `return (() => { const c = (()=>{}).constructor; return c; })();`, /blocked property 'constructor'/],
  ["__proto__", `return (() => { return {}.__proto__; })();`, /blocked property '__proto__'/],
  ["new", `return (() => { return new Function('return process')(); })();`, /disallowed expression: NewExpression/],
  // A function that arrived ON THE DATA CONTEXT stays uncallable. Only arrows this expression itself
  // defined may be invoked, which is what makes the IIFE work without opening the door generally.
  ["a host function from the context", `return (() => { return hostFn(); })();`, /call of non-allowlisted function/],
  // The run's own data is READ-ONLY. A template computes from signal/config and may never rewrite them.
  ["rewriting the data context", `return (() => { signal = {evil:1}; return signal; })();`, /assignment to undeclared 'signal'/],
  ["mutating a property", `return (() => { config.keep = 'gone'; return config; })();`, /assignment to a property/],
  // Not RCE, but still a hole: a pasted expression must not be able to hang the engine. Iteration is
  // covered by .map/.filter, which are bounded by their input.
  ["while(true)", `return (() => { while(true){} })();`, /disallowed statement: WhileStatement/],
  ["for(;;)", `return (() => { for(;;){} })();`, /disallowed statement: ForStatement/],
];

for (const [label, expr, expected] of ESCAPES) {
  test(`statements did not open a way to: ${label}`, () => {
    assert.throws(
      () => evaluateSafeExpression(expr, { signal: { a: 1 }, config: { keep: "me" }, hostFn: () => "leaked" }),
      (e: Error) => e instanceof UnsafeExpressionError && expected.test(e.message),
      `"${label}" must be refused by the interpreter simply not implementing it`,
    );
  });
}

test("the data context is untouched after every escape attempt", () => {
  const ctx = { signal: { a: 1 }, config: { keep: "me" }, hostFn: () => "leaked" };
  for (const [, expr] of ESCAPES) {
    try {
      evaluateSafeExpression(expr, ctx);
    } catch {
      /* expected — the point is what survives */
    }
  }
  assert.deepEqual(ctx.config, { keep: "me" }, "an escape attempt mutated the caller's data");
  assert.deepEqual(ctx.signal, { a: 1 });
});

/**
 * DATES. `Date.now` alone could not build a date RANGE, which is what half the APIs a node talks to
 * want: an expression could do the arithmetic and then had no way to render it, because `new Date` is
 * a NewExpression and `toISOString` is not a safe method. `Date.iso` closes that with one pure
 * formatter, and `.split("T")[0]` — already allowed — covers YYYY-MM-DD without a second primitive.
 */
test("a YYYY-MM-DD date range can be derived from a config value", () => {
  const out: any = evaluateSafeExpression(
    `return (() => {
       const days = config.daysBack || 30;
       return { start: Date.iso(Date.now() - days * 86400000).split('T')[0], end: Date.iso().split('T')[0] };
     })();`,
    { config: { daysBack: 30 } },
  );
  // Shape, not value: asserting a literal date would fail tomorrow.
  assert.match(out.start, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(out.end, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(out.start < out.end, "30 days back must sort before today");
});

test("Date.iso formats a known timestamp exactly, and defaults to now", () => {
  assert.equal(evaluateSafeExpression(`return Date.iso(0)`, {}), "1970-01-01T00:00:00.000Z");
  assert.equal(evaluateSafeExpression(`return Date.iso().length`, {}), 24);
  assert.equal(evaluateSafeExpression(`return Date.iso(null).length`, {}), 24);
});

test("Date.iso names a bad argument instead of throwing a bare RangeError", () => {
  // `new Date(NaN).toISOString()` throws a RangeError naming neither the value nor its field, and
  // getting a string where a timestamp was meant is the likely mistake.
  assert.throws(
    () => evaluateSafeExpression(`return Date.iso('yesterday')`, {}),
    (e: Error) => e instanceof UnsafeExpressionError && /timestamp in milliseconds, got "yesterday"/.test(e.message),
  );
});

test("formatting a date did not make Date constructible", () => {
  // The boundary that must not move: read and format time, never construct or reach through it.
  for (const [label, expr] of [
    ["new Date()", `return new Date().toISOString()`],
    ["toISOString as a method", `return (0).toISOString()`],
    ["Date.constructor", `return Date.constructor`],
  ] as const) {
    assert.throws(
      () => evaluateSafeExpression(expr, {}),
      (e: Error) => e instanceof UnsafeExpressionError,
      `${label} must still be refused`,
    );
  }
});
