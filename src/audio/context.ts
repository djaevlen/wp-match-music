let shared: AudioContext | null = null;

/** The one AudioContext every voice plays through. Created on first use. */
export function getAudioContext(): AudioContext {
  if (!shared) {
    const Ctor: typeof AudioContext =
      globalThis.AudioContext ??
      (globalThis as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    shared = new Ctor();
  }
  return shared;
}

/** Resume the shared context. Call inside a user gesture (tap or click handler). */
export function unlockAudio(): Promise<void> {
  const ctx = getAudioContext();
  return ctx.state === 'running' ? Promise.resolve() : ctx.resume();
}

/** True while the shared context is running, so a voice started now sounds at once. */
export function audioRunning(): boolean {
  return getAudioContext().state === 'running';
}
