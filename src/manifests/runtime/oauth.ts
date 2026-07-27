/**
 * OAUTH2 CLIENT CREDENTIALS. An auth scheme, so it is written once here rather than in
 * every node that needs it (DECLARATIVE_NODES.md §2).
 *
 * Unlike a bearer key, this is not a value the manifest can template: the credential is a
 * client id and secret that must be EXCHANGED for a short-lived token, over a form-encoded
 * POST, and the result cached until it expires. That is computation over the request, and
 * a manifest that tried to express it would need a request before its request.
 *
 * The token response is put back into scope as `token`, because some vendors return where
 * to talk as well as how. Salesforce returns `instance_url` and the org's API lives there,
 * not at the login host you authenticated against.
 */

interface Minted {
  accessToken: string;
  instanceUrl?: string;
  expiresAt: number;
}

/**
 * Cached per connected-app identity, not per node or per run.
 *
 * A workflow that makes six calls must not mint six tokens, and a vendor will rate-limit or
 * refuse if it does. Keyed by client id AND token url so two orgs never share an entry.
 */
const CACHE = new Map<string, Minted>();

/** Default life. Salesforce client-credentials sessions are ~2h; refresh well before. */
const DEFAULT_TTL_MS = 110 * 60 * 1000;

/** Drop a cached token, so the next call mints a fresh one. */
export function invalidateToken(tokenUrl: string, clientId: string): void {
  CACHE.delete(`${clientId}@${tokenUrl}`);
}

export async function mintClientCredentials(
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  scope: string | undefined,
  force = false,
): Promise<Minted> {
  const key = `${clientId}@${tokenUrl}`;
  const hit = CACHE.get(key);
  if (!force && hit && hit.expiresAt > Date.now()) return hit;

  // FORM ENCODED, not JSON. The OAuth2 spec says so and vendors enforce it, which is why
  // this cannot ride the ordinary body path: that one always sends JSON.
  const form = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
  if (scope) form.set("scope", scope);

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
  });

  const data: any = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    // The description, not just the status: "invalid_client" tells you which of the two
    // secrets is wrong, and a bare 400 does not.
    const detail = data?.error_description ?? data?.error ?? res.statusText;
    throw new Error(`oauth2ClientCredentials: token request to ${tokenUrl} failed (${res.status}): ${detail}`);
  }

  const minted: Minted = {
    accessToken: data.access_token,
    instanceUrl: typeof data.instance_url === "string" ? data.instance_url.replace(/\/+$/, "") : undefined,
    // Honour the vendor's own expiry when it sends one, minus a minute of slack so a token
    // cannot expire in flight.
    expiresAt: Date.now() + (Number(data.expires_in) ? Number(data.expires_in) * 1000 - 60_000 : DEFAULT_TTL_MS),
  };
  CACHE.set(key, minted);
  return minted;
}
