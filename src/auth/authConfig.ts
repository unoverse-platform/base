/**
 * Canonical auth flag + startup contract.
 *
 * MIRRORED across services (apps/server, apps/mcp-server, apps/memory-server, and
 * now apps/unoverse) — keep the copies in sync. Single source of truth:
 * docs/AUTH_REMEDIATION.md (Phase 0).
 *
 * Rules:
 *  - Default: auth ENABLED. Only an explicit AUTH_ENABLED=false (or the deprecated
 *    DISABLE_AUTH=true) turns it off. Missing/typo'd flags read as ENABLED.
 *  - "Not configured" is NOT "disabled": if auth is enabled but OIDC is missing,
 *    the service refuses to boot (assertAuthStartup) rather than silently allow.
 *  - Disabled: a fixed dev identity is injected so downstream code always has auth.
 *  - Disabled + NODE_ENV=production: refuse to boot.
 */

export interface DevIdentity {
  id: string;
  email: string;
  roles: string[];
  permissions: string[];
}

const isTrue = (v: string | undefined): boolean => v?.toLowerCase() === "true";

/** Single source of truth: is JWT enforcement on? Default ON; only explicit opt-out disables. */
export function isAuthEnabled(): boolean {
  if (isTrue(process.env.DISABLE_AUTH)) return false; // deprecated alias, still honored
  return (process.env.AUTH_ENABLED ?? "true").toLowerCase() !== "false";
}

/** Is an OIDC provider configured (issuer + audience present)? */
export function isOidcConfigured(): boolean {
  const issuer = process.env.AUTH_ISSUER;
  return !!issuer && issuer !== "undefined" && !!process.env.AUTH_AUDIENCE;
}

/** Fixed identity injected on every request when auth is DISABLED (dev only).
 *  Deliberately carries NO roles and NO permissions: any gate accidentally built on
 *  `authorize()` instead of a fail-closed wrapper then denies rather than escalates. */
export function devIdentity(): DevIdentity {
  return { id: "dev-user", email: "dev@local", roles: [], permissions: [] };
}

/**
 * Validate auth configuration at boot. Fails closed:
 *  - enabled + OIDC missing → throw (refuse to start)
 *  - disabled + production  → throw (refuse to start)
 * Returns the resolved mode and logs the true state.
 */
export function assertAuthStartup(log: (msg: string) => void = console.warn): "enabled" | "disabled" {
  const enabled = isAuthEnabled();
  const isProd = process.env.NODE_ENV === "production";

  if (enabled && !isOidcConfigured()) {
    throw new Error(
      "[auth] Auth is ENABLED but OIDC is not configured (AUTH_ISSUER/AUTH_AUDIENCE missing). " +
        "Refusing to start. For local dev without auth, set AUTH_ENABLED=false.",
    );
  }
  if (!enabled && isProd) {
    throw new Error(
      "[auth] Auth is DISABLED (AUTH_ENABLED=false / DISABLE_AUTH=true) while NODE_ENV=production. Refusing to start.",
    );
  }

  log(
    enabled
      ? "[auth] ENABLED — JWT enforced on /mcp + /dev"
      : "[auth] DISABLED — injecting dev identity (non-production only)",
  );
  return enabled ? "enabled" : "disabled";
}
