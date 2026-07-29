/**
 * Build what a manifest's templates and expressions may see.
 *
 * `config` arrives ALREADY RESOLVED: the engine runs its template resolver before it
 * calls execute, so {{signal.x}} and {{prompt.y}} an author wrote in a config field are
 * plain text by the time they reach here.
 *
 * `executionContext.auth.accessToken` — the CALLER'S JWT (AUTH_TOKEN_FLOW.md) — is
 * DELIBERATELY WITHHELD, and must stay that way. A code node may reach it because a code
 * node is bounded by provenance; a manifest is data that can arrive by paste or database
 * row. The blast radii are not comparable: a third-party API key reaches that vendor
 * account, while a platform JWT IS the user against our own services, so a pasted
 * manifest could forward it to any host its allowedHosts list allows.
 *
 * `auth.user` — the signed-in person's email, id and name — IS exposed, as `user`. That
 * is not a softening of the rule, it is the rule applied to a different thing: an email
 * authenticates nothing, and it is the join key every CRM, support and account node needs.
 * Withholding it would force those nodes to take identity off the WIRE, which is strictly
 * worse: a caller could then ask for someone else's record. Never widen this to the token.
 *
 * The tool bridge DOES use the token, and that is not a contradiction: there the
 * platform is calling its own internal /mcp on the user's behalf, rather than data
 * deciding where a secret goes.
 *
 * EXPORTED ONLY FOR THE SIBLING FILES IN THIS FOLDER (the two executors and the re-fire).
 * Nothing outside `executor/` may import it: every consumer of a RunContext outside this
 * folder receives one already built, and a second builder is how the token rule would
 * eventually be widened by accident. Pinned by manifest-chain.test.ts.
 */
import type { ComposedNode } from "../compose.js";
import { applyResolvers, emptyContext, type RunContext } from "../runtime/index.js";

export function contextFor(node: ComposedNode, inputs: any, config: any, executionContext: any): RunContext {
  const user = executionContext?.auth?.user ?? {};
  return emptyContext({
    config: applyResolvers(config ?? {}, node),
    // The bag holds EVERY credential in the workflow keyed by name. Selecting by name is
    // the manifest's job, which is what stops a node authenticating with a neighbour's
    // apiKey (04-credentials.md).
    credentials: executionContext?.credentials ?? {},
    signal: inputs ?? {},
    services: executionContext?.services ?? {},
    // Picked field by field, never spread: a future field on auth.user must be an explicit
    // decision to expose, not something a manifest silently inherits.
    user: { email: user.email, id: user.id ?? user.sub, name: user.name },
    // The PLATFORM's ids, which is what state keys are built from. Same precedence the
    // retired CRM code used, and it is not interchangeable with user.id above.
    //
    // `conversationId` and `chatId` are here because the AUDIO LANE is keyed by conversation.
    // Their absence was a silent, total failure of the voice node: `runDuplexSession` fell back
    // to the node TYPE as its key, so `setAudioDataHandler` compared the client's real session id
    // against the string "OpenAIRealtimeVoice", dropped every microphone frame, and sent the
    // model's audio to a conversation nobody was listening on. No error anywhere — just silence.
    //
    // Same precedence the retired node used: publishingContext first, then workflow variables.
    scope: {
      userId: executionContext?.publishingContext?.userId ?? executionContext?.workflow?.variables?.userId,
      workflowId: executionContext?.workflowId ?? executionContext?.workflow?.id,
      conversationId:
        executionContext?.publishingContext?.conversationId ?? executionContext?.workflow?.variables?.conversationId,
      chatId: executionContext?.publishingContext?.chatId ?? executionContext?.workflow?.variables?.chatId,
      executionId: executionContext?.executionId,
      // Which INSTANCE on the canvas. The retired Code node fell back to the literal "code" when
      // this was missing, which meant two Code nodes minted the same universal id and the saved
      // context stored them under one key. Passing it through rather than defaulting is what makes
      // that failure impossible instead of merely unlikely.
      nodeId: executionContext?.nodeId,
      /**
       * THE PLATFORM'S OWN API, for a node that calls us rather than a vendor.
       *
       * DERIVED, not configured. A node runs INSIDE the unoverse service, so it is calling itself —
       * asking a developer to supply the platform's own address would be configuration for something
       * the process already knows. `UNOVERSE_RUNTIME_PORT` is the internal listener and is already set
       * in docker-compose; the server reads it the same way (`RUNTIME_PORT`), and already builds its own
       * loopback url as `http://127.0.0.1:${port}` elsewhere.
       *
       * LOOPBACK, not a service name: :4106 is the UNGATED internal listener, published to 127.0.0.1
       * only and never widened. Reaching it from anywhere else would be a mistake, so the address says
       * so.
       *
       * The retired SpatialIngest read UNOVERSE_SERVICE_URL with a `|| "http://localhost:4106"`
       * fallback — a variable that is set NOWHERE in this repo, so the fallback was the whole
       * behaviour. Deriving it removes both the dead variable and the hardcoded string.
       */
      platformUrl: `http://127.0.0.1:${process.env.UNOVERSE_RUNTIME_PORT ?? 4106}`,
      /**
       * THE ENGINE, on :4101, and it is NOT the same service as `platformUrl`.
       *
       * Two internal listeners, two different sets of routes, and picking the wrong one is a
       * 404 rather than anything that reads like an address problem:
       *
       *   :4106  the unoverse runtime  — /service-call, /execute, /skills
       *   :4101  the engine            — /spatial/search, /dictionary/entry, /workflows
       *
       * SpatialSearch needs BOTH, which is what makes the distinction worth a second field
       * rather than a note: its searches are engine routes and its skill reads are runtime
       * routes. The retired node had the same split and hid it in two different env vars
       * (WORKFLOW_SERVICE_URL and UNOVERSE_SERVICE_URL), neither of which is set anywhere in
       * this repo, so both fallbacks were the entire behaviour.
       *
       * Same derivation as above, and the same reasoning: loopback because these listeners
       * are internal and never published, and derived so there is no dead variable to set.
       */
      engineUrl: `http://127.0.0.1:${process.env.ENGINE_PORT ?? process.env.WORKFLOW_SERVICE_PORT ?? 4101}`,
    },
  });
}
