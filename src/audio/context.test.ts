import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeAudioContext {
  static created = 0;
  state: AudioContextState = 'suspended';
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  constructor() {
    FakeAudioContext.created++;
  }
}

describe('audio context', () => {
  beforeEach(() => {
    vi.resetModules();
    FakeAudioContext.created = 0;
    vi.stubGlobal('AudioContext', FakeAudioContext);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getAudioContext returns one shared instance', async () => {
    const { getAudioContext } = await import('./context');
    expect(getAudioContext()).toBe(getAudioContext());
    expect(FakeAudioContext.created).toBe(1);
  });

  it('falls back to webkitAudioContext', async () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', FakeAudioContext);
    const { getAudioContext } = await import('./context');
    expect(getAudioContext()).toBeInstanceOf(FakeAudioContext);
  });

  it('unlockAudio resumes a suspended context', async () => {
    const { getAudioContext, unlockAudio } = await import('./context');
    await unlockAudio();
    const ctx = getAudioContext() as unknown as FakeAudioContext;
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(ctx.state).toBe('running');
  });

  it('unlockAudio does nothing when already running', async () => {
    const { getAudioContext, unlockAudio } = await import('./context');
    const ctx = getAudioContext() as unknown as FakeAudioContext;
    ctx.state = 'running';
    await unlockAudio();
    expect(ctx.resume).not.toHaveBeenCalled();
  });

  it('audioRunning is true only while the context runs', async () => {
    const { audioRunning, getAudioContext } = await import('./context');
    expect(audioRunning()).toBe(false);
    const ctx = getAudioContext() as unknown as { state: string };
    ctx.state = 'interrupted';
    expect(audioRunning()).toBe(false);
    ctx.state = 'running';
    expect(audioRunning()).toBe(true);
  });
});
