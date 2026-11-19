import { createFader } from './fader';
import type { Voice } from './voice';

const SEEK_TOLERANCE_SEC = 0.001;

/**
 * A Voice backed by one <audio> element, routed element -> gain -> destination
 * so the fade works everywhere (iOS ignores audio.volume).
 * Resolves once metadata is loaded; rejects if the element cannot load src.
 */
export function createElementVoice(
  ctx: AudioContext,
  src: string,
  destination: AudioNode = ctx.destination,
): Promise<Voice> {
  const el = new Audio();
  el.preload = 'auto';

  return new Promise<Voice>((resolve, reject) => {
    const onMeta = () => {
      el.removeEventListener('error', onError);
      resolve(buildVoice(ctx, el, destination));
    };
    const onError = () => {
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeAttribute('src');
      reject(new Error(`Could not load audio: ${src}`));
    };
    el.addEventListener('loadedmetadata', onMeta, { once: true });
    el.addEventListener('error', onError, { once: true });
    el.src = src;
  });
}

function buildVoice(ctx: AudioContext, el: HTMLAudioElement, destination: AudioNode): Voice {
  const source = ctx.createMediaElementSource(el);
  const gainNode = ctx.createGain();
  source.connect(gainNode).connect(destination);
  const fader = createFader(ctx, gainNode.gain);

  const play = () => {
    const p = el.play();
    if (p) {
      p.catch((err: unknown) => {
        // pause() or a new seek interrupting play() is expected under rapid pressing.
        if ((err as { name?: string } | null)?.name !== 'AbortError') {
          console.error('Audio play() failed', err);
        }
      });
    }
  };

  return {
    get durationSec() {
      return Number.isFinite(el.duration) ? el.duration : 0;
    },
    arm(startSec) {
      el.pause();
      el.currentTime = startSec;
      fader.set(1);
    },
    start(fromSec) {
      fader.set(1);
      if (Math.abs(el.currentTime - fromSec) > SEEK_TOLERANCE_SEC) el.currentTime = fromSec;
      play();
    },
    halt() {
      el.pause();
      fader.set(0);
    },
    fadeOut(seconds) {
      fader.fadeOut(seconds);
    },
    cancelFade() {
      fader.set(1);
    },
    positionSec() {
      return el.currentTime;
    },
    onEnded(cb) {
      el.addEventListener('ended', cb);
    },
    dispose() {
      el.pause();
      source.disconnect();
      gainNode.disconnect();
      el.removeAttribute('src');
      el.load();
    },
  };
}
