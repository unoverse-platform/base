/**
 * SafeExpression — security + correctness tests.
 * Run: node --import tsx --test apps/unoverse/engine/src/template/SafeExpression.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateSafeExpression, UnsafeExpressionError } from "./SafeExpression";

const ctx = {
  signal: {
    inputtrigger1: { output: { message: "hello world" } },
    openaistream1: { chunk: "streamed text", text: "final text" },
    s3files1: { files: ["a.png", "b.png"] },
    geminiimagegen1: { images: [{ data: "IMG0" }, { data: "IMG1" }] },
    items: [{ name: "Ada" }, { name: "Linus" }, { name: "Grace" }],
  },
  input: { count: 3 },
};

test("legit data-shaping expressions evaluate correctly", () => {
  // member access
  assert.equal(evaluateSafeExpression("return signal.openaistream1.chunk", ctx), "streamed text");
  // deep + array index
  assert.equal(evaluateSafeExpression("return signal.geminiimagegen1.images[0].data", ctx), "IMG0");
  // whole array
  assert.deepEqual(evaluateSafeExpression("return signal.s3files1.files", ctx), ["a.png", "b.png"]);
  // object construction (the documented pattern)
  assert.deepEqual(
    evaluateSafeExpression("return { topic: signal.inputtrigger1.output.message, image: signal.geminiimagegen1.images[0].data }", ctx),
    { topic: "hello world", image: "IMG0" },
  );
  // arrow .map
  assert.deepEqual(evaluateSafeExpression("return signal.items.map(x => x.name)", ctx), ["Ada", "Linus", "Grace"]);
  // string method + template literal + ternary
  assert.equal(evaluateSafeExpression("return signal.openaistream1.chunk.toUpperCase()", ctx), "STREAMED TEXT");
  assert.equal(evaluateSafeExpression("return `count is ${input.count}`", ctx), "count is 3");
  assert.equal(evaluateSafeExpression("return input.count > 2 ? 'many' : 'few'", ctx), "many");
  // safe globals
  assert.equal(evaluateSafeExpression("return JSON.stringify(signal.items[0])", ctx), '{"name":"Ada"}');
  assert.deepEqual(evaluateSafeExpression("return Object.keys(signal.items[0])", ctx), ["name"]);
});

test("SECURITY: process / env access is blocked", () => {
  assert.throws(() => evaluateSafeExpression("return process.env", ctx), UnsafeExpressionError);
  assert.throws(() => evaluateSafeExpression("return process", ctx), UnsafeExpressionError);
  assert.throws(() => evaluateSafeExpression("return globalThis.process.env.SECRET", ctx), UnsafeExpressionError);
});

test("SECURITY: prototype-chain / constructor escape is blocked", () => {
  // The classic `new Function` escape — reach Function via the prototype chain.
  assert.throws(() => evaluateSafeExpression("return [].constructor.constructor('return process')()", ctx), UnsafeExpressionError);
  assert.throws(() => evaluateSafeExpression("return signal.constructor", ctx), UnsafeExpressionError);
  assert.throws(() => evaluateSafeExpression("return signal.__proto__", ctx), UnsafeExpressionError);
  assert.throws(() => evaluateSafeExpression("return ({}).constructor.constructor", ctx), UnsafeExpressionError);
});

test("SECURITY: require / fetch / eval are blocked", () => {
  assert.throws(() => evaluateSafeExpression("return require('child_process')", ctx), UnsafeExpressionError);
  assert.throws(() => evaluateSafeExpression("return fetch('https://evil.com')", ctx), UnsafeExpressionError);
  assert.throws(() => evaluateSafeExpression("return eval('1+1')", ctx), UnsafeExpressionError);
  assert.throws(() => evaluateSafeExpression("return Function('return process')()", ctx), UnsafeExpressionError);
});

test("SECURITY: unsafe methods (call/apply/bind, mutation-to-escape) are blocked", () => {
  assert.throws(() => evaluateSafeExpression("return signal.items.map.call(null, x => x)", ctx), UnsafeExpressionError);
  assert.throws(() => evaluateSafeExpression("return signal.openaistream1.chunk.constructor('x')", ctx), UnsafeExpressionError);
});

test("SECURITY: assignments, new, and statements are rejected", () => {
  assert.throws(() => evaluateSafeExpression("return (signal.x = 1)", ctx), UnsafeExpressionError);
  assert.throws(() => evaluateSafeExpression("return new Date()", ctx), UnsafeExpressionError);
  assert.throws(() => evaluateSafeExpression("return (() => { return process })()", ctx), UnsafeExpressionError);
});

test("unknown identifiers throw (a rogue expr can't reach ambient names)", () => {
  assert.throws(() => evaluateSafeExpression("return somethingUndeclared", ctx), UnsafeExpressionError);
});
