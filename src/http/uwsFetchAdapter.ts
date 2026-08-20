/**
 * uWS ↔ Web-Fetch adapter — the ONLY bespoke transport code.
 *
 * The MCP SDK's transport is framework-agnostic: `WebStandardStreamableHTTPServerTransport`
 * exposes `handleRequest(req: Request) => Promise<Response>` — the exact entry the SDK
 * documents for Hono / Cloudflare Workers / Deno / Bun. So we do NOT hand-roll the MCP
 * protocol: this adapter just converts a uWS request into a Web `Request`, and writes the
 * Web `Response` (single-shot JSON, or a long-lived SSE stream) back onto the uWS
 * `HttpResponse`. All MCP protocol logic stays inside the SDK transport.
 *
 * uWS rules honored here (these are the easy things to get wrong):
 *  - `HttpRequest` is valid only synchronously → method/url/headers are read up-front.
 *  - `onAborted` MUST be registered before the first `await`, or uWS throws on disconnect.
 *  - every write happens inside `res.cork()`.
 *  - body chunks are copied synchronously (uWS reuses the chunk's backing memory).
 */
import { gzipSync } from "node:zlib";
import type { HttpRequest, HttpResponse } from "uWebSockets.js";

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  202: "Accepted",
  204: "No Content",
  304: "Not Modified",
  400: "Bad Request",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  500: "Internal Server Error",
};
const statusLine = (code: number): string => `${code} ${STATUS_TEXT[code] ?? "OK"}`;

/** Text-ish payloads compress ~4:1; anything else (images, audio) is already packed. */
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|vnd\.unoverse))/;
/** Below this, the gzip header + CPU outweigh the shrink. */
const COMPRESS_MIN_BYTES = 1024;

function writeCors(res: HttpResponse): void {
  // The workbench is same-origin (via the Vite proxy) so needs none of this; kept so
  // external MCP clients / the Inspector / the canvas can connect cross-origin.
  res.writeHeader("Access-Control-Allow-Origin", "*");
  res.writeHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.writeHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id, mcp-protocol-version");
  res.writeHeader("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version");
  // A PREFLIGHT IS A ROUND TRIP THAT CARRIES NO DATA, AND WITHOUT THIS THE BROWSER REPEATS
  // IT CONSTANTLY. Chrome's default preflight cache is 5 seconds, so an app making a series
  // of MCP calls pays OPTIONS → 204 → the real request, doubling the round trips on nearly
  // every one. On a universe served from one region that is the dominant cost of loading an
  // app: measured London → UAE, a round trip is ~150ms and the server's own processing is
  // ~0ms, so the preflights were most of the wait, not the work.
  //
  // 24h is the practical ceiling (Chromium caps at 2h, Firefox at 24h; both clamp rather
  // than ignore). The response being cached says only which methods and headers are allowed,
  // which is static in this file — no authorization decision is cached, because auth is
  // checked on the real request every time.
  res.writeHeader("Access-Control-Max-Age", "86400");
}

/** Buffer the full request body; resolves on the last chunk (copies as it goes). */
function readBody(res: HttpResponse): Promise<Buffer> {
  return new Promise((resolve) => {
    // Collect copies and concat ONCE at the end. The old per-chunk
    // `Buffer.concat([buf, chunk])` reallocated+copied the whole accumulator on every
    // chunk — O(n²) in body size, which hurts large /execute payloads. Each chunk is
    // still copied synchronously (uWS reuses the chunk's backing memory after return).
    const chunks: Buffer[] = [];
    res.onData((chunk, isLast) => {
      // COPY each chunk synchronously NOW — uWS detaches/reuses the chunk's backing
      // ArrayBuffer after this callback returns. `Buffer.from(arrayBuffer)` is only a
      // VIEW (no copy), so wrap in a Uint8Array, which Buffer.from then copies; deferring
      // a bare view to the final concat would read detached memory.
      chunks.push(Buffer.from(new Uint8Array(chunk)));
      if (isLast) resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks));
    });
  });
}

/**
 * Drive a uWS request through a Web-fetch handler: OPTIONS preflight, body buffering,
 * and pumping the Response (single-shot JSON or long-lived SSE) back to uWS.
 */
export async function handleFetch(
  res: HttpResponse,
  req: HttpRequest,
  handler: (request: Request) => Promise<Response>,
): Promise<void> {
  const state: { aborted: boolean; reader?: ReadableStreamDefaultReader<Uint8Array> } = { aborted: false };
  res.onAborted(() => {
    state.aborted = true;
    void state.reader?.cancel().catch(() => {});
  });

  // HttpRequest is only valid synchronously — capture everything now.
  const method = req.getMethod().toUpperCase();
  const query = req.getQuery();
  const url = `http://localhost${req.getUrl()}${query ? `?${query}` : ""}`;
  const headers: Record<string, string> = {};
  req.forEach((k, v) => {
    headers[k] = v;
  });

  if (method === "OPTIONS") {
    res.cork(() => {
      res.writeStatus(statusLine(204));
      writeCors(res);
      res.endWithoutBody();
    });
    return;
  }

  const body = method !== "GET" && method !== "HEAD" ? await readBody(res) : undefined;
  if (state.aborted) return;

  let response: Response;
  try {
    const init: RequestInit = { method, headers };
    if (body && body.length) init.body = new Uint8Array(body); // BodyInit-compatible copy of the Buffer
    response = await handler(new Request(url, init));
  } catch (err) {
    // Log the detail server-side; return a GENERIC message to the client (no internal
    // detail leakage — MCP security best-practices).
    console.error("[unoverse] request handler error:", err);
    if (!state.aborted) {
      res.cork(() => {
        res.writeStatus(statusLine(500));
        res.writeHeader("Content-Type", "application/json");
        writeCors(res);
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
      });
    }
    return;
  }
  if (state.aborted) return;

  const isSse = (response.headers.get("content-type") ?? "").startsWith("text/event-stream");

  // Single-shot responses (everything except SSE) are buffered so large text payloads
  // can be gzipped. Neither uWS nor the DO load balancer compresses, so without this
  // every byte travels identity-encoded — the widget boot alone was ~660KB of JS/JSON
  // that gzips to ~150KB. SSE must stream, so it is never buffered or compressed.
  if (!isSse) {
    const contentType = response.headers.get("content-type") ?? "";
    const acceptsGzip = /(^|,)\s*gzip\s*(;|,|$)/.test(headers["accept-encoding"] ?? "");
    let payload: Buffer | null = null;
    try {
      payload = Buffer.from(await response.arrayBuffer());
    } catch {
      payload = null; // body unreadable — fall through and end empty below
    }
    if (state.aborted) return;
    const shouldCompress =
      acceptsGzip &&
      payload !== null &&
      payload.length >= COMPRESS_MIN_BYTES &&
      COMPRESSIBLE.test(contentType) &&
      !response.headers.get("content-encoding");
    const body = shouldCompress && payload ? gzipSync(payload) : payload;
    res.cork(() => {
      res.writeStatus(statusLine(response.status));
      response.headers.forEach((value, key) => {
        const k = key.toLowerCase();
        // uWS generates these itself on every response. Forwarding an upstream copy
        // (e.g. the engine's own `date`) yields a DUPLICATE header — nginx just warns
        // and serves 200, but HTTP/3 (QUIC) rejects the malformed header block with
        // QUIC_PACKET_READ_ERROR. Skip them so uWS's single copy is authoritative.
        // access-control-*: writeCors() below is authoritative — forwarding an upstream
        // copy too produced the doubled `access-control-allow-origin: *,*` seen live.
        if (k === "content-length" || k === "date" || k === "server" || k.startsWith("access-control-")) return;
        res.writeHeader(key, value);
      });
      if (shouldCompress) {
        res.writeHeader("Content-Encoding", "gzip");
        // Encoding varies by the request's Accept-Encoding, so shared caches must key on it.
        res.writeHeader("Vary", "Accept-Encoding");
      }
      writeCors(res);
      if (body && body.length) res.end(body);
      else res.endWithoutBody();
    });
    return;
  }

  // SSE: write head, then pump chunks until the transport closes the stream.
  const reader = response.body?.getReader();
  state.reader = reader;
  res.cork(() => {
    res.writeStatus(statusLine(response.status));
    response.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      // See the single-shot branch for why these are skipped.
      if (k === "content-length" || k === "date" || k === "server" || k.startsWith("access-control-")) return;
      res.writeHeader(key, value);
    });
    writeCors(res);
  });

  if (!reader) {
    if (!state.aborted) res.cork(() => res.end());
    return;
  }

  // SSE pump lifecycle. A GET stream that dies leaves its session registered while
  // every push silently drops (the SDK sends nothing to a missing standalone stream),
  // so these logs are the ground truth for whether a client's inbound stream exists.
  const path = new URL(url).pathname;
  // Session id ties a pump to its MCP session (request header on established sessions,
  // response header on initialize).
  const sid = headers["mcp-session-id"] ?? response.headers.get("mcp-session-id") ?? "-";
  if (isSse) console.log(`[unoverse:sse] pump OPEN ${method} ${path} sid=${sid}`);

  // KEEPALIVE — an idle SSE stream writes NOTHING, and a silent connection is fair game
  // for any middlebox (the Vite dev proxy kills one after ~2 min; observed as "client
  // aborted" mid-run, after which every push into the still-registered session drops
  // silently). An SSE comment line every 25s keeps every hop alive; parsers ignore
  // comments by spec, so no client sees them.
  // 10s, not 25s: the client's zombie watchdog declares death after ~1.5 missed
  // beats, so the beat interval directly sets how long a silently-dead stream can
  // blind the canvas. Comment lines are ~18 bytes — frequency is free.
  const keepalive = isSse
    ? setInterval(() => {
        if (!state.aborted) res.cork(() => res.write(": keepalive\n\n"));
      }, 10_000)
    : null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (state.aborted) {
        void reader.cancel().catch(() => {});
        if (isSse) console.log(`[unoverse:sse] pump CLOSED (client aborted) ${method} ${path} sid=${sid}`);
        return;
      }
      if (done) break;
      if (value) res.cork(() => res.write(value));
    }
    if (!state.aborted) res.cork(() => res.end());
    if (isSse) console.log(`[unoverse:sse] pump CLOSED (stream ended) ${method} ${path} sid=${sid}`);
  } catch {
    void reader.cancel().catch(() => {});
    if (!state.aborted) res.cork(() => res.end());
    if (isSse) console.log(`[unoverse:sse] pump CLOSED (pump error) ${method} ${path} sid=${sid}`);
  } finally {
    if (keepalive) clearInterval(keepalive);
  }
}
