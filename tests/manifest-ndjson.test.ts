/**
 * NDJSON BODIES, against a real server that reads what actually arrived.
 *
 * Newline-delimited JSON is one complete document per line, no enclosing array and no commas.
 * Pinecone's integrated-inference upsert takes a batch this way so the server can stream
 * records instead of holding the batch in memory.
 *
 * THE FAILURE THIS GUARDS is quiet in the worst way: `JSON.stringify` of the same records
 * produces `[{...},{...}]`, which is perfectly valid JSON. It is only invalid for THIS
 * vendor, which parses line by line and chokes on the first unterminated document. A stubbed
 * fetch asserting my own serialization back at me would not notice, so this asserts the
 * BYTES ON THE WIRE and re-parses them the way the vendor would.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { sendRequest } from "../src/manifests/runtime/http/request.js";
import { emptyContext } from "../src/manifests/runtime/index.js";

function echoServer() {
  const seen: { contentType: string; raw: string }[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ contentType: req.headers["content-type"] ?? "", raw: Buffer.concat(chunks).toString("utf8") });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ upserted: seen.length }));
    });
  });
  return { server, seen, listen: () => new Promise<number>((r) => server.listen(0, () => r((server.address() as any).port))) };
}

const nodeFor = (port: number) => ({ type: "Upserter", allowedHosts: [`127.0.0.1:${port}`] }) as any;

async function send(port: number, body: unknown) {
  await sendRequest(
    nodeFor(port),
    { name: "upsert", method: "POST", url: `http://127.0.0.1:${port}/records/upsert`, transport: "json", encoding: "ndjson", body },
    emptyContext(),
    "Upserter",
  );
}

test("an array of records becomes one JSON document per line, with no array wrapper", async () => {
  const { server, seen, listen } = echoServer();
  const port = await listen();
  try {
    await send(port, [
      { _id: "rec1", chunk_text: "the first" },
      { _id: "rec2", chunk_text: "the second" },
      { _id: "rec3", chunk_text: "the third" },
    ]);

    const { raw, contentType } = seen[0];
    // A strict JSON parser must dispatch on this, not on application/json.
    assert.equal(contentType, "application/x-ndjson");

    // THE WRAPPER IS THE BUG. `[` at the start is what JSON.stringify would have produced.
    assert.ok(!raw.startsWith("["), `the body was sent as a JSON array, not ndjson: ${raw.slice(0, 60)}`);
    assert.ok(!raw.includes("},{"), "records are comma-separated, which is the array form again");

    // Parsed the way the vendor parses it: line by line, each line whole.
    const lines = raw.split("\n");
    assert.equal(lines.length, 3, "one line per record");
    const parsed = lines.map((l) => JSON.parse(l));
    assert.deepEqual(
      parsed.map((p: any) => p._id),
      ["rec1", "rec2", "rec3"],
      "record order must survive, since ids are the caller's handle on what was written",
    );
    assert.equal(parsed[1].chunk_text, "the second");
  } finally {
    server.close();
  }
});

test("a single record is still one line, not a bare object needing special-casing", async () => {
  // Upserting one row is the common case and must not need a different manifest shape.
  const { server, seen, listen } = echoServer();
  const port = await listen();
  try {
    await send(port, { _id: "only", chunk_text: "alone" });
    assert.equal(seen[0].raw.split("\n").length, 1);
    assert.deepEqual(JSON.parse(seen[0].raw), { _id: "only", chunk_text: "alone" });
  } finally {
    server.close();
  }
});

test("no trailing newline, which would parse as an empty fourth record", async () => {
  // `join` rather than a per-row append, precisely so the body does not end in "\n". A
  // vendor splitting on newline would otherwise see one final empty line and reject it.
  const { server, seen, listen } = echoServer();
  const port = await listen();
  try {
    await send(port, [{ _id: "a" }, { _id: "b" }]);
    assert.ok(!seen[0].raw.endsWith("\n"), "a trailing newline makes an empty trailing record");
    assert.equal(seen[0].raw.split("\n").filter((l) => l.trim() === "").length, 0);
  } finally {
    server.close();
  }
});

test("a value containing a newline does not split into two records", async () => {
  // The one input that could genuinely corrupt the framing. JSON escapes it to \\n inside
  // the string, so the line count is unchanged — asserted rather than assumed, because the
  // alternative (building the body by hand in an expression) would NOT be safe here, and
  // that is the whole argument for this being an encoding.
  const { server, seen, listen } = echoServer();
  const port = await listen();
  try {
    await send(port, [{ _id: "multi", chunk_text: "line one\nline two" }, { _id: "next" }]);
    const lines = seen[0].raw.split("\n");
    assert.equal(lines.length, 2, "an embedded newline broke the record framing");
    assert.equal(JSON.parse(lines[0]).chunk_text, "line one\nline two");
  } finally {
    server.close();
  }
});
