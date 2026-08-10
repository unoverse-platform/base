/**
 * A CONVERSATION SEARCHES A THING ONCE.
 *
 * `query` and every entry of `queries` is its own search returning its own rows, so a
 * repeat spends result slots on material the conversation already holds and re-surfaces
 * every app row it surfaced the first time.
 *
 * THE SHAPE THIS CATCHES (observed live 2026-08-10): a discovery search runs the guest's
 * opening sentence and finds an app; the app collects six answers; the follow-up search
 * leads with that same sentence again. Six of eleven rows came back answering the question
 * the guest had already moved past, and the app row rode back in with them. The tool
 * descriptions asked the model not to do this and the model did it anyway, which is why
 * the rule is enforced here rather than requested there.
 *
 * The escape hatches matter as much as the rule: only EXACT repeats go (normalized for
 * case and punctuation), only within one conversation, only for discovery tools, and never
 * down to an empty search.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dropRepeatedQueries } from "../src/agent-mcp/memo.js";

const OPENING = "Help me find the right course or learning journey for my career goals";
const ANSWERED = "technology professional qualification online on-demand full-time school leaver";

test("the opening ask is dropped from the search that follows the guest's answers", () => {
  const conv = "c-drop-1";
  // The discovery search that found the app.
  dropRepeatedQueries(conv, "discoverRelated", { query: OPENING });
  // The follow-up, after the app collected answers: the model leads with the opening ask.
  const sent = dropRepeatedQueries(conv, "findIntent", { query: OPENING, queries: [OPENING, ANSWERED] }) as any;

  assert.deepEqual(sent.queries, [ANSWERED], "the spent opening ask still costs a result slot");
  assert.equal(sent.query, undefined, "the scalar `query` carried the repeat too");
});

test("a repeat is matched across case and punctuation, not by exact string", () => {
  const conv = "c-drop-2";
  dropRepeatedQueries(conv, "findIntent", { query: "Chinese restaurants, near me!" });
  const sent = dropRepeatedQueries(conv, "findIntent", { queries: ["chinese restaurants near me", "vegan options"] }) as any;
  assert.deepEqual(sent.queries, ["vegan options"]);
});

test("a search is NEVER emptied: all-repeats passes through untouched", () => {
  /**
   * "You have already searched all of this" is the model's judgement to make. Sending a
   * search with no query at all would be a different instruction than it wrote, and the
   * node would ask the engine for nothing.
   */
  const conv = "c-drop-3";
  const first = { query: OPENING, queries: [OPENING] };
  dropRepeatedQueries(conv, "findIntent", first);
  const sent = dropRepeatedQueries(conv, "findIntent", { query: OPENING, queries: [OPENING] }) as any;
  assert.equal(sent.query, OPENING);
  assert.deepEqual(sent.queries, [OPENING]);
});

test("conversations do not share a history, and non-discovery tools are untouched", () => {
  dropRepeatedQueries("c-drop-4a", "findIntent", { query: OPENING });
  const other = dropRepeatedQueries("c-drop-4b", "findIntent", { query: OPENING }) as any;
  assert.equal(other.query, OPENING, "one guest's search suppressed another's");

  const read = dropRepeatedQueries("c-drop-4a", "readResult", { query: OPENING }) as any;
  assert.equal(read.query, OPENING, "a non-discovery tool had its arguments rewritten");
});

test("with no conversation to scope it, nothing is dropped", () => {
  const sent = dropRepeatedQueries(undefined, "findIntent", { query: OPENING }) as any;
  assert.equal(sent.query, OPENING);
});

test("the bridge applies it, and only to the service path", () => {
  // Guard the guard: the rule is worthless if the one call site stops calling it, and an
  // app invocation must never have its arguments rewritten.
  const src = new URL("../src/manifests/executor/toolBridge.ts", import.meta.url);
  const bridge = readFileSync(src, "utf8");
  assert.ok(/dropRepeatedQueries\(/.test(bridge), "the bridge no longer drops repeated queries");
  assert.ok(
    bridge.indexOf("if (app) return stringify(await app(args))") < bridge.indexOf("dropRepeatedQueries("),
    "an app invocation must return BEFORE the query rewrite — its args are not a search",
  );
});
