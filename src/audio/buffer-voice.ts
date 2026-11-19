import { createFader } from './fader';
import { indexMp3, type Mp3Index } from './mp3-index';
import type { Voice } from './voice';

/**
 * A Voice that decodes the mp3 itself, a few seconds at a time, and plays the
 * pieces back to back with AudioBufferSourceNodes on the audio clock.
 *
 * Why: the <audio> element failed the seek-accuracy gate (docs/audio-gate-results.md).
 * Memory stays low: an idle track holds only ARM_SEC decoded at its start point;
 * the playing track holds at most about LOOKAHEAD_SEC + CHUNK_SEC more. The compressed
 * file stays in a Blob and is sliced per piece.
 */

export const ARM_SEC = 3; // decoded and held at the start point, so Play needs no decoding
export const CHUNK_SEC = 10; // length of each later piece
export const LOOKAHEAD_SEC = 12; // keep at least this much scheduled ahead of the playhead
// Refill runs on this timer and also on every piece's 'ended' event, which comes from the
// audio thread and keeps coming when timers are throttled (hidden tab, locked screen).
const PUMP_MS = 250;
// The first piece is scheduled ahead so it is never already late when the audio thread sees
// it (Firefox's currentTime trails the render position by 256 frames; phones render further
// ahead). A late first piece would sound late, and the next piece, on time, would overlap it.
// The lead is the larger of 15 ms and the context's base latency plus one render quantum.
const MIN_START_LEAD_SEC = 0.015;
export function startLeadSec(ctx: Pick<BaseAudioContext, 'sampleRate'> & { baseLatency?: number }): number {
  const quantum = ctx.sampleRate > 0 ? 128 / ctx.sampleRate : 0;
  return Math.max(MIN_START_LEAD_SEC, (ctx.baseLatency ?? 0) + quantum);
}
const SAME_POSITION_SEC = 0.001;
// Whole frames decoded before a piece and thrown away, so the decoder's bit reservoir and
// overlap are primed (MPEG-1 reservoir reaches back at most 511 bytes; 12 frames always cover it).
const PREROLL_FRAMES = 12;
const TAIL_FRAMES = 4;
// The standard mpeg decoder delay. Added to the encoder delay to map track time onto
// decoded samples. With no LAME tag, LAME's usual encoder delay (576) is assumed.
const DECODER_DELAY = 529;
const DEFAULT_ENCODER_DELAY = 576;

interface Piece {
  buffer: AudioBuffer;
  startSec: number; // track time of the buffer's first sample
}

export interface BufferVoiceOptions {
  armSec?: number;
  chunkSec?: number;
  lookaheadSec?: number;
}

export async function createBufferVoice(
  ctx: AudioContext,
  src: string,
  destination: AudioNode = ctx.destination,
  options: BufferVoiceOptions = {},
): Promise<Voice> {
  let blob: Blob;
  let index: Mp3Index;
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    blob = await res.blob();
    index = indexMp3(new Uint8Array(await blob.arrayBuffer()));
  } catch (err) {
    throw new Error(`Could not load audio: ${src} (${String(err)})`);
  }
  return buildBufferVoice(ctx, blob, index, destination, options);
}

export function buildBufferVoice(
  ctx: AudioContext,
  blob: Blob,
  index: Mp3Index,
  destination: AudioNode,
  { armSec = ARM_SEC, chunkSec = CHUNK_SEC, lookaheadSec = LOOKAHEAD_SEC }: BufferVoiceOptions = {},
): Voice {
  const { sampleRate: rate, samplesPerFrame: spf, frameOffsets } = index;
  const frames = frameOffsets.length;
  const duration = index.durationSec;
  const delay = (index.encoderDelay ?? DEFAULT_ENCODER_DELAY) + DECODER_DELAY;
  const lead = startLeadSec(ctx);

  const gainNode = ctx.createGain();
  gainNode.connect(destination);
  const fader = createFader(ctx, gainNode.gain);

  /** Decode track time [fromSec, toSec) plus pre-roll and tail, cut on frame boundaries. */
  async function decode(fromSec: number, toSec: number): Promise<Piece> {
    const f0 = Math.max(0, Math.floor((fromSec * rate + delay) / spf) - PREROLL_FRAMES);
    const f1 = Math.min(frames, Math.ceil((toSec * rate + delay) / spf) + TAIL_FRAMES);
    const end = f1 < frames ? frameOffsets[f1] : index.dataEnd;
    const bytes = await blob.slice(frameOffsets[f0], end).arrayBuffer();
    const buffer = await ctx.decodeAudioData(bytes);
    return { buffer, startSec: (f0 * spf - delay) / rate };
  }

  // Armed window: decoded at the start point ahead of Play.
  let armed: { startSec: number; promise: Promise<Piece>; piece: Piece | null } | null = null;

  function prepare(startSec: number) {
    if (armed && Math.abs(armed.startSec - startSec) < SAME_POSITION_SEC) return armed;
    const entry = { startSec, promise: decode(startSec, startSec + armSec), piece: null as Piece | null };
    entry.promise.then(
      (p) => (entry.piece = p),
      (err: unknown) => {
        console.error('Audio decode failed', err);
        if (armed === entry) armed = null; // let the next arm try again
      },
    );
    armed = entry;
    return entry;
  }

  // Playback state. gen invalidates async work from an earlier start/halt/arm.
  let gen = 0;
  let playing = false;
  let restSec = 0; // position while not playing
  let fromSec = 0;
  let t0: number | null = null; // ctx time at which track time fromSec sounds
  let scheduledUntil = 0;
  let decoding = false;
  let pumpTimer: ReturnType<typeof setInterval> | null = null;
  let sources: AudioBufferSourceNode[] = [];
  const endedCallbacks: Array<() => void> = [];

  function silence(): void {
    gen++;
    playing = false;
    decoding = false;
    t0 = null;
    if (pumpTimer !== null) clearInterval(pumpTimer);
    pumpTimer = null;
    for (const s of sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* never started */
      }
      s.disconnect();
    }
    sources = [];
  }

  function finish(myGen: number): void {
    if (myGen !== gen || !playing) return;
    silence();
    restSec = duration;
    for (const cb of endedCallbacks) cb();
  }

  /** Play track time [a, b) from piece p at its place on the clock. */
  function schedule(p: Piece, a: number, b: number, myGen: number): void {
    if (t0 === null) return;
    const now = ctx.currentTime;
    let when = t0 + (a - fromSec);
    let offset = a - p.startSec;
    if (when < now) {
      // late (decoding fell behind): skip what should already have sounded, stay in time
      offset += now - when;
      when = now;
    }
    const length = b - a - (offset - (a - p.startSec));
    if (length <= 0) {
      if (b >= duration) finish(myGen); // the end was due already
      return;
    }
    const s = ctx.createBufferSource();
    s.buffer = p.buffer;
    s.connect(gainNode);
    s.start(when, offset, length);
    sources.push(s);
    const last = b >= duration;
    s.onended = () => {
      sources = sources.filter((x) => x !== s);
      s.disconnect();
      if (last) finish(myGen);
      else pump();
    };
  }

  function pump(): void {
    if (!playing || decoding || t0 === null || scheduledUntil >= duration) return;
    const pos = position();
    if (scheduledUntil < pos) {
      // Refill stalled and the scheduled audio ran out. Do not decode what is already late:
      // carry on from the playhead (or end, if the track's time is up).
      if (pos >= duration) return finish(gen);
      scheduledUntil = pos;
    }
    if (scheduledUntil - pos >= lookaheadSec) return;
    const myGen = gen;
    const a = scheduledUntil;
    const b = Math.min(duration, a + chunkSec);
    decoding = true;
    decode(a, b).then(
      (p) => {
        if (myGen !== gen) return;
        decoding = false;
        schedule(p, a, b, myGen);
        scheduledUntil = b;
        pump();
      },
      (err: unknown) => {
        if (myGen !== gen) return;
        console.error('Audio decode failed', err);
        // play out what is scheduled, then end
        decoding = false;
        scheduledUntil = duration;
        const tail = sources[sources.length - 1];
        if (tail) tail.onended = () => finish(myGen);
        else finish(myGen);
      },
    );
  }

  function begin(p: Piece, myGen: number): void {
    if (myGen !== gen) return;
    if (fromSec >= duration) return finish(myGen);
    t0 = ctx.currentTime + lead;
    const b = Math.min(duration, fromSec + armSec);
    schedule(p, fromSec, b, myGen);
    scheduledUntil = b;
    pumpTimer = setInterval(pump, PUMP_MS);
    pump();
  }

  function position(): number {
    if (!playing) return restSec;
    if (t0 === null) return fromSec;
    return Math.min(duration, fromSec + Math.max(0, ctx.currentTime - t0));
  }

  return {
    durationSec: duration,
    arm(startSec) {
      silence();
      restSec = startSec;
      fader.set(1);
      prepare(startSec);
    },
    start(from) {
      silence();
      fader.set(1);
      playing = true;
      fromSec = from;
      const myGen = gen;
      const w =
        armed && Math.abs(armed.startSec - from) < SAME_POSITION_SEC
          ? armed
          : { promise: decode(from, from + armSec), piece: null };
      if (w.piece) {
        begin(w.piece, myGen); // the usual case: armed and decoded, starts this tick
      } else {
        w.promise.then(
          (p) => begin(p, myGen),
          () => finish(myGen),
        );
      }
    },
    halt() {
      restSec = position();
      silence();
      fader.set(0);
    },
    fadeOut(seconds) {
      fader.fadeOut(seconds);
    },
    cancelFade() {
      fader.set(1);
    },
    positionSec() {
      return position();
    },
    onEnded(cb) {
      endedCallbacks.push(cb);
    },
    dispose() {
      silence();
      gainNode.disconnect();
      armed = null;
      endedCallbacks.length = 0;
    },
  };
}
