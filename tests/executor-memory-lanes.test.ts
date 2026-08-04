/**
 * THE MEMORY LANES on the manifest executor — hydrate before the run, ingest after.
 *
 * These existed in every legacy agent and were silently ABSENT from the manifest
 * executor: the memory server ran healthy while its ingest stream stayed empty, and
 * nothing anywhere errored (found live 2026-07-30). The lanes are fire-and-forget by
 * design, so only a test can tell "off" from "broken" — which is exactly why this file
 * pins when each lane MUST fire and when it must not.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { hydrateMemory, ingestMemoryTurn } = await import(
  "@unoverse-platform/base/manifests/executor/memory.js"
);

const EC = {
  publishingContext: { userId: "u1", conversationId: "c1", chatId: "ch1" },
  workflow: { id: "wf1" },
  executionId: "ex1",
  nodeId: "n1",
};

/** Capture fetch; answer GET /context with a memory block, /memory/ingest with ok. */
function stubFetch() {
  const calls: Array<{ url: string; body: any }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    if (String(url).includes("/context"))
      return new Response(JSON.stringify({ block: "KNOWN USER: Ada. Prefers tea.", count: 2 }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as any;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test("toggle OFF: the prompt passes through untouched and nothing is fetched", async () => {
  const { calls, restore } = stubFetch();
  try {
    const config = { prompt: "hello", enableUserMemory: false };
    assert.equal(await hydrateMemory(config, EC), config, "must return the SAME config object");
    await ingestMemoryTurn("OpenAIAgent", config, EC, { text: "answer" });
    assert.equal(calls.length, 0, "no memory traffic with the toggle off");
  } finally {
    restore();
  }
});

test("toggle ON: ingest fires with the ORIGINAL input and the final answer", async () => {
  const { calls, restore } = stubFetch();
  try {
    await ingestMemoryTurn("OpenAIAgent", { prompt: "what is ACCA?", enableUserMemory: true }, EC, {
      text: "ACCA is…",
      stream: "ACCA is…",
    });
    // fire-and-forget — give the detached POST a beat to reach the stub
    await new Promise((r) => setTimeout(r, 50));
    const ingest = calls.find((c) => c.url.includes("/memory/ingest"));
    assert.ok(ingest, "the completed turn must reach /memory/ingest");
    assert.equal(ingest!.body.userMessage, "what is ACCA?");
    assert.equal(ingest!.body.agentResponse, "ACCA is…");
    assert.equal(ingest!.body.userId, "u1");
  } finally {
    restore();
  }
});

test("hydration prepends the context block to the prompt, and only the prompt", async () => {
  const { restore } = stubFetch();
  try {
    const config = { prompt: "hello", enableUserMemory: true, model: "gpt-5" };
    const hydrated = await hydrateMemory(config, EC);
    assert.notEqual(hydrated, config, "a hydrated run gets a NEW config object");
    assert.ok(hydrated.prompt.startsWith("KNOWN USER: Ada"), "the block leads the user prompt");
    assert.ok(hydrated.prompt.endsWith("hello"), "the original prompt survives at the end");
    assert.equal(hydrated.model, "gpt-5", "every other field passes through");
    assert.equal(config.prompt, "hello", "the caller's config is never mutated");
  } finally {
    restore();
  }
});

test("a dead memory server never blocks the run", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as any;
  try {
    const config = { prompt: "hello", enableUserMemory: true };
    const hydrated = await hydrateMemory(config, EC);
    assert.equal(hydrated.prompt, "hello", "hydration failure passes the prompt through");
    await ingestMemoryTurn("OpenAIAgent", config, EC, { text: "answer" }); // must not throw
  } finally {
    globalThis.fetch = real;
  }
});
