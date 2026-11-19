import type { Voice } from '@/audio/voice';

/** A Voice that records every call, for engine and store tests. */
export class FakeVoice implements Voice {
  calls: [string, number?][] = [];
  position = 0;
  private ended: (() => void) | null = null;
  constructor(readonly durationSec: number) {}
  private rec(name: string, arg?: number) {
    this.calls.push(arg === undefined ? [name] : [name, arg]);
  }
  arm(s: number) { this.rec('arm', s); }
  start(s: number) { this.rec('start', s); }
  halt() { this.rec('halt'); }
  fadeOut(s: number) { this.rec('fadeOut', s); }
  cancelFade() { this.rec('cancelFade'); }
  positionSec() { return this.position; }
  onEnded(cb: () => void) { this.ended = cb; }
  dispose() { this.rec('dispose'); }
  fireEnded() { this.ended?.(); }
  last() { return this.calls[this.calls.length - 1]; }
  names() { return this.calls.map((c) => c[0]); }
}
