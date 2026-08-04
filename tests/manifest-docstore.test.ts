/**
 * THE DOCSTORE: the sectioned, hash-checked markdown document behind `docstore:` calls.
 *
 * Transcribed from the retired smart-document package, so these tests pin the behaviours a
 * live doc depends on surviving the move: the parse rules (hashes must not change or every
 * agent's next edit fails STALE_SECTION at once), the error protocol (STALE_SECTION carries
 * the fresh hash AND body — it is the agent's retry instruction), and the addressing rules
 * (exact-once substring match, placement by id never by index).
 */
import test from "node:test";
import assert from "node:assert/strict";

const { performDoc, docKeyFor } = await import("@unoverse-platform/base/manifests/runtime/index.js");

/** A minimal Redis: get/set + WATCH/MULTI that never conflicts (single caller). */
function fakeRedis() {
  const data = new Map<string, string>();
  return {
    data,
    async get(k: string) { return data.get(k) ?? null; },
    async set(k: string, v: string) { data.set(k, v); return "OK"; },
    async watch() {}, async unwatch() {},
    multi() {
      const ops: Array<() => void> = [];
      const tx = {
        set: (k: string, v: string) => { ops.push(() => data.set(k, v)); return tx; },
        exec: async () => { ops.forEach((f) => f()); return []; },
      };
      return tx;
    },
  };
}

const SCOPE = { userId: "u1", workflowId: "wf1", conversationId: "c1", nodeId: "n1" };
const CONFIG = {
  initialMarkdown: "# Plan\n\nThe overview.\n\n## First step\n\nDo the thing.\n",
  sectionizeAt: 2,
};

const doc = (redis: any, op: string, params: Record<string, any> = {}, config: Record<string, any> = CONFIG) =>
  performDoc(op, params, redis, SCOPE, config) as Promise<any>;

test("render initialises from config and round-trips the content", async () => {
  const redis = fakeRedis();
  const r = await doc(redis, "render");
  assert.equal(r.ok, true);
  for (const piece of ["# Plan", "The overview.", "## First step", "Do the thing."]) {
    assert.ok(r.markdown.includes(piece), `render lost "${piece}"`);
  }
});

test("outline maps the doc: H2 nests under H1, hashes and word counts ride along", async () => {
  const redis = fakeRedis();
  const o = await doc(redis, "outline");
  assert.equal(o.ok, true);
  assert.equal(o.sections.length, 2);
  const [plan, step] = o.sections;
  assert.equal(plan.heading, "Plan");
  assert.equal(step.heading, "First step");
  assert.equal(step.parentId, plan.id, "the H2 must nest under the H1");
  assert.match(step.hash, /^[0-9a-f]{12}$/);
  assert.equal(step.wordCount, 3);
});

test("the edit protocol: a fresh hash edits, a stale hash returns the retry instruction", async () => {
  const redis = fakeRedis();
  const o = await doc(redis, "outline");
  const step = o.sections[1];

  const ok = await doc(redis, "updateSection", { id: step.id, expectedHash: step.hash, body: "Do it CAREFULLY." });
  assert.equal(ok.ok, true);
  assert.notEqual(ok.hash, step.hash, "an edit must mint a new hash");
  assert.equal(ok.version, o.version + 1, "every mutation bumps the doc version");

  // The OLD hash is now stale — and the error must carry everything the agent needs to
  // retry WITHOUT another read: the fresh hash and the fresh body.
  const stale = await doc(redis, "updateSection", { id: step.id, expectedHash: step.hash, body: "x" });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "STALE_SECTION");
  assert.equal(stale.currentHash, ok.hash);
  assert.equal(stale.currentBody, "Do it CAREFULLY.");
});

test("replaceInSection grounds to real content: exact-once or a structured refusal", async () => {
  const redis = fakeRedis();
  const o = await doc(redis, "outline");
  const plan = o.sections[0];

  // "The" appears once in the body — replaces.
  const one = await doc(redis, "replaceInSection", { id: plan.id, expectedHash: plan.hash, old_str: "overview", new_str: "summary" });
  assert.equal(one.ok, true);

  // A string that is not there → NOT_FOUND, never a silent best-match.
  const none = await doc(redis, "replaceInSection", { id: plan.id, expectedHash: one.hash, old_str: "hallucinated text", new_str: "x" });
  assert.equal(none.ok, false);
  assert.equal(none.error, "NOT_FOUND");
});

test("a body containing an H1/H2 is refused — it would corrupt the outline", async () => {
  const redis = fakeRedis();
  const o = await doc(redis, "outline");
  const plan = o.sections[0];
  const bad = await doc(redis, "updateSection", { id: plan.id, expectedHash: plan.hash, body: "## Sneaky heading" });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "INVALID_STRUCTURE");
  // H3 is fine inside a body.
  const fine = await doc(redis, "updateSection", { id: plan.id, expectedHash: plan.hash, body: "### Sub-point\n\nAllowed." });
  assert.equal(fine.ok, true);
});

test("insert places by id, and the render shows the new section in position", async () => {
  const redis = fakeRedis();
  const o = await doc(redis, "outline");
  const [plan] = o.sections;
  const ins = await doc(redis, "insertSection", { afterId: plan.id, level: 2, heading: "Second step", body: "Then this." });
  assert.equal(ins.ok, true);
  assert.ok(ins.id && ins.hash, "a new section returns its server-minted id and hash");
  const r = await doc(redis, "render");
  const md: string = r.markdown;
  assert.ok(md.indexOf("## Second step") < md.indexOf("## First step"), "afterId must place it directly after the H1");
});

test("the doc key derives from the run's ids, never from params — and no ids means no doc", async () => {
  assert.equal(docKeyFor(SCOPE), "md:u1:wf1:c1:n1");
  // conversationId falls back to workflowId, exactly as the retired resolveKey did.
  assert.equal(docKeyFor({ userId: "u1", workflowId: "wf1", nodeId: "n1" }), "md:u1:wf1:wf1:n1");
  const r = await performDoc("outline", {}, fakeRedis(), {}, CONFIG) as any;
  assert.equal(r.ok, false);
  assert.equal(r.error, "NOT_INITIALISED");
});

test("a legacy { content } blob lazily migrates to sections on first read", async () => {
  const redis = fakeRedis();
  redis.data.set("md:u1:wf1:c1:n1", JSON.stringify({ content: "# Old\n\nlegacy body", version: 3, updatedAt: "x" }));
  const o = await doc(redis, "outline");
  assert.equal(o.ok, true);
  assert.equal(o.sections[0].heading, "Old");
  assert.equal(o.version, 4, "migration bumps the stored version");
});
