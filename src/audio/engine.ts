import type { Voice } from './voice';

export type TrackState = 'ready' | 'playing' | 'fading';

export interface EngineTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface Track {
  voice: Voice;
  startMs: number;
  state: TrackState;
  removeWhenIdle: boolean;
}

export class Engine {
  private tracks = new Map<number, Track>();
  private listeners = new Set<() => void>();
  private active: number | null = null;
  private fadeTimer: unknown = null;
  private fadeMs = 0;
  private readonly timers: EngineTimers;

  constructor(timers?: EngineTimers) {
    this.timers = timers ?? {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
    };
  }

  add(id: number, voice: Voice, startMs: number): void {
    const track: Track = { voice, startMs, state: 'ready', removeWhenIdle: false };
    this.tracks.set(id, track);
    voice.arm(startMs / 1000);
    voice.onEnded(() => {
      if (this.tracks.get(id) === track && track.state !== 'ready') {
        this.settle(id);
        this.emit();
      }
    });
    this.emit();
  }

  remove(id: number): void {
    const t = this.tracks.get(id);
    if (!t) return;
    if (t.state === 'ready') {
      this.dispose(id);
      this.emit();
    } else {
      t.removeWhenIdle = true;
    }
  }

  has(id: number): boolean {
    return this.tracks.has(id);
  }

  setStartMs(id: number, startMs: number): void {
    const t = this.tracks.get(id);
    if (!t) return;
    t.startMs = startMs;
    if (t.state === 'ready') {
      t.voice.arm(startMs / 1000);
      this.emit();
    }
  }

  setFadeMs(ms: number): void {
    this.fadeMs = ms;
  }

  play(id: number, fromMs?: number): void {
    const t = this.tracks.get(id);
    if (!t) return;
    if (this.active !== null && this.active !== id) this.settle(this.active);
    this.clearFadeTimer();
    if (t.state === 'fading') t.voice.cancelFade();
    t.voice.start((fromMs ?? t.startMs) / 1000);
    t.state = 'playing';
    this.active = id;
    this.emit();
  }

  stop(id: number): void {
    const t = this.tracks.get(id);
    if (!t || t.state === 'ready') return;
    if (t.state === 'fading' || this.fadeMs <= 0) {
      this.settle(id);
    } else {
      t.voice.fadeOut(this.fadeMs / 1000);
      t.state = 'fading';
      this.fadeTimer = this.timers.setTimeout(() => {
        this.fadeTimer = null;
        this.settle(id);
        this.emit();
      }, this.fadeMs);
    }
    this.emit();
  }

  /** Silence a playing or fading track at once, with no fade, and make it ready again. */
  cut(id: number): void {
    const t = this.tracks.get(id);
    if (!t || t.state === 'ready') return;
    this.settle(id);
    this.emit();
  }

  state(id: number): TrackState | undefined {
    return this.tracks.get(id)?.state;
  }

  activeId(): number | null {
    return this.active;
  }

  positionSec(id: number): number {
    return this.tracks.get(id)?.voice.positionSec() ?? 0;
  }

  durationSec(id: number): number {
    return this.tracks.get(id)?.voice.durationSec ?? 0;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Silence a track, return it to ready, and honour a deferred remove. No notification. */
  private settle(id: number): void {
    const t = this.tracks.get(id);
    if (!t) return;
    this.clearFadeTimer();
    t.voice.halt();
    t.state = 'ready';
    if (this.active === id) this.active = null;
    if (t.removeWhenIdle) this.dispose(id);
    else t.voice.arm(t.startMs / 1000);
  }

  private dispose(id: number): void {
    const t = this.tracks.get(id);
    if (!t) return;
    t.voice.dispose();
    this.tracks.delete(id);
  }

  private clearFadeTimer(): void {
    if (this.fadeTimer !== null) {
      this.timers.clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}
