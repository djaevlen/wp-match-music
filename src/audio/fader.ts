/** Gain control shared by the voices: instant set, and a linear fade from the current level. */
export interface Fader {
  set(value: number): void;
  fadeOut(seconds: number): void;
}

export function createFader(ctx: BaseAudioContext, gain: AudioParam): Fader {
  return {
    set(value) {
      const now = ctx.currentTime;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(value, now);
    },
    fadeOut(seconds) {
      const now = ctx.currentTime;
      const current = gain.value;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(current, now);
      gain.linearRampToValueAtTime(0, now + seconds);
    },
  };
}
