import { useEffect, useReducer, useState } from 'react';
import { createApi } from '@/api';
import { buildBufferVoice } from '@/audio/buffer-voice';
import { getAudioContext, unlockAudio } from '@/audio/context';
import { Engine } from '@/audio/engine';
import { loadAudioBlob, pruneCache } from '@/audio/loader';
import { indexMp3 } from '@/audio/mp3-index';
import type { Voice } from '@/audio/voice';
import { BoardStore } from '@/board-store';
import { getBoot } from '@/boot';

const REFRESH_MS = 60_000;

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
 * becomes visible, on focus, every minute), unlocks audio on user gestures, cuts the sounding
 * track if the audio output is interrupted, and keeps the screen awake.
 */
export function useBoard(env: BoardEnv = realEnv): BoardStore {
  const [store] = useState(env.createStore);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => store.subscribe(rerender), [store]);

  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;
    let disposed = false;
    const keepAwake = () => {
      try {
        navigator.wakeLock?.request('screen').then(
          (lock) => {
            if (disposed) void lock.release().catch(() => {});
            else wakeLock = lock;
          },
          () => {},
        );
      } catch {
        // Wake lock is best effort.
      }
    };

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void store.refresh();
      keepAwake();
    };
    const onFocus = () => void store.refresh();
    // Every gesture, not just the first: iOS can suspend the context again later.
    const onGesture = () => void env.unlockAudio().catch(() => {});

    // iOS suspends or interrupts Web Audio when the phone is locked. The music has stopped,
    // so the row must say so: cut the sounding track. A hidden tab alone never stops it.
    const ctx = env.audioContext();
    const onAudioState = () => {
      if (ctx.state !== 'running') store.cutActive();
    };

    void store.refresh();
    keepAwake();
    const timer = setInterval(() => void store.refresh(), REFRESH_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
    ctx.addEventListener('statechange', onAudioState);

    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pointerdown', onGesture, true);
      window.removeEventListener('keydown', onGesture, true);
      ctx.removeEventListener('statechange', onAudioState);
      void wakeLock?.release().catch(() => {});
    };
  }, [store, env]);

  return store;
}
