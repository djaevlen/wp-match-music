import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBufferVoice, startLeadSec } from './buffer-voice';
import type { Mp3Index } from './mp3-index';

// Synthetic file: 44.1 kHz, 1152-sample frames of 100 bytes, LAME delay 576.
const RATE = 44100;
const SPF = 1152;
const FRAMES = 2000; // ~52 s
const DELAY = 576 + 529; // encoder + decoder delay, as the voice maps it
const BYTES = 100;

const index: Mp3Index = {
  sampleRate: RATE,
  channels: 2,
  samplesPerFrame: SPF,
  frameOffsets: Uint32Array.from({ length: FRAMES }, (_, i) => i * BYTES),
  dataEnd: FRAMES * BYTES,
  encoderDelay: 576,
  encoderPadding: 0,
  durationSec: (FRAMES * SPF - 576) / RATE,
};

/** Track time of the first sample of a slice that starts at frame f. */
const frameTime = (f: number) => (f * SPF - DELAY) / RATE;
const firstFrame = (sec: number) => Math.max(0, Math.floor((sec * RATE + DELAY) / SPF) - 12);

class FakeParam {
  value = 1;
  calls: Array<[string, ...number[]]> = [];
  cancelScheduledValues(t: number) {
    this.calls.push(['cancel', t]);
  }
  setValueAtTime(v: number, t: number) {
    this.calls.push(['set', v, t]);
    this.value = v;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.calls.push(['ramp', v, t]);
  }
}

class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started: [number, number, number] | null = null;
  stopped = false;
  connect = vi.fn();
  disconnect = vi.fn();
  start(when: number, offset: number, duration: number) {
    this.started = [when, offset, duration];
  }
  stop() {
    this.stopped = true;
  }
}

function setup(ctxExtras: Record<string, number> = {}) {
  const sources: FakeSource[] = [];
  const decodes: Array<{ bytes: number; resolve: () => void }> = [];
  let auto = true;
  const gainNode = { gain: new FakeParam(), connect: vi.fn(), disconnect: vi.fn() };
  let failNext = false;
  const ctx = {
    currentTime: 100,
    ...ctxExtras,
    createGain: () => gainNode,
    createBufferSource: () => {
      const s = new FakeSource();
      sources.push(s);
      return s;
    },
    decodeAudioData: (buf: ArrayBuffer) =>
      new Promise((resolve, reject) => {
        if (failNext) {
          failNext = false;
          return reject(new Error('decode failed'));
        }
        const entry = { bytes: buf.byteLength, resolve: () => resolve({ bytes: buf.byteLength }) };
        decodes.push(entry);
        if (auto) entry.resolve();
      }),
  };
  const voice = buildBufferVoice(
    ctx as unknown as AudioContext,
    new Blob([new Uint8Array(FRAMES * BYTES)]),
    index,
    {} as AudioNode,
    { armSec: 3, chunkSec: 10, lookaheadSec: 12 },
  );
  return {
    ctx,
    voice,
    sources,
    decodes,
    gain: gainNode.gain,
    manual() {
      auto = false;
    },
    failNextDecode() {
      failNext = true;
    },
    live: () => sources.filter((s) => s.started && !s.stopped),
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('buffer voice', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('arm decodes whole frames around the start point, with pre-roll and tail', async () => {
    const t = setup();
    t.voice.arm(10);
    await flush();
    expect(t.decodes).toHaveLength(1);
    const f0 = firstFrame(10);
    const f1 = Math.ceil((13 * RATE + DELAY) / SPF) + 4;
    expect(t.decodes[0].bytes).toBe((f1 - f0) * BYTES);
    expect(t.voice.positionSec()).toBe(10);
  });

  it('start on the armed point starts in the same tick, 15 ms ahead, at the exact offset', async () => {
    const t = setup();
    t.voice.arm(10);
    await flush();
    t.voice.start(10);
    const first = t.sources[0];
    expect(first.started).not.toBeNull();
    const [when, offset, duration] = first.started!;
    expect(when).toBeCloseTo(100.015, 9);
    expect(offset).toBeCloseTo(10 - frameTime(firstFrame(10)), 9);
    expect(duration).toBeCloseTo(3, 9);
    expect(t.gain.value).toBe(1);
  });

  it('schedules the next piece back to back on the audio clock', async () => {
    const t = setup();
    t.voice.arm(10);
    await flush();
    t.voice.start(10);
    await flush();
    expect(t.sources).toHaveLength(2);
    const [when, offset, duration] = t.sources[1].started!;
    expect(when).toBeCloseTo(100.015 + 3, 9);
    expect(offset).toBeCloseTo(13 - frameTime(firstFrame(13)), 9);
    expect(duration).toBeCloseTo(10, 9);
  });

  it('keeps decoding ahead as the playhead moves', async () => {
    const t = setup();
    t.voice.arm(0);
    await flush();
    t.voice.start(0);
    await flush();
    expect(t.sources).toHaveLength(2); // 0-3, 3-13
    t.ctx.currentTime = 100.015 + 2;
    vi.advanceTimersByTime(250);
    await flush();
    expect(t.sources).toHaveLength(3); // 13-23
    expect(t.sources[2].started![0]).toBeCloseTo(100.015 + 13, 9);
  });

  it('reports the playing position from the audio clock and holds it on halt', async () => {
    const t = setup();
    t.voice.arm(10);
    await flush();
    t.voice.start(10);
    t.ctx.currentTime = 100.015 + 1.25;
    expect(t.voice.positionSec()).toBeCloseTo(11.25, 9);
    t.voice.halt();
    t.ctx.currentTime += 5;
    expect(t.voice.positionSec()).toBeCloseTo(11.25, 9);
    expect(t.live()).toHaveLength(0);
    expect(t.gain.value).toBe(0);
  });

  it('halt makes a decode that finishes later schedule nothing', async () => {
    const t = setup();
    t.voice.arm(10);
    await flush();
    t.manual();
    t.voice.start(10);
    await flush();
    expect(t.decodes).toHaveLength(2); // the 13-23 piece is in flight
    t.voice.halt();
    t.decodes[1].resolve();
    await flush();
    expect(t.sources).toHaveLength(1);
    expect(t.live()).toHaveLength(0);
  });

  it('start at a point that is not armed decodes first, then starts', async () => {
    const t = setup();
    t.voice.arm(10);
    await flush();
    t.manual();
    t.voice.start(0);
    await flush();
    expect(t.sources).toHaveLength(0);
    t.decodes[1].resolve();
    await flush();
    expect(t.sources[0].started![1]).toBeCloseTo(0 - frameTime(0), 9);
  });

  it('rapid starts leave only the latest playback sounding', async () => {
    const t = setup();
    t.voice.arm(10);
    await flush();
    t.voice.start(10);
    t.voice.start(10);
    t.voice.start(10);
    await flush();
    expect(t.live().length).toBe(2); // the latest start's first piece and its follow-on
    expect(t.live().every((s) => s === t.sources.at(-1) || s === t.sources.at(-2))).toBe(true);
  });

  it('fires ended when the last piece finishes, not after a halt', async () => {
    const t = setup();
    const ended = vi.fn();
    t.voice.onEnded(ended);
    const nearEnd = Math.floor((index.durationSec - 2) * 10) / 10;
    t.voice.arm(nearEnd);
    await flush();
    t.voice.start(nearEnd);
    const last = t.sources[0];
    expect(last.started![2]).toBeCloseTo(index.durationSec - nearEnd, 9);
    last.onended!();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(t.voice.positionSec()).toBeCloseTo(index.durationSec, 9);

    t.voice.arm(nearEnd);
    t.voice.start(nearEnd);
    const again = t.sources[1];
    t.voice.halt();
    again.onended?.();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('ends when the final piece arrives after its end time has passed', async () => {
    const t = setup();
    const ended = vi.fn();
    t.voice.onEnded(ended);
    const from = Math.floor((index.durationSec - 8) * 10) / 10; // 3 s window, then a 5 s last piece
    t.voice.arm(from);
    await flush();
    t.manual();
    t.voice.start(from);
    await flush();
    t.ctx.currentTime += 20; // decoding stalled past the end of the track
    t.decodes.at(-1)!.resolve();
    await flush();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('retries the armed window after a failed decode', async () => {
    const t = setup();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    t.failNextDecode();
    t.voice.arm(10);
    await flush();
    expect(err).toHaveBeenCalledTimes(1);
    t.voice.arm(10);
    await flush();
    t.voice.start(10);
    expect(t.sources[0]?.started).not.toBeNull();
    err.mockRestore();
  });

  it('derives the start lead from the context: at least 15 ms, else base latency + one quantum', async () => {
    expect(startLeadSec({ sampleRate: 48000, baseLatency: 0 })).toBe(0.015);
    expect(startLeadSec({ sampleRate: 44100 })).toBe(0.015);
    expect(startLeadSec({ sampleRate: 48000, baseLatency: 0.03 })).toBeCloseTo(0.03 + 128 / 48000, 12);

    const t = setup({ sampleRate: 48000, baseLatency: 0.03 });
    t.voice.arm(10);
    await flush();
    t.voice.start(10);
    expect(t.sources[0].started![0]).toBeCloseTo(100 + 0.03 + 128 / 48000, 9);
  });

  it('refills from the pieces\' ended events when timers never fire', async () => {
    const t = setup();
    t.voice.arm(0);
    await flush();
    t.voice.start(0);
    await flush();
    expect(t.sources).toHaveLength(2); // 0-3, 3-13; the refill interval is never advanced
    t.ctx.currentTime = 100.015 + 3;
    t.sources[0].onended!();
    await flush();
    expect(t.sources).toHaveLength(3);
    expect(t.sources[2].started![0]).toBeCloseTo(100.015 + 13, 9);
  });

  it('after a refill stall, carries on from the playhead instead of decoding late audio', async () => {
    const t = setup();
    t.voice.arm(0);
    await flush();
    t.voice.start(0);
    await flush();
    expect(t.decodes).toHaveLength(2); // window 0-3, piece 3-13
    t.ctx.currentTime = 100.015 + 30; // nothing ran for 27 s; 13-30 has been silent
    t.sources[1].onended!();
    await flush();
    const f0 = firstFrame(30);
    const f1 = Math.ceil((40 * RATE + DELAY) / SPF) + 4;
    expect(t.decodes[2].bytes).toBe((f1 - f0) * BYTES); // 30-40, not 13-23
    const [when, offset, duration] = t.sources[2].started!;
    expect(when).toBeCloseTo(100.015 + 30, 9);
    expect(offset).toBeCloseTo(30 - frameTime(f0), 9);
    expect(duration).toBeCloseTo(10, 9);
  });

  it('ends when a refill stall outlasts the track', async () => {
    const t = setup();
    const ended = vi.fn();
    t.voice.onEnded(ended);
    t.voice.arm(0);
    await flush();
    t.voice.start(0);
    await flush();
    t.ctx.currentTime = 100.015 + index.durationSec + 1;
    t.sources[1].onended!();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('fades from the current level and cancels back to full', async () => {
    const t = setup();
    t.voice.arm(10);
    await flush();
    t.voice.start(10);
    t.gain.calls = [];
    t.voice.fadeOut(2);
    expect(t.gain.calls).toEqual([
      ['cancel', 100],
      ['set', 1, 100],
      ['ramp', 0, 102],
    ]);
    t.voice.cancelFade();
    expect(t.gain.value).toBe(1);
  });

  it('dispose stops playback and disconnects', async () => {
    const t = setup();
    t.voice.arm(10);
    await flush();
    t.voice.start(10);
    t.voice.dispose();
    expect(t.live()).toHaveLength(0);
  });
});
