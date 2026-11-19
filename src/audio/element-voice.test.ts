import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElementVoice } from './element-voice';

type Call = [string, ...number[]];

class FakeParam {
  value = 1;
  calls: Call[] = [];
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

class FakeNode {
  connected: unknown[] = [];
  disconnect = vi.fn();
  connect<T>(n: T): T {
    this.connected.push(n);
    return n;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeAudio extends EventTarget {
  static last: FakeAudio;
  preload = '';
  src = '';
  currentTime = 0;
  duration = NaN;
  seeks: number[] = [];
  playResult: Promise<void> = Promise.resolve();
  play = vi.fn(() => this.playResult);
  pause = vi.fn();
  load = vi.fn();
  constructor() {
    super();
    FakeAudio.last = this;
    let t = 0;
    Object.defineProperty(this, 'currentTime', {
      get: () => t,
      set: (v: number) => {
        this.seeks.push(v);
        t = v;
      },
    });
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
}

function fakeContext() {
  const destination = new FakeNode();
  const sources: FakeNode[] = [];
  const gains: FakeGain[] = [];
  const ctx = {
    currentTime: 5,
    destination,
    createMediaElementSource: vi.fn(() => {
      const s = new FakeNode();
      sources.push(s);
      return s;
    }),
    createGain: vi.fn(() => {
      const g = new FakeGain();
      gains.push(g);
      return g;
    }),
  };
  return { ctx, destination, sources, gains, asCtx: ctx as unknown as AudioContext };
}

async function ready(asCtx: AudioContext, destination?: AudioNode) {
  const p = createElementVoice(asCtx, 'song.mp3', destination);
  const el = FakeAudio.last;
  el.duration = 30;
  el.dispatchEvent(new Event('loadedmetadata'));
  const voice = await p;
  return { voice, el };
}

describe('createElementVoice', () => {
  beforeEach(() => {
    vi.stubGlobal('Audio', FakeAudio);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resolves after loadedmetadata with a preloading element routed source -> gain -> destination', async () => {
    const f = fakeContext();
    const { voice, el } = await ready(f.asCtx);
    expect(el.preload).toBe('auto');
    expect(el.src).toBe('song.mp3');
    expect(f.ctx.createMediaElementSource).toHaveBeenCalledWith(el);
    expect(f.sources[0].connected).toEqual([f.gains[0]]);
    expect(f.gains[0].connected).toEqual([f.destination]);
    expect(voice.durationSec).toBe(30);
  });

  it('routes to a given destination instead of ctx.destination', async () => {
    const f = fakeContext();
    const tap = new FakeNode();
    await ready(f.asCtx, tap as unknown as AudioNode);
    expect(f.gains[0].connected).toEqual([tap]);
  });

  it("rejects on the element's error event and clears its src", async () => {
    const f = fakeContext();
    const p = createElementVoice(f.asCtx, 'fake.mp3');
    const el = FakeAudio.last;
    el.dispatchEvent(new Event('error'));
    await expect(p).rejects.toThrow(/fake\.mp3/);
    expect(el.src).toBe('');
    expect(f.ctx.createMediaElementSource).not.toHaveBeenCalled();
  });

  it('arm pauses, seeks and resets gain to 1', async () => {
    const f = fakeContext();
    const { voice, el } = await ready(f.asCtx);
    const g = f.gains[0].gain;
    g.value = 0.3;
    g.calls = [];
    voice.arm(10.3);
    expect(el.pause).toHaveBeenCalled();
    expect(el.currentTime).toBe(10.3);
    expect(g.calls).toEqual([
      ['cancel', 5],
      ['set', 1, 5],
    ]);
    expect(el.play).not.toHaveBeenCalled();
  });

  it('start skips the seek when already within 1 ms of fromSec', async () => {
    const f = fakeContext();
    const { voice, el } = await ready(f.asCtx);
    voice.arm(10.3);
    el.seeks = [];
    el.currentTime = 10.3005;
    el.seeks = [];
    voice.start(10.3);
    expect(el.seeks).toEqual([]);
    expect(el.play).toHaveBeenCalledTimes(1);
  });

  it('start seeks when further than 1 ms away, then plays at gain 1', async () => {
    const f = fakeContext();
    const { voice, el } = await ready(f.asCtx);
    const g = f.gains[0].gain;
    g.calls = [];
    voice.start(12);
    expect(el.seeks).toEqual([12]);
    expect(el.play).toHaveBeenCalledTimes(1);
    expect(g.calls).toEqual([
      ['cancel', 5],
      ['set', 1, 5],
    ]);
  });

  it('fadeOut holds the current gain then ramps to 0, without pausing', async () => {
    const f = fakeContext();
    const { voice, el } = await ready(f.asCtx);
    const g = f.gains[0].gain;
    g.value = 0.8;
    g.calls = [];
    voice.fadeOut(2);
    expect(g.calls).toEqual([
      ['cancel', 5],
      ['set', 0.8, 5],
      ['ramp', 0, 7],
    ]);
    expect(el.pause).not.toHaveBeenCalled();
  });

  it('cancelFade cancels the ramp and sets gain 1', async () => {
    const f = fakeContext();
    const { voice } = await ready(f.asCtx);
    const g = f.gains[0].gain;
    voice.fadeOut(2);
    g.calls = [];
    voice.cancelFade();
    expect(g.calls).toEqual([
      ['cancel', 5],
      ['set', 1, 5],
    ]);
  });

  it('halt pauses and silences', async () => {
    const f = fakeContext();
    const { voice, el } = await ready(f.asCtx);
    voice.halt();
    expect(el.pause).toHaveBeenCalled();
    expect(f.gains[0].gain.value).toBe(0);
  });

  it('swallows an AbortError from play() and logs other rejections', async () => {
    const f = fakeContext();
    const { voice, el } = await ready(f.asCtx);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    el.playResult = Promise.reject(new DOMException('interrupted', 'AbortError'));
    voice.start(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(log).not.toHaveBeenCalled();

    el.playResult = Promise.reject(new DOMException('no gesture', 'NotAllowedError'));
    voice.start(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('reports position and forwards ended', async () => {
    const f = fakeContext();
    const { voice, el } = await ready(f.asCtx);
    el.currentTime = 4.25;
    expect(voice.positionSec()).toBe(4.25);
    const cb = vi.fn();
    voice.onEnded(cb);
    el.dispatchEvent(new Event('ended'));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('dispose pauses, disconnects and clears src', async () => {
    const f = fakeContext();
    const { voice, el } = await ready(f.asCtx);
    voice.dispose();
    expect(el.pause).toHaveBeenCalled();
    expect(f.sources[0].disconnect).toHaveBeenCalled();
    expect(f.gains[0].disconnect).toHaveBeenCalled();
    expect(el.src).toBe('');
    expect(el.load).toHaveBeenCalled();
  });
});
