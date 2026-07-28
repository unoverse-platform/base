/**
 * WHO MAY RUN THIS NODE, enforced at node start (DECLARATIVE_NODES.md §9.13).
 *
 * The inbound question, about the CALLER. A call's `credential` is the outbound one: how the
 * node proves itself to a vendor. Both were spelled `auth` until 2026-07-28, which is the
 * reason the two were so easy to mistake for each other.
 *
 * WHY THIS FILE EXISTS. `requires.role` was in the node schema and checked by lint from the
 * day the format shipped, and read by no runtime code at all: `compose.ts` never carried the
 * field onto the composed node, so the executor could not have enforced it even if someone
 * had written the check. Every doc said "schema + lint exist, the executor check does not".
 * A security field that lints clean and does nothing is worse than no field, because a
 * reviewer reads it as a decision that was made and is holding.
 *
 * WHAT THIS IS NOT. This does not admit anyone. The platform gate at the edge decides who
 * gets in at all (default-deny JWT, `auth/publicEntry.ts` for the anonymous case). By the
 * time a node runs the caller is already whoever they are going to be, and this only ever
 * NARROWS: a node may demand more than the trigger did and can never waive what it demanded.
 *
 * FAILS LOUDLY, and that is a deliberate choice over the alternative. A node that no-ops on
 * missing identity looks fine in testing and silently does nothing in production, and nobody
 * finds out for a week. Throwing names the claim that was missing, in the run's error, on
 * the node that wanted it.
 */

/** What the platform gate put on the run. Guests carry an id and nothing else. */
interface Caller {
  id?: string;
  sub?: string;
  email?: string;
  roles?: string[];
  permissions?: string[];
}

export class NodeAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeAuthorizationError";
  }
}

/**
 * A guest is an ADMITTED anonymous visitor, not an absent one, and the two must not be
 * conflated: a guest legitimately reached a public workflow, while `undefined` means no
 * identity travelled at all. Both fail `required: true`, but only the first is expected.
 *
 * The id shape is the gate's contract (`publicEntry.ts` mints `guest:<uuid>` and refuses a
 * session claiming any other shape), and the retired `guest-` spelling still counts because
 * clients mint and keep these across sessions.
 */
function isGuest(user: Caller | undefined): boolean {
  const id = String(user?.id ?? user?.sub ?? "");
  return id.startsWith("guest:") || id.startsWith("guest-");
}

/**
 * Roles and permissions are ONE namespace here, deliberately. Both are `noun:verb` claims
 * parsed off the same token (`auth.ts` reads each from its own claim, Auth0-namespaced or
 * not), and `marketplace:publish` is already checked as a permission while reading exactly
 * like a role. Making an author know which claim their identity provider happened to put a
 * string in would be a footgun with no upside: the question is whether the caller carries
 * the claim, not which list it arrived in.
 */
function carries(user: Caller | undefined, role: string): boolean {
  return [...(user?.roles ?? []), ...(user?.permissions ?? [])].includes(role);
}

/**
 * TWO SOURCES, AND THE STRICTER WINS.
 *
 * The manifest's `auth` is the node AUTHOR's floor: "this node is inherently privileged",
 * true of every copy of it everywhere. The instance's `authRequired` / `authRole` are the
 * WORKFLOW BUILDER's, set per box on the canvas, because only they know that this
 * particular box faces customers rather than staff.
 *
 * A role in particular has to be able to come from the instance. `finance:approve` is a
 * claim ONE deployment's identity provider mints, so a node published to the marketplace
 * cannot name it: the author does not know the role vocabulary of the universes that
 * install their node, and the builder does.
 *
 * Neither source can loosen the other. Requirements only narrow, which is the same law the
 * trigger's public toggle obeys, so both roles are demanded when both exist rather than one
 * overriding the other.
 */
function combine(
  manifest: { required: boolean; role?: string },
  config: any,
): { required: boolean; roles: string[] } {
  // Read STRAIGHT off the instance config and never through the template resolver. A gate
  // that resolved `{{ ... }}` would let the thing being gated choose its own answer.
  const instanceRequired = config?.authRequired === true;
  const instanceRole = typeof config?.authRole === "string" && config.authRole.trim() ? config.authRole.trim() : undefined;

  const roles = [manifest.role, instanceRole].filter((r): r is string => !!r);
  // A role implies a signed-in caller wherever it came from, so an instance role that
  // someone set while leaving the toggle off still demands identity rather than being
  // quietly ignored.
  return { required: manifest.required || instanceRequired || roles.length > 0, roles };
}

/**
 * Throws unless this caller may run this node. Called once per node start, before any call
 * is made, so a refused run costs no vendor request and no side effect.
 *
 * `nodeAuth` in compose.ts has already collapsed the unsatisfiable `role` + `required: false`
 * pair in the manifest, so a manifest role always implies `required: true`.
 */
export function assertAuthorized(
  node: { type: string; auth?: { required: boolean; role?: string } },
  executionContext: any,
  config?: any,
): void {
  // Absent means a manifest composed before this field existed. Treated as "signed in
  // required" for the same reason compose.ts does: the safe reading of a node that never
  // said, rather than the convenient one.
  const want = combine(node.auth ?? { required: true }, config);
  if (!want.required) return;

  const user: Caller | undefined = executionContext?.auth?.user;
  const identified = !!(user?.id ?? user?.sub) && !isGuest(user);

  if (!identified)
    throw new NodeAuthorizationError(
      `${node.type} requires a signed-in caller${want.roles.length ? ` carrying ${want.roles.map((r) => `"${r}"`).join(" and ")}` : ""}, and this run has ` +
        (isGuest(user) ? "an anonymous guest" : "no identity") +
        `. The workflow's trigger admitted the run; this step asks for more than the trigger did, ` +
        `set either on the node itself (node.yaml auth) or on this box in the workflow (Require sign-in).`,
    );

  // NAMES THE CLAIM. A bare "forbidden" sends whoever hit it to read the manifest to find
  // out what they lacked, and an operator granting it needs the exact string anyway.
  const missing = want.roles.filter((r) => !carries(user, r));
  if (missing.length)
    throw new NodeAuthorizationError(
      `${node.type} requires the role${missing.length > 1 ? "s" : ""} ${missing.map((r) => `"${r}"`).join(" and ")}, ` +
        `which this caller does not carry. ` +
        `Present claims: ${[...(user?.roles ?? []), ...(user?.permissions ?? [])].join(", ") || "none"}.`,
    );
}
