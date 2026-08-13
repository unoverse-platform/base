/**
 * The two pieces of `transport: ws` that are pure computation, tested without a socket.
 *
 * These are the parts that FAIL SILENTLY, which is why they get a test while the socket
 * plumbing does not. A wrong resample is not an error anywhere: the vendor accepts the bytes
 * and transcribes them at the wrong speed, so it surfaces as "the model mishears people". A
 * flush where there should be a discard is not an error either: the call simply feels like the
 * assistant talks over you. Neither would be caught by lint, by tsc, or by a live call going
 * through successfully.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { runDuplexSession } from "../src/manifests/runtime/duplex/session.js";
import { resamplePcm16, makeAudioBuffer, type AudioLane } from "../src/manifests/runtime/duplex/audioLane.js";
import { buildExecutionContext } from "../src/platform/executionContext.js";

/** PCM16 buffer from sample values. */
function pcm(...samples: number[]): Buffer {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
}

/** Sample values back out of a PCM16 buffer. */
function samples(b: Buffer): number[] {
  return Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2));
}

test("resampling 16k to 24k produces exactly 1.5x the samples", () => {
  // The ratio OpenAI and xAI need. Wrong length here IS the chipmunk bug.
  const input = pcm(...Array.from({ length: 160 }, (_, i) => i * 100));
  const out = resamplePcm16(input, 16000, 24000);
  assert.equal(samples(out).length, 240, "160 samples at 16k must become 240 at 24k");
});

test("resampling is a no-op at the same rate, byte for byte", () => {
  // Nova wants 16k, which is what the client already captures. This must not touch the buffer:
  // interpolating onto the same grid would still round every sample.
  const input = pcm(1, -1, 32767, -32768, 500);
  const out = resamplePcm16(input, 16000, 16000);
  assert.deepEqual(samples(out), samples(input));
  assert.ok(out.equals(input));
});

test("resampling interpolates rather than repeating samples", () => {
  // Nearest-neighbour would emit each source sample twice for a 2x ratio. Interpolation puts a
  // midpoint between them, and the difference is audible graininess that measurably worsens
  // transcription.
  const out = samples(resamplePcm16(pcm(0, 1000), 16000, 32000));
  assert.ok(out.length > 2, "should have upsampled");
  const anyMidpoint = out.some((s) => s > 0 && s < 1000);
  assert.ok(anyMidpoint, `expected an interpolated value between 0 and 1000, got ${out.join(",")}`);
});

test("resampling clamps instead of wrapping at the PCM16 limits", () => {
  // Overshoot from interpolation must clamp. Wrapping turns a loud sample into a loud sample of
  // the OPPOSITE sign, which is a click on every peak.
  const out = samples(resamplePcm16(pcm(32767, 32767, -32768, -32768), 16000, 48000));
  for (const s of out) {
    assert.ok(s >= -32768 && s <= 32767, `sample ${s} is outside PCM16`);
  }
});

test("resampling an empty or sub-sample buffer does not throw", () => {
  // A lane can hand over a zero-length frame on a stopped microphone.
  assert.equal(resamplePcm16(Buffer.alloc(0), 16000, 24000).length, 0);
  assert.equal(resamplePcm16(Buffer.alloc(1), 16000, 24000).length, 1);
});

/** A lane that records what it was told, so ordering can be asserted. */
function fakeLane() {
  const sent: Buffer[] = [];
  const control: unknown[] = [];
  const lane: AudioLane = {
    sendAudio: (_id, bytes) => void sent.push(bytes),
    sendControl: (_id, msg) => void control.push(msg),
  };
  return { lane, sent, control };
}

test("the buffer coalesces until the byte budget, then sends once", () => {
  // One frame per vendor delta floods the client. The budget is the whole point.
  const { lane, sent } = fakeLane();
  const buf = makeAudioBuffer(lane, "c1", 100, 100000);
  buf.add(Buffer.alloc(40));
  buf.add(Buffer.alloc(40));
  assert.equal(sent.length, 0, "under budget, nothing should have gone out");
  buf.add(Buffer.alloc(40));
  assert.equal(sent.length, 1, "crossing the budget sends");
  assert.equal(sent[0].length, 120, "and sends everything held, combined");
});

test("flush sends a partial buffer, so a short utterance is not swallowed", () => {
  const { lane, sent } = fakeLane();
  const buf = makeAudioBuffer(lane, "c1", 100000, 100000);
  buf.add(Buffer.alloc(10));
  buf.flush();
  assert.deepEqual(sent.map((b) => b.length), [10]);
});

test("discard sends NOTHING — this is barge-in, and it is not flush", () => {
  // The single most important assertion in this file. Discarding plays nothing; flushing plays a
  // fragment of the sentence the user already talked over.
  const { lane, sent } = fakeLane();
  const buf = makeAudioBuffer(lane, "c1", 100000, 100000);
  buf.add(Buffer.alloc(500));
  buf.discard();
  assert.equal(sent.length, 0, "discarded audio must never reach the client");
  buf.flush();
  assert.equal(sent.length, 0, "and a later flush must not resurrect it");
});

test("flushing twice does not send the same audio twice", () => {
  // The executor flushes on `done` and again on socket close. Without the buffer clearing
  // itself, the tail of every utterance would play twice.
  const { lane, sent } = fakeLane();
  const buf = makeAudioBuffer(lane, "c1", 100000, 100000);
  buf.add(Buffer.alloc(64));
  buf.flush();
  buf.flush();
  assert.equal(sent.length, 1);
});

test("the timer sends what the byte budget never would", async () => {
  // The tail of a short utterance is under the budget and would otherwise wait for bytes that
  // are never coming.
  const { lane, sent } = fakeLane();
  const buf = makeAudioBuffer(lane, "c1", 100000, 10);
  buf.add(Buffer.alloc(8));
  assert.equal(sent.length, 0);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(sent.length, 1, "the delay should have flushed it");
  assert.equal(sent[0].length, 8);
});

/**
 * THE EXECUTION API MUST CARRY THE AUDIO LANE.
 *
 * A voice node reaches the browser through `executionContext.api.getAudioWebSocketManager()`. That
 * handle was missing from the api the RUNTIME builds per execution, while being present on the api a
 * PLUGIN receives at setup — so a code node found it via plugin-base's singleton and a manifest node
 * got `undefined`.
 *
 * The failure mode is why this is a test rather than a comment: with no lane the duplex session runs
 * a completely healthy conversation that nobody can hear or speak to. Nothing throws, nothing logs,
 * the node reports success, and both directions of audio are silently dropped.
 */
test("the per-execution api exposes the audio lane", () => {
  const ctx: any = buildExecutionContext("SomeVoiceNode", {}, {}, { publishingContext: { conversationId: "c1" } });
  assert.equal(
    typeof ctx.api?.getAudioWebSocketManager,
    "function",
    "executionContext.api has no getAudioWebSocketManager — every duplex voice node will run silently, " +
      "in both directions, with no error anywhere. Add it in platform/executionContext.ts.",
  );
  const lane = ctx.api.getAudioWebSocketManager();
  for (const fn of ["sendAudio", "sendControl", "setAudioDataHandler", "setControlMessageHandler"]) {
    assert.equal(typeof lane?.[fn], "function", `the audio lane is missing ${fn}(), which duplex.ts calls`);
  }
});

/**
 * EVERY FRAME MUST BE SAMPLE-ALIGNED.
 *
 * PCM16 is two bytes per sample and the client decodes a frame with `new Int16Array(buffer)`, which
 * throws on an odd byte length:
 *
 *     RangeError: byte length of Int16Array should be a multiple of 2
 *
 * The vendor's deltas are chunks of a byte stream and do not have to end on a sample boundary, so
 * concatenating them freely produces odd frames. This is a live bug that shipped: the call connected,
 * the model spoke, frames reached the browser, and the browser refused all of them.
 */
test("every emitted frame has an even byte length", () => {
  const { lane, sent } = fakeLane();
  // Odd-length chunks, exactly as the vendor may send them.
  const buf = makeAudioBuffer(lane, "c1", 10, 100000);
  for (const n of [3, 5, 7, 1, 9, 11]) buf.add(Buffer.alloc(n));
  buf.flush();
  assert.ok(sent.length > 0, "nothing was sent at all");
  for (const b of sent) {
    assert.equal(b.length % 2, 0, `sent a ${b.length}-byte frame — the client cannot decode an odd length`);
  }
});

test("the held-back odd byte is carried into the next frame, never dropped", () => {
  // It is half of a real sample. Dropping it would click and shift the phase of everything after.
  const { lane, sent } = fakeLane();
  const buf = makeAudioBuffer(lane, "c1", 4, 100000);
  buf.add(Buffer.alloc(5, 1)); // 5 bytes: 4 sent, 1 held
  buf.add(Buffer.alloc(1, 2)); // its partner arrives
  buf.flush();
  const totalSent = sent.reduce((n, b) => n + b.length, 0);
  assert.equal(totalSent, 6, `all 6 bytes must reach the client, got ${totalSent}`);
});

test("a lone odd byte is never sent on its own", () => {
  const { lane, sent } = fakeLane();
  const buf = makeAudioBuffer(lane, "c1", 100000, 100000);
  buf.add(Buffer.alloc(1));
  buf.flush();
  assert.equal(sent.length, 0, "a single byte is half a sample — it must wait, not ship");
});

/**
 * THE CONTROL VOCABULARY THE CLIENT ACTUALLY CONSUMES.
 *
 * Asserted against what the SDK's voice hook does with each state, not against the retired node's
 * comments — which sent me the wrong way once already. `voice.tsx handleAudioState`:
 *
 *   SPEECH_STARTED       setAssistantHint(true)                  UI only
 *   SPEECH_ENDED         setAssistantHint(false) + markAsLastChunk()
 *   USER_SPEECH_STARTED  setUserSpeaking(true) + playback.stopAll()   <- the barge-in cut
 *   USER_SPEECH_ENDED    setUserSpeaking(false)
 *
 * The microphone is NOT gated on any of them: `capture.setMuted` is called from the mute button and
 * nowhere else. The mic streams continuously and voice-activity detection runs server-side.
 */
test("all four audio states are sent", () => {
  const src = readFileSync(new URL("../src/manifests/runtime/duplex/session.ts", import.meta.url), "utf8");
  for (const state of ["SPEECH_STARTED", "SPEECH_ENDED", "USER_SPEECH_STARTED", "USER_SPEECH_ENDED"]) {
    assert.ok(src.includes(`"${state}"`), `duplex.ts never sends ${state}`);
  }
});

test("barge-in discards the buffer and does NOT send its own state", () => {
  // The cut comes from USER_SPEECH_STARTED, which the VAD forwarding sends on the same event.
  // Sending SPEECH_ENDED here instead let the buffered audio play over the person, because
  // SPEECH_ENDED does not stop playback — it only marks the end of the stream.
  const src = readFileSync(new URL("../src/manifests/runtime/duplex/session.ts", import.meta.url), "utf8");
  const bargeIn = src.slice(src.indexOf("interruptOn && type ==="));
  const body = bargeIn.slice(0, bargeIn.indexOf("voice-activity detection"));
  assert.ok(body.includes("buffer?.discard()"), "barge-in must discard the buffered audio");
  assert.ok(
    !/sendControl\(/.test(body),
    "barge-in must not send its own control state — the VAD path already sends USER_SPEECH_STARTED, " +
      "which is what makes the client stop playback",
  );
  assert.equal(typeof runDuplexSession, "function");
});

/**
 * EVERY ASYNC TEMPLATE CALL IS AWAITED.
 *
 * `evaluate`, `render` and `resolveBody` are async. Forgetting that does not throw and does not log
 * — it silently substitutes a Promise for a value, and I did it TWICE in this file:
 *
 *   the audio path   `String(promise)` is the text "[object Promise]", which base64-decodes to 11
 *                    bytes of garbage. Every frame carried noise instead of speech, so the call
 *                    crackled while every transcript in the log looked perfect.
 *   a send rule's `when`   `!promise` is always false, so the condition never blocked anything and
 *                    every reactive send fired regardless. Firing too often reads as working.
 *
 * Neither is visible in a log, a type error, or a passing lint — which is why it is a test. Returning
 * the promise (`return evaluate(...)`) is fine and common; using its VALUE without awaiting is not.
 */
test("no async template call is used un-awaited", () => {
  const dir = new URL("../src/manifests/runtime/", import.meta.url);
  const offenders: string[] = [];
  const walk = (d: URL) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = new URL(entry.name + (entry.isDirectory() ? "/" : ""), d);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.name.endsWith(".ts")) continue;
      readFileSync(p, "utf8").split("\n").forEach((line, i) => {
        // The value is USED, not returned: assigned, negated, or interpolated.
        const used = /(?:^|[^a-zA-Z._])(?:const|let|var)\s+\w+\s*=\s*(evaluate|resolveBody)\(/.test(line)
          || /!\s*(evaluate|resolveBody)\(/.test(line)
          || /String\(\s*(evaluate|resolveBody)\(/.test(line);
        if (used && !line.includes("await")) {
          offenders.push(`${entry.name}:${i + 1}  ${line.trim().slice(0, 100)}`);
        }
      });
    }
  };
  walk(dir);
  assert.deepEqual(
    offenders,
    [],
    "these use the RESULT of an async template call without awaiting it, so they operate on a Promise:\n  " +
      offenders.join("\n  "),
  );
});

/**
 * WHAT THE CALL COST. A voice call was the one transport that reported no tokens at all.
 *
 * json, sse, chunk, paginate, poll and the tool loop each build a `makeUsageCollector`; the
 * `transport: ws` branch built none, so the execution's Token Usage tab read empty for the most
 * expensive node on the canvas. The retired node did report it (`UsageStatsCollector`,
 * accumulating per `response.done`) and it was lost in the YAML migration.
 *
 * The payloads below are the REAL realtime envelope, captured off a live `response.done`
 * (2026-08-12) rather than guessed. Two details are load-bearing and easy to get wrong:
 *
 *   input_token_details   SINGULAR "token". The Responses API says `input_tokens_details`, and
 *                         reading only that spelling is what made Canvas report zero audio and
 *                         zero reasoning on every voice call while the totals beside them were
 *                         right.
 *   no `model`            realtime omits it from response.done, so the collector's fallback to
 *                         the configured model is the only thing naming the model on the bill.
 *
 * TWO responses, because a call is billed PER RESPONSE. A ten-turn conversation carries ten
 * usage blocks and only the sum is the bill; reporting the last one would under-report a long
 * call by an order of magnitude, which is the bug the retired node's UPDATES.md records fixing
 * ("previously only the final turn's tokens were saved").
 */
test("a voice call reports the summed token bill, with the audio/text split intact", async () => {
  const { makeUsageCollector } = await import("../src/manifests/runtime/usage.js");

  const posted: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    posted.push(JSON.parse(String(init?.body)));
    return { ok: true, json: async () => ({}) } as any;
  }) as any;

  try {
    const ctx: any = {
      config: { model: "gpt-realtime-2.1" },
      scope: { workflowId: "wf-1", executionId: "exec-1", nodeId: "openairealtimevoice1" },
    };
    const usage = makeUsageCollector({ type: "OpenAIRealtimeVoice" } as any, ctx);

    const turn = (inTok: number, outTok: number, inAudio: number, outAudio: number, cached = 0) => ({
      type: "response.done",
      response: {
        usage: {
          total_tokens: inTok + outTok,
          input_tokens: inTok,
          output_tokens: outTok,
          input_token_details: {
            text_tokens: inTok - inAudio,
            audio_tokens: inAudio,
            cached_tokens: cached,
            /**
             * TWO LEVELS DOWN, and the collector summed only one — so this vanished and a
             * cached token could not be priced. Canvas then billed every cached token at the
             * full fresh rate, overcharging a real call by ~45% (found 2026-08-12). Nothing
             * errored: the stored row looked complete because what was missing was never
             * written.
             */
            cached_tokens_details: { text_tokens: cached, audio_tokens: 0, image_tokens: 0 },
          },
          output_token_details: { text_tokens: outTok - outAudio, audio_tokens: outAudio },
        },
      },
    });

    // Frames that carry no usage must not disturb the total — most of a call is these.
    usage.see({ type: "response.output_audio.delta", delta: "…" });
    usage.see(turn(120, 300, 90, 280, 40));
    usage.see({ type: "response.output_audio_transcript.delta", delta: "hello" });
    usage.see(turn(80, 150, 60, 140, 25));
    usage.save();
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(posted.length, 1, "the bill is posted once for the whole call, not once per turn");
    const body = posted[0];
    assert.equal(body.nodeType, "OpenAIRealtimeVoice");
    assert.equal(body.model, "gpt-realtime-2.1", "a call with no per-response model falls back to the configured one");
    assert.equal(body.usage.input_tokens, 200, "both responses must be summed, not just the last");
    assert.equal(body.usage.output_tokens, 450);
    assert.equal(body.usage.total_tokens, 650);
    // THE SPLIT IS THE POINT. Realtime bills audio and text at different rates, so a total
    // with no split cannot be priced at all.
    assert.equal(body.usage.input_token_details.audio_tokens, 150);
    assert.equal(body.usage.output_token_details.audio_tokens, 420);
    assert.equal(body.usage.output_token_details.text_tokens, 30);
    // THE SECOND LEVEL. Without recursion this key is absent entirely and the assertion below
    // reads `undefined` — which is exactly how the live overcharge went unnoticed.
    assert.equal(
      body.usage.input_token_details.cached_tokens_details?.text_tokens,
      65,
      "cached_tokens_details was dropped — cached tokens cannot be priced without it",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

/**
 * The collector has to be WIRED, not merely written. Source-level, like the audio-state guards
 * above, because there is no socket harness here to drive a real session.
 */
test("the duplex transport builds a usage collector and saves it", () => {
  const src = readFileSync(new URL("../src/manifests/runtime/channels/final.ts", import.meta.url), "utf8");
  const ws = src.slice(src.indexOf('call.transport === "ws"'), src.indexOf("const res = await sendRequest"));
  assert.match(ws, /makeUsageCollector\(node, ctx\)/, "the ws branch reports no tokens — a voice call would cost nothing on the Token Usage tab");
  assert.match(ws, /usage\.save\(\)/, "usage is collected and never saved");
  assert.ok(
    ws.indexOf("usage.save()") < ws.indexOf('throw new Error(`${node.type}: duplex session failed'),
    "usage must be saved BEFORE the error throw, or a call that ended badly reports nothing",
  );
});

/**
 * A DISCOVERED TOOL REACHES A LIVE CALL. The tool list is discovered, not declared: a spatial
 * search returns rows pointing at apps, each becoming a tool the model may call, so whatever the
 * handshake carried is only the seed.
 *
 * The socket used to DROP everything `absorb()` minted, with a log line asserting that "a duplex
 * session's tool list is fixed at open". That was never true of the vendor, only of this code —
 * a `session.update` sent mid-call is accepted, merges rather than replaces, and the new tool is
 * callable on the next turn (verified against the live API, 2026-08-12). The symptom was a caller
 * watching an app's page open on screen while the assistant could not operate it.
 *
 * Source-level, like the audio-state guards above, because there is no socket harness here.
 */
test("a tool discovered mid-call is re-offered, not dropped", () => {
  const src = readFileSync(new URL("../src/manifests/runtime/duplex/session.ts", import.meta.url), "utf8");

  assert.ok(
    !/discovered mid-call and not registered — a duplex session's tool list is fixed at open/.test(src),
    "the drop is back: minted tools are being discarded on the claim that a session's tool list cannot change. It can.",
  );
  assert.match(src, /live\.push\(await evaluate\(exchange\.tool/, "minted tools must join the live list");
  assert.match(src, /exchange\.offer/, "the grown list must be re-offered through the manifest's `offer` message");

  // NOT gated on an idle conversation. `session.update` is accepted mid-response; it is
  // `response.create` that is refused with conversation_already_has_active_response. Waiting for
  // a gap in the talking would delay every discovered tool for no reason.
  const block = src.slice(src.indexOf("absorbed.minted.length"), src.indexOf("output = absorbed.content"));
  assert.ok(!/speaking|await new Promise|setTimeout/.test(block), "re-offering must not wait for a quiet moment");
});

/**
 * The message itself belongs to the NODE, because it is the vendor's wire format — the same split
 * `result` follows. This checks the one package that has a duplex protocol actually declares it,
 * so the runtime's `offer` branch is reachable rather than dead code.
 */
test("the realtime package declares how to re-offer its tools", async () => {
  const { load } = await import("js-yaml");
  const shared = load(
    readFileSync(new URL("../../../apps/unoverse/nodes/openai/shared/realtimeTools.yaml", import.meta.url), "utf8"),
  ) as any;

  assert.ok(shared.offer, "the realtime protocol declares no `offer` — every mid-call discovery is dropped");
  assert.match(String(shared.offer), /session\.update/, "the vendor's re-offer message is session.update");
  assert.match(String(shared.offer), /tools: tools/, "it must carry the live list");
  // MERGE, NOT REPLACE. Naming only `tools` leaves instructions, voice, modalities and turn
  // detection as the handshake set them. Re-sending the whole session block invites two copies
  // of that config to drift.
  assert.ok(
    !/instructions|output_modalities|voice|turn_detection/.test(String(shared.offer)),
    "the re-offer must name ONLY tools — session.update merges, so anything else is a second copy of the handshake",
  );
});

/**
 * THE ACCUMULATOR RESETS AT THE END OF A TURN. Without this, a socket's transcript is unusable.
 *
 * `accumulate` runs for the length of a RUN, which is right for HTTP (a run is one answer) and
 * wrong for a socket (a run is a whole conversation). A live BPP call showed it plainly: five
 * turns in, every emission still read "Hello, you're speaking with the BPP virtual assistant…"
 * and the settled `text` was the entire call concatenated (2026-08-12).
 *
 * Driven through the REAL emitter with the REAL manifest row, rather than asserting on source,
 * because the bug was in what the emitter accumulates and only running it proves that.
 */
test("a duplex transcript starts each turn empty", async () => {
  const { makeEmitter } = await import("../src/manifests/runtime/events.js");
  const { load } = await import("js-yaml");

  const rows = load(
    readFileSync(
      new URL("../../../apps/unoverse/nodes/openai/nodes/OpenAIRealtimeVoice/api/events.yaml", import.meta.url),
      "utf8",
    ),
  ) as any[];
  const transcript = rows.filter((r) => r.emit === "assistantTranscript");
  assert.equal(transcript.length, 1);
  assert.ok(transcript[0].resetOn, "the transcript row declares no resetOn — it will accumulate across the whole call");

  const got: any[] = [];
  // The REAL emitter over the REAL row, so this exercises accumulation rather than describing it.
  const emitter = makeEmitter({ api: { events: transcript } } as any, (e: any) => got.push(e.value));
  const delta = (d: string) => emitter.response({ type: "response.output_audio_transcript.delta", delta: d }, "response.output_audio_transcript.delta");
  const endTurn = () => emitter.response({ type: "response.done" }, "response.done");

  // Turn one. throttleMs holds all but the first, so the rest arrive on the turn-end flush.
  await delta("Hello");
  await delta(", you're speaking with BPP.");
  await endTurn();
  assert.equal(got.at(-1), "Hello, you're speaking with BPP.", "the turn's closing words must be flushed, not dropped");

  // Turn two must NOT carry turn one.
  await delta("We have");
  await delta(" three ACCA courses.");
  await endTurn();
  assert.equal(got.at(-1), "We have three ACCA courses.", "turn two is carrying turn one — the accumulator never reset");
  assert.ok(
    !String(got.at(-1)).includes("Hello"),
    "the greeting leaked into a later turn, which is exactly the live failure this guards",
  );
});

/**
 * A LIVE CALL TELLS THE PERSON IT IS LOOKING SOMETHING UP.
 *
 * A spatial search on a call has been measured at 8 to 9 seconds. For all of it the assistant is
 * silent, and on a phone-shaped interface silence reads as a dropped line, not as thinking.
 *
 * Every other piece of this existed for months: the client flips `isLookingUp` on TOOL_USE
 * (`web/sdk/src/lib/voice.tsx`), `lookup-indicator.yaml` in all three voice templates draws dots
 * and a caption off that flag, and VOICE_STREAMING_GUIDE.md lists TOOL_USE as server-to-client
 * and calls it implemented. Nothing in the repository ever sent one (found 2026-08-12).
 */
test("a duplex call signals TOOL_USE while a tool runs, and always clears it", () => {
  const src = readFileSync(new URL("../src/manifests/runtime/duplex/session.ts", import.meta.url), "utf8");

  assert.match(src, /state: "TOOL_USE"/, "nothing tells the client a lookup started — the caller gets dead air");
  assert.match(src, /state: "TOOL_USE_COMPLETED"/, "nothing clears the indicator");

  // The clear must sit AFTER the catch. Inside the try it only runs on success, and a failed
  // lookup leaves the dots spinning for the rest of the call — worse than no indicator, because
  // it promises something still coming.
  const branch = src.slice(src.indexOf('state: "TOOL_USE"'), src.indexOf("await emitter.tool("));
  const catchAt = branch.indexOf("} catch (err: any)");
  const clearAt = branch.indexOf('state: "TOOL_USE_COMPLETED"');
  assert.ok(catchAt !== -1 && clearAt > catchAt, "TOOL_USE_COMPLETED must be after the catch, or a failed tool spins forever");
});

/**
 * A VOICE CALL'S TOOLS APPEAR ON THE EXECUTION TIMELINE, like every other agent's.
 *
 * They did not: the node rendered as one 125-second block with nothing inside it, so a
 * nine-second spatial search was invisible and unattributable. `runToolLoop` has recorded these
 * since the migration and `manifest-tool-trace.test.ts` guards that it keeps doing so; the socket
 * simply never called the same function.
 *
 * SHARED, not copied. Two implementations of "what a tool call looks like on a timeline" drift
 * the first time either is touched, which is how the socket came to differ from the loop in four
 * separate ways in one day.
 */
test("a duplex call records an MCP trace per tool, using the loop's own recorder", () => {
  const src = readFileSync(new URL("../src/manifests/runtime/duplex/session.ts", import.meta.url), "utf8");
  const loop = readFileSync(new URL("../src/manifests/runtime/tools/toolloop.ts", import.meta.url), "utf8");

  assert.match(loop, /export function recordToolTrace/, "the recorder is private again — the socket cannot share it");
  assert.match(src, /recordToolTrace\(/, "the duplex session records no MCP trace — voice tools vanish from the timeline");
  assert.ok(
    !/saveMCPTraceToWorkflow/.test(src),
    "the socket is posting its own trace instead of using the shared recorder — two copies that will drift",
  );
  // A failed tool is the one most worth seeing, so success must be passed through rather than
  // hardcoded true.
  assert.match(src, /recordToolTrace\([^;]*toolOk\)/, "the trace hardcodes success — a failed tool is the one most worth seeing");
});
