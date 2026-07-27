/**
 * What a manifest may see at run time, and the resolvers applied before it does.
 *
 * Part of the manifest runtime (DECLARATIVE_NODES.md §2): the manifest DESCRIBES the
 * service, this half COMPUTES it. Split by concern so each piece stays readable.
 */
import type { ComposedNode } from "../compose.js";

/** Everything a manifest's templates and expressions may see. */
export interface RunContext {
  config: Record<string, any>;
  credentials: Record<string, any>;
  /** Upstream node outputs, keyed signal.<sourceId>.<outputHandle>. */
  signal: Record<string, any>;
  /** Prompt blocks by camelCase name, so {{prompt.markdownGuidelines}} resolves. */
  prompt: Record<string, string>;
  /** Runtime service wiring, e.g. services.mcpService.tools. */
  services: Record<string, any>;
  /** Arguments a CALLER passed to a service method. Empty when the graph runs the node. */
  params: Record<string, any>;
  /**
   * Replies from the calls made EARLIER in this run, keyed by each call's `name`.
   *
   * Empty for a node that makes one call. A call skipped by its `when` has no key at all,
   * which is what lets a later call, an events row, or `returns` ask whether it happened.
   *
   * Named `calls` and not `steps` on purpose: a step is a node on a canvas, and reusing
   * the word here would make "this node's steps" and "the workflow's steps" the same
   * phrase for two different things.
   */
  calls: Record<string, any>;
  /**
   * The SIGNED-IN person, and nothing that authenticates as them.
   *
   * Identity only: email, id, name. The caller's `accessToken` is deliberately absent and
   * must stay absent (see executor.ts contextFor). The distinction is the whole reason
   * this scope can exist at all: a JWT IS the user against our own services, so a pasted
   * manifest could send it to any allowed host, whereas an email authenticates nothing.
   *
   * It earns a first-class scope because "who is asking" is the join key for every CRM,
   * support and account node, and reading it off the wire instead would let a caller
   * fetch someone else's record.
   */
  user: { email?: string; id?: string; name?: string };
  /**
   * WHICH RUN this is, for keying platform state.
   *
   * `userId` is the PUBLISHING context's id, not `user.id`: the platform's own user id and
   * the authenticated identity are different values, and the memory server keys its
   * snapshot by the former. Using the wrong one writes to a key nobody reads, silently.
   */
  scope: { userId?: string; workflowId?: string };
  /**
   * What an OAuth2 exchange returned, for the call it authenticated.
   *
   * Some vendors tell you WHERE to talk as well as how: Salesforce returns `instance_url`
   * and the org's data lives there, not at the login host you authenticated against. Only
   * populated for `oauth2ClientCredentials`, and never carries the token itself.
   */
  token: { instanceUrl?: string };
}

export function emptyContext(partial: Partial<RunContext> = {}): RunContext {
  return { config: {}, credentials: {}, signal: {}, prompt: {}, services: {}, params: {}, calls: {}, user: {}, scope: {}, token: {}, ...partial };
}

/** Config values a resolver rewrites just before the request is built. */
export const RESOLVERS: Record<string, (value: any, node: ComposedNode) => any> = {
  // Migration of shared/models.ts resolveModel(): a saved workflow stores a concrete
  // model id, and if that id is retired this falls back to the current best model in
  // the same tier. Without it, replacing a model generation breaks every saved
  // workflow that named an old id.
  modelTier(value: any, node: ComposedNode) {
    const field = node.definition.configSchema?.properties?.model;
    const options: string[] = field?.enum ?? [];
    if (!value || options.includes(value)) return value || options[0];
    const m = String(value).toLowerCase();
    const tier = /luna|mini|small|nano/.test(m) ? 0 : /terra|balanced|medium/.test(m) ? 1 : 2;
    // Options are listed large first, so index from the end for small.
    const picked = [options[options.length - 1], options[1], options[0]][tier] ?? options[0];
    console.warn(`[manifests] model "${value}" is no longer available — using "${picked}". Update this node.`);
    return picked;
  },
};

/** Apply every declared resolver to the config before templates see it. */
export function applyResolvers(config: Record<string, any>, node: ComposedNode): Record<string, any> {
  const props = node.definition.configSchema?.properties ?? {};
  const out = { ...config };
  for (const [name, spec] of Object.entries<any>(props)) {
    const fn = spec?.resolve ? RESOLVERS[spec.resolve] : null;
    if (fn) out[name] = fn(out[name], node);
  }
  return out;
}
