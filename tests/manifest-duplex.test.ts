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
