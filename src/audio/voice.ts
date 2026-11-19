export interface Voice {
  readonly durationSec: number;
  arm(startSec: number): void; // paused, positioned at startSec, gain 1
  start(fromSec: number): void; // audible from fromSec at gain 1
  halt(): void; // silent and paused at once
  fadeOut(seconds: number): void; // ramp gain to 0; does not pause
  cancelFade(): void; // gain back to 1
  positionSec(): number;
  onEnded(cb: () => void): void;
  dispose(): void;
}
