/**
 * Building and sending the request. One fetch, one allowedHosts check, both channels.
 *
 * Part of the manifest runtime (DECLARATIVE_NODES.md §2): the manifest DESCRIBES the
 * service, this half COMPUTES it. Split by concern so each piece stays readable.
 */
import type { ComposedNode } from "../../compose.js";
import type { RunContext } from "../context.js";
import { render, evaluate, primeTemplating } from "../templating.js";
import { assertAllowedHost } from "./allowedHosts.js";
import { readSettled, assertOk } from "./response.js";
import { performState, type StateStore } from "../state.js";
import { mintClientCredentials, invalidateToken } from "../auth/oauth.js";
import { signAwsRequest, presignAwsUrl, encodeDynamoJson, decodeDynamoJson, type AwsSigning } from "../auth/aws.js";
import { fetchPaginated } from "../loops/paginate.js";
import { fetchPolled } from "../loops/poll.js";
import { performLoop } from "../loops/loop.js";
import { performDoc } from "../docstore/index.js";
import { sendChunked } from "../loops/chunk.js";

/**
 * Build the HTTP request from a call. Auth schemes are executor capabilities.
 *
 * ONE RESOLUTION RULE, EVERYWHERE IN A CALL. Every string here goes through `resolveValue`:
 * a Handlebars template unless it starts with `return `, in which case it is a sandboxed
 * expression. That rule used to apply to the BODY only, and the gap was arbitrary rather
 * than designed.
 *
 * It cost a real bug. A URL is often assembled from a previous call's reply, and the
 * vendor's shape is not always uniform: HubSpot's v3 associations return the related id as
 * `toObjectId` on some object pairs and `id` on others, which the retired TypeScript
 * handled with `toObjectId ?? id`. Handlebars has no `??`, so the manifest could not say
 * it, and the only way out was picking an API version whose shape happened to be
 * predictable. That is a node contorting itself around a limitation of the executor, which
 * is exactly backwards.
 *
 * The allowedHosts consequence, stated because it is a security control: the LINTER checks hosts
 * statically by blanking `{{ }}` and parsing what remains, and it cannot do that with an
 * expression. Runtime enforcement is unaffected, since `sendRequest` calls
 * `assertAllowedHost` on the RESOLVED url no matter how it was produced, and that is the
 * single chokepoint every call passes through. Lint reports which nodes it could not check
 * statically rather than staying quiet about it.
 */
export async function buildRequest(
  api: any,
  ctx: RunContext,
  forceReauth = false,
): Promise<{ url: string; init: RequestInit; rawBody: unknown }> {
  const req = api.request ?? {};

  // AUTH FIRST, because a minted token can carry WHERE to talk as well as how. Salesforce
  // returns instance_url and the org's data lives there rather than at the login host, so
  // the url has to be resolved against what auth produced, not before it.
  const authHeaders: Record<string, string> = {};
  const authQuery: Array<[string, string]> = [];
  let scoped = ctx;
  // DEFERRED, not resolved. awsSigV4 cannot produce a header here: a signature covers the
  // method, path, query, headers and a hash of the BODY, and none of those are settled
  // until the request is fully assembled. So this carries what signing will need, and
  // `sendRequest` signs once everything is final.
  let sigv4: AwsSigning | undefined;

  const pre = (v: unknown) => resolveValue(v, ctx);

  /**
   * An auth value that resolved to NOTHING is a missing credential, not a value to send.
   *
   * Without this the header went out as the literal string "undefined" and the vendor
   * answered "invalid API key", which is indistinguishable from a key that is simply wrong.
   * Whoever sees that error then goes looking at the vendor's dashboard for a problem that
   * is actually an unset field one screen away.
   */
  const required = async (v: unknown, what: string): Promise<string> => {
    const resolved = await pre(v);
    const out = resolved === undefined || resolved === null ? "" : String(resolved);
    if (!out.trim())
      throw new Error(
        `${auth.scheme} auth needs ${what}, which resolved to nothing. ` +
          `Check the credential is attached to this node and its field is filled in.`,
      );
    return out;
  };
  // `credential` — the OUTBOUND one, how this node proves itself to the vendor. Renamed from
  // `auth` on 2026-07-28: node.yaml's inbound `auth` (who may RUN this node) had the same
  // name one file away, and the two were routinely mistaken for each other.
  const auth = req.credential ?? { scheme: "none" };
  switch (auth.scheme) {
    case "none":
      break;
    case "bearer":
      authHeaders.Authorization = `Bearer ${await required(auth.token, "a token")}`;
      break;
    case "basic":
      authHeaders.Authorization = `Basic ${Buffer.from(
        `${await required(auth.username, "a username")}:${await required(auth.password, "a password")}`,
      ).toString("base64")}`;
      break;
    case "apiKeyHeader":
      authHeaders[auth.header] = await required(auth.value ?? auth.token, `a value for the ${auth.header} header`);
      break;
    case "apiKeyQuery":
      authQuery.push([auth.param, await required(auth.value ?? auth.token, `a value for the ${auth.param} parameter`)]);
      break;
    case "oauth2ClientCredentials": {
      const minted = await mintClientCredentials(
        await required(auth.tokenUrl, "a token url"),
        await required(auth.clientId, "a client id"),
        await required(auth.clientSecret, "a client secret"),
        auth.scope ? String(await pre(auth.scope)) : undefined,
        forceReauth,
      );
      authHeaders.Authorization = `Bearer ${minted.accessToken}`;
      // In scope for everything resolved below, which is how a url reaches instance_url.
      scoped = { ...ctx, token: { instanceUrl: minted.instanceUrl } } as RunContext;
      break;
    }
    case "awsSigV4": {
      // The manifest names the SERVICE and the REGION, because those decide what the
      // signature is scoped to and they are properties of the endpoint being described.
      // The keys come from the credential, never from the manifest.
      const creds = (ctx.credentials?.awsCredential ?? {}) as Record<string, string>;
      sigv4 = {
        region: String(await required(auth.region ?? creds.region, "a region")),
        service: String(auth.service ?? ""),
        accessKeyId: await required(creds.accessKeyId, "an access key id"),
        secretAccessKey: await required(creds.secretAccessKey, "a secret access key"),
        // Only for temporary credentials. Sent AND signed when present, absent otherwise:
        // an empty token header is not the same as no token header, and AWS rejects it.
        sessionToken: creds.sessionToken || undefined,
      };
      if (!sigv4.service)
        throw new Error(
          `awsSigV4 auth needs a service (e.g. dynamodb, s3, bedrock), which the manifest did not name. ` +
            `It is what the signature is scoped to, so it cannot be guessed from the URL.`,
        );
      break;
    }
    default:
      // Reachable only if api.schema.json gained a value this file did not implement.
      throw new Error(`auth scheme "${auth.scheme}" is declared in the schema but not implemented in the executor`);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((await resolveValue(req.headers ?? {}, scoped)) as Record<string, string>),
    ...authHeaders,
  };
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries((await resolveValue(req.query ?? {}, scoped)) as Record<string, unknown>))
    query.set(k, String(v));
  for (const [k, v] of authQuery) query.set(k, v);

  let url = String(await resolveValue(req.url, scoped));

  /**
   * AN UNSET `scope.platformUrl` NAMES ITSELF.
   *
   * A node that calls the platform builds its url from `scope.platformUrl`, which is supplied from
   * UNOVERSE_SERVICE_URL with no fallback (executor.ts). Unset, the expression yields undefined and
   * string concatenation produces "undefined/content/ingest" — a URL that fails at DNS, reporting a
   * host nobody configured rather than a variable nobody set.
   *
   * Same trap as a missing job id in poll.ts, and the same fix: the string form of nothing looks like
   * a value, so it is caught by name here rather than left to the network.
   */
  if (/^undefined\b|^null\b/.test(url.trim()))
    throw new Error(
      `the request url resolved to "${url}". If it is built from scope.platformUrl, set ` +
        `UNOVERSE_SERVICE_URL — it has no default, because a hardcoded localhost fallback fails silently ` +
        `in production.`,
    );
  if ([...query.keys()].length) url += (url.includes("?") ? "&" : "?") + query.toString();

  const method = req.method ?? "GET";
  return { url, init: { method, headers, body: undefined }, rawBody: req.body, scoped, sigv4 } as any;
}

/**
 * Resolve the request body, at ANY depth.
 *
 * Two kinds of value, and the distinction is the same one a developer already knows from
 * config template fields: a string containing `{{ }}` is a Handlebars template, and a
 * string starting with `return ` is a sandboxed expression. Expressions are the only way
 * to express a value whose SHAPE depends on the run: a conditionally-present array
 * member, a key whose name varies by model, or a prompt that differs by which moment the
 * narrator is describing.
 *
 * THIS USED TO CHECK THE TOP LEVEL ONLY, and the failure was silent in the worst way.
 * A nested `return ...` matched neither branch: `render()` ignores any string without
 * `{{`, so the expression's SOURCE TEXT was sent to the vendor as the value. The
 * narrator received its own code as the customer's message on every single run, wrote a
 * generic line from its instructions alone, and nothing anywhere errored. Recursing is
 * what makes "a body value may be an expression" mean what it says.
 */
export async function resolveBody(body: any, ctx: RunContext): Promise<unknown> {
  return resolveValue(body ?? {}, ctx);
}

async function resolveValue(value: any, ctx: RunContext): Promise<unknown> {
  if (typeof value === "string") {
    return value.trimStart().startsWith("return ")
      ? evaluate(value, ctx as unknown as Record<string, unknown>)
      : render(value, ctx);
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => resolveValue(v, ctx)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = await resolveValue(v, ctx);
      // Same rule render() applies: a key that resolved to nothing is OMITTED rather
      // than sent as an empty string, because vendors reject "" where they accept absence.
      if (r !== undefined && r !== "") out[k] = r;
    }
    return out;
  }
  return value;
}

/**
 * `fetch`, bounded by the call's `timeoutMs`.
 *
 * THIS WAS DECLARED AND NOT IMPLEMENTED. `timeoutMs` has been in api.schema.json and in seven
 * manifests since the first of them was written, and the runtime never read it — so every call had
 * no client-side limit at all. It surfaced as an OpenAI node sitting for 154 SECONDS against a
 * declared `timeoutMs: 120000` before the vendor's edge gave up and returned a Cloudflare 520. The
 * node looked hung, the number in the manifest was fiction, and nothing anywhere said so.
 *
 * TIME TO RESPONSE, not time to completion, which is why this clears the timer the moment `fetch`
 * resolves rather than passing a bare `AbortSignal.timeout`. An abort signal stays live while the
 * body is read, so the simple version would cut a long SSE stream off at the timeout — killing a
 * working voice or agent turn on a limit that was only ever meant to catch a host that never
 * answers. Headers arriving is the signal that the host is alive; after that the transport decides
 * how long the body may take.
 *
 * A timeout is an ERROR, not an empty result: it fails with a message naming the limit and the call,
 * so the manifest's own number appears in the log that reports it.
 */
async function fetchWithTimeout(url: string, init: any, timeoutMs: unknown, label: string): Promise<Response> {
  const ms = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 0;
  if (!ms) return fetch(url, init);

  // Composed rather than replaced: a caller's own signal (a cancelled run) must still abort.
  const controller = new AbortController();
  const outer: AbortSignal | undefined = init.signal;
  const onAbort = () => controller.abort();
  outer?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: any) {
    if (controller.signal.aborted && !outer?.aborted)
      throw new Error(`${label}: no response after ${ms}ms (timeoutMs)`);
    throw err;
  } finally {
    // Cleared as soon as the headers are in, so the body may stream for as long as it needs.
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
}

/**
 * A MULTIPART BODY, from the same plain object every other encoding starts from.
 *
 * Needed because some endpoints only accept a file upload: ElevenLabs speech-to-text takes the audio
 * as a form part, and no amount of JSON expresses that. Without it a node that uploads anything cannot
 * be a manifest at all.
 *
 * TWO KINDS OF FIELD, and the manifest says which by SHAPE rather than by a flag:
 *
 *   a scalar                  a text field. Numbers and booleans are stringified, because a form
 *                             carries text and the alternative is `[object Object]` reaching a vendor
 *   { base64, mimeType?,      a FILE part. base64 is how bytes travel between calls — `transport:
 *     filename? }             binary` produced it, and an event bus cannot carry a Buffer — so this is
 *                             where it turns back into bytes, at the last moment before sending
 *
 * A file part needs a FILENAME even when the content is what matters: many servers ignore a part with
 * none, and the failure is a 400 about a missing field rather than about the name. `file` is the
 * fallback, which is what the retired ElevenLabs client used.
 */
function toFormData(body: unknown): FormData {
  const form = new FormData();
  if (!body || typeof body !== "object") return form;

  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;

    const part = value as Record<string, unknown>;
    if (typeof value === "object" && typeof part.base64 === "string") {
      const bytes = Buffer.from(part.base64, "base64");
      form.set(key, new Blob([bytes], { type: String(part.mimeType ?? "application/octet-stream") }), String(part.filename ?? "file"));
      continue;
    }

    // An object that is NOT a file part is JSON in a text field, which is how vendors take nested
    // options on a form. Stringifying it as [object Object] would be silently wrong.
    form.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return form;
}

export async function sendRequest(node: ComposedNode, requestSpec: any, ctx: RunContext, label: string, forceReauth = false): Promise<Response> {
  await primeTemplating();
  const built: any = await buildRequest({ request: requestSpec }, ctx, forceReauth);
  const { url, init, rawBody } = built;
  if (init.method !== "GET") {
    const resolved = await resolveBody(rawBody, built.scoped ?? ctx);
    /**
     * RAW BYTES, not JSON. Storing a file means PUTting the file, not a JSON document that
     * describes it, and JSON.stringify would upload the quoted base64 text instead.
     *
     * The manifest hands over base64 because that is the only form bytes take while they
     * travel between calls — `transport: binary` produced it, and an event bus cannot carry
     * a Buffer. This is where it turns back into bytes, at the last moment before sending.
     */
    if (requestSpec?.encoding === "binary") {
      const b64 = typeof resolved === "string" ? resolved : String((resolved as any)?.base64 ?? "");
      init.body = Buffer.from(b64, "base64");
      // Content-Length must be the BYTE count, and the default JSON header would be a lie
      // about what is in the body. Only set when the manifest did not say.
      const headers = init.headers as Record<string, string>;
      if (headers["Content-Type"] === "application/json") delete headers["Content-Type"];
    } else if (requestSpec?.encoding === "multipart") {
      init.body = toFormData(resolved);
      /**
       * THE BOUNDARY IS NOT OURS TO WRITE. `fetch` generates it and sets Content-Type itself, so a
       * declared `multipart/form-data` header would arrive WITHOUT the boundary parameter and the
       * vendor would reject a body it could not split. Deleting the header is the fix, and it is the
       * same reasoning as `binary` above: the default JSON header is a lie about what is being sent.
       */
      delete (init.headers as Record<string, string>)["Content-Type"];
    } else if (requestSpec?.encoding === "ndjson") {
      /**
       * NEWLINE-DELIMITED JSON: one complete JSON document per line, no enclosing array and
       * no commas between them. Pinecone's integrated-inference upsert is the reason — it
       * takes a batch of records this way so a server can stream them without holding the
       * whole batch in memory.
       *
       * THE ARRAY IS NOT THE BODY. `JSON.stringify` of the same records would produce
       * `[{...},{...}]`, which is valid JSON and a 400 here: the vendor parses line by line
       * and the very first line would be an unterminated document. That is why this is an
       * encoding rather than something a manifest could express by hand — an expression
       * returning a pre-joined string would be a string, and every other encoding starts
       * from the same plain resolved value.
       */
      const rows = Array.isArray(resolved) ? resolved : [resolved];
      init.body = rows.map((row) => JSON.stringify(row)).join("\n");
      // Not application/json: a server dispatching on content type would hand this to a
      // strict JSON parser, which fails on the second line.
      (init.headers as Record<string, string>)["Content-Type"] = "application/x-ndjson";
    } else {
      // BEFORE signing, because the signature covers the bytes actually sent. Encoding after
      // would sign one body and send another, which AWS rejects with a signature mismatch.
      init.body = JSON.stringify(requestSpec?.encoding === "dynamodbJson" ? encodeDynamoJson(resolved) : resolved);
    }
  }
  // AFTER templating, because the host may itself be templated (a per-tenant
  // subdomain), so only the resolved URL can be judged.
  // The LAST argument is what makes the `"*"` host rule safe: a call with no `credential`
  // block sends nothing secret, so there is nothing for a wildcard host to leak. One that
  // does is held to the declared list no matter what the package also allows.
  assertAllowedHost(url, node.allowedHosts, node.type, !!requestSpec?.credential && requestSpec.credential.scheme !== "none");

  // LAST, once the url, headers and body are final. A SigV4 signature covers all three, so
  // it is the one auth scheme that cannot be resolved up front with the others. Signing
  // before the body existed would have produced a valid signature over an empty request and
  // a 403 on every call that sent one.
  if (built.sigv4) init.headers = await signAwsRequest(url, init.method, init.headers, init.body, built.sigv4);

  const retry = requestSpec?.retry;
  const attempts = Math.max(1, retry?.attempts ?? 1);
  const retryOn: number[] = retry?.on ?? [];


  let res!: Response;
  for (let attempt = 1; ; attempt++) {
    res = await fetchWithTimeout(url, init, requestSpec?.timeoutMs, label);
    if (res.ok) return res;

    // Statuses the manifest declares as an ANSWER rather than a failure (`okOn: [404]`),
    // so a projection can interpret them — an existence check, a lookup by an id the
    // model may have mistyped. Without this, the projection's graceful miss-handling is
    // unreachable: the transport throws first and the caller sees an empty result.
    if (Array.isArray(requestSpec?.okOn) && requestSpec.okOn.includes(res.status)) return res;

    // A minted token can be revoked or expire early, and the vendor says so with a 401.
    // Refresh ONCE and retry, exactly as the retired client did. Guarded by !forceReauth so
    // a genuinely rejected credential fails rather than looping.
    if (res.status === 401 && requestSpec?.credential?.scheme === "oauth2ClientCredentials" && !forceReauth) {
      invalidateToken(String(render(requestSpec.credential.tokenUrl, ctx)), String(render(requestSpec.credential.clientId, ctx)));
      console.warn(`[manifests] ${label}: 401, refreshing the access token and retrying once`);
      return sendRequest(node, requestSpec, ctx, label, true);
    }

    // Only the statuses the manifest named, and never the last attempt. A retry on a
    // 400 just sends the same bad request again.
    if (attempt >= attempts || !retryOn.includes(res.status)) break;

    const wait =
      retry.backoff === "exponential" ? 250 * 2 ** (attempt - 1) : retry.backoff === "fixed" ? 250 : 0;
    console.warn(`[manifests] ${label}: ${res.status}, retrying in ${wait}ms (${attempt}/${attempts - 1})`);
    if (wait) await new Promise((r) => setTimeout(r, wait));
  }

  const detail = await res.text().catch(() => "");
  throw new Error(`${label}: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 400)}` : ""}`);
}

/**
 * SETTLING calls, made in order, each seeing what the earlier ones returned.
 *
 * A node declares its calls as a list, and this runs the part of that list whose replies
 * are only ever read by something later: every call but the last when the graph runs the
 * node, and every call of a service method. The last call of a graph run is framed
 * separately, in runFinal, because it alone may stream.
 *
 * Why more than one call is an executor capability and not something a manifest could
 * fake: one fact often takes more than one request to establish, and the second request's
 * URL is built from the first's reply. Resolving a CRM contact is a search by email, then
 * a follow of the company association only when the contact's own company field came back
 * blank. No body template expresses "and then", so without this the node stays code.
 *
 * FLAT, not nested. The list reads top to bottom, exactly like the events table and for
 * the same reason: no merge order to reason about, and no way to declare one call twice.
 * Each entry is an ordinary call spec, so `sendRequest` is untouched and every capability
 * one call has (auth, retry, error, allowedHosts) they all have for free.
 *
 * Two rules the shape depends on:
 *   - A call's `name` is how later calls and `returns` reach its reply, via `calls.<name>`.
 *   - A call SKIPPED by `when` leaves no key behind, so "did it happen?" is `!!calls.x`
 *     rather than a sentinel nobody would remember to check.
 */
export async function runCalls(
  node: ComposedNode,
  calls: any[],
  ctx: RunContext,
  label: string,
  store?: StateStore,
): Promise<{ results: Record<string, any>; last: any }> {
  const results: Record<string, any> = {};
  let last: any = undefined;

  for (const call of calls) {
    // Rebuilt each time so a call sees every earlier reply, and never its own.
    const scoped: RunContext = { ...ctx, calls: results };

    if (call.when && !(await evaluate(call.when, scoped as unknown as Record<string, unknown>))) continue;

    // A PLATFORM STATE operation rather than a request. Same list, same `name`, same
    // `when`: reading a cache, calling a vendor only when it was cold, then writing the
    // answer back is one sequence, and splitting it across two sections would put the
    // order in the reader's head instead of on the page.
    if (call.state) {
      const value = call.value ? ((await evaluate(call.value, scoped as unknown as Record<string, unknown>)) as any) : undefined;
      // `key` is optional now that `save` exists: its key is the run's, so a manifest naming one
      // would be guessing at the engine's layout. `render(undefined)` gives back undefined, and
      // String() of that is the text "undefined" — harmless only because `save` ignores the key
      // entirely, which is why performState takes the scope separately rather than a built key.
      const payload = await performState(
        call.state,
        String(render(call.key, scoped)),
        value,
        call.max,
        store,
        ctx.scope,
      );
      results[call.name] = payload;
      last = payload;
      continue;
    }

    /**
     * A DOCSTORE operation — the sectioned, hash-checked markdown document in Redis
     * (docstore/index.ts). In this list for the same reason `state` and `loop` are: it is a
     * platform capability the manifest NAMES, not a request, and it belongs to the sequence.
     *
     * `params` defaults to the CALLER'S params, because nine of the ten ops exist as service
     * methods whose arguments arrive exactly there; an explicit `params` expression overrides
     * for the odd case. The doc's KEY is derived from the run's own ids inside performDoc —
     * never from the manifest, which could otherwise read another conversation's document.
     */
    if (call.docstore) {
      const args = call.params
        ? ((await evaluate(call.params, scoped as unknown as Record<string, unknown>)) as Record<string, any>)
        : ctx.params;
      const payload = await performDoc(String(call.docstore), args ?? {}, store?.raw, ctx.scope, ctx.config);
      results[call.name] = payload;
      last = payload;
      continue;
    }

    // ITERATION BOOKKEEPING, and it belongs in this list for the same reason `state` does: a
    // LoopStart both READS the advanced index and OPENS a new loop, one or the other depending on
    // whether it was re-fired, and those are two entries whose `when` tells them apart.
    if (call.loop) {
      const value = call.value ? await evaluate(call.value, scoped as unknown as Record<string, unknown>) : undefined;
      const payload = await performLoop(call.loop, ctx.scope?.executionId, String(render(call.key, scoped)), value, store?.loop);
      results[call.name] = payload;
      last = payload;
      continue;
    }

    /**
     * A PRESIGN entry makes no request at all. Like `state`, it earns its place in the same
     * ordered list because it belongs to the sequence: list a bucket, then mint a link for
     * each thing found. Splitting it elsewhere would put the order in the reader's head.
     *
     * ALWAYS A LIST, even for one URL. A bucket listing needs a link per object and a single
     * file needs one, and having those be two different shapes would mean the events table
     * cared how many there were.
     */
    if (call.presign) {
      const p = call.presign;
      const items = (await evaluate(p.for, scoped as unknown as Record<string, unknown>)) as unknown[];
      const creds = (ctx.credentials?.awsCredential ?? {}) as Record<string, string>;
      const signing: AwsSigning = {
        region: String(p.region ?? creds.region ?? ""),
        service: String(p.service ?? "s3"),
        accessKeyId: String(creds.accessKeyId ?? ""),
        secretAccessKey: String(creds.secretAccessKey ?? ""),
        sessionToken: creds.sessionToken || undefined,
      };
      const expiresIn = Number(await evaluate(String(p.expiresIn ?? "return 3600"), scoped as unknown as Record<string, unknown>)) || 3600;

      const urls: string[] = [];
      for (const item of Array.isArray(items) ? items : []) {
        // `item` is in scope, so the manifest says how ONE url is built and this repeats it.
        const target = String(await evaluate(p.url, { ...scoped, item } as unknown as Record<string, unknown>));
        // ALWAYS credential-carrying: a presigned url IS authority, so it can never ride
        // on the unauthenticated wildcard.
        assertAllowedHost(target, node.allowedHosts, node.type, true);
        urls.push(await presignAwsUrl(target, signing, expiresIn));
      }

      results[call.name] = urls;
      last = urls;
      continue;
    }

    // A CHUNKED call is many requests over one collection: { sent, batches, results, errors }.
    if (call.chunk) {
      const written = await sendChunked(node, call, scoped, `${label}.${call.name}`);
      results[call.name] = written;
      last = written;
      continue;
    }

    // A PAGINATED call is many requests and one reply: { items, pages, truncated }.
    if (call.paginate) {
      const walked = await fetchPaginated(node, call, scoped, `${label}.${call.name}`);
      results[call.name] = walked;
      last = walked;
      continue;
    }

    // A POLLED call is a JOB: start it, then ask until it is done. The reply is the final
    // status payload, never the start receipt.
    if (call.poll) {
      const finished = await fetchPolled(node, call, scoped, `${label}.${call.name}`);
      results[call.name] = finished;
      last = finished;
      continue;
    }

    // SETTLING transports. `xml` settles exactly like json — one body, parsed once — so it
    // belongs here; only a STREAM is barred from a non-final position.
    if (call.transport !== "json" && call.transport !== "text" && call.transport !== "xml" && call.transport !== "headers" && call.transport !== "binary") {
      throw new Error(
        `${label}.${call.name}: this call must settle (transport json or text), not "${call.transport}". ` +
          `Only a node's LAST call may stream, because its reply is the answer; an earlier one exists ` +
          `so a later call can read it, and there is nothing to read from a stream nobody framed.`,
      );
    }

    const res = await sendRequest(node, call, scoped, `${label}.${call.name}`);
    const payload = await readSettled(res, call.transport, call.encoding);
    await assertOk(node, call, payload, `${label}.${call.name}`);

    results[call.name] = payload;
    last = payload;
  }

  return { results, last };
}
