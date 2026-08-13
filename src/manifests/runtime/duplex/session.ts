/**
 * `transport: ws` — a DUPLEX SESSION, and the audio lane beside it.
 *
 * Every other transport here is one request and a reply the executor reads. A voice model is
 * a conversation both sides write to, held open for the length of a call, and that is the only
 * reason this file exists as something other than another branch in `response.ts`.
 *
 * TWO SOCKETS, and confusing them is the mistake this file is arranged to prevent:
 *
 *   the VENDOR socket   this file opens it, to OpenAI or xAI. `api/run.yaml` describes it.
 *   the AUDIO LANE      the platform already owns it, to the browser. `api/audio.yaml` binds
 *                       to it, and it exists for ONE reason: MCP cannot carry binary audio.
 *
 * So everything inbound that is NOT audio goes to `emitter.response(payload, payload.type)`,
 * exactly as an `sse` reply does, and reaches the client over MCP streaming by landing on an
 * output connector. Only audio bypasses that, because only audio has to.
 *
 * WHAT IS HERE RATHER THAN IN YAML. Four things, and each is computation over bytes or time
 * rather than a description of the vendor's API, which is the test in DECLARATIVE_NODES.md §2:
 *
 *   resampling    linear interpolation across samples. The client captures 16 kHz; OpenAI and
 *                 xAI want 24 kHz. Getting it wrong is not an error anywhere — the vendor
 *                 transcribes at the wrong speed and it reads as poor accuracy.
 *   coalescing    a byte budget and a timer. One frame per vendor delta floods the client.
 *   barge-in      DISCARDING a buffer rather than flushing it. Flushing plays a fragment of a
 *                 sentence the user already talked over, which is the most obvious way a
 *                 voice call feels broken.
 *   ordering      the flush goes out BEFORE the end signal, because SPEECH_ENDED marks the END of
 *                 the utterance and the client finishes playback once its queue drains. A frame
 *                 sent after it lands on a player that has already stopped.
 *
 * All four are identical for every vendor, which is precisely why they are not in the manifest.
 */
import WebSocket from "ws";
import type { ComposedNode } from "../../compose.js";
import type { RunContext } from "../context.js";
import { resolveBody } from "../http/request.js";
import { evaluate } from "../templating.js";
import { assertAllowedHost } from "../http/allowedHosts.js";
import type { Emitter } from "../events.js";
// The audio lane lives next door: this file owns the VENDOR socket, that one owns the bytes and
// the browser. See the header of audioLane.ts for why they are separate files.
import { makeAudioBuffer, resamplePcm16, CLIENT_RATE, type AudioLane } from "./audioLane.js";

/**
 * PLATFORM CEILINGS, independent of anything a manifest says — the same arrangement `poll` has,
 * and for the same reason: the author's bound can be wrong.
 *
 * A duplex session ends when the vendor closes it or the person hangs up. If neither happens the
 * socket stays open forever, and a voice session is billed by the minute, so "forever" is a real
 * cost rather than a leaked handle. Two bounds, because they catch different failures:
 *
 *   IDLE  nothing inbound at all. A vendor that accepted the handshake and then went quiet, or a
 *         call nobody ever spoke on. This is what makes the node testable without a microphone.
 *   MAX   a session that is active but has run absurdly long, e.g. an open mic in an empty room
 *         keeping VAD busy indefinitely.
 */
const IDLE_TIMEOUT_MS = 30_000;
const MAX_SESSION_MS = 30 * 60_000;

import { offerDiscovered, parseMaybeJson, recordToolTrace, type ToolBridge } from "../tools/toolloop.js";


/** Resolve one manifest message against the run scope, with `extra` layered on top. */
async function message(spec: unknown, ctx: RunContext, extra: Record<string, unknown> = {}) {
  return resolveBody(spec, { ...ctx, ...extra } as RunContext);
}

export interface DuplexResult {
  /** Why the session ended, for the caller to record. */
  reason: "closed" | "ended" | "error" | "idle" | "maxDuration";
  error?: string;
}

/**
 * Hold one duplex session open until the vendor closes it, the client hangs up, or it errors.
 *
 * Resolves only when the session is OVER, because a voice node's run IS the call: the workflow
 * step is in progress for as long as the person is talking.
 */
export async function runDuplexSession(opts: {
  node: ComposedNode;
  call: any;
  ctx: RunContext;
  emitter: Emitter;
  url: string;
  headers: Record<string, string>;
  lane: AudioLane | null;
  conversationId: string;
  /** MCP tools, when an `mcp` provider is wired to this node's consumer handle. */
  tools?: ToolBridge;
  /**
   * THE TOKEN BILL, collected exactly as every HTTP transport collects it.
   *
   * Owned by the CALLER, like the collector on the json and sse paths, because the caller is
   * what knows the run is over and must `save()` once. This only feeds it.
   */
  usage?: { see(payload: any): void };
  onError?: (message: string, detail?: unknown) => void;
}): Promise<DuplexResult> {
  const { node, call, ctx, emitter, url, headers, lane, conversationId, tools, usage, onError } = opts;
  const exchange = node.api?.toolExchange;
  const audio = node.api?.audio ?? {};
  const outSpec = audio.out;
  const inSpec = audio.in;

  // Checked here as well as for HTTP calls: a socket url carries the credential in a header on
  // the handshake, so an undeclared host is exactly the exfiltration allowedHosts exists to stop.
  // A session always authenticates, hence `true` rather than reading the auth block.
  assertAllowedHost(url, node.allowedHosts, node.type, true);

  const ws = new WebSocket(url, { headers });
  const buffer = lane && outSpec ? makeAudioBuffer(lane, conversationId, outSpec.coalesceBytes, outSpec.coalesceMs) : null;

  let settled = false;
  let closing = false;
  /**
   * Is the assistant mid-utterance? The vendor has no "about to speak" event, so the FIRST audio
   * delta after silence is the start, and the client gates playback on being told. Transcribed from
   * the retired node's `audioStarted` flag, which existed for exactly this.
   */
  let speaking = false;

  /** The tool list, which GROWS: a search mid-call can add to it and the socket re-offers it. */
  let live: any[] = [];

  const send = (payload: unknown) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  };

  /** Run the `close` list, then close. Ordered, because Nova rejects a teardown out of order. */
  const shutdown = async (reason: DuplexResult["reason"]) => {
    if (closing) return;
    closing = true;
    for (const spec of call.close ?? []) {
      try {
        // Same array flattening as `open`, for the same reason.
        for (const m of ([] as any[]).concat((await message(spec, ctx)) ?? [])) if (m) send(m);
      } catch (err: any) {
        onError?.(`close message failed: ${err?.message ?? err}`);
      }
    }
    buffer?.flush();
    try {
      ws.close();
    } catch {
      /* already gone */
    }
    return reason;
  };

  return new Promise<DuplexResult>((resolve) => {
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const maxTimer = setTimeout(() => {
      void shutdown("maxDuration").then(() => finish({ reason: "maxDuration" }));
    }, MAX_SESSION_MS);

    /** Restarted by every inbound frame, so it only fires when the vendor has gone quiet. */
    const touch = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        void shutdown("idle").then(() => finish({ reason: "idle" }));
      }, IDLE_TIMEOUT_MS);
    };

    const finish = (result: DuplexResult) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      resolve(result);
    };

    ws.on("open", async () => {
      touch();
      try {
        /**
         * THE TOOLS THE CALL OPENS WITH, discovered before the handshake goes out because the
         * handshake is where they are first offered. Exposed to the `open` messages as `tools`,
         * which is why the manifest writes the vendor's envelope itself instead of the executor
         * guessing at it.
         *
         * These are the SEED, not the whole set — `offer` below carries what discovery adds
         * later.
         *
         * Empty when nothing is wired, and that is the normal case: the node degrades to a plain
         * voice call rather than failing, exactly as an agent with no MCP provider does.
         */
        if (tools && exchange) {
          try {
            live = await offerDiscovered(exchange, tools);
          } catch (err: any) {
            onError?.(`tool discovery failed, continuing without tools: ${err?.message ?? err}`);
          }
        }
        // In scope as `services.<connector>.tools`, which is the DOCUMENTED root a consumer reads
        // (07-service-connectors.md) and the same place the HTTP loop puts them. The handshake
        // therefore says `return services.mcpService.tools` rather than re-deriving the envelope.
        const connector = exchange?.from ?? "mcpService";
        const withTools = {
          ...ctx,
          services: { ...ctx.services, [connector]: { ...(ctx.services as any)?.[connector], tools: live } },
        } as RunContext;

        /**
         * The handshake, IN ORDER. A list because Nova's sessionStart/promptStart/contentStart
         * sequence is only valid in that order, while OpenAI sends one session.update.
         *
         * An entry may resolve to an ARRAY, and each element is then sent in turn. That is what
         * makes a variable-length handshake expressible: replaying N turns of conversation history
         * is one entry that maps over the array, and an entry that resolves to [] sends nothing —
         * which is how an optional opening message is written without a `when` on every item.
         */
        for (const spec of call.open ?? []) {
          const built = await message(spec, withTools);
          for (const m of ([] as any[]).concat(built ?? [])) if (m) send(m);
        }

        if (lane && inSpec) {
          lane.startAudioSession?.(conversationId, conversationId);

          lane.setAudioDataHandler?.(async (sessionId, data) => {
            if (sessionId !== conversationId || ws.readyState !== WebSocket.OPEN) return;
            const raw = Buffer.from(data);
            const rate = inSpec.resampleTo ?? CLIENT_RATE;
            const pcm = resamplePcm16(raw, CLIENT_RATE, rate);
            send(
              await message(inSpec.message, ctx, {
                audio: { base64: pcm.toString("base64"), bytes: pcm.length, rate },
              }),
            );
          });

          lane.setControlMessageHandler?.(async (sessionId, msg) => {
            if (sessionId !== conversationId) return;
            const endOn: string[] = audio.control?.endOn ?? [];
            if (endOn.includes(String(msg?.type))) finish({ reason: await shutdown("ended") ?? "ended" });
          });
        }
      } catch (err: any) {
        onError?.(`session open failed: ${err?.message ?? err}`);
        await shutdown("error");
        finish({ reason: "error", error: err?.message ?? String(err) });
      }
    });

    ws.on("message", async (raw) => {
      touch();
      let event: any;
      try {
        event = JSON.parse(String(raw));
      } catch {
        return; // a frame that is not JSON is not something a manifest can describe
      }
      const type = String(event?.type ?? "");

      // Billed per RESPONSE, so a ten-turn call carries ten usage blocks and the collector sums
      // them. Above the dispatch, because the frame carrying usage must not depend on which
      // branch claims it. `sniffUsage` already reads `payload.response.usage` — no manifest change.
      usage?.see(event);

      try {
        // AUDIO, the one thing that bypasses an output connector, and only because MCP cannot
        // carry it.
        if (outSpec && type === outSpec.match) {
          // SPEECH_STARTED, once per utterance. The client sets up playback on it, so audio sent
          // before it is audio nobody hears.
          if (!speaking) {
            speaking = true;
            lane?.sendControl(conversationId, {
              type: "AUDIO_STATE",
              state: "SPEECH_STARTED",
              message: "Assistant started speaking",
            });
          }
          /**
           * AWAITED. `evaluate` is async, and forgetting that here was the crackling: `String(promise)`
           * is the literal text "[object Promise]", which base64-decodes to 11 bytes of garbage, so
           * every audio frame carried noise instead of speech.
           *
           * It was invisible in the transcripts because those go through `emitter.response`, which
           * awaits properly — the call sounded broken while every log line looked perfect.
           */
          const b64 = await evaluate(outSpec.value, { ...ctx, response: event } as any);
          if (b64) buffer?.add(Buffer.from(String(b64), "base64"));
          return;
        }
        if (outSpec?.done && type === outSpec.done) {
          // Flush FIRST. SPEECH_ENDED marks the end of the utterance (`markAsLastChunk` in the
          // SDK's playback hook), and the client finishes as soon as its queue drains — so a frame
          // sent after it can arrive on a player that has already stopped and reset.
          buffer?.flush();
          speaking = false;
          lane?.sendControl(conversationId, {
            type: "AUDIO_STATE",
            state: "SPEECH_ENDED",
            message: "Assistant finished speaking",
          });
          return;
        }
        if (outSpec?.interruptOn && type === outSpec.interruptOn) {
          /**
           * DISCARD ONLY — no control message of its own.
           *
           * The client cuts playback on USER_SPEECH_STARTED (`playback.stopAll()` in the SDK's
           * voice hook), and the VAD forwarding below already sends that on this very event. A
           * second control here would be redundant at best.
           *
           * It was actively wrong when it sent SPEECH_ENDED: that only clears the assistant hint and
           * marks the end of the utterance, so the buffered audio kept playing over the person.
           *
           * So the server's job on barge-in is exactly one thing: throw away the audio the person
           * talked over, so it cannot be flushed later.
           */
          buffer?.discard();
          speaking = false;
          // NOT returned. Barge-in is also a fact the workflow may want, so it still goes to
          // the events table below.
        }
        // The vendor's own voice-activity detection, forwarded as the retired node forwarded it.
        // Separate from `interruptOn` even when both name the same event: this tells the client the
        // person is talking, that one throws away the audio they talked over.
        if (audio.control?.userSpeaking && type === audio.control.userSpeaking) {
          lane?.sendControl(conversationId, { type: "AUDIO_STATE", state: "USER_SPEECH_STARTED" });
        }
        if (audio.control?.userStopped && type === audio.control.userStopped) {
          lane?.sendControl(conversationId, { type: "AUDIO_STATE", state: "USER_SPEECH_ENDED" });
        }

        // EVERYTHING ELSE, to the events table, exactly as an sse reply. This is the path that
        // reaches the client over MCP streaming.
        await emitter.response(event, type);

        /**
         * A TOOL CALL, mid-conversation.
         *
         * The socket difference from `runToolLoop`: there are no TURNS. An HTTP agent sends a
         * request, reads the tool calls out of the reply, and sends another request — so it can
         * count turns and stop. Here the conversation never ended, so the result simply goes back
         * down the same socket and the model carries on talking. `maxTurns` and
         * `stuckAfterRepeats` have nothing to count, which is why this reads the exchange's
         * `call`/`result` shape and none of its budget keys.
         */
        if (exchange && tools && type === exchange.call?.match) {
          // The SAME contract the HTTP loop reads — match / id / name / arguments — so a vendor's
          // tool shape is described once and both paths agree. `when` narrows it where that event
          // type carries more than calls.
          const scope = { ...ctx, response: event } as any;
          const wanted = !exchange.call.when || (await evaluate(exchange.call.when, scope));
          if (wanted) {
            const id = String(await evaluate(exchange.call.id, scope) ?? "");
            const name = String(await evaluate(exchange.call.name, scope) ?? "");
            // A JSON STRING, per the schema, which is the trap: handed over unparsed the tool gets
            // a string where it expected its parameters.
            const rawArgs = String((await evaluate(exchange.call.arguments, scope)) ?? "{}");
            if (name) {
              let output: string;
              // A lookup takes 8-9s, and silence on a call reads as a dropped line. The client,
              // the lookup-indicator and the docs all had this wired already; nothing ever sent it.
              lane?.sendControl(conversationId, {
                type: "AUDIO_STATE",
                state: "TOOL_USE",
                metadata: { toolName: name },
              });
              // Started BEFORE the call, so the timeline bar measures the wait the caller
              // actually sat through, not the bookkeeping after it.
              const toolStart = Date.now();
              let toolOk = true;
              try {
                const args = JSON.parse(rawArgs || "{}");
                /**
                 * THE SAME ABSORBER the HTTP loop uses, which is the point of it being one
                 * function: a voice call that discovers an app must open its page exactly as a
                 * typed one does, and the result must be leaned before it goes back — on a
                 * voice call every extra token is latency the person hears.
                 */
                const absorbed = await tools.absorb(name, await tools.call(name, args));
                /**
                 * THE TOOL LIST IS DISCOVERED, NOT DECLARED: a search returns rows pointing at apps,
                 * each of which becomes a tool. The handshake's tools are only the seed.
                 *
                 * These used to be dropped on the claim that a session's tool list is fixed at open.
                 * That was true of this code, never of the vendor: verified live 2026-08-12, a
                 * mid-call `session.update` is accepted, MERGES, and the tool is callable next turn.
                 * Sent immediately — `session.update` is not gated on an idle conversation, only
                 * `response.create` is.
                 */
                if (absorbed.minted.length) {
                  for (const tool of absorbed.minted) live.push(await evaluate(exchange.tool, { tool } as any));
                  if (exchange.offer) {
                    const grown = await message(exchange.offer, ctx, { tools: live });
                    for (const m of ([] as any[]).concat(grown ?? [])) if (m) send(m);
                    console.log(
                      `[manifests] ${node.type}: re-offered ${live.length} tool(s) after ${absorbed.minted.length} discovered by ${name}`,
                    );
                  } else {
                    console.log(
                      `[manifests] ${node.type}: ${absorbed.minted.length} tool(s) discovered mid-call and not registered — this package's toolExchange declares no 'offer'`,
                    );
                  }
                }
                output = absorbed.content;
              } catch (err: any) {
                // Reported TO THE MODEL rather than thrown. A failed tool on a live call should let
                // the assistant say it could not do the thing, not drop the conversation.
                toolOk = false;
                output = `Tool "${name}" failed: ${err?.message ?? err}`;
              }
              // The same timeline row an HTTP agent's tool call draws. `runToolLoop` has recorded
              // these since the migration; the socket never called it, so voice tools were invisible.
              recordToolTrace(node, ctx, name, parseMaybeJson(rawArgs), output, toolStart, toolOk);
              // After the catch, so a tool that THREW still stops the dots. Spinning forever is
              // worse than no indicator: it promises something still coming.
              lane?.sendControl(conversationId, { type: "AUDIO_STATE", state: "TOOL_USE_COMPLETED" });
              // PARSED for the connector lane only (readable mcpResult, same as the HTTP
              // loop); the model message two lines down keeps the raw `output` string —
              // the vendor wire requires text.
              await emitter.tool({ name, args: parseMaybeJson(rawArgs), output: parseMaybeJson(output) });
              // A LIST, because a vendor may need more than one message: OpenAI adds the item and
              // then asks for a response, and without the second the model never speaks the result.
              const back = await message(exchange.result, ctx, { call: { id, name, output } });
              for (const m of ([] as any[]).concat(back ?? [])) send(m);
            }
          }
        }

        // Reactive sends: a tool result going back, a response asked for. The triggering event
        // is in scope as `response`, as in an events row.
        for (const rule of call.send ?? []) {
          if (rule.on !== type) continue;
          // AWAITED, for the same reason the audio path is: `evaluate` is async, so `!promise` is
          // always false and an un-awaited `when` never blocks anything. Every reactive send would
          // fire regardless of its condition — silently, since firing too often looks like working.
          if (rule.when && !(await evaluate(rule.when, { ...ctx, response: event } as any))) continue;
          // A list, because one rule may need several messages (add the item, then ask for a reply).
          for (const m of ([] as any[]).concat((await message(rule.message, ctx, { response: event })) ?? [])) {
            if (m) send(m);
          }
        }
      } catch (err: any) {
        onError?.(`handling ${type} failed: ${err?.message ?? err}`, err);
      }
    });

    ws.on("error", (err: any) => {
      onError?.(`socket error: ${err?.message ?? err}`);
      buffer?.discard();
      finish({ reason: "error", error: err?.message ?? String(err) });
    });

    ws.on("close", () => {
      buffer?.flush();
      finish({ reason: closing ? "ended" : "closed" });
    });
  });
}
