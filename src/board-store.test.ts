import { ApiError, SessionExpiredError, type Api, type Track } from './api';
import { Engine } from './audio/engine';
import { BoardStore } from './board-store';
import { FakeVoice } from './test/fake-voice';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve();
};

const track = (id: number, extra: Partial<Track> = {}): Track => ({
  id,
  name: `Track ${id}`,
  start_ms: 0,
  order: id,
  size: 1000,
  version: 'a',
  ...extra,
});

/**
 * A store over a fake api, the real Engine and FakeVoices. Each loadBlob call waits on a
 * deferred the test settles; `autoLoad` settles them at once.
 */
function setup(initial: Track[], { autoLoad = false } = {}) {
  let server = initial.map((t) => ({ ...t }));
  const api = {
    listTracks: vi.fn(async () => server.map((t) => ({ ...t }))),
    getSettings: vi.fn(async () => ({ fade_ms: 2000 })),
    saveSettings: vi.fn(async (s: { fade_ms: number }) => s),
    saveOrder: vi.fn(async (ids: number[]) =>
      ids.map((id, i) => ({ ...server.find((t) => t.id === id)!, order: i + 1 })),
    ),
    updateTrack: vi.fn(),
    uploadTrack: vi.fn(),
    deleteTrack: vi.fn(async () => {}),
    fetchAudio: vi.fn(),
  } satisfies Record<keyof Api, unknown>;

  const engine = new Engine();
  const loads: Array<{ track: Track; d: Deferred<Blob>; blob: Blob }> = [];
  const voices: Array<{ id: number; version: string; voice: FakeVoice }> = [];
  const blobOwner = new Map<Blob, { id: number; version: string }>();

  const loadBlob = vi.fn((t: Track) => {
    const blob = new Blob([`${t.id}:${t.version}`]);
    blobOwner.set(blob, { id: t.id, version: t.version });
    const d = deferred<Blob>();
    loads.push({ track: t, d, blob });
    if (autoLoad) d.resolve(blob);
    return d.promise;
  });
  let building = 0;
  let maxBuilding = 0;
  const makeVoice = vi.fn(async (blob: Blob) => {
    building++;
    maxBuilding = Math.max(maxBuilding, building);
    for (let i = 0; i < 3; i++) await Promise.resolve();
    building--;
    const voice = new FakeVoice(200);
    voices.push({ ...blobOwner.get(blob)!, voice });
    return voice;
  });
  const prune = vi.fn(async (_keep: Track[]) => {});

  const store = new BoardStore({ api: api as unknown as Api, engine, loadBlob, makeVoice, prune }, 2000);

  const resolveLoad = async (id: number, version = 'a') => {
    const l = loads.find((x) => x.track.id === id && x.track.version === version)!;
    l.d.resolve(l.blob);
    await flush();
  };
  const voiceOf = (id: number, version = 'a') =>
    voices.filter((v) => v.id === id && v.version === version).at(-1)!.voice;
  const statuses = () => store.rows().map((r) => r.status);
  const ids = () => store.rows().map((r) => r.track.id);
  const setServer = (tracks: Track[]) => {
    server = tracks.map((t) => ({ ...t }));
  };

  return { store, api, engine, loads, loadBlob, makeVoice, prune, resolveLoad, voiceOf, statuses, ids, setServer,
    maxBuilding: () => maxBuilding };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test('new tracks load and become ready', async () => {
  const s = setup([track(1), track(2)]);
  expect(s.store.listed()).toBe(false);
  await s.store.refresh();
  expect(s.store.listed()).toBe(true);
  expect(s.statuses()).toEqual(['loading', 'loading']);
  expect(s.store.loaded()).toBe(0);
  expect(s.store.total()).toBe(2);
  await s.resolveLoad(1);
  expect(s.statuses()).toEqual(['ready', 'loading']);
  expect(s.store.loaded()).toBe(1);
  await s.resolveLoad(2);
  expect(s.statuses()).toEqual(['ready', 'ready']);
  expect(s.store.loaded()).toBe(2);
  expect(s.voiceOf(1).calls).toEqual([['arm', 0]]);
});

test('downloads run three at a time in list order', async () => {
  const s = setup([1, 2, 3, 4, 5].map((id) => track(id)));
  await s.store.refresh();
  expect(s.loadBlob.mock.calls.map(([t]) => t.id)).toEqual([1, 2, 3]);
  await s.resolveLoad(2);
  expect(s.loadBlob.mock.calls.map(([t]) => t.id)).toEqual([1, 2, 3, 4]);
});

test('voices are built one file at a time', async () => {
  const s = setup([1, 2, 3].map((id) => track(id)), { autoLoad: true });
  await s.store.refresh();
  await flush();
  await flush();
  await flush();
  expect(s.statuses()).toEqual(['ready', 'ready', 'ready']);
  expect(s.makeVoice).toHaveBeenCalledTimes(3);
  expect(s.maxBuilding()).toBe(1);
});

test('a failed load marks only that row', async () => {
  const s = setup([track(1), track(2), track(3)]);
  await s.store.refresh();
  await s.resolveLoad(1);
  s.loads.find((l) => l.track.id === 2)!.d.reject(new ApiError('mm_network', 'offline', 0));
  await flush();
  await s.resolveLoad(3);
  expect(s.statuses()).toEqual(['ready', 'error', 'ready']);
  s.store.retry(2);
  expect(s.statuses()).toEqual(['ready', 'loading', 'ready']);
  s.loads.filter((l) => l.track.id === 2).at(-1)!.d.resolve(new Blob(['x']));
  await flush();
  expect(s.statuses()).toEqual(['ready', 'ready', 'ready']);
});

test('a voice that cannot be built marks the row as failed', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const s = setup([track(1)]);
  s.makeVoice.mockRejectedValueOnce(new Error('not an mp3'));
  await s.store.refresh();
  await s.resolveLoad(1);
  expect(s.statuses()).toEqual(['error']);
  expect(logged).toHaveBeenCalled();
  logged.mockRestore();
});

test('a changed start point reaches the engine', async () => {
  const s = setup([track(1)], { autoLoad: true });
  await s.store.refresh();
  await flush();
  s.setServer([track(1, { start_ms: 10000 })]);
  await s.store.refresh();
  expect(s.voiceOf(1).last()).toEqual(['arm', 10]);
  expect(s.store.rows()[0].track.start_ms).toBe(10000);
});

test('a start point changed while playing waits', async () => {
  const s = setup([track(1)], { autoLoad: true });
  await s.store.refresh();
  await flush();
  s.store.play(1);
  s.setServer([track(1, { start_ms: 10000 })]);
  await s.store.refresh();
  expect(s.voiceOf(1).last()).toEqual(['start', 0]);
  s.store.stop(1);
  vi.advanceTimersByTime(2000);
  expect(s.voiceOf(1).last()).toEqual(['arm', 10]);
});

test('a track deleted elsewhere keeps playing, then disappears', async () => {
  const s = setup([track(1), track(2), track(3)], { autoLoad: true });
  await s.store.refresh();
  await flush();
  s.prune.mockClear();
  s.store.play(1);
  s.setServer([track(2), track(3)]);
  await s.store.refresh();
  expect(s.ids()).toEqual([1, 2, 3]);
  expect(s.statuses()[0]).toBe('playing');
  expect(s.store.total()).toBe(2);
  expect(s.prune).not.toHaveBeenCalled();
  s.store.stop(1);
  expect(s.ids()).toEqual([1, 2, 3]);
  vi.advanceTimersByTime(2000);
  expect(s.ids()).toEqual([2, 3]);
  expect(s.voiceOf(1).last()).toEqual(['dispose']);
  expect(s.prune).not.toHaveBeenCalled(); // pruning waits for a fresh list
  await s.store.refresh();
  expect(s.prune).toHaveBeenCalledTimes(1);
  expect(s.prune.mock.calls[0][0].map((t: Track) => t.id)).toEqual([2, 3]);
});

test('a track deleted elsewhere while idle disappears at once', async () => {
  const s = setup([track(1), track(2)], { autoLoad: true });
  await s.store.refresh();
  await flush();
  s.setServer([track(2)]);
  await s.store.refresh();
  expect(s.ids()).toEqual([2]);
  expect(s.voiceOf(1).last()).toEqual(['dispose']);
  expect(s.prune).toHaveBeenLastCalledWith([expect.objectContaining({ id: 2 })]);
});

test('a new version swaps after the track is idle', async () => {
  const s = setup([track(1)], { autoLoad: true });
  await s.store.refresh();
  await flush();
  s.store.play(1);
  s.setServer([track(1, { version: 'b' })]);
  await s.store.refresh();
  await flush();
  expect(s.loadBlob).toHaveBeenLastCalledWith(expect.objectContaining({ id: 1, version: 'b' }));
  const oldVoice = s.voiceOf(1, 'a');
  const newVoice = s.voiceOf(1, 'b');
  expect(oldVoice.names()).not.toContain('dispose');
  expect(s.statuses()).toEqual(['playing']);
  s.store.stop(1);
  vi.advanceTimersByTime(2000);
  expect(oldVoice.last()).toEqual(['dispose']);
  expect(newVoice.calls).toEqual([['arm', 0]]);
  s.store.play(1);
  expect(newVoice.last()).toEqual(['start', 0]);
  expect(oldVoice.names().filter((n) => n === 'start')).toHaveLength(1);
});

test('session expiry does not stop playback', async () => {
  const s = setup([track(1)], { autoLoad: true });
  await s.store.refresh();
  await flush();
  s.store.play(1);
  s.api.listTracks.mockRejectedValueOnce(new SessionExpiredError());
  await s.store.refresh();
  expect(s.store.sessionExpired()).toBe(true);
  expect(s.engine.state(1)).toBe('playing');
  expect(s.ids()).toEqual([1]);
});

test('prune runs only after a successful list, with every server track', async () => {
  const s = setup([track(1), track(2)], { autoLoad: true });
  s.api.listTracks.mockRejectedValueOnce(new ApiError('mm_network', 'offline', 0));
  await s.store.refresh();
  expect(s.prune).not.toHaveBeenCalled();
  await s.store.refresh();
  expect(s.prune).toHaveBeenCalledTimes(1);
  expect(s.prune.mock.calls[0][0].map((t: Track) => t.id)).toEqual([1, 2]);
});

test('settings from the server set the fade', async () => {
  const s = setup([track(1)], { autoLoad: true });
  s.api.getSettings.mockResolvedValueOnce({ fade_ms: 500 });
  await s.store.refresh();
  await flush();
  expect(s.store.fadeMs()).toBe(500);
  s.store.play(1);
  s.store.stop(1);
  expect(s.voiceOf(1).last()).toEqual(['fadeOut', 0.5]);
});

test('elapsed time counts from where playback started', async () => {
  const s = setup([track(1, { start_ms: 42300 })], { autoLoad: true });
  await s.store.refresh();
  await flush();
  s.store.play(1);
  s.voiceOf(1).position = 49.5;
  expect(s.store.elapsedSec(1)).toBeCloseTo(7.2);
  s.store.play(1, 0);
  s.voiceOf(1).position = 3;
  expect(s.store.elapsedSec(1)).toBeCloseTo(3);
});

test('an interrupted audio context cuts the active track', async () => {
  const s = setup([track(1)], { autoLoad: true });
  await s.store.refresh();
  await flush();
  s.store.play(1);
  s.store.stop(1);
  s.store.cutActive();
  expect(s.statuses()).toEqual(['ready']);
  expect(s.voiceOf(1).calls.slice(-2)).toEqual([['halt'], ['arm', 0]]);
});

test('reorder reverts on failure', async () => {
  const s = setup([track(1), track(2), track(3)], { autoLoad: true });
  await s.store.refresh();
  await flush();
  const d = deferred<Track[]>();
  s.api.saveOrder.mockReturnValueOnce(d.promise);
  const pending = s.store.reorder([3, 1, 2]);
  expect(s.ids()).toEqual([3, 1, 2]);
  d.reject(new ApiError('mm_forbidden', 'no', 403));
  await expect(pending).rejects.toThrow('no');
  expect(s.ids()).toEqual([1, 2, 3]);
});

test('reorder keeps the new order on success', async () => {
  const s = setup([track(1), track(2), track(3)], { autoLoad: true });
  await s.store.refresh();
  await flush();
  await s.store.reorder([3, 1, 2]);
  expect(s.ids()).toEqual([3, 1, 2]);
  expect(s.api.saveOrder).toHaveBeenCalledWith([3, 1, 2]);
});

test('subscribers hear changes', async () => {
  const s = setup([track(1)], { autoLoad: true });
  const fn = vi.fn();
  const off = s.store.subscribe(fn);
  await s.store.refresh();
  await flush();
  expect(fn).toHaveBeenCalled();
  fn.mockClear();
  s.store.play(1);
  expect(fn).toHaveBeenCalled();
  off();
  fn.mockClear();
  s.store.stop(1);
  expect(fn).not.toHaveBeenCalled();
});

test('update applies what the server returns', async () => {
  const s = setup([track(1)], { autoLoad: true });
  await s.store.refresh();
  await flush();
  s.api.updateTrack.mockResolvedValueOnce(track(1, { name: 'Goal', start_ms: 5000 }));
  await s.store.update(1, { name: 'Goal', start_ms: 5000 });
  expect(s.api.updateTrack).toHaveBeenCalledWith(1, { name: 'Goal', start_ms: 5000 });
  expect(s.store.rows()[0].track.name).toBe('Goal');
  expect(s.voiceOf(1).last()).toEqual(['arm', 5]);
});

test('a list fetched before a local change does not undo it', async () => {
  const s = setup([track(1)], { autoLoad: true });
  await s.store.refresh();
  await flush();
  const list = deferred<Track[]>();
  s.api.listTracks.mockReturnValueOnce(list.promise);
  const refreshing = s.store.refresh();
  s.api.updateTrack.mockResolvedValueOnce(track(1, { name: 'Goal' }));
  await s.store.update(1, { name: 'Goal' });
  list.resolve([track(1)]);
  await refreshing;
  expect(s.store.rows()[0].track.name).toBe('Goal');
});

test('upload adds each new track and reports failures per file', async () => {
  const s = setup([track(1)], { autoLoad: true });
  await s.store.refresh();
  await flush();
  const a = new File(['a'], 'a.mp3');
  const b = new File(['b'], 'b.mp3');
  s.api.uploadTrack
    .mockImplementationOnce(async (_f: File, onProgress: (f: number) => void) => {
      onProgress(0.5);
      return track(2, { name: 'a' });
    })
    .mockRejectedValueOnce(new ApiError('mm_too_large', 'Too large (limit 8 MB)', 413));
  const progress = vi.fn();
  const results = await s.store.upload([a, b], progress);
  expect(results).toEqual([{ file: a }, { file: b, error: 'Too large (limit 8 MB)' }]);
  expect(progress).toHaveBeenCalledWith(a, 0.5);
  expect(s.ids()).toEqual([1, 2]);
  await flush();
  expect(s.statuses()).toEqual(['ready', 'ready']);
});

test('remove deletes on the server and drops the row once idle', async () => {
  const s = setup([track(1), track(2)], { autoLoad: true });
  await s.store.refresh();
  await flush();
  s.store.play(1);
  await s.store.remove(1);
  expect(s.api.deleteTrack).toHaveBeenCalledWith(1);
  expect(s.ids()).toEqual([1, 2]);
  s.store.stop(1);
  vi.advanceTimersByTime(2000);
  expect(s.ids()).toEqual([2]);
});

test('saveFade stores the fade the server accepted', async () => {
  const s = setup([track(1)], { autoLoad: true });
  s.api.saveSettings.mockResolvedValueOnce({ fade_ms: 3500 });
  await s.store.saveFade(3500);
  expect(s.api.saveSettings).toHaveBeenCalledWith({ fade_ms: 3500 });
  expect(s.store.fadeMs()).toBe(3500);
});

test('session expiry on a write sets the flag and rethrows', async () => {
  const s = setup([track(1)], { autoLoad: true });
  s.api.saveSettings.mockRejectedValueOnce(new SessionExpiredError());
  await expect(s.store.saveFade(1000)).rejects.toBeInstanceOf(SessionExpiredError);
  expect(s.store.sessionExpired()).toBe(true);
});

test('a voice that throws while being installed fails only its row, and the queue keeps going', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const s = setup([track(1), track(2)]);
  s.makeVoice.mockImplementationOnce(async () => {
    const broken = new FakeVoice(200);
    broken.arm = () => {
      throw new Error('arm failed');
    };
    return broken;
  });
  await s.store.refresh();
  await s.resolveLoad(1);
  await s.resolveLoad(2);
  expect(s.statuses()).toEqual(['error', 'ready']);
  expect(logged).toHaveBeenCalled();
  s.store.retry(1);
  expect(s.statuses()).toEqual(['loading', 'ready']);
  s.loads.filter((l) => l.track.id === 1).at(-1)!.d.resolve(new Blob(['x']));
  await flush();
  expect(s.statuses()).toEqual(['ready', 'ready']);
  logged.mockRestore();
});

test('a throwing listener does not stop the board', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const s = setup([track(1), track(2)], { autoLoad: true });
  s.store.subscribe(() => {
    throw new Error('listener failed');
  });
  await s.store.refresh();
  await flush();
  expect(s.statuses()).toEqual(['ready', 'ready']);
  s.store.play(2);
  expect(s.statuses()).toEqual(['ready', 'playing']);
  logged.mockRestore();
});

test('a refresh started before saveFade does not undo it', async () => {
  const s = setup([track(1)], { autoLoad: true });
  const settings = deferred<{ fade_ms: number }>();
  s.api.getSettings.mockReturnValueOnce(settings.promise);
  const refreshing = s.store.refresh();
  s.api.saveSettings.mockResolvedValueOnce({ fade_ms: 3500 });
  await s.store.saveFade(3500);
  settings.resolve({ fade_ms: 2000 });
  await refreshing;
  expect(s.store.fadeMs()).toBe(3500);
});

test('a deleted track going idle after an upload never prunes the new upload', async () => {
  const s = setup([track(1), track(2)], { autoLoad: true });
  await s.store.refresh();
  await flush();
  s.store.play(1);
  s.setServer([track(2)]);
  await s.store.refresh(); // track 1 still sounding: prune deferred
  s.api.uploadTrack.mockResolvedValueOnce(track(3));
  await s.store.upload([new File(['c'], 'c.mp3')], () => {});
  s.setServer([track(2), track(3)]);
  s.prune.mockClear();
  s.store.stop(1);
  vi.advanceTimersByTime(2000);
  expect(s.ids()).toEqual([2, 3]);
  expect(s.prune).not.toHaveBeenCalled();
  await s.store.refresh();
  expect(s.prune).toHaveBeenCalledTimes(1);
  expect(s.prune.mock.calls[0][0].map((t: Track) => t.id)).toEqual([2, 3]);
});

test('a new server order waits while a track is active', async () => {
  const s = setup([track(1), track(2), track(3)], { autoLoad: true });
  await s.store.refresh();
  await flush();
  s.store.play(2);
  s.setServer([track(3, { order: 1 }), track(1, { order: 2 }), track(2, { order: 3 })]);
  await s.store.refresh();
  expect(s.ids()).toEqual([1, 2, 3]);
  s.store.stop(2);
  expect(s.ids()).toEqual([1, 2, 3]); // still fading
  vi.advanceTimersByTime(2000);
  expect(s.ids()).toEqual([3, 1, 2]);
});

test('a server rename of the playing track waits; other rows rename at once', async () => {
  const s = setup([track(1), track(2)], { autoLoad: true });
  await s.store.refresh();
  await flush();
  s.store.play(1);
  s.setServer([track(1, { name: 'Goal' }), track(2, { name: 'Timeout' })]);
  await s.store.refresh();
  expect(s.store.rows().map((r) => r.track.name)).toEqual(['Track 1', 'Timeout']);
  s.store.stop(1);
  vi.advanceTimersByTime(2000);
  expect(s.store.rows().map((r) => r.track.name)).toEqual(['Goal', 'Timeout']);
});

test('local reorder and rename apply at once while a track plays, and stay', async () => {
  const s = setup([track(1), track(2), track(3)], { autoLoad: true });
  await s.store.refresh();
  await flush();
  s.store.play(1);
  s.setServer([track(3, { order: 1 }), track(1, { order: 2 }), track(2, { order: 3 })]);
  await s.store.refresh(); // held server order
  await s.store.reorder([2, 3, 1]);
  expect(s.ids()).toEqual([2, 3, 1]);
  s.api.updateTrack.mockResolvedValueOnce(track(1, { name: 'Goal' }));
  await s.store.update(1, { name: 'Goal' });
  expect(s.store.rows().find((r) => r.track.id === 1)!.track.name).toBe('Goal');
  s.store.stop(1);
  vi.advanceTimersByTime(2000);
  expect(s.ids()).toEqual([2, 3, 1]);
});

test('an unreachable server before the first list is reported until a refresh succeeds', async () => {
  const s = setup([track(1)], { autoLoad: true });
  expect(s.store.loadError()).toBe(false);
  s.api.listTracks.mockRejectedValueOnce(new ApiError('mm_network', 'offline', 0));
  await s.store.refresh();
  expect(s.store.loadError()).toBe(true);
  await s.store.refresh();
  expect(s.store.loadError()).toBe(false);
  expect(s.ids()).toEqual([1]);
});

test('session expiry is not reported as an unreachable server', async () => {
  const s = setup([track(1)]);
  s.api.listTracks.mockRejectedValueOnce(new SessionExpiredError());
  await s.store.refresh();
  expect(s.store.loadError()).toBe(false);
  expect(s.store.sessionExpired()).toBe(true);
});
