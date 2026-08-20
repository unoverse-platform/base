/**
 * JWT authentication for the Unoverse MCP server.
 *
 * Mirrors apps/mcp-server/src/server/auth/auth.ts — same OIDC/JWT flow as the rest
 * of the platform (docs/AUTH_TOKEN_FLOW.md): validate the access token against the
 * shared AUTH_ISSUER/AUTH_AUDIENCE via JWKS. The only difference is transport: this
 * server speaks MCP over uWS + Web `Request`/`Response`, so the gate is a pure
 * function over the Authorization header rather than node req/res.
 *
 * Secure-MCP per the MCP best-practices/authorization specs: default-deny, 401 +
 * `WWW-Authenticate` pointing at RFC 9728 protected-resource-metadata.
 */

import { jwtVerify, createRemoteJWKSet, JWTPayload } from "jose";
import { isAuthEnabled, devIdentity } from "./authConfig.js";

// Read env lazily (not at module load) so it's correct regardless of when .env loads.
//
// THE ISSUER SPELLING IS PROVIDER-SPECIFIC AND jose COMPARES `iss` EXACTLY.
//
// Auth0 mints `iss` WITH a trailing slash; Cognito mints it WITHOUT one (verified against
// the pool's own discovery document: issuer =
// https://cognito-idp.<region>.amazonaws.com/<poolId>, no slash). This used to append a
// slash unconditionally, which matches Auth0 and can therefore NEVER match Cognito: every
// authenticated request on an AWS universe failed with `unexpected "iss" claim value` while
// sign-in, the pool, the client and the token were all correct (BPP, 2026-08-17).
//
// So accept BOTH spellings of the one configured issuer rather than one provider's
// convention. This is the same shape as the `aud`/`client_id` comparison below: it looks in
// two places, it does not accept fewer. A token from any other issuer is rejected exactly as
// before, because both candidates are built from AUTH_ISSUER itself.
const getIssuerBase = (): string => {
  const raw = process.env.AUTH_ISSUER;
  if (!raw || raw === "undefined") return "";
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
};
/** Both spellings of the configured issuer, for jose's exact `iss` comparison. */
const getIssuerCandidates = (): string[] => {
  const base = getIssuerBase();
  return base ? [base, `${base}/`] : [];
};
const getAudience = (): string | undefined => process.env.AUTH_AUDIENCE;

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJWKS() {
  const base = getIssuerBase();
  if (!jwks && base) {
    jwks = createRemoteJWKSet(new URL(`${base}/.well-known/jwks.json`));
  }
  return jwks;
}

export interface AuthUser {
  id: string;
  email?: string;
  roles: string[];
  permissions: string[];
  raw: JWTPayload;
}

/** Parse array claims, handling Auth0-style namespaced claims (e.g. https://…/roles). */
function parseArrayClaim(payload: JWTPayload, claimName: string): string[] {
  const direct = payload[claimName];
  if (Array.isArray(direct)) return direct as string[];
  const namespaced = Object.keys(payload).find(
    (k) => k.endsWith(`/${claimName}`) || k.endsWith(`/claims/${claimName}`),
  );
  if (namespaced && Array.isArray(payload[namespaced])) return payload[namespaced] as string[];
  return [];
}

/** Parse a string claim, handling Auth0-style namespaced claims (e.g. https://…/email).
 *  Auth0 emits custom claims (email on the access token) ONLY namespaced, so a plain
 *  `payload.email` read returns undefined and silently no-ops every email-keyed feature
 *  (CRM resolve). Same namespace-aware read as parseArrayClaim. See docs/AUTH_TOKEN_FLOW.md. */
function parseStringClaim(payload: JWTPayload, claimName: string): string | undefined {
  const direct = payload[claimName];
  if (typeof direct === "string") return direct;
  const namespaced = Object.keys(payload).find(
    (k) => k.endsWith(`/${claimName}`) || k.endsWith(`/claims/${claimName}`),
  );
  if (namespaced && typeof payload[namespaced] === "string") return payload[namespaced] as string;
  return undefined;
}

/** Validate a bearer token and extract the user, or null if invalid/unconfigured. */
export async function validateJWT(token: string): Promise<AuthUser | null> {
  const jwksSet = getJWKS();
  const issuers = getIssuerCandidates();
  if (!jwksSet || issuers.length === 0) {
    console.warn("[auth] OIDC not configured (AUTH_ISSUER missing)");
    return null;
  }
  try {
    // AUDIENCE IS CHECKED HERE, NOT BY jose, BECAUSE PROVIDERS NAME IT DIFFERENTLY.
    //
    // Auth0 access tokens carry the API identifier in `aud`. Cognito access tokens have NO
    // `aud` at all — the same value lives in `client_id`, and `aud` appears only on its ID
    // tokens. Verified 2026-08-03 against a real token: {iss, client_id, token_use:"access",
    // ...} with no aud. So `jwtVerify(..., { audience })` can never pass on AWS, and every
    // authenticated request there failed with `missing required "aud" claim` on a
    // deployment that was otherwise entirely correct.
    //
    // Signature, issuer and expiry are still jose's and unchanged. Only the comparison moves
    // out, so it can read whichever claim the provider used. A token matching neither is
    // rejected exactly as before — this looks in two places, it does not accept fewer.
    const { payload } = await jwtVerify(token, jwksSet, { issuer: issuers });
    const expected = getAudience();
    if (expected) {
      const claimed = payload.aud ?? (payload as Record<string, unknown>).client_id;
      const values = Array.isArray(claimed) ? claimed.map(String) : claimed ? [String(claimed)] : [];
      if (!values.includes(expected)) {
        console.error(
          `[auth] JWT validation failed: audience mismatch (expected ${expected}, token had ${values.join(", ") || "none"})`,
        );
        return null;
      }
    }
    return {
      id: payload.sub || "unknown",
      email: parseStringClaim(payload, "email"),
      roles: parseArrayClaim(payload, "roles"),
      permissions: parseArrayClaim(payload, "permissions"),
      raw: payload,
    };
  } catch (error) {
    console.error("[auth] JWT validation failed:", error);
    return null;
  }
}

export type AuthResult = { ok: true; userId: string } | { ok: false };

/**
 * Default-deny gate over the Authorization header.
 *  - auth DISABLED (dev) → pass as the fixed dev identity (never undefined).
 *  - auth ENABLED → require a valid bearer for AUTH_ISSUER/AUTH_AUDIENCE.
 */
export async function authorize(authHeader: string | null | undefined): Promise<AuthResult> {
  if (!isAuthEnabled()) return { ok: true, userId: devIdentity().id };
  if (!authHeader) return { ok: false };
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  if (!token) return { ok: false };
  const user = await validateJWT(token);
  return user ? { ok: true, userId: user.id } : { ok: false };
}

/**
 * The permission a token must carry to reach the HOSTED workflow builder. Gated on
 * this exact string (Auth0 API permission on the gravity-api audience), NOT on a
 * role name — end-user chat tokens are valid on the same audience, so "authenticated"
 * is not enough; only "authenticated AND may author workflows" passes. This is the
 * platform's first authZ check (docs/AUTH_REMEDIATION.md Phase 1b).
 */
export const BUILDER_PERMISSION = "workflow:author";

export type BuilderAuthResult = { ok: true; user: AuthUser } | { ok: false; reason: "unauthenticated" | "forbidden" };

/**
 * Gate for the hosted builder route (public :4105/mcp-builder). Stricter than
 * `authorize` in two ways:
 *  - FAIL-CLOSED when auth is disabled: this route must never be open, so an
 *    AUTH_ENABLED=false deployment simply cannot serve it (returns forbidden).
 *    Local dev uses the ungated LOOPBACK route (:4106) instead — never this one.
 *  - Requires the BUILDER_PERMISSION claim, not just a valid bearer.
 * Returns the full user so a later step can bind the session to a workflow grant.
 */
export async function authorizeBuilder(authHeader: string | null | undefined): Promise<BuilderAuthResult> {
  // No fail-open: unlike `authorize`, disabled auth does NOT admit a dev identity here.
  if (!isAuthEnabled()) return { ok: false, reason: "forbidden" };
  if (!authHeader) return { ok: false, reason: "unauthenticated" };
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  if (!token) return { ok: false, reason: "unauthenticated" };
  const user = await validateJWT(token);
  if (!user) return { ok: false, reason: "unauthenticated" };
  if (!user.permissions.includes(BUILDER_PERMISSION)) return { ok: false, reason: "forbidden" };
  return { ok: true, user };
}

/**
 * Public base URL for advertised OAuth metadata. Prefer the configured canonical URL
 * (UNOVERSE_PUBLIC_URL) over the request `Host` header — the header is client-controlled,
 * so reflecting it into discovery metadata is a (minor) spoofing vector.
 */
function resourceBase(host: string): string {
  const configured = process.env.UNOVERSE_PUBLIC_URL?.replace(/\/$/, "");
  if (configured) return configured;
  const protocol = host.includes("localhost") || host.startsWith("127.") ? "http" : "https";
  return `${protocol}://${host}`;
}

/** The 401 challenge — points clients at the RFC 9728 protected-resource-metadata. */
export function unauthorizedResponse(host: string): Response {
  const resourceMetadataUrl = `${resourceBase(host)}/.well-known/oauth-protected-resource`;
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
      },
    },
  );
}

/** OAuth Authorization Server Metadata (for MCP Inspector / discovery). */
export function getOAuthAuthorizationServerMetadata(): object {
  const issuer = process.env.AUTH_ISSUER;
  const audience = process.env.AUTH_AUDIENCE;
  return {
    issuer,
    authorization_endpoint: audience
      ? `${issuer}/authorize?audience=${encodeURIComponent(audience)}`
      : `${issuer}/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oidc/register`,
    scopes_supported: ["openid", "profile", "email", "offline_access"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
  };
}

/**
 * What a REMOTE client needs to log in to this universe, served publicly.
 *
 * Canvas gets this from `window.__GRAVITY_CONFIG__`, injected into its own page
 * (`apps/canvas/src/App.jsx:14`). A developer's local Studio is a different origin on a
 * different machine, so it cannot read that. It has to ask the universe.
 *
 * This is the whole reason the tooling stays provider-agnostic: Studio hardcodes no
 * issuer and no provider. It asks a universe who authenticates it and follows the answer,
 * so Auth0, Okta, Entra or Keycloak all work with no change here or in Studio.
 *
 * NOTHING SECRET. `clientId` is a public OAuth client identifier by definition, it is
 * already shipped inside Canvas's JavaScript, and it authorises nothing on its own.
 * There is deliberately no client secret: a desktop tool cannot keep one.
 *
 * `authEnabled: false` is a real answer, not a failure. A universe with auth off tells a
 * client not to bother logging in, rather than sending it to an issuer that is not there.
 */
export function getPublicAuthConfig(): object {
  const issuer = process.env.AUTH_ISSUER;
  const clientId = process.env.AUTH_CLIENT_ID;
  return {
    authEnabled: isAuthEnabled(),
    issuer: issuer ?? null,
    clientId: clientId ?? null,
    audience: process.env.AUTH_AUDIENCE ?? null,
    // The permission a developer's token needs before this universe will accept a
    // publish. Named here so Studio can say "you are logged in but not allowed to
    // publish" instead of failing at the first push.
    publishPermission: "marketplace:publish",
  };
}

/** OAuth 2.0 Protected Resource Metadata (RFC 9728); canonical URL preferred over Host. */
export function getOAuthProtectedResourceMetadata(host: string): object {
  return {
    resource: resourceBase(host),
    authorization_servers: [process.env.AUTH_ISSUER],
    scopes_supported: ["openid", "profile", "email"],
    bearer_methods_supported: ["header"],
  };
}
