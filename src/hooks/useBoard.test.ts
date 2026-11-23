import { act, renderHook } from '@testing-library/react';
import type { Api, Track } from '@/api';
import { Engine } from '@/audio/engine';
import { BoardStore } from '@/board-store';
import { FakeVoice } from '@/test/fake-voice';
import { useBoard, type BoardEnv } from './useBoard';

const flush = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve();
};

/** Stands in for the shared AudioContext: only its state and statechange event matter here. */
class FakeAudioContext extends EventTarget {
  state = 'suspended';
  set(state: string) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

const track: Track = { id: 1, name: 'Goal', start_ms: 0, quick_play: true, order: 1, size: 1, version: 'a' };

function setup() {
  const api = {
    listTracks: vi.fn(async () => [track]),
    getSettings: vi.fn(async () => ({ fade_ms: 2000 })),
  } as unknown as Api;
  const engine = new Engine();
  const ctx = new FakeAudioContext();
  const unlock = vi.fn(async () => {});
  const store = new BoardStore(
    {
      api,
      engine,
      output: { running: () => ctx.state === 'running', unlock },
      loadBlob: async () => new Blob(['x']),
      makeVoice: async () => new FakeVoice(200),
      prune: async () => {},
    },
    2000,
  );
  const refresh = vi.spyOn(store, 'refresh');
  const env: BoardEnv = { createStore: () => store, audioContext: () => ctx, unlockAudio: unlock };
  return { store, engine, refresh, ctx, unlock, env };
}

let lockRelease: ReturnType<typeof vi.fn<() => Promise<void>>>;
let lockRequest: ReturnType<typeof vi.fn>;
let locks: Array<{ released: boolean; release: () => Promise<void> }>;

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  lockRelease = vi.fn(async () => {});
  locks = [];
  lockRequest = vi.fn(async () => {
    const lock = {
      released: false,
      release: async () => {
        lock.released = true;
        await lockRelease();
      },
    };
    locks.push(lock);
    return lock;
  });
  Object.defineProperty(navigator, 'wakeLock', { value: { request: lockRequest }, configurable: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  Reflect.deleteProperty(navigator, 'wakeLock');
});

/** Mounts the hook and waits until track 1 is loaded and ready. */
async function mount() {
  const s = setup();
  const view = renderHook(() => useBoard(s.env));
  await act(flush);
  expect(s.store.rows().map((r) => r.status)).toEqual(['ready']);
  return { ...s, view };
}

test('returns the store it created', async () => {
  const { view, store } = await mount();
  expect(view.result.current).toBe(store);
});

test.each(['suspended', 'interrupted'])('audio going %s while a track plays cuts it', async (state) => {
  const { store, engine, ctx } = await mount();
  act(() => ctx.set('running'));
  act(() => store.play(1));
  act(() => ctx.set(state));
  expect(engine.state(1)).toBe('ready');
  expect(store.rows()[0].status).toBe('ready');
});

test('audio going suspended during a fade cuts it', async () => {
  const { store, engine, ctx } = await mount();
  act(() => ctx.set('running'));
  act(() => store.play(1));
  act(() => store.stop(1));
  act(() => ctx.set('suspended'));
  expect(engine.state(1)).toBe('ready');
});

test('a Play pressed before the audio runs waits for it, then starts', async () => {
  const { store, engine, ctx } = await mount();
  act(() => store.play(1));
  expect(engine.state(1)).toBe('ready');
  act(() => ctx.set('running'));
  expect(engine.state(1)).toBe('playing');
});

test('every statechange reaches the store', async () => {
  const { store, ctx } = await mount();
  const changed = vi.spyOn(store, 'outputChanged');
  act(() => ctx.set('interrupted'));
  act(() => ctx.set('running'));
  expect(changed).toHaveBeenCalledTimes(2);
});

test('a hidden page or lost focus never stops the track', async () => {
  const { store, engine, ctx } = await mount();
  act(() => ctx.set('running'));
  act(() => store.play(1));
  act(() => {
    setVisibility('hidden');
    window.dispatchEvent(new Event('blur'));
  });
  expect(engine.state(1)).toBe('playing');
});

test('refreshes on mount, when visible, on focus and every minute', async () => {
  const { refresh } = await mount();
  expect(refresh).toHaveBeenCalledTimes(1);
  act(() => setVisibility('hidden'));
  expect(refresh).toHaveBeenCalledTimes(1);
  act(() => setVisibility('visible'));
  expect(refresh).toHaveBeenCalledTimes(2);
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
  expect(refresh).toHaveBeenCalledTimes(3);
  await act(async () => {
    vi.advanceTimersByTime(60_000);
  });
  expect(refresh).toHaveBeenCalledTimes(4);
});

const GESTURES = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'];

test('every gesture unlocks audio, in the capture phase', async () => {
  const added = vi.spyOn(window, 'addEventListener');
  const { unlock } = await mount();
  for (const type of GESTURES) expect(added).toHaveBeenCalledWith(type, expect.any(Function), true);
  act(() => {
    for (const type of GESTURES) window.dispatchEvent(new Event(type));
    window.dispatchEvent(new Event('pointerdown'));
  });
  expect(unlock).toHaveBeenCalledTimes(GESTURES.length + 1);
});

test('a gesture while the audio runs leaves it alone', async () => {
  const { unlock, ctx } = await mount();
  act(() => ctx.set('running'));
  act(() => {
    window.dispatchEvent(new Event('click'));
  });
  expect(unlock).not.toHaveBeenCalled();
});

test('a gesture whose unlock settles tells the store', async () => {
  const { store } = await mount();
  const changed = vi.spyOn(store, 'outputChanged');
  await act(async () => {
    document.body.dispatchEvent(new Event('touchend', { bubbles: true }));
    await flush();
  });
  expect(changed).toHaveBeenCalledTimes(1);
});

test('keeps the screen awake on mount and when visible again', async () => {
  await mount();
  expect(lockRequest).toHaveBeenCalledWith('screen');
  locks[0].released = true; // the browser lets go of the lock while the page is hidden
  act(() => setVisibility('hidden'));
  await act(async () => {
    setVisibility('visible');
    await flush();
  });
  expect(lockRequest).toHaveBeenCalledTimes(2);
});

test('a wake lock released while visible is asked for again on the minute tick', async () => {
  await mount();
  await act(async () => {
    vi.advanceTimersByTime(60_000);
    await flush();
  });
  expect(lockRequest).toHaveBeenCalledTimes(1); // still held: not asked again
  locks[0].released = true; // e.g. battery saver
  await act(async () => {
    vi.advanceTimersByTime(60_000);
    await flush();
  });
  expect(lockRequest).toHaveBeenCalledTimes(2);
});

test('a refused wake lock is asked for again on the next gesture', async () => {
  lockRequest.mockRejectedValueOnce(new Error('denied'));
  await mount();
  expect(lockRequest).toHaveBeenCalledTimes(1);
  await act(async () => {
    window.dispatchEvent(new Event('click'));
    await flush();
  });
  expect(lockRequest).toHaveBeenCalledTimes(2);
  await act(async () => {
    window.dispatchEvent(new Event('click'));
    await flush();
  });
  expect(lockRequest).toHaveBeenCalledTimes(2); // held now
});

test('a refused wake lock is ignored', async () => {
  lockRequest.mockRejectedValue(new Error('denied'));
  const { store } = await mount();
  expect(store.rows()).toHaveLength(1);
});

test('unmount removes every listener, the interval and the wake lock', async () => {
  const added: unknown[][] = [];
  const removed: unknown[][] = [];
  const s = setup();
  for (const target of [window, document, s.ctx] as EventTarget[]) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation((...args) => {
      added.push([target, ...args]);
      add(...args);
    });
    vi.spyOn(target, 'removeEventListener').mockImplementation((...args) => {
      removed.push([target, ...args]);
      remove(...args);
    });
  }
  const view = renderHook(() => useBoard(s.env));
  await act(flush);
  const types = ['visibilitychange', 'focus', 'statechange', ...GESTURES];
  const ours = added.filter(([, type]) => types.includes(type as string));
  expect(ours.map(([, type]) => type).sort()).toEqual([...types].sort());

  view.unmount();
  for (const entry of ours) expect(removed).toContainEqual(entry);
  expect(lockRelease).toHaveBeenCalledTimes(1);

  s.refresh.mockClear();
  vi.advanceTimersByTime(180_000);
  window.dispatchEvent(new Event('focus'));
  expect(s.refresh).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
