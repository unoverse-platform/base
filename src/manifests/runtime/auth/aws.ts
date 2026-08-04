/**
 * AWS Signature Version 4.
 *
 * THE CANONICAL CASE FOR THE WHOLE FORMAT (DECLARATIVE_NODES.md §2). Signing is
 * computation over the request — it hashes the exact bytes being sent — so it belongs to
 * the executor. What service to call, at what URL, with what body, is description, so it
 * belongs to the manifest. Implement this once and DynamoDB, Bedrock, Textract and
 * Comprehend stop being TypeScript packages.
 *
 * It is also why AWS "needs an SDK". Take the signer out of @aws-sdk/client-dynamodb and
 * what remains is a JSON POST to one endpoint with a header naming the operation.
 *
 * NOT HAND-ROLLED, deliberately. `@smithy/signature-v4` is the same signer every AWS
 * customer runs, and the edge cases are where this bites: canonical URI encoding differs by
 * service (S3 does not double-encode paths, everything else does), headers must be trimmed
 * and sorted just so, and temporary credentials add a token header that is itself signed.
 * Getting any of them subtly wrong returns a 403, which reads as a bad credential and sends
 * whoever sees it hunting IAM for a problem that is in here.
 *
 * NOTHING HERE IS PER-VENDOR IN THE AWS SENSE EITHER: this signs a request for whatever
 * `service` the manifest names. There is no DynamoDB in this file, and there must not be.
 */
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

export interface AwsSigning {
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Present only for temporary credentials (STS / assumed roles). */
  sessionToken?: string;
  /**
   * Send and sign `x-amz-content-sha256`, the payload hash. Defaults to ON.
   *
   * S3 REQUIRES it. Every other service accepts it, and signing the payload hash
   * explicitly is strictly safer than leaving it implicit, so ON is the right default
   * rather than a per-service opt-in nobody would remember to set.
   *
   * Off exists because AWS's own published test vectors are written without it, and a
   * signer that cannot be compared against a known-good value is a signer nobody can check.
   */
  applyChecksum?: boolean;
}

/**
 * Sign a fully-built request, returning the headers to send.
 *
 * TAKES THE FINAL URL AND THE FINAL BODY, and that ordering is the whole subtlety. Every
 * other auth scheme resolves before the request is assembled, because a bearer token does
 * not depend on what it is attached to. A signature does: it covers the method, the path,
 * the query, the headers and a hash of the body, so it cannot be computed until all of
 * them are settled. Signing early would produce a valid-looking Authorization header for a
 * request that was never sent.
 */
export async function signAwsRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  signing: AwsSigning,
): Promise<Record<string, string>> {
  const parsed = new URL(url);

  const query: Record<string, string> = {};
  parsed.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const signer = new SignatureV4({
    service: signing.service,
    region: signing.region,
    credentials: {
      accessKeyId: signing.accessKeyId,
      secretAccessKey: signing.secretAccessKey,
      sessionToken: signing.sessionToken,
    },
    sha256: Sha256,
    applyChecksum: signing.applyChecksum !== false,
    /**
     * S3 IS THE EXCEPTION, and it is the classic SigV4 bug.
     *
     * Every other service double-encodes the path when canonicalising it; S3 does not,
     * because an S3 key may legitimately contain characters that a second pass would
     * mangle. Sign an S3 request the ordinary way and any key with a space or a slash in it
     * returns 403 while simple keys work — which reads as a permissions problem on some
     * objects and not others.
     */
    uriEscapePath: signing.service !== "s3",
  });

  const signed = await signer.sign(
    new HttpRequest({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : undefined,
      path: parsed.pathname,
      query,
      method: method.toUpperCase(),
      // `host` MUST be present and MUST match what is dialled: it is a signed header, and a
      // mismatch between the signature and the Host the server sees is a 403 with a message
      // that does not mention hosts.
      headers: { ...headers, host: parsed.host },
      body,
    }),
  );

  return signed.headers as Record<string, string>;
}

/**
 * A PRESIGNED URL: authority to fetch one object, handed to someone who has no credentials.
 *
 * The signature moves out of the Authorization HEADER and into the QUERY STRING, with an
 * expiry, so the URL alone is enough. That is what makes it shareable — a browser, an email,
 * an LLM's answer — and also why the expiry matters: anyone holding the link has the access
 * until it lapses.
 *
 * NO NETWORK. This computes a string from the credentials and the clock, which is why a
 * manifest reaches it as a call entry that never goes out, the same way `state` does.
 */
export async function presignAwsUrl(
  url: string,
  signing: AwsSigning,
  expiresIn: number,
): Promise<string> {
  const parsed = new URL(url);

  const query: Record<string, string> = {};
  parsed.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const signer = new SignatureV4({
    service: signing.service,
    region: signing.region,
    credentials: {
      accessKeyId: signing.accessKeyId,
      secretAccessKey: signing.secretAccessKey,
      sessionToken: signing.sessionToken,
    },
    sha256: Sha256,
    uriEscapePath: signing.service !== "s3",
  });

  const signed = await signer.presign(
    new HttpRequest({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : undefined,
      path: parsed.pathname,
      query,
      method: "GET",
      // UNSIGNED-PAYLOAD, declared as the sha256 header so the signer hoists it into the
      // query and signs THAT. Without it the signer hashes the (absent) body to the
      // empty-string sha, while S3 verifies a query-auth GET against UNSIGNED-PAYLOAD —
      // a SignatureDoesNotMatch whose error mentions neither body nor payload. This is
      // what @aws-sdk/s3-request-presigner does; proved against live S3 rather than added
      // as a dependency for one header.
      headers: { host: parsed.host, "x-amz-content-sha256": "UNSIGNED-PAYLOAD" },
    }),
    { expiresIn },
  );

  const out = new URL(`${signed.protocol}//${signed.hostname}${signed.path}`);
  for (const [k, v] of Object.entries(signed.query ?? {})) {
    if (typeof v === "string") out.searchParams.set(k, v);
  }
  return out.toString();
}

/**
 * DynamoDB's type-tagged encoding, in and out.
 *
 * DynamoDB does not carry `{ name: "Ada" }`. It carries `{ name: { S: "Ada" } }` — every
 * value tagged with its type, nested arbitrarily. Something has to translate, and it cannot
 * be an expression: the walk is RECURSIVE and the sandbox has no way to define a function
 * that calls itself.
 *
 * `@aws-sdk/util-dynamodb` is AWS's own translator for exactly this, and it is what the
 * DocumentClient uses internally. Same judgement as the signer above: a published,
 * widely-run implementation beats one written here, because the edge cases (binary, sets,
 * empty strings, numeric precision) are where a hand-rolled version quietly differs.
 *
 * Marked ENCODING rather than transport: transport is how a reply is FRAMED (json, sse),
 * this is how the values inside it are SPELLED. A manifest writes plain JSON either way.
 */
export function encodeDynamoJson(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (Array.isArray(value)) return value.map(encodeDynamoJson);
  if (typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    // Only the keys that HOLD ITEM DATA are translated. The rest of a DynamoDB request is
    // ordinary JSON — TableName is a string, Limit is a number — and marshalling those
    // would turn `TableName: "Users"` into `{ S: "Users" }` and 400 every call.
    out[key] = ITEM_KEYS.has(key) && v && typeof v === "object" && !Array.isArray(v)
      ? marshall(v as Record<string, unknown>, { removeUndefinedValues: true })
      : encodeDynamoJson(v);
  }
  return out;
}

/** Request keys whose value is item data, so the only ones that get type tags. */
const ITEM_KEYS = new Set(["Item", "Key", "ExpressionAttributeValues", "ExclusiveStartKey"]);

/** Reply keys that come back type-tagged. `Items` is a list, `Item` a single map. */
const REPLY_KEYS = new Set(["Item", "Items", "Attributes", "LastEvaluatedKey", "Responses"]);

export function decodeDynamoJson(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (!REPLY_KEYS.has(key) || !v || typeof v !== "object") {
      out[key] = v;
      continue;
    }
    out[key] = Array.isArray(v)
      ? v.map((row) => unmarshall(row as Record<string, any>))
      : unmarshall(v as Record<string, any>);
  }
  return out;
}
