/**
 * POLLING A JOB, both shapes, against a real HTTP server.
 *
 * `poll` already started a job with the CALL's own method, so POST-start → GET-poll worked from the
 * beginning — the backlog entry claiming otherwise was wrong, and this file's first test exists to
 * pin that rather than take it on trust again.
 *
 * What genuinely did not work is a POST STATUS CHECK. The status call was built with a hardcoded
 * `method: "GET"` and `body: undefined`, which is fine for the vendors that put a job id in the path
 * and useless for AWS: Textract's `GetDocumentAnalysis` is a POST carrying `{ JobId }`, and every AWS
 * batch job is shaped that way. That single hardcoded string is what kept the whole family in
 * TypeScript.
 *
 * A REAL SERVER, not a stubbed fetch. The thing under test is what actually goes on the wire —
 * method, body, and whether the job id survives to the second request — and a stub would be asserting
 * my own mock rather than the executor's behaviour.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { fetchPolled } from "../src/manifests/runtime/loops/poll.js";
import { emptyContext } from "../src/manifests/runtime/index.js";

/** Records every request it receives, so a test can assert what was SENT, not just what came back. */
function jobServer(finishAfter: number) {
  const seen: Array<{ method: string; url: string; body: string }> = [];
  let polls = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/start") return res.end(JSON.stringify({ JobId: "job-42" }));
      // Every status shape below answers on the same handler; the job finishes after N asks.
      polls++;
      res.end(JSON.stringify({ JobStatus: polls >= finishAfter ? "SUCCEEDED" : "IN_PROGRESS", value: 7 }));
    });
  });
  return { server, seen, listen: () => new Promise<number>((r) => server.listen(0, () => r((server.address() as any).port))) };
}

/**
 * Built per test with the REAL port, because `allowedHosts` matches host AND port. Declaring a bare
 * "127.0.0.1" against an ephemeral port is refused — which is the rule working, so the fixture bends
 * to it rather than reaching for the "*" wildcard and testing nothing.
 */
const nodeFor = (port: number) => ({ type: "TestJob", allowedHosts: [`127.0.0.1:${port}`] }) as any;

test("POST start with a GET poll — the shape that already worked, pinned", async () => {
  const { server, seen, listen } = jobServer(2);
  const port = await listen();
  try {
    const result: any = await fetchPolled(
      nodeFor(port),
      {
        name: "job",
        method: "POST",
        url: `http://127.0.0.1:${port}/start`,
        transport: "json",
        body: { input: "x" },
        poll: {
          url: `return "http://127.0.0.1:${port}/status/" + response.JobId`,
          until: `return response.JobStatus === 'SUCCEEDED'`,
          intervalMs: 5,
        },
      },
      emptyContext(),
      "TestJob",
    );
    assert.equal(result.JobStatus, "SUCCEEDED");
    assert.equal(seen[0].method, "POST", "the job must be STARTED with the call's own method");
    assert.equal(seen[1].method, "GET", "the status check defaults to GET");
    // The job id reached the status URL — the failure mode the url guard exists for.
    assert.match(seen[1].url, /job-42/);
  } finally {
    server.close();
  }
});

test("POST start with a POST poll carrying a body — the AWS shape", async () => {
  const { server, seen, listen } = jobServer(3);
  const port = await listen();
  try {
    const result: any = await fetchPolled(
      nodeFor(port),
      {
        name: "analyse",
        method: "POST",
        url: `http://127.0.0.1:${port}/start`,
        transport: "json",
        body: { Document: "s3://x" },
        poll: {
          url: `return "http://127.0.0.1:${port}/status"`,
          method: "POST",
          // The job id lives ONLY in the start reply, which is why this resolves against it.
          body: `return { JobId: response.JobId }`,
          until: `return response.JobStatus === 'SUCCEEDED'`,
          intervalMs: 5,
        },
      },
      emptyContext(),
      "TestJob",
    );
    assert.equal(result.JobStatus, "SUCCEEDED");

    const polls = seen.slice(1);
    assert.ok(polls.length >= 3, `expected to poll until finished, saw ${polls.length}`);
    for (const p of polls) {
      assert.equal(p.method, "POST", "every status check must use the declared method");
      // THE BODY IS THE POINT. Before this change it was dropped, so AWS answered "missing JobId"
      // on every attempt until the poll timed out — a slow failure that read as a slow job.
      assert.deepEqual(JSON.parse(p.body), { JobId: "job-42" });
    }
    // The start body must NOT leak into the status check: it described starting work.
    assert.ok(!polls.some((p) => p.body.includes("s3://x")), "the start body leaked into a status check");
  } finally {
    server.close();
  }
});

test("the start body and query never carry over to the status check", async () => {
  const { server, seen, listen } = jobServer(1);
  const port = await listen();
  try {
    await fetchPolled(
      nodeFor(port),
      {
        name: "job",
        method: "POST",
        url: `http://127.0.0.1:${port}/start`,
        transport: "json",
        body: { big: "payload" },
        query: { mode: "start" },
        poll: { url: `return "http://127.0.0.1:${port}/status"`, until: `return true`, intervalMs: 5 },
      },
      emptyContext(),
      "TestJob",
    );
    // `until` is tested against the START reply first, so a job that finishes inline never polls at
    // all — the Hyperbrowser fast path. One request total.
    assert.equal(seen.length, 1, "a job that is already done on the start reply must not poll");
  } finally {
    server.close();
  }
});
