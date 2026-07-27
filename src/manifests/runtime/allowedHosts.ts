/**
 * THE ALLOWED_HOSTS BOUNDARY. Its own file because it is the security control.
 *
 * Part of the manifest runtime (DECLARATIVE_NODES.md §2): the manifest DESCRIBES the
 * service, this half COMPUTES it. Split by concern so each piece stays readable.
 */
/**
 * THE ALLOWED_HOSTS BOUNDARY.
 *
 * A manifest cannot execute code, but it can say "send this credential to
 * evil.example", and that is exfiltration with no code at all. SECURITY.md bounds a
 * code node by PROVENANCE (the first-party npm scope) and a template expression by
 * having no credentials in scope. A manifest node is neither: it arrives as data yet
 * holds a credential and a URL. This is its boundary.
 *
 * Deny by default. A package that declares no `allowedHosts` reaches nothing.
 */
export function assertAllowedHost(
  url: string,
  allowedHosts: string[],
  nodeType: string,
  /**
   * Does THIS call send a credential? Only a call that does is bounded by the host list in
   * the strict sense; see the `"*"` rule below.
   */
  carriesCredential = true,
): void {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1")
      throw new Error(`${nodeType}: refusing a non-https request to ${parsed.protocol}//${parsed.host} — a credential must not travel in clear text`);
    host = parsed.host.toLowerCase();
  } catch (err: any) {
    if (err?.message?.startsWith(nodeType)) throw err;
    throw new Error(`${nodeType}: request url is not a valid URL: ${url}`);
  }

  const allowed = allowedHosts.some((pattern) => {
    /**
     * `"*"` — ANY HOST, and ONLY for a call that sends no credential.
     *
     * Some nodes legitimately fetch a url a person supplies: an image for a model to look
     * at, a document to read. That url cannot be declared in advance, because the whole
     * point is that it is not known until someone types it.
     *
     * Allowing it is safe HERE and nowhere else, because of what this boundary is actually
     * for. SECURITY.md's concern is exfiltration: a manifest saying "POST this credential to
     * evil.example". A call with no `auth` block has no credential to leak — it is an
     * ordinary unauthenticated GET, the same thing any browser does.
     *
     * Two things still bound it. Non-https is already refused above, which puts the cloud
     * metadata endpoint and plaintext internal services out of reach. And the moment a call
     * carries a credential, `"*"` stops matching and the real host list applies — so a
     * tampered manifest cannot move the credential onto the wildcard call.
     */
    if (pattern === "*") return !carriesCredential;
    /**
     * `**.a.com` — ANY DEPTH. Written with two stars because it is a deliberately weaker
     * claim than one, and the author should have to say so.
     *
     * AWS forced this. Its endpoints are inherently multi-level: `dynamodb.us-east-1.
     * amazonaws.com` is two labels deep and an S3 bucket is three
     * (`bucket.s3.region.amazonaws.com`), because both the region AND the bucket are part
     * of the name. A single-level wildcard cannot express that, and the alternatives were
     * worse: listing every region defeats itself the day AWS adds one, and a bucket name is
     * config, so it cannot be listed at all.
     *
     * Still bounded, and that is the point: `**.amazonaws.com` reaches any AWS host and
     * NOTHING else, so a tampered manifest still cannot post a credential to evil.example.
     */
    if (pattern.startsWith("**.")) {
      const suffix = pattern.slice(2); // ".amazonaws.com"
      // A non-empty label must precede it, so `**.a.com` does not match a bare `a.com`.
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".example.com"
      // One level only: *.a.com matches x.a.com, not x.y.a.com.
      return host.endsWith(suffix) && !host.slice(0, -suffix.length).includes(".");
    }
    return host === pattern;
  });

  if (!allowed)
    throw new Error(
      `${nodeType}: refusing a request to "${host}". This package allows ${allowedHosts.length ? allowedHosts.map((h) => `"${h}"`).join(", ") : "NOTHING"}. ` +
        `A manifest may only call hosts its package declared in package.yaml, so a pasted node cannot ship your credentials somewhere you never approved.` +
        (allowedHosts.includes("*") && carriesCredential
          ? ` This package does declare "*", but that covers unauthenticated calls only, and THIS call sends a credential.`
          : ""),
    );
}
