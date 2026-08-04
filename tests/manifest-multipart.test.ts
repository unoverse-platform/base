/**
 * MULTIPART BODIES, against a real server that parses what arrives.
 *
 * Some endpoints only accept an upload — ElevenLabs speech-to-text takes its audio as a form part — and
 * no amount of JSON expresses that, so without this a node that uploads anything could not be a
 * manifest at all.
 *
 * A REAL SERVER because the thing under test is the WIRE FORMAT: that a boundary exists, that the file
 * part carries its filename and content type, that bytes survive the base64 round trip, and that text
 * fields are not quietly `[object Object]`. A stubbed fetch would assert my own FormData back at me.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { sendRequest } from "../src/manifests/runtime/http/request.js";
import { emptyContext } from "../src/manifests/runtime/index.js";

/** Captures the raw body and the content-type, which is where the boundary lives. */
function echoServer() {
  const seen: { contentType: string; raw: Buffer }[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ contentType: req.headers["content-type"] ?? "", raw: Buffer.concat(chunks) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return { server, seen, listen: () => new Promise<number>((r) => server.listen(0, () => r((server.address() as any).port))) };
}

const nodeFor = (port: number) => ({ type: "Uploader", allowedHosts: [`127.0.0.1:${port}`] }) as any;

test("a file part carries its bytes, filename and content type", async () => {
  const { server, seen, listen } = echoServer();
  const port = await listen();
  try {
    // Bytes that are NOT valid text, so a lazy String() conversion would corrupt them visibly.
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x10, 0x42]);
    await sendRequest(
      nodeFor(port),
      {
        name: "upload",
        method: "POST",
        url: `http://127.0.0.1:${port}/speech-to-text`,
        transport: "json",
        encoding: "multipart",
        body: {
          model_id: "scribe_v1",
          file: { base64: bytes.toString("base64"), mimeType: "audio/mpeg", filename: "audio" },
        },
      },
      emptyContext(),
      "Uploader",
    );

    const { contentType, raw } = seen[0];
    // THE BOUNDARY IS FETCH'S. A declared multipart header would arrive without one and the vendor
    // could not split the body — which is why the executor deletes any Content-Type it was given.
    assert.match(contentType, /^multipart\/form-data; boundary=/);

    const text = raw.toString("latin1");
    assert.match(text, /name="model_id"/);
    assert.match(text, /scribe_v1/);
    // The file part must be named AND typed: many servers ignore a part with no filename, and the
    // resulting 400 talks about a missing field rather than a missing name.
    assert.match(text, /name="file"; filename="audio"/);
    assert.match(text, /Content-Type: audio\/mpeg/);
    // The raw bytes survived the base64 round trip, non-text values included.
    assert.ok(raw.includes(bytes), "the file's bytes did not arrive intact");
  } finally {
    server.close();
  }
});

test("scalars become text fields, and an object becomes JSON rather than [object Object]", async () => {
  const { server, seen, listen } = echoServer();
  const port = await listen();
  try {
    await sendRequest(
      nodeFor(port),
      {
        name: "upload",
        method: "POST",
        url: `http://127.0.0.1:${port}/x`,
        transport: "json",
        encoding: "multipart",
        body: { source_url: "https://example.com/a.mp3", diarize: true, count: 3, options: { a: 1 } },
      },
      emptyContext(),
      "Uploader",
    );
    const text = seen[0].raw.toString("latin1");
    assert.match(text, /name="source_url"[\s\S]*example\.com/);
    // A form carries TEXT, so a boolean and a number are stringified rather than dropped.
    assert.match(text, /name="diarize"[\s\S]*true/);
    assert.match(text, /name="count"[\s\S]*3/);
    // The failure this guards: an object silently becoming the string "[object Object]".
    assert.match(text, /name="options"[\s\S]*\{"a":1\}/);
    assert.ok(!text.includes("[object Object]"), "an object was stringified as [object Object]");
  } finally {
    server.close();
  }
});

test("an omitted optional field sends no part at all", async () => {
  const { server, seen, listen } = echoServer();
  const port = await listen();
  try {
    // `resolveBody` drops a key that resolved to "", so an unset optional simply is not there. Vendors
    // reject an empty value where they accept absence, which is the whole reason for that rule.
    await sendRequest(
      nodeFor(port),
      {
        name: "upload",
        method: "POST",
        url: `http://127.0.0.1:${port}/x`,
        transport: "json",
        encoding: "multipart",
        body: { model_id: "scribe_v1", language_code: "{{ config.missing }}" },
      },
      emptyContext(),
      "Uploader",
    );
    const text = seen[0].raw.toString("latin1");
    assert.match(text, /name="model_id"/);
    assert.ok(!text.includes('name="language_code"'), "an unset optional field was sent as an empty part");
  } finally {
    server.close();
  }
});

/**
 * `scope.platformUrl` — the platform's own API, for the nodes that call US rather than a vendor.
 *
 * DERIVED from UNOVERSE_RUNTIME_PORT, which docker-compose already sets: a node runs inside the service,
 * so it is calling itself and needs no configuration to learn its own address. The retired SpatialIngest
 * instead read UNOVERSE_SERVICE_URL — a variable set NOWHERE in this repo — behind a hardcoded
 * `|| "http://localhost:4106"`, so the fallback was the entire behaviour.
 *
 * The guard below is not about platformUrl specifically. ANY expression that resolves to undefined
 * produces a well-formed string like "undefined/content/ingest" that fails at DNS, reporting a host
 * nobody configured rather than the value that was missing — the same trap as a missing job id in
 * poll.ts, where the string form of nothing looks like a value.
 */
test("a url that resolved to undefined says so, instead of failing at DNS", async () => {
  await assert.rejects(
    () =>
      sendRequest(
        { type: "PlatformCaller", allowedHosts: ["*"] } as any,
        { name: "call", method: "POST", url: "return config.missingBase + '/content/ingest'", transport: "json", body: {} },
        emptyContext(),
        "PlatformCaller",
      ),
    (e: Error) => /undefined\/content\/ingest/.test(e.message),
    "the error must show the url it produced rather than a refused connection",
  );
});

test("a derived platformUrl builds a normal url", async () => {
  const { server, seen, listen } = echoServer();
  const port = await listen();
  try {
    await sendRequest(
      { type: "PlatformCaller", allowedHosts: [`127.0.0.1:${port}`] } as any,
      { name: "call", method: "POST", url: "return scope.platformUrl + '/content/ingest'", transport: "json", body: { a: 1 } },
      emptyContext({ scope: { platformUrl: `http://127.0.0.1:${port}` } }),
      "PlatformCaller",
    );
    assert.equal(seen.length, 1, "the request should have been sent");
  } finally {
    server.close();
  }
});
