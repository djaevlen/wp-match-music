import { useEffect, useReducer, useState } from 'react';
import { createApi } from '@/api';
import { buildBufferVoice } from '@/audio/buffer-voice';
import { audioRunning, getAudioContext, unlockAudio } from '@/audio/context';
import { Engine } from '@/audio/engine';
import { loadAudioBlob, pruneCache } from '@/audio/loader';
import { indexMp3 } from '@/audio/mp3-index';
import type { Voice } from '@/audio/voice';
import { BoardStore } from '@/board-store';
import { getBoot } from '@/boot';

const REFRESH_MS = 60_000;
// Touch activates on pointerup, touchend and click, not on a touch pointerdown; listen to all.
const GESTURES = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const;

/** A voice over the blob the store already holds, so nothing is fetched twice. */
async function voiceFromBlob(blob: Blob): Promise<Voice> {
  const ctx = getAudioContext();
  const index = indexMp3(new Uint8Array(await blob.arrayBuffer()));
  return buildBufferVoice(ctx, blob, index, ctx.destination);
}

function createStore(): BoardStore {
  const boot = getBoot();
  const api = createApi(boot);
  return new BoardStore(
    {
      api,
      engine: new Engine(),
      output: { running: audioRunning, unlock: unlockAudio },
      makeVoice: voiceFromBlob,
      loadBlob: (t) => loadAudioBlob(t, api.fetchAudio),
      prune: pruneCache,
    },
    boot.fadeMs,
  );
}

/** What the hook builds on; tests swap in fakes. */
export interface BoardEnv {
  createStore(): BoardStore;
  /** The shared audio output: its state and its statechange event. */
  audioContext(): Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & { readonly state: string };
  unlockAudio(): Promise<void>;
}

const realEnv: BoardEnv = { createStore, audioContext: getAudioContext, unlockAudio };

/**
 * The board's store, created once. Keeps it in step with the server (on mount, when the page
 * becomes visible, on focus, every minute), unlocks audio on user gestures, tells the store
 * whenever the audio output changes state (it cuts the sounding track if the output is
 * interrupted, and starts a Play that was waiting for it), and keeps the screen awake.
 */
export function useBoard(env: BoardEnv = realEnv): BoardStore {
  const [store] = useState(env.createStore);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => store.subscribe(rerender), [store]);

  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;
    let requesting = false;
    let disposed = false;
    /** Asks for a screen wake lock unless one is held (or being asked for). Best effort. */
    const keepAwake = () => {
      if (requesting || (wakeLock && !wakeLock.released)) return;
      if (document.visibilityState === 'hidden') return; // refused while hidden; asked again on visible
      try {
        const asked = navigator.wakeLock?.request('screen');
        if (!asked) return;
        requesting = true;
        asked.then(
          (lock) => {
            requesting = false;
            if (disposed) void lock.release().catch(() => {});
            else wakeLock = lock;
          },
          () => {
            requesting = false;
          },
        );
      } catch {
        requesting = false; // Wake lock is best effort.
      }
    };

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void store.refresh();
      keepAwake();
    };
    const onFocus = () => void store.refresh();
    const onTick = () => {
      void store.refresh();
      keepAwake(); // the browser can release the lock while the page is visible (battery saver)
    };
    // Every gesture, not just the first: iOS can suspend the context again later.
    const onGesture = () => {
      env.unlockAudio().then(
        () => store.outputChanged(),
        () => {},
      );
      keepAwake();
    };

    // iOS suspends or interrupts Web Audio when the phone is locked. The store cuts the sounding
    // track then (the row must say the music stopped) and starts a Play waiting for the output
    // once it runs. A hidden tab alone never stops it.
    const ctx = env.audioContext();
    const onAudioState = () => store.outputChanged();

    void store.refresh();
    keepAwake();
    const timer = setInterval(onTick, REFRESH_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    for (const type of GESTURES) window.addEventListener(type, onGesture, true);
    ctx.addEventListener('statechange', onAudioState);

    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
      for (const type of GESTURES) window.removeEventListener(type, onGesture, true);
      ctx.removeEventListener('statechange', onAudioState);
      void wakeLock?.release().catch(() => {});
    };
  }, [store, env]);

  return store;
}
