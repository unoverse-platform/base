/**
 * THE AUDIO LANE — the platform's socket to the browser, and everything about bytes.
 *
 * Split from `duplex.ts` because there are TWO SOCKETS in a voice call and conflating them is the
 * mistake this whole area invites:
 *
 *   duplex.ts      the VENDOR socket. The conversation with OpenAI or xAI: handshake, inbound
 *                  event routing, tool calls, teardown. Described by `api/run.yaml`.
 *   this file      the AUDIO LANE. The platform's own socket to the browser, bound by
 *                  `api/audio.yaml`, and it exists for ONE reason: MCP cannot carry binary audio.
 *
 * Everything here is COMPUTATION OVER BYTES OR TIME, which is why it is executor code rather than
 * anything a manifest could say: resampling is interpolation across samples, coalescing is a byte
 * budget and a timer, barge-in is discarding a buffer rather than flushing it. All identical for
 * every vendor, which is the test for belonging here (DECLARATIVE_NODES.md §2).
 *
 * These are also the parts that FAIL SILENTLY, so they are unit-tested in
 * `tests/manifest-duplex.test.ts`: a wrong resample rate is not an error anywhere, the vendor just
 * transcribes at the wrong speed and it reads as poor accuracy.
 */
/**
 * The platform's audio lane, INJECTED so this file touches no platform global — the same
 * arrangement `state.ts` uses for Redis. `null` when the platform has no lane, which is not an
 * error: a voice node with nowhere to send audio still holds a valid conversation, and the
 * transcripts still reach the workflow.
 */
export interface AudioLane {
  sendAudio(conversationId: string, bytes: Buffer): void;
  sendControl(conversationId: string, message: unknown): void;
  setAudioDataHandler?(fn: (sessionId: string, data: ArrayBuffer) => void | Promise<void>): void;
  setControlMessageHandler?(fn: (sessionId: string, message: any) => void | Promise<void>): void;
  startAudioSession?(sessionId: string, conversationId: string): void;
}


/** Bytes per sample. PCM16 throughout, which is what every vendor here speaks. */
const BYTES_PER_SAMPLE = 2;
const DEFAULT_COALESCE_BYTES = 32768;
const DEFAULT_COALESCE_MS = 50;
/** What the browser captures at. Not configurable, because the capture side is ours. */
export const CLIENT_RATE = 16000;

/**
 * Resample PCM16 by linear interpolation.
 *
 * Interpolating rather than dropping or repeating samples: nearest-neighbour at these ratios
 * is audibly grainy, and speech recognition is measurably worse on it. Transcribed from the
 * retired node unchanged, because it was already correct and a rewrite here would be a
 * behaviour change disguised as a refactor.
 */
export function resamplePcm16(input: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return input;
  const srcSamples = Math.floor(input.length / BYTES_PER_SAMPLE);
  if (srcSamples === 0) return input;

  const dstSamples = Math.round((srcSamples * toRate) / fromRate);
  const output = Buffer.alloc(dstSamples * BYTES_PER_SAMPLE);
  const ratio = srcSamples / dstSamples;

  for (let i = 0; i < dstSamples; i++) {
    const srcPos = i * ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;
    const s0 = input.readInt16LE(srcIndex * BYTES_PER_SAMPLE);
    const s1 = srcIndex + 1 < srcSamples ? input.readInt16LE((srcIndex + 1) * BYTES_PER_SAMPLE) : s0;
    const sample = Math.round(s0 + frac * (s1 - s0));
    output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * BYTES_PER_SAMPLE);
  }
  return output;
}

/**
 * Coalesce vendor audio deltas into fewer, larger frames.
 *
 * `discard` is not `flush` and the difference is the whole point: on barge-in the buffered
 * audio must be thrown away, because the user is already talking over the sentence it belongs
 * to. Transcribed from the retired WebSocketAudioPublisher.
 */
export function makeAudioBuffer(
  lane: AudioLane,
  conversationId: string,
  targetBytes = DEFAULT_COALESCE_BYTES,
  maxDelayMs = DEFAULT_COALESCE_MS,
) {
  let chunks: Buffer[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  /**
   * SAMPLE-ALIGNED, and it must be. PCM16 is TWO BYTES PER SAMPLE, and the client decodes a frame
   * with `new Int16Array(buffer)`, which throws outright on an odd byte length:
   *
   *     RangeError: byte length of Int16Array should be a multiple of 2
   *
   * The vendor's audio deltas are chunks of a byte stream and are NOT guaranteed to end on a sample
   * boundary, so concatenating them freely produces odd-length frames. Any trailing odd byte is
   * therefore held back and becomes the first byte of the next frame — which is also the only
   * correct thing to do with it, since it is half of a real sample whose other half has not arrived.
   * Dropping it instead would inject a click and shift the phase of everything after it.
   */
  const flush = () => {
    clear();
    if (!chunks.length) return;
    const combined = Buffer.concat(chunks);

    /**
     * SEND A WHOLE BUFFER, NEVER A VIEW. This is what the retired node did and the drift from it
     * was audible: nothing but a light crackle.
     *
     * `Buffer.concat` can return a POOLED buffer, and `subarray` returns a view whose byteLength is
     * smaller than the ArrayBuffer behind it. A transport that takes the underlying ArrayBuffer
     * rather than honouring the view's offset and length then puts whatever surrounds the audio on
     * the wire, and the client decodes that as sound. The retired publisher passed
     * `Buffer.concat(chunks)` straight through, so it never had a view to mishandle.
     *
     * The even case is therefore byte-for-byte what the legacy sent. Only an odd trailing byte
     * needs slicing, and that path COPIES so the frame is still a standalone, exactly-sized buffer.
     */
    if (combined.length % 2 === 0) {
      chunks = [];
      total = 0;
      lane.sendAudio(conversationId, combined);
      return;
    }

    /**
     * An odd length means the vendor's delta boundary split a sample. PCM16 is two bytes per sample
     * and the client decodes with `new Int16Array(buffer)`, which throws on an odd length, so the
     * trailing byte is held back to become the first byte of the next frame — it is half of a real
     * sample whose other half has not arrived. Dropping it would click and shift the phase of
     * everything after it.
     */
    const aligned = combined.length - 1;
    if (aligned === 0) {
      chunks = [combined];
      total = combined.length;
      return;
    }
    chunks = [Buffer.from(combined.subarray(aligned))];
    total = 1;
    lane.sendAudio(conversationId, Buffer.from(combined.subarray(0, aligned)));
  };

  return {
    add(chunk: Buffer) {
      chunks.push(chunk);
      total += chunk.length;
      clear();
      if (total >= targetBytes) flush();
      else timer = setTimeout(flush, maxDelayMs);
    },
    flush,
    /** Barge-in. Drop everything held, send nothing. */
    discard() {
      clear();
      chunks = [];
      total = 0;
    },
  };
}
