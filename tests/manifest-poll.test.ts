/**
 * WAITING ON A JOB — the capability that lets an asynchronous vendor stop being code
 * (DECLARATIVE_NODES.md §5). Start work, get a handle, ask until it is done.
 *
 * Asserted on BEHAVIOUR against a stubbed fetch, because every failure mode here is
 * silent in the same way:
 *
 *   settling on the START reply hands back a job id where the answer was expected, and
 *   every downstream field reads empty with nothing reporting a problem
 *
 *   missing the INLINE completion turns the vendor's fast path into the broken one, by
 *   building a status URL out of an id that was never sent
 *
 *   ignoring `failed` polls a dead job to the attempt bound and calls it a timeout, which
 *   sends whoever reads it looking for a slow job rather than a broken one
 *
 * The interval is set to 1ms throughout so these run in milliseconds; the loop under test
 * is the same one either way.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const UNOVERSE = join(HERE, "../../../apps/unoverse");

const { runCalls, emptyContext, primeTemplating } = await import("@unoverse-platform/base/manifests/runtime/index.js");

const NODE: any = { type: "TestNode", allowedHosts: ["api.example.com"] };

/** Swap fetch for one that records every request and answers from a function. */
function stubFetch(reply: (url: string, init: any, n: number) => unknown) {
  const seen: Array<{ url: string; method: string; body: any }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const n = seen.length;
    seen.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(reply(String(url), init, n)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as any;
  return { seen, restore: () => { globalThis.fetch = real; } };
}

/** A job call: POST to start, then follow the id the start reply hands back. */
const job = (over: Record<string, unknown> = {}) => ({
  name: "work",
  method: "POST",
  url: "https://api.example.com/jobs",
  transport: "json",
  poll: {
    until: "return response.status === 'completed'",
    failed: "return response.status === 'failed'",
    message: "return response.error",
    url: "return 'https://api.example.com/jobs/' + response.jobId",
    intervalMs: 1,
    maxAttempts: 10,
    ...((over.poll as object) ?? {}),
  },
  // `poll` is merged above, so it must not be overwritten wholesale by the spread.
  ...(() => { const { poll, ...rest } = over; return rest; })(),
});

test("a job is followed until it completes, and settles on the FINAL payload", async () => {
  await primeTemplating();
  // Start hands back an id and "pending"; two polls later it is done.
  const { seen, restore } = stubFetch((url, _init, n) =>
    n === 0 ? { jobId: "j1", status: "pending" }
      : n < 3 ? { jobId: "j1", status: "running" }
        : { jobId: "j1", status: "completed", data: { markdown: "the page" } },
  );
  try {
    const { results } = await runCalls(NODE, [job()], emptyContext(), "test");

    assert.equal(seen[0].method, "POST", "the first request starts the job");
    assert.equal(seen[1].url, "https://api.example.com/jobs/j1", "the status URL is built from the START reply");
    assert.equal(seen[1].method, "GET", "a status check is a GET, whatever the start request was");
    assert.equal(seen[1].body, undefined, "the start request's BODY described starting work and must not be resent");

    assert.deepEqual(
      results.work,
      { jobId: "j1", status: "completed", data: { markdown: "the page" } },
      "the call settles on the final status payload, NOT the start receipt",
    );
  } finally {
    restore();
  }
});

test("a job that finishes INLINE on the start reply never polls", async () => {
  await primeTemplating();
  // The vendor's fast path: no jobId at all, the answer is right there on the POST.
  const { seen, restore } = stubFetch(() => ({ status: "completed", data: { markdown: "inline" } }));
  try {
    const { results } = await runCalls(NODE, [job()], emptyContext(), "test");
    assert.equal(seen.length, 1, "one request, because the job was already done");
    assert.deepEqual((results.work as any).data, { markdown: "inline" });
  } finally {
    restore();
  }
});

test("a job that FAILS throws with the vendor's reason, and stops polling", async () => {
  await primeTemplating();
  const { seen, restore } = stubFetch((_url, _init, n) =>
    n === 0 ? { jobId: "j2", status: "pending" } : { jobId: "j2", status: "failed", error: "blocked by robots.txt" },
  );
  try {
    await assert.rejects(
      () => runCalls(NODE, [job()], emptyContext(), "test"),
      // The vendor's own words, not "the job did not finish": a terminal failure reported
      // as a timeout is the wrong diagnosis on the wrong screen.
      /blocked by robots\.txt/,
    );
    assert.equal(seen.length, 2, "it stops at the failure rather than polling out the bound");
  } finally {
    restore();
  }
});

test("a job that never finishes gives up at maxAttempts and says how long it waited", async () => {
  await primeTemplating();
  const { seen, restore } = stubFetch((_url, _init, n) =>
    n === 0 ? { jobId: "j3", status: "pending" } : { jobId: "j3", status: "running" },
  );
  try {
    await assert.rejects(
      () => runCalls(NODE, [job({ poll: { maxAttempts: 4 } })], emptyContext(), "test"),
      /still unfinished after 4 polls/,
    );
    assert.equal(seen.length, 5, "one start plus exactly maxAttempts polls");
  } finally {
    restore();
  }
});

test("a start reply with no handle fails loudly rather than polling a broken URL", async () => {
  await primeTemplating();
  // Not done, and nothing to follow. Silently polling "https://…/jobs/undefined" would
  // produce a 404 loop and blame the vendor for the manifest's problem.
  const { restore } = stubFetch(() => ({ status: "pending" }));
  try {
    await assert.rejects(
      () => runCalls(NODE, [job()], emptyContext(), "test"),
      /poll.url did not resolve to a real URL/,
    );
  } finally {
    restore();
  }
});

/**
 * `chunk` walks a collection, `poll` waits on a request. They are different axes, so a
 * vendor whose endpoint is BOTH single-item and asynchronous needs both at once. Without
 * this the node goes back to being a hand-written Promise.all.
 */
test("chunk and poll compose: one request per item, each followed to completion", async () => {
  await primeTemplating();
  const { seen, restore } = stubFetch((url, init) => {
    if (init?.method === "POST") {
      const which = JSON.parse(init.body).url.slice(-1);
      return { jobId: `job${which}`, status: "pending" };
    }
    return { status: "completed", data: { json: { from: url.slice(-4) } } };
  });
  try {
    const { results } = await runCalls(
      NODE,
      [
        {
          name: "extract",
          method: "POST",
          url: "https://api.example.com/jobs",
          transport: "json",
          chunk: { items: "return ['https://a.test/1', 'https://a.test/2']", size: 1 },
          body: { url: "return batch[0]" },
          poll: {
            until: "return response.status === 'completed'",
            url: "return 'https://api.example.com/jobs/' + response.jobId",
            intervalMs: 1,
          },
        },
      ],
      emptyContext(),
      "test",
    );

    const reply: any = results.extract;
    assert.equal(reply.batches, 2, "one batch per url");
    assert.equal(seen.length, 4, "two starts and two polls");
    assert.deepEqual(
      reply.items,
      ["https://a.test/1", "https://a.test/2"],
      "the reply carries WHAT it walked, so a fan-out can pair each result back to its input",
    );
    assert.equal(reply.results.length, 2, "one entry per batch");
  } finally {
    restore();
  }
});

/**
 * Positional results. This only bites when `chunk` fans out a READ: a write reads `sent`
 * and never notices, but pairing reply i to item i is impossible if the failures were
 * dropped, and the mislabelled output LOOKS like an answer.
 */
test("a failed batch holds its slot in results, so later replies stay on the right item", async () => {
  await primeTemplating();
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async () => {
    // The middle item fails; the ones either side succeed.
    const i = n++;
    return i === 1
      ? new Response("nope", { status: 500, statusText: "Server Error" })
      : new Response(JSON.stringify({ got: i }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as any;
  try {
    const { results } = await runCalls(
      NODE,
      [
        {
          name: "fan",
          method: "POST",
          url: "https://api.example.com/one",
          transport: "json",
          chunk: { items: "return ['a', 'b', 'c']", size: 1 },
          body: { it: "return batch[0]" },
        },
      ],
      emptyContext(),
      "test",
    );
    const reply: any = results.fan;
    assert.equal(reply.results.length, 3, "one entry per batch, including the failed one");
    assert.equal(reply.results[1], null, "the failure holds its slot");
    assert.deepEqual(reply.results[2], { got: 2 }, "the third reply is still at index 2, not shifted to 1");
    assert.equal(reply.sent, 2);
    assert.equal(reply.errors.length, 1);
  } finally {
    globalThis.fetch = real;
  }
});
