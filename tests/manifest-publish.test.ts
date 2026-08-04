/**
 * THE PUBLISH LANE: api/publish.yaml, a generic write into the caller's template state —
 * the workflow channel's sibling of the service channel's renderCards.
 *
 * Asserted on BEHAVIOUR against a captured clientTransport, because every failure mode here
 * is silent by design: the lane no-ops with no session, no-ops on a non-object, and no-ops
 * when nobody is listening. Each no-op is correct — and each is also exactly what a broken
 * push would look like, so the tests pin down when the push MUST happen and what frame it
 * carries, not just that nothing throws.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { performApi, emptyContext, primeTemplating } = await import(
  "@unoverse-platform/base/manifests/runtime/index.js"
);
const { setClientTransport } = await import("@unoverse-platform/base/platform/clientTransport.js");

/** Capture pushToClient calls; restore() puts the no-op transport back. */
function stubTransport(listening = true) {
  const pushed: Array<{ userId: string; conversationId: string; message: any }> = [];
  setClientTransport({
    pushToClient: (userId, conversationId, message) => {
      pushed.push({ userId, conversationId, message });
      return listening;
    },
  });
  return { pushed, restore: () => setClientTransport({}) };
}

/** An events-only node shaped like Suggestions: one connector, published to the screen. */
const node = (publish: Record<string, unknown>): any => ({
  type: "PublishTest",
  kind: "PromiseNode",
  allowedHosts: [],
  api: {
    events: [{ emit: "suggestions", value: "return { faqs: signal.signal.faqs || [] }" }],
    publish,
  },
});

const SESSION = { userId: "u1", conversationId: "conv1", chatId: "chat1" };

const run = (n: any, session?: any, signal: any = { signal: { faqs: [{ text: "hi" }] } }) =>
  performApi(n, { ...emptyContext(), signal }, () => {}, undefined, undefined, undefined, session);

test("publish pushes the emitted output as a TEMPLATE_DATA frame, keyed by the session", async () => {
  await primeTemplating();
  const { pushed, restore } = stubTransport();
  try {
    const { outputs }: any = await run(node({ data: "return output.suggestions" }), SESSION);
    assert.equal(pushed.length, 1, "one settle, one push");
    const { userId, conversationId, message } = pushed[0];
    assert.equal(userId, "u1");
    assert.equal(conversationId, "conv1");
    assert.equal(message.type, "TEMPLATE_DATA");
    assert.equal(message.chatId, "chat1");
    // THE SCREEN AND THE GRAPH CANNOT DRIFT: the frame carries the very object the
    // connector emitted, because `data` is evaluated over `output`, not re-derived.
    assert.deepEqual(message.data, outputs.suggestions);
    assert.deepEqual(message.data, { faqs: [{ text: "hi" }] });
  } finally {
    restore();
  }
});

test("no live session → no push, and the run still succeeds", async () => {
  // Builder, tests, headless, cron: a run nobody is watching should carry on, not throw.
  await primeTemplating();
  const { pushed, restore } = stubTransport();
  try {
    const { outputs }: any = await run(node({ data: "return output.suggestions" }), undefined);
    assert.equal(pushed.length, 0, "nothing must be pushed without a session");
    assert.deepEqual(outputs.suggestions, { faqs: [{ text: "hi" }] }, "the connector still fires");
  } finally {
    restore();
  }
});

test("a `when` of false skips the push", async () => {
  await primeTemplating();
  const { pushed, restore } = stubTransport();
  try {
    await run(node({ when: "return false", data: "return output.suggestions" }), SESSION);
    assert.equal(pushed.length, 0);
  } finally {
    restore();
  }
});

test("a non-object `data` is refused, never pushed", async () => {
  // The client MERGES data into template state; merging a string would fail far from here,
  // in a browser, with nothing pointing back at the manifest that sent it.
  await primeTemplating();
  const { pushed, restore } = stubTransport();
  try {
    await run(node({ data: "return 'not an object'" }), SESSION);
    await run(node({ data: "return [1, 2]" }), SESSION);
    assert.equal(pushed.length, 0);
  } finally {
    restore();
  }
});
