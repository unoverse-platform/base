/**
 * BODY RESOLUTION GUARD — a `return ...` expression must be evaluated at ANY depth.
 *
 * The bug this exists to prevent shipped and ran in production for a day, and every
 * layer reported success while it did it. `resolveBody` checked only whether the WHOLE
 * body was an expression. A nested one matched neither branch: `render()` skips any
 * string without `{{`, so the expression's SOURCE TEXT was sent to the vendor as the
 * value.
 *
 * Concretely, OpenAIAgent's narrator received its own JavaScript as the customer's
 * message on every run. It never saw the question, never saw a tool call's arguments,
 * and dutifully wrote a plausible generic line from its instructions alone. Nothing
 * errored, no test failed, the node passed its own bench, and the only visible symptom
 * was that the thinking line "felt samey".
 *
 * That is why this asserts on RESOLVED CONTENT and not on a call count: the failure mode
 * is a well-formed request carrying the wrong words.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const UNOVERSE = join(HERE, "../../../apps/unoverse");

const { diskSource } = await import("@unoverse-platform/base/manifests/source.js");
const { composeNode } = await import("@unoverse-platform/base/manifests/compose.js");
const { resolveBody, primeTemplating } = await import("@unoverse-platform/base/manifests/runtime/index.js");

const ctx = (over: Record<string, unknown> = {}) => ({
  config: {}, credentials: {}, signal: {}, prompt: {}, services: {}, params: {}, ...over,
});

test("a `return` expression nested in a body object is EVALUATED, not passed through", async () => {
  await primeTemplating();
  const body: any = await resolveBody(
    { nested: { deep: "return config.a + config.b" }, list: ["return config.a"] },
    ctx({ config: { a: 1, b: 2 } }) as any,
  );
  assert.equal(body.nested.deep, 3, "a nested expression must evaluate, not arrive as its own source");
  assert.equal(body.list[0], 1, "an expression inside an array must evaluate too");
});

test("a body string that is NOT an expression still renders as a template", async () => {
  await primeTemplating();
  const body: any = await resolveBody({ greeting: "hi {{ config.name }}" }, ctx({ config: { name: "Ada" } }) as any);
  assert.equal(body.greeting, "hi Ada");
});

test("the OpenAIAgent narrator is told the CUSTOMER'S MESSAGE, not its own source", async () => {
  await primeTemplating();
  const pkgs = await diskSource(join(UNOVERSE, "nodes")).listPackages();
  const pkg = pkgs.find((p: any) => p.name === "openai");
  assert.ok(pkg, "the openai package must be on disk for this guard to mean anything");
  const raw = pkg.nodes.find((n: any) => n.dir === "OpenAIAgent");
  assert.ok(raw, "OpenAIAgent must be on disk");
  const node = composeNode(raw, pkg);

  const base = ctx({ config: { prompt: "what is ACCA?" }, credentials: { openAICredential: { apiKey: "x" } } });

  const turn: any = await resolveBody(node.api.narrate.request.body, {
    ...base, event: { kind: "turnStart", userMessage: "what is ACCA?" },
  } as any);
  assert.match(String(turn.input), /what is ACCA\?/, "the narrator must be told the customer's actual message");
  assert.doesNotMatch(String(turn.input), /^return /, "the narrator must never receive the expression's source");

  const tool: any = await resolveBody(node.api.narrate.request.body, {
    ...base, event: { kind: "toolCall", toolName: "findIntent", args: { query: "ACCA qualification" } },
  } as any);
  // The ARGUMENTS are the context. Without them the narrator knows only that "a tool
  // ran", and its instructions forbid naming the tool, so every line collapses into an
  // interchangeable paraphrase of the examples it was given.
  assert.match(String(tool.input), /findIntent/, "the narrator must be told which capability ran");
  assert.match(String(tool.input), /ACCA qualification/, "the narrator must be told the tool's arguments");
});
