/**
 * Every rule that applies to ONE node folder.
 *
 * Tier 2 is structure (does it match the schema); tier 3 is everything a schema cannot
 * express: agreement BETWEEN files, the events table matching the output connectors,
 * chained calls being reachable by name, credentials existing in the package that needs
 * them, whenToUse carrying real selection signal.
 *
 * The rules stay in one function because they share the composed node: splitting them
 * further would mean rebuilding `parts` several times, or threading a dozen locals
 * between modules, and neither is more readable than this.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { report, rel, refCounts, derivedKinds, allCredentials, state } from "../context.mjs";
import { SCHEMA_ID, SECTIONS, validateAgainst, Validator } from "./schema.mjs";
import { readYaml, resolveRefs, sharedDirFor } from "./load.mjs";
import { HANDLEBARS_HELPERS, promptBlocks } from "./blocks.mjs";

export function lintNode(dir, pkg) {
  const nodePath = join(dir, "node.yaml");
  const label = rel(dir);

  if (!existsSync(nodePath))
    return report("error", label, `has no node.yaml. It is the one REQUIRED file in a node folder (DECLARATIVE_NODES.md §5)`);

  const node = readYaml(nodePath);
  if (!node) return;

  // Each section: its own file, or inline in node.yaml, NEVER both. Silently
  // merging the two would make a stale file invisible.
  const parts = {};
  for (const s of SECTIONS) {
    const file = join(dir, `${s}.yaml`);
    const folder = join(dir, s);
    const hasFolder = existsSync(folder) && statSync(folder).isDirectory();
    const onDisk = existsSync(file);
    const inline = node[s] !== undefined;

    const ways = [hasFolder ? `${s}/` : null, onDisk ? `${s}.yaml` : null, inline ? "node.yaml" : null].filter(Boolean);
    if (ways.length > 1) {
      report("error", rel(hasFolder ? folder : file), `"${s}" is defined in ${ways.join(" and ")}. Pick one; this is never a merge (DECLARATIVE_NODES.md §5)`);
      continue;
    }

    // `api` is always the folder form, so every node reads the same way.
    if (s === "api" && (onDisk || inline)) {
      report("error", onDisk ? rel(file) : rel(nodePath), `api must be a FOLDER: api/run.yaml, api/events.yaml, and one file per further part (api/service.yaml, api/toolExchange.yaml, api/narrate.yaml). Every node has the same shape (DECLARATIVE_NODES.md §5)`);
      continue;
    }

    if (hasFolder) {
      // One file per top-level key, named for the key it holds. Assembled here so
      // every rule below reads the same shape whichever layout the author chose.
      const files = readdirSync(folder).filter((f) => /\.ya?ml$/.test(f)).sort();
      if (!files.length) {
        report("error", rel(folder), `is an empty ${s}/ folder. Delete it, or add one file per top-level key (DECLARATIVE_NODES.md §5)`);
        continue;
      }
      const doc = {};
      for (const f of files) {
        const key = f.replace(/\.ya?ml$/, "");
        const part = readYaml(join(folder, f));
        if (part === undefined || part === null) continue;
        // The filename IS the key, so a file that repeats it nests the block twice.
        if (typeof part === "object" && !Array.isArray(part) && Object.keys(part).length === 1 && key in part)
          report("error", rel(join(folder, f)), `starts with "${key}:" again. The FILENAME is the key, so this file holds the CONTENTS of ${key} (DECLARATIVE_NODES.md §5)`);
        doc[key] = part;
      }
      parts[s] = { doc, file: rel(folder) };
    } else if (onDisk) parts[s] = { doc: readYaml(file), file: rel(file) };
    else if (inline) parts[s] = { doc: node[s], file: rel(nodePath) };
  }
  for (const s of SECTIONS) if (parts[s]) delete node[s];

  // Resolve $refs into shared/ before anything reads a value.
  for (const s of SECTIONS)
    if (parts[s]?.doc) parts[s].doc = resolveRefs(parts[s].doc, dir, parts[s].file);

  // ── tier 2: structure ──
  validateAgainst(SCHEMA_ID.node, node, rel(nodePath), "node.schema.json");
  for (const s of SECTIONS) if (parts[s]?.doc) validateAgainst(SCHEMA_ID[s], parts[s].doc, parts[s].file, `${s}.schema.json`);

  const iface = parts.interface?.doc ?? {};
  const config = parts.config?.doc ?? null;
  const api = parts.api?.doc ?? null;
  const test = parts.test?.doc ?? null;
  const F = { node: rel(nodePath), iface: parts.interface?.file, config: parts.config?.file, api: parts.api?.file, test: parts.test?.file };

  const outputs = new Set((iface.outputs ?? []).map((o) => o.name));
  const inputs = new Set((iface.inputs ?? []).map((i) => i.name));

  /**
   * EVERY call this node makes, wherever it is declared, each with a label saying where.
   *
   * The rules that matter most are per-CALL, not per-node: the allowedHosts boundary, https,
   * and the capabilities package.yaml must promise. Those all used to read `api.request`
   * alone, so a host named only in `narrate.request` or in a `service` method was never
   * checked against the allowedHosts list at all. Since allowedHosts is the security boundary for a
   * format whose whole premise is that a manifest may arrive as data, a rule that skips
   * four of the five places a URL can appear is not a rule.
   *
   * Widened here rather than by adding a fifth special case, so a call site added to the
   * schema later is covered by being a call.
   */
  const calls = [
    ...(api?.run ?? []).map((c, i) => ({ at: `run[${i}]${c?.name ? ` (${c.name})` : ""}`, call: c })),
    ...(api?.narrate?.request ? [{ at: "narrate.request", call: api.narrate.request }] : []),
    ...Object.entries(api?.service ?? {}).flatMap(([m, spec]) =>
      (spec?.calls ?? []).map((c, i) => ({ at: `service.${m}.calls[${i}]${c?.name ? ` (${c.name})` : ""}`, call: c })),
    ),
  ].filter((c) => c.call && typeof c.call === "object");

  /**
   * Every LIST of calls in the node, with whether its last one may stream.
   *
   * A graph run's last call is the node's answer, so it may stream. A service method
   * hands back one value and has no connector to stream onto, so all of its calls settle.
   * Same list shape, one rule that differs, stated here rather than inferred.
   */
  const chains = [
    ...(api?.run ? [{ at: "run", list: api.run, lastMayStream: true }] : []),
    ...Object.entries(api?.service ?? {})
      .filter(([, spec]) => spec?.calls)
      .map(([m, spec]) => ({ at: `service.${m}.calls`, list: spec.calls, lastMayStream: false })),
  ];

  // A PURE SERVICE node legitimately has no outputs: it is never triggered by the
  // graph, it answers callers and hands them a value. Any other node with no outputs
  // cannot be wired to anything.
  //
  // AN ANNOTATION node is the second legitimate case: no inputs, no outputs, no api. `Note` is
  // canvas furniture — a markdown sticky explaining a workflow. Having NO INPUTS is what keeps
  // it out of the data flow, since the graph can never reach it, and that is exactly why it also
  // needs no outputs. Requiring one would force a dot that could never carry anything.
  //
  // Both halves matter: a node with inputs but no outputs is still an error, because something
  // reaches it and then the data stops dead.
  const isAnnotation = !outputs.size && !(iface.inputs ?? []).length && !api;
  if (!outputs.size && !api?.service && !isAnnotation)
    report("error", F.iface ?? F.node, `declares no outputs. A node that emits nothing cannot be wired to anything`);

  // The service channel must match what the node advertises. A method with no
  // connector is undiscoverable; a connector method with no implementation is a lie
  // that only surfaces when a consumer calls it (08-mcp-services.md).
  if (api?.service || (iface.serviceConnectors ?? []).some((s) => s.isService === true)) {
    const advertised = new Set(
      (iface.serviceConnectors ?? []).filter((s) => s.isService === true).flatMap((s) => s.methods ?? []),
    );
    for (const method of Object.keys(api?.service ?? {}))
      if (!advertised.has(method))
        report("error", F.api, `api/service.yaml has "${method}" but no serviceConnector with isService: true lists it in methods. Nothing can discover it`);
    for (const method of advertised)
      if (!api?.service?.[method])
        report("error", F.iface ?? F.node, `advertises method "${method}" but api/service.yaml has no implementation. A consumer calling it gets an error`);
  }

  // ── tier 3: semantics ──

  // kind is DECLARED but VERIFIED. Getting it wrong used to surface only at runtime.
  // A tool exchange is a multi-turn LOOP, so it makes the node a CallbackNode just as
  // surely as a streaming transport does, and it must name a connector that grants tools.
  // Tools reach a node through an mcp serviceConnector it CONSUMES. Declaring a tool
  // exchange without one means the request would carry an empty tools array.
  if (api?.toolExchange) {
    const consumes = (iface.serviceConnectors ?? []).filter((s) => s.serviceType === "mcp" && s.isService === false);
    if (!consumes.length)
      report(
        "error",
        F.iface ?? F.node,
        `declares a toolExchange but no serviceConnector with serviceType: mcp and isService: false. There is nothing to source tools from`,
      );
  }

  // The LAST step is the node's answer, so it is the only one whose transport can make
  // the node stream. Every earlier step settles by definition.
  if (api?.run?.length) {
    const finalCall = api.run[api.run.length - 1] ?? {};
    const streaming = ["sse", "ndjson", "awsEventStream", "ws"].includes(finalCall.transport);
    // SPAWN implies an actor; CONTINUE does not. A CONTINUE port only says something re-fires this
    // node, and a ROUTED EDGE does that to a settle-once node — which is exactly how LoopEnd
    // re-triggers LoopStart, one fresh execution per pass. See compose.ts for the full reasoning;
    // the two must agree or lint and load disagree about the same manifest.
    const spawnPort = (iface.inputs ?? []).some((i) => i.signal === "SPAWN");
    const derived = streaming || spawnPort || api.toolExchange ? "CallbackNode" : "PromiseNode";
    if (node.kind && node.kind !== derived) {
      const why = streaming
        ? `its last step's transport "${finalCall.transport}" streams`
        : api.toolExchange
          ? `it declares a toolExchange, which is a multi-turn loop`
          : `an input declares a SPAWN signal`;
      report("error", F.node, `kind is "${node.kind}" but this node is a ${derived}: ${why} (DECLARATIVE_NODES.md §5)`);
    }
    derivedKinds.set(label, derived);

    // The events table is compulsory for a node the graph can trigger: it is the only
    // way anything leaves the node, so without it the node is a call into the void.
    if (!(api.events ?? []).length)
      report("error", F.api, `has run calls but no api/events.yaml. The events table is compulsory, it is the only way anything leaves a node (DECLARATIVE_NODES.md §5)`);
  } else if (existsSync(join(dir, "src")) === false && !parts.api && !isAnnotation) {
    // An ANNOTATION node is exempt, because "does nothing" is the whole specification. `Note`
    // has no inputs, no outputs and no api: it is a markdown sticky on the canvas. Warning about
    // it would train a reader to ignore this message, which is the only thing that makes it
    // useful for the case it IS about — a node someone forgot to finish.
    report("warn", F.node, `has no api.yaml. A manifest node with no upstream call does nothing`);
  }

  // ── the events table: one row per output connector, in connector order ──
  //
  // This is the whole DX bet. A reader should learn a node's outward behaviour from ONE
  // ordered list rather than from four scattered keys, so the order is enforced, not
  // merely suggested. Enforcing it is also the only way it stays true after edits.
  const rows = api?.events ?? [];
  const streams = ["sse", "ndjson", "awsEventStream", "ws"].includes(api?.run?.[api.run.length - 1]?.transport);
  const outputOrder = (iface.outputs ?? []).map((o) => o.name);
  const SOURCES = ["response", "narrator", "tool", "complete"];

  for (const [i, r] of rows.entries()) {
    const from = r.from ?? "response";
    if (!SOURCES.includes(from))
      report("error", F.api, `events[${i}] has from: "${from}". Must be one of ${SOURCES.join(", ")} (DECLARATIVE_NODES.md §5)`);
    if (!outputs.has(r.emit))
      report("error", F.api, `events[${i}] emits to "${r.emit}", which is not a declared output (interface.yaml)`);
    // `match` names a streamed event type, so it means nothing on the other sources.
    if (r.match && from !== "response")
      report("error", F.api, `events[${i}] (${r.emit}) has a match but from: ${from}. Only a "response" row matches an event type`);
    /**
     * A STREAMING ROW NORMALLY NAMES ITS EVENT, because otherwise it fires on all of them.
     *
     * Unless the vendor has no event types to name. OpenAI's Responses API tags every SSE event with a
     * `type`; a Chat Completions chunk — GLM, Grok, most OpenAI-COMPATIBLE vendors — carries none at
     * all, so there is nothing a match could compare and the rule would demand the impossible.
     *
     * `toolExchange.call.each` is the tell, and it is a declared fact rather than a guess: `each` exists
     * precisely because that vendor streams tool calls in fragments, which is the same wire style that
     * omits event types. Such a row reads a field that only some events carry, and the emitter drops an
     * undefined value — so "fires on every event" is true and harmless there.
     */
    const untypedEvents = !!api?.toolExchange?.call?.each;
    if (streams && from === "response" && !r.match && !untypedEvents)
      report("error", F.api, `events[${i}] (${r.emit}) is a streaming response row with no match. It would fire on every event`);
    if (r.throttleMs && r.throttleChars)
      report("error", F.api, `events[${i}] (${r.emit}) sets both throttleMs and throttleChars. Pick the one that suits the output`);
    if (r.accumulate && from === "tool")
      report("warn", F.api, `events[${i}] (${r.emit}) accumulates a tool result into a string. Tool results are usually objects`);
  }

  // Coverage: an output nothing emits to is dead, and downstream nodes can wire to it.
  if (api) {
    const emitted = new Set(rows.map((r) => r.emit));
    for (const o of outputs)
      if (!emitted.has(o)) report("warn", F.iface ?? F.node, `output "${o}" is declared but no events row emits to it`);
  }

  // Order: the rows a reader sees must be the connectors they see, in the same order.
  // Compared over the outputs that ARE covered, so a missing row reports once (above)
  // rather than also reading as a reorder.
  if (rows.length) {
    const rowOrder = [...new Set(rows.map((r) => r.emit))].filter((n) => outputs.has(n));
    const want = outputOrder.filter((n) => rowOrder.includes(n));
    if (rowOrder.join(",") !== want.join(","))
      report(
        "error",
        F.api,
        `events rows are ordered ${rowOrder.join(", ")} but the output connectors are ${want.join(", ")}. Keep the table in connector order so the node reads top to bottom (DECLARATIVE_NODES.md §5)`,
      );
  }

  const fixture = parts.test?.doc?.testData?.config ?? {};
  const known = Object.keys(config?.configSchema?.properties ?? {});
  if (config) for (const k of Object.keys(fixture))
    if (!known.includes(k))
      report("error", F.test, `testData.config sets "${k}", which config.yaml does not declare. The value is silently ignored, so the fixture drifts from the node`);

  // Retired keys. Left in place they would silently do nothing, which is worse than a
  // hard error, so each one names its replacement.
  if (api?.response !== undefined)
    report("error", F.api, `api.response is retired: transport/terminator/error moved INTO the call (request), and what leaves the node is the events table (DECLARATIVE_NODES.md §5)`);
  if (api?.narrate?.output !== undefined)
    report("error", F.api, `narrate.output is retired. The narrator's line lands via an \`events\` row with from: narrator (DECLARATIVE_NODES.md §5)`);
  for (const [name, m] of Object.entries(api?.service ?? {}))
    if (m.response !== undefined)
      report("error", F.api, `service.${name}.response is retired: transport/error moved into the call, and the value it hands back is service.${name}.returns (DECLARATIVE_NODES.md §5)`);

  // ── chained calls ──
  //
  // A chain is reached by NAME, so the names are the contract: a step with none is
  // unreachable, and two calls sharing one silently shadow each other. Both would fail
  // as a confusing empty value inside somebody's `returns` expression rather than here.
  for (const { at, list, lastMayStream } of chains) {
    const names = [];
    for (const [i, s] of list.entries()) {
      const isLast = i === list.length - 1;
      if (!s?.name) {
        report("error", F.api, `${at}[${i}] has no name. A call is reached as calls.<name>, so an unnamed one cannot be read by a later call, an events row, or returns (DECLARATIVE_NODES.md §5)`);
      } else {
        if (names.includes(s.name))
          report("error", F.api, `${at} declares two calls named "${s.name}". The second silently overwrites the first in calls.<name>`);
        names.push(s.name);
      }
      // `auth` on a CALL is retired (2026-07-28). It now means the opposite thing one file
      // away — node.yaml's `auth` is inbound, about who may RUN the node — and the collision
      // was a reliable source of confusion. The outbound one took the name of what it holds.
      //
      // An ERROR rather than a silent accept: the executor reads `credential` only, so a call
      // left on the old spelling would send NO credential at all and fail as a vendor 401,
      // which reads as a bad key rather than a manifest that was never migrated.
      if (s?.auth !== undefined)
        report("error", F.api, `${at}[${i}] (${s.name ?? "unnamed"}) uses "auth", which is retired on a call. Rename it to "credential" — that is how this node proves itself to the VENDOR. node.yaml's "auth" is the other direction: who may run this node (DECLARATIVE_NODES.md §9.13)`);

      // Only the LAST step may stream, and only on the workflow channel: its reply is the
      // node's answer. An earlier step exists so a later one can READ it, and there is
      // nothing to read from a stream nobody framed.
      // A STATE call reaches Redis, not a host, so the request rules do not apply to it
      // and the request keys are meaningless on it.
      if (s?.state) {
        for (const k of ["method", "url", "transport", "credential", "body", "retry", "headers", "query"])
          if (s[k] !== undefined)
            report("error", F.api, `${at}[${i}] (${s.name ?? "unnamed"}) is a "${s.state}" state call, so "${k}" does nothing. A state call reaches platform storage, not a host`);
        const writes = s.state === "merge" || s.state === "save";
        if (!writes && s.value !== undefined)
          report("error", F.api, `${at}[${i}] (${s.name}) sets "value", which only a "merge" or a "save" writes`);
        if (s.state !== "drain" && s.max !== undefined)
          report("error", F.api, `${at}[${i}] (${s.name}) sets "max", which only a "drain" bounds`);
        if (writes && s.value === undefined)
          report("error", F.api, `${at}[${i}] (${s.name}) is a "${s.state}" with no "value", so it would store nothing`);
        // A `save` writes the RUN's saved-context hash, whose key is the engine's — `saved:<executionId>`,
        // read by the template resolver and deleted when the run ends. A manifest naming a key here
        // would be guessing at another component's layout, and the deployment namespace would be
        // applied to the one key that must not carry it, so the write would land where nothing reads.
        // Silent, and the toggle would still look like it worked.
        if (s.state === "save" && s.key !== undefined)
          report("error", F.api, `${at}[${i}] (${s.name}) is a "save", so "key" does nothing — the run's saved-context key belongs to the engine and the executor builds it`);
        if (s.state !== "save" && s.key === undefined)
          report("error", F.api, `${at}[${i}] (${s.name}) is a "${s.state}" with no "key", so there is nothing to address`);
        continue;
      }

      // A POLLED call's STATUS check is a GET unless it says otherwise, so a body on it would be
      // built and silently dropped — the same shape of bug as `timeoutMs` being declared and never
      // read. Starting the job is unaffected: that already uses the call's own method and body.
      if (s?.poll?.body && s.poll.method !== "POST")
        report("error", F.api, `${at}[${i}] (${s.name}) sets poll.body, which is only sent when poll.method is POST. As a GET it would be discarded`);

      // A LOOP entry keeps an index rather than reaching a host, so the request keys are as
      // meaningless on it as they are on a state call.
      if (s?.loop) {
        for (const k of ["method", "url", "transport", "credential", "body", "retry", "headers", "query"])
          if (s[k] !== undefined)
            report("error", F.api, `${at}[${i}] (${s.name ?? "unnamed"}) is a "${s.loop}" loop call, so "${k}" does nothing. A loop call keeps an index in platform storage, not a host`);
        // `key` is the LoopStart node's id: `{{ scope.nodeId }}` from LoopStart itself, or the paired
        // id from LoopEnd's config. Without it there is no loop to address, and the executor cannot
        // guess which of two loops on one canvas was meant.
        if (s.key === undefined)
          report("error", F.api, `${at}[${i}] (${s.name}) is a "${s.loop}" with no "key". A loop is addressed by its LoopStart node id`);
        // `open` needs the array; `advance` may collect a value; `read` moves nothing and stores
        // nothing, so a value on it would be silently discarded.
        if (s.loop === "open" && s.value === undefined)
          report("error", F.api, `${at}[${i}] (${s.name}) is a loop "open" with no "value", so it would iterate an empty list`);
        if (s.loop === "read" && s.value !== undefined)
          report("error", F.api, `${at}[${i}] (${s.name}) is a loop "read", which stores nothing, so "value" is discarded`);
        if (s.max !== undefined)
          report("error", F.api, `${at}[${i}] (${s.name}) sets "max", which only a "drain" bounds`);
        continue;
      }

      const settles = s?.transport === "json" || s?.transport === "text" || s?.transport === "xml" || s?.transport === "headers" || s?.transport === "binary";
      if (s?.transport && !settles && !(isLast && lastMayStream))
        report(
          "error",
          F.api,
          isLast
            ? `${at}[${i}] (${s.name ?? "unnamed"}) has transport "${s.transport}". A provided method hands back ONE value, so it has no connector to stream onto (DECLARATIVE_NODES.md §5)`
            : `${at}[${i}] (${s.name ?? "unnamed"}) has transport "${s.transport}" but is not the last step. Only the last may stream (DECLARATIVE_NODES.md §5)`,
        );
      // Only when it tests an earlier REPLY. A first call may perfectly well be gated on
      // config or on the caller's params, and Salesforce's is. What is meaningless is
      // reading calls.<name> before any call has happened. Warning on any `when` at all
      // made a correct manifest look wrong, which is how a warning stops being read.
      if (i === 0 && s?.when && /\bcalls\./.test(String(s.when)))
        report("warn", F.api, `${at}[0] (${s.name ?? "unnamed"}) reads calls.* but is the FIRST call, so there is no earlier reply and the test always fails`);
    }

    // A step naming one that does not exist reads as empty, and the request goes out
    // with a hole in it rather than failing.
    for (const [i, s] of list.entries())
      for (const [, ref] of JSON.stringify(s ?? {}).matchAll(/\bcalls\.([A-Za-z0-9_]+)/g)) {
        const earlier = names.slice(0, i);
        if (!earlier.includes(ref))
          report(
            "error",
            F.api,
            names.includes(ref)
              ? `${at}[${i}] (${s.name}) reads calls.${ref}, which happens LATER. A call sees only the calls before it`
              : `${at}[${i}] (${s.name}) reads calls.${ref}, which is not a call in this list`,
          );
      }
  }

  // The narrator's call is not part of a list: nothing reads its reply back and it can
  // never be followed by another, so a name or a when on it does nothing at all.
  for (const { at, call } of calls)
    if (at === "narrate.request")
      for (const k of ["name", "when"])
        if (call[k] !== undefined)
          report("error", F.api, `${at} sets "${k}", which belongs to a call in a list and is ignored here (DECLARATIVE_NODES.md §5)`);

  // RETIRED SHAPES. Each would silently do nothing rather than fail: the executor reads
  // `run` and `service`, finds no calls at all, and the node dies on its first run with a
  // message about neither. Naming the replacement matters more than the error itself,
  // because these are what every older example and every half-remembered habit produces.
  for (const [old, now] of [["request", "api/run.yaml, a LIST"], ["steps", "api/run.yaml"], ["provides", "api/service.yaml"]])
    if (api?.[old] !== undefined)
      report("error", F.api, `api/${old}.yaml is retired. This is ${now}. A node's calls are ALWAYS a list, each entry starting "- name: <what it fetches>" (DECLARATIVE_NODES.md §5)`);

  for (const [name, m] of Object.entries(api?.service ?? {}))
    for (const old of ["request", "steps"])
      if (m[old] !== undefined)
        report("error", F.api, `service.${name} declares "${old}". A method's calls are ALWAYS a list named "calls", even when there is one (DECLARATIVE_NODES.md §5)`);

  // Credentials must resolve to a declared type, or the run fails at execute time.
  for (const c of iface.credentials ?? []) {
    const name = c.name;
    if (!pkg.credentials.has(name))
      report("error", F.iface ?? F.node, `needs credential "${name}" but no credentials/${name}.yaml exists in this package. A package DECLARES the credentials it needs (04-credentials.md)`);
  }

  // configSchema internal consistency.
  if (config?.configSchema) {
    const props = config.configSchema.properties ?? {};
    const names = Object.keys(props);

    /**
     * THE TWO RUN-AUTHORIZATION FIELDS, on every node without exception.
     *
     * These are the WORKFLOW BUILDER's control, per box on the canvas, and they are separate
     * from node.yaml's `auth`, which is the node AUTHOR's floor. Both exist because they
     * answer different questions: the author knows a node is inherently privileged, and only
     * the builder knows that this particular box faces customers rather than staff.
     *
     * A role has to be here rather than only in the manifest. `finance:approve` is a claim
     * one deployment's identity provider mints, and a node published to the marketplace
     * cannot know the role vocabulary of every universe that installs it.
     *
     * COMPULSORY for the same reason the manifest block is: an optional field that most
     * nodes omit means a reviewer cannot tell "considered and left open" from "never thought
     * about", and a node written next year would quietly miss the control entirely.
     */
    const RUN_AUTH = {
      authRequired: { type: "boolean", widget: "toggle" },
      authRole: { type: "string", dependsOn: "authRequired" },
    };
    for (const [field, want] of Object.entries(RUN_AUTH)) {
      const f = props[field];
      if (!f) {
        report(
          "error",
          F.config,
          `config.yaml has no "${field}" property. Every node carries the two run-authorization fields, so whoever builds a workflow can say who may run THIS box (15-who-can-run-it.md)`,
        );
        continue;
      }
      if (f.type !== want.type)
        report("error", F.config, `${field} must be type "${want.type}", not "${f.type}". The executor reads it directly and a string "false" is truthy`);
      if (want.widget && f["ui:widget"] !== want.widget)
        report("error", F.config, `${field} must render as a "${want.widget}", not "${f["ui:widget"] ?? "a text box"}". It is a yes/no decision about access`);
      // The role box is meaningless while sign-in is off, and showing it invites someone to
      // fill it in and believe the step is protected.
      if (want.dependsOn && f["ui:dependencies"]?.[want.dependsOn] !== true)
        report("error", F.config, `${field} must declare "ui:dependencies": { ${want.dependsOn}: true }, so it is hidden while ${want.dependsOn} is off`);
      if (f.default !== (want.type === "boolean" ? false : ""))
        report("error", F.config, `${field} must default to ${want.type === "boolean" ? "false" : '""'}. A node that gates by default breaks every workflow that already uses it`);
    }
    for (const r of config.configSchema.required ?? [])
      if (!names.includes(r)) report("error", F.config, `required names "${r}", which is not a property`);

    const order = config["ui:order"] ?? [];
    for (const f of order) if (!names.includes(f)) report("error", F.config, `ui:order names "${f}", which is not a property`);
    if (order.length) for (const p of names) if (!order.includes(p)) report("warn", F.config, `property "${p}" is missing from ui:order. It renders last, in an arbitrary place`);

    for (const [n, f] of Object.entries(props)) {
      if (f.enum && f.enumNames && f.enum.length !== f.enumNames.length)
        report("error", F.config, `${n}: enum has ${f.enum.length} values but enumNames has ${f.enumNames.length}. They are positionally parallel`);
      if (f.enum && f.default !== undefined && !f.enum.includes(f.default))
        report("error", F.config, `${n}: default "${f.default}" is not one of its enum values`);
      for (const dep of Object.keys(f["ui:dependencies"] ?? {}))
        if (!names.includes(dep)) report("error", F.config, `${n}: ui:dependencies names "${dep}", which is not a sibling property`);
      // A template field on an object/array takes a `return` expression, not handlebars.
      if (f["ui:field"] === "template" && (f.type === "object" || f.type === "array") && typeof f.default === "string" && f.default.trim() && !f.default.startsWith("return "))
        report("warn", F.config, `${n}: is an object template, so its value is a "return ..." expression, not handlebars (06-config-schema.md)`);
    }

    // Every {{ config.x }} in the request must name a real config field.
    if (api)
      for (const ref of [...JSON.stringify(api).matchAll(/\{\{[~\s]*(?:[#\/]?\w+\s+)?(?:\(\w+\s+)?config\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))
        if (!names.includes(ref)) report("error", F.api, `templates {{ config.${ref} }} but "${ref}" is not a config property`);
  }

  // A template naming an unregistered helper compiles and then throws at run time.
  // The registered set lives in engine/src/template/StringTemplateResolver.ts.
  //
  // Scan ONLY inside {{ }}. The rest of an api.yaml holds `return ...` expressions
  // whose arrow callbacks — filter(e => ...) — read exactly like a subexpression.
  if (api) {
    const seen = new Set();
    for (const [, body] of JSON.stringify(api).matchAll(/\{\{([^}]*)\}\}/g)) {
      const helpers = [
        ...[...body.matchAll(/^[~\s]*[#\/]([a-zA-Z][\w]*)/g)].map((m) => m[1]), // {{#if}} {{/if}}
        ...[...body.matchAll(/\(([a-zA-Z][\w]*)\s/g)].map((m) => m[1]), // (eq a b)
      ];
      for (const h of helpers)
        if (!HANDLEBARS_HELPERS.has(h) && !seen.has(h)) {
          seen.add(h);
          report("error", F.api, `template uses helper "${h}", which is not registered (engine/src/template/StringTemplateResolver.ts). It throws at run time, not at build time`);
        }
      // {{prompt.x}} / {{blocks.x}} must name a real block, else it resolves to
      // EMPTY and the instruction just silently vanishes from the prompt.
      for (const [, b] of body.matchAll(/\b(?:prompt|blocks)\.([A-Za-z0-9_]+)/g))
        if (!promptBlocks().has(b) && !seen.has(b)) {
          seen.add(b);
          report("error", F.api, `references prompt block "{{prompt.${b}}}", which does not exist in prompts/blocks/. It resolves to empty and the instruction silently disappears`);
        }
    }
  }

  // A node nobody can run is a node nobody can trust.
  //
  // Unless there is nothing to run. A node with NO `api` makes no call and fires no events —
  // `Note` is the case, a markdown sticky on the canvas — so a fixture could only assert that
  // nothing happened. Demanding one would mean inventing sample data for a node that never
  // executes, which teaches a reader that fixtures are paperwork rather than proof.
  //
  // Scoped to the absence of `api` ALONE. An events-only node (no calls, but an events table,
  // like IfElse) DOES run and still needs its fixture.
  if (!test?.testData && !api) {
    // nothing to run, so nothing to fixture
  } else if (!test?.testData) {
    report("error", F.node, `has no testData. Every node needs sample data so it can be loaded and run (DECLARATIVE_NODES.md §6)`);
  } else {
    if (config?.configSchema) {
      /**
       * A TEMPLATE FIELD'S DECLARED TYPE DESCRIBES THE FORM, NOT THE RESOLVED VALUE.
       *
       * `ui:field: template` on an `object` means the author writes a `return` expression, and
       * the ENGINE resolves it before the node runs. So the type in configSchema is about
       * authoring, while a fixture holds what actually arrives — and those legitimately differ.
       * IfElse is the clean case: `condition` is an object-typed expression field whose resolved
       * value is a boolean, which is the entire point of the node.
       *
       * So the type constraint is dropped for template fields only. Everything else about them is
       * still checked (required, unknown keys), and every non-template field is still checked in
       * full, which is what catches a fixture that has drifted from the form.
       */
      const relaxed = JSON.parse(JSON.stringify(config.configSchema));
      for (const prop of Object.values(relaxed.properties ?? {})) {
        if (prop && typeof prop === "object" && prop["ui:field"] === "template") delete prop.type;
      }
      const v = new Validator(relaxed, "7", false);
      const r = v.validate(test.testData.config ?? {});
      for (const e of r.errors.filter((e) => e.instanceLocation !== "#").slice(0, 4))
        report("error", F.test, `testData.config${e.instanceLocation.replace(/^#/, "")} ${e.error}. The sample must satisfy this node's own configSchema`);
    }
    for (const k of Object.keys(test.testData.inputs ?? {}))
      if (!inputs.has(k)) report("error", F.test, `testData.inputs has "${k}", which is not a declared input`);
    // On the workflow channel an expect key names an output connector. On the SERVICE
    // channel there are no connectors: the method hands back one value, so the keys are
    // just labels for the assertions over it.
    const call = test.testData.call;
    if (!call)
      for (const k of Object.keys(test.testData.expect ?? {}))
        if (!outputs.has(k)) report("error", F.test, `testData.expect has "${k}", which is not a declared output`);

    if (call && !api?.service?.[call.method])
      report("error", F.test, `testData.call names method "${call.method}", which api.yaml does not provide`);
    if (!call && api?.service && !api?.run)
      report("error", F.test, `this node has only service methods, so testData needs a "call" block naming one. Otherwise nothing can run it`);
  }

  // WHO MAY RUN THIS NODE (DECLARATIVE_NODES.md §9.13).
  //
  // COMPULSORY, and that is the entire point of the block. Before 2026-07-28 authorization was
  // an OPTIONAL `requires: { role }`, so a node that said nothing was indistinguishable from a
  // node nobody had thought about — and every one of the 64 said nothing. Silence is not an
  // answer to "who may run this", so each node now states its stance out loud and a reviewer
  // reads a decision rather than an absence.
  if (node.requires !== undefined)
    report("error", F.node, `"requires" is retired on a node. Authorization is now "auth: { required, role }" — and unlike requires it is compulsory, so a node cannot stay silent about who may run it (DECLARATIVE_NODES.md §9.13)`);

  const auth = node.auth;
  if (auth === undefined) {
    report("error", F.node, `node.yaml has no "auth" block. Every node states who may run it: "auth: { required: false }" adds no requirement of its own (the trigger still owns the door), "required: true" demands a signed-in caller, and "role: noun:verb" demands a specific claim (DECLARATIVE_NODES.md §9.13)`);
  } else if (typeof auth.required !== "boolean") {
    report("error", F.node, `auth.required must be true or false, written out. Leaving it off would put the node back to being silent about authorization, which is what this block exists to stop (DECLARATIVE_NODES.md §9.13)`);
  } else if (auth.role !== undefined && auth.required === false) {
    // A role lives on a token, so demanding one while waiving the token is unsatisfiable. It
    // would read as "protected" on the acceptance screen and admit everyone at run time.
    report("error", F.node, `auth declares role "${auth.role}" with required: false. A role lives on a token, so this can never be satisfied — a node asking for a role is asking for a signed-in caller (DECLARATIVE_NODES.md §9.13)`);
  }

  // whenToUse decides whether the node SURFACES to the building agent at all.
  const w = (node.whenToUse ?? "").trim();
  if (w) {
    if (/^use this (node|when)/i.test(w))
      report("warn", F.node, `whenToUse opens by restating itself. Lead with the OUTCOME in task vocabulary (14-node-discoverability.md)`);
    if (/^(hybrid|attach|this is an?|a powerful)/i.test(w))
      report("warn", F.node, `whenToUse opens with plumbing or marketing. Outcome first, mechanism last; it sinks the ranking (14-node-discoverability.md)`);
    if (node.description && w.toLowerCase() === node.description.toLowerCase())
      report("error", F.node, `whenToUse merely repeats description. It carries zero selection signal (14-node-discoverability.md)`);
  }

  // ALLOWED_HOSTS. A manifest cannot execute, but it can say "send this credential to
  // evil.example". SECURITY.md bounds a code node by provenance and a template
  // expression by having no credentials in scope; a manifest node is neither, so the
  // declared host list is its boundary. Deny by default, and catch it statically here
  // as well as at run time.
  // Per CALL, not per node. This used to read `api.request` alone, so a host named only
  // in narrate.request or inside a service method was never checked against the allowedHosts
  // list at all. For a format whose premise is that a manifest may arrive as data, a
  // boundary that skips four of the five places a URL can appear is not a boundary.
  for (const { at, call } of calls) {
    if (!call.url) continue;
    // An EXPRESSION url cannot be parsed statically: there is no literal to blank down to
    // a host. Runtime still enforces allowedHosts on the RESOLVED url, through the same single
    // chokepoint every call passes, so this loses a build-time warning and not the
    // control. Said out loud rather than skipped, because a check that quietly covers less
    // than it claims is exactly what this file got wrong once already today.
    if (String(call.url).trimStart().startsWith("return ")) {
      report(
        "hint",
        F.api,
        `${at}.url is an expression, so its host cannot be checked at build time: allowedHosts is enforced at run time only for this call`,
      );
      continue;
    }
    const literal = String(call.url).replace(/\{\{[^}]*\}\}/g, "\u0000");
    let host = null;
    try {
      host = new URL(literal.replace(/\u0000/g, "x")).host.toLowerCase();
    } catch {
      // A url that is ENTIRELY a template has no scheme to parse, and that is legitimate
      // when the whole address comes from config — an attachment a person supplies. Only a
      // package that declared "*" may do it, and there the run-time check is the real one.
      report(
        (pkg.allowedHosts ?? []).includes("*") ? "hint" : "error",
        F.api,
        `${at}.url is not a valid URL: ${call.url}` +
          ((pkg.allowedHosts ?? []).includes("*")
            ? " — fully templated, and this package allows any host for unauthenticated calls, so it is checked at run time"
            : ""),
      );
    }
    if (host) {
      if (!/^https:/i.test(literal))
        report("error", F.api, `${at}.url is not https. A credential must not travel in clear text`);
      const allowedHosts = pkg.allowedHosts ?? [];
      const templated = literal.includes("\u0000");
      // MUST MATCH runtime/allowedHosts.ts exactly. Two matchers that disagree is worse
      // than one: lint passes and the call is refused at run time, or the reverse.
      //   **.a.com  any depth   (AWS: dynamodb.us-east-1.amazonaws.com is two labels deep)
      //   *.a.com   one level
      // `*` = any host, for unauthenticated calls only. Runtime enforces the credential
      // half; lint cannot see auth reliably here, so it accepts the host and leaves the
      // real check to assertAllowedHost, which is the single chokepoint anyway.
      const ok = allowedHosts.includes("*") || allowedHosts.some((p) =>
        p.startsWith("**.")
          ? host.endsWith(p.slice(2)) && host.length > p.length - 2
          : p.startsWith("*.")
            ? host.endsWith(p.slice(1)) && !host.slice(0, -(p.length - 1)).includes(".")
            : host === p,
      );
      if (!allowedHosts.length)
        report("error", rel(pkg.file), `node ${node.type} makes a request (${at}) but package.yaml declares no allowedHosts. A package with no declared hosts cannot call out at all`);
      else if (!ok && !templated)
        report("error", rel(pkg.file), `node ${node.type} calls "${host}" from ${at} but package.yaml allowedHosts is ${allowedHosts.map((e) => `"${e}"`).join(", ")}. Declare it or the executor will refuse the request`);
    }
  }

  // The package must promise every executor capability its nodes name, or deploy
  // to an older executor lints clean and fails at run time.
  //
  // Per call for the same reason as allowedHosts. The transport check also read
  // `api.response.transport`, a key retired when a call absorbed its own framing, so it
  // had been comparing undefined and passing everything ever since.
  // Renamed with the call key it mirrors, so the package's promise and the call's spelling
  // stay the same word. Left as `auth` it would list schemes for a key no call has.
  if (pkg.requires?.auth !== undefined)
    report("error", rel(pkg.file), `package.yaml uses requires.auth, which is retired. Rename it to requires.credential to match the call key (DECLARATIVE_NODES.md §9.13)`);

  if (pkg.requires && api)
    for (const { at, call } of calls) {
      const scheme = call.credential?.scheme;
      if (scheme && scheme !== "none" && !(pkg.requires.credential ?? []).includes(scheme))
        report("error", rel(pkg.file), `node ${node.type} uses credential "${scheme}" at ${at} but package.yaml requires.credential does not list it`);
      const t = call.transport;
      if (t && !(pkg.requires.transport ?? []).includes(t))
        report("error", rel(pkg.file), `node ${node.type} uses transport "${t}" at ${at} but package.yaml requires.transport does not list it`);
      // A state op on an executor without it no-ops SILENTLY: the cache reads cold forever
      // and the queue never drains. That is precisely what requires exists to catch.
      if (call.state && !(pkg.requires.state ?? []).includes(call.state))
        report("error", rel(pkg.file), `node ${node.type} uses state "${call.state}" at ${at} but package.yaml requires.state does not list it`);
      // Same reason again: a paginated call on an executor without pagination silently
      // returns page one, and a chunked write goes out whole and is rejected.
      if (call.paginate?.strategy && !(pkg.requires.paginate ?? []).includes(call.paginate.strategy))
        report("error", rel(pkg.file), `node ${node.type} paginates by "${call.paginate.strategy}" at ${at} but package.yaml requires.paginate does not list it`);
      if (call.chunk && pkg.requires.chunk !== true)
        report("error", rel(pkg.file), `node ${node.type} writes in batches at ${at} but package.yaml requires.chunk is not true`);
      // And a POLLED call on an executor without polling is the worst of the set: the start
      // reply is a RECEIPT, so the node would settle on a job id and emit it as the answer.
      // Nothing errors, and every downstream field reads empty.
      if (call.poll && pkg.requires.poll !== true)
        report("error", rel(pkg.file), `node ${node.type} waits on a job at ${at} but package.yaml requires.poll is not true`);
    }

  return node;
}
