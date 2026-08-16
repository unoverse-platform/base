import { evaluate } from "../templating.js";
import { decodeDynamoJson } from "../auth/aws.js";

/**
 * Reading a response off the wire. Bytes to payloads, and nothing else.
 *
 * Part of the manifest runtime (DECLARATIVE_NODES.md §2): the manifest DESCRIBES the
 * service, this half COMPUTES it. Split by concern so each piece stays readable.
 */

export interface Emission {
  /**
   * The output connector this fired on. Absent on a `send` row, which addresses a NODE
   * instead of a connector and therefore has no dot on the canvas and no edge to draw.
   */
  emit?: string;
  /** Target NODE id, resolved from the row's `send` template. Present only on a send row. */
  to?: string;
  /** Input handle on the target node. Defaults to `input`. */
  handle?: string;
  value: unknown;
}

/**
 * Read a Server-Sent Events stream into parsed payloads.
 *
 * Reading and DECIDING are separate: this turns bytes into events, and events.ts decides
 * what leaves the node. Keeping them apart is why the tool loop can watch the same stream
 * for a tool call without the emission table knowing anything about tools.
 */
export async function readSse(res: Response, terminator: string | undefined, onPayload: (payload: any) => Promise<void>): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("response has no body to stream");
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; a frame's data may span lines.
    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data || (terminator && data === terminator)) continue;

      let payload: any;
      try {
        payload = JSON.parse(data);
      } catch {
        continue; // a keep-alive or comment frame
      }

      await onPayload(payload);
    }
  }
}

/**
 * Read a settled response body, per the declared transport and encoding.
 *
 * `encoding` is a second axis to `transport`: transport says how the reply is FRAMED
 * (one body, or a stream of events), encoding says how the values inside it are SPELLED.
 * DynamoDB is JSON-framed and type-tagged, so it needs both.
 */
export async function readSettled(res: Response, transport: string, encoding?: string): Promise<any> {
  if (transport === "text") return res.text();

  /**
   * THE HEADERS ARE THE ANSWER. A HEAD request has no body by definition: the size, the
   * content type and the modified date all come back as headers and there is nothing else.
   *
   * Reading it as `text` gave an empty string and a manifest with no way to reach any of it,
   * which is what makes this a transport rather than a flag. Lower-cased keys, because HTTP
   * header names are case-insensitive and an expression asking for `content-length` should
   * not depend on what the vendor happened to capitalise.
   */
  if (transport === "headers") {
    const out: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }

  /**
   * XML, for the vendors that never moved. S3's list endpoints are the reason.
   *
   * Parsed to the same plain object shape a JSON reply would give, so an events table reads
   * `response.ListBucketResult.Contents` either way and nothing downstream knows or cares
   * which wire format it came from.
   *
   * `isArray` is the setting that matters. XML cannot distinguish one element from a list of
   * one, so a bucket holding a SINGLE object parses `Contents` as an object while a bucket
   * holding two parses it as an array. A manifest written against the second silently breaks
   * on the first, and the failure only appears once a bucket happens to have one file in it.
   * Naming the repeatable elements up front makes them always arrays.
   */
  if (transport === "xml") {
    const { XMLParser } = await import("fast-xml-parser");
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@",
      isArray: (name) => XML_REPEATED.has(name),
    });
    return parser.parse(await res.text());
  }

  /**
   * BYTES. Audio a model generated, an image to send on to another model, a file to store.
   *
   * Handed over as BASE64 rather than a Buffer or a stream, because what leaves a node
   * travels on the event bus and through JSON: a Buffer does not survive that trip, and a
   * stream cannot be handed to two consumers. base64 is the form every downstream thing can
   * actually hold.
   *
   * `contentType` comes along because bytes without their type are unusable — the receiver
   * has to guess whether it is holding an mp3 or a PDF — and the vendor already said.
   */
  if (transport === "binary") {
    const bytes = Buffer.from(await res.arrayBuffer());
    return {
      base64: bytes.toString("base64"),
      contentType: res.headers.get("content-type") || "application/octet-stream",
      bytes: bytes.length,
    };
  }

  const payload = await res.json().catch(() => ({}));
  return encoding === "dynamodbJson" ? decodeDynamoJson(payload) : payload;
}

/**
 * Elements that are a LIST even when there is one of them.
 *
 * Named rather than inferred, because the ambiguity is in XML itself and no parser can
 * resolve it without being told. Add to this when a node meets a new repeatable element;
 * getting it wrong shows up as "works with 2 files, breaks with 1".
 */
const XML_REPEATED = new Set(["Contents", "CommonPrefixes", "Bucket", "Version", "DeleteMarker", "member", "item"]);

/**
 * A 200 carrying an error body must not read as success.
 *
 * This was declared by every node and implemented on the service channel only, so on the
 * workflow channel a failed stream emitted nothing and reported success. Same class of
 * gap as `retry`: named in the schema, absent from the executor.
 */
export async function assertOk(node: unknown, call: any, payload: any, where: string): Promise<void> {
  if (!call.error?.when) return;
  if (!(await evaluate(call.error.when, { response: payload }))) return;
  const message = call.error.message ? await evaluate(call.error.message, { response: payload }) : "upstream error";
  throw new Error(`${where}: ${message}`);
}
