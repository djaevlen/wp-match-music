import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CACHE_NAME, cacheKey, loadAudioBlob, pruneCache } from './loader';

/** Minimal in-memory Cache Storage. Keys are paths, as cacheKey() builds them. */
function stubCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const open = vi.fn(async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    const path = (r: string | { url: string }) =>
      new URL(typeof r === 'string' ? r : r.url, 'http://localhost').pathname;
    return {
      match: async (r: string) => store.get(path(r))?.clone(),
      put: async (r: string, res: Response) => {
        store.set(path(r), res);
      },
      keys: async () => [...store.keys()].map((k) => ({ url: `http://localhost${k}` })),
      delete: async (r: { url: string }) => store.delete(path(r)),
    };
  });
  vi.stubGlobal('caches', { open });
  return { stores, open, entries: () => [...(stores.get(CACHE_NAME)?.keys() ?? [])].sort() };
}

const audio = () => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'Content-Type': 'audio/mpeg' } });

describe('loader', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('builds the cache key from id and version', () => {
    expect(cacheKey({ id: 3, version: 'abc' })).toBe('/mm-audio/3/abc');
  });

  it('cache miss fetches and stores', async () => {
    const c = stubCaches();
    const fetchAudio = vi.fn(async () => audio());
    const blob = await loadAudioBlob({ id: 1, version: 'a', size: 4 }, fetchAudio);
    expect(blob.size).toBe(4);
    expect(fetchAudio).toHaveBeenCalledTimes(1);
    expect(fetchAudio).toHaveBeenCalledWith(1);
    expect(c.entries()).toEqual([cacheKey({ id: 1, version: 'a' })]);
  });

  it('cache hit skips the network', async () => {
    stubCaches();
    const fetchAudio = vi.fn(async () => audio());
    await loadAudioBlob({ id: 1, version: 'a', size: 4 }, fetchAudio);
    const again = await loadAudioBlob({ id: 1, version: 'a', size: 4 }, fetchAudio);
    expect(again.size).toBe(4);
    expect(fetchAudio).toHaveBeenCalledTimes(1);
  });

  it('new version re-downloads', async () => {
    stubCaches();
    const fetchAudio = vi.fn(async () => audio());
    await loadAudioBlob({ id: 1, version: 'a', size: 4 }, fetchAudio);
    await loadAudioBlob({ id: 1, version: 'b', size: 4 }, fetchAudio);
    expect(fetchAudio).toHaveBeenCalledTimes(2);
  });

  it('works without Cache Storage', async () => {
    vi.stubGlobal('caches', undefined);
    const blob = await loadAudioBlob({ id: 1, version: 'a', size: 4 }, async () => audio());
    expect(blob.size).toBe(4);
    expect(blob.type).toBe('audio/mpeg');
  });

  it('falls back to a plain fetch when a cache call throws', async () => {
    vi.stubGlobal('caches', { open: vi.fn().mockRejectedValue(new Error('SecurityError')) });
    const fetchAudio = vi.fn(async () => audio());
    const blob = await loadAudioBlob({ id: 1, version: 'a', size: 4 }, fetchAudio);
    expect(blob.size).toBe(4);
    expect(fetchAudio).toHaveBeenCalledTimes(1);
  });

  it('still returns the audio when storing fails', async () => {
    vi.stubGlobal('caches', {
      open: vi.fn(async () => ({
        match: async () => undefined,
        put: async () => {
          throw new Error('QuotaExceededError');
        },
      })),
    });
    const blob = await loadAudioBlob({ id: 1, version: 'a', size: 4 }, async () => audio());
    expect(blob.size).toBe(4);
  });

  it('asks for persistent storage once, ignoring the result', async () => {
    stubCaches();
    const persist = vi.fn().mockRejectedValue(new Error('nope'));
    vi.stubGlobal('navigator', { ...navigator, storage: { persist } });
    vi.resetModules();
    const fresh = await import('./loader');
    const fetchAudio = async () => audio();
    await fresh.loadAudioBlob({ id: 1, version: 'a', size: 4 }, fetchAudio);
    await fresh.loadAudioBlob({ id: 2, version: 'a', size: 4 }, fetchAudio);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('pruneCache removes stale entries', async () => {
    const c = stubCaches();
    const fetchAudio = async () => audio();
    await loadAudioBlob({ id: 1, version: 'a', size: 4 }, fetchAudio);
    await loadAudioBlob({ id: 1, version: 'old', size: 4 }, fetchAudio);
    await loadAudioBlob({ id: 2, version: 'x', size: 4 }, fetchAudio);
    await pruneCache([{ id: 1, version: 'a' }]);
    expect(c.entries()).toEqual([cacheKey({ id: 1, version: 'a' })]);
  });

  it('pruneCache does nothing without Cache Storage', async () => {
    vi.stubGlobal('caches', undefined);
    await expect(pruneCache([])).resolves.toBeUndefined();
  });

  it('rejects a download shorter than the track, and does not keep it', async () => {
    const c = stubCaches();
    const fetchAudio = vi.fn(async () => audio());
    await expect(loadAudioBlob({ id: 1, version: 'a', size: 5 }, fetchAudio)).rejects.toThrow();
    expect(c.entries()).toEqual([]);
  });

  it('a wrong-sized cached copy is replaced by a fresh download', async () => {
    const c = stubCaches();
    await loadAudioBlob({ id: 1, version: 'a', size: 4 }, async () => audio());
    const longer = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4, 5]), { headers: { 'Content-Type': 'audio/mpeg' } }));
    const blob = await loadAudioBlob({ id: 1, version: 'a', size: 5 }, longer);
    expect(blob.size).toBe(5);
    expect(longer).toHaveBeenCalledTimes(1);
    const again = vi.fn(async () => audio());
    expect((await loadAudioBlob({ id: 1, version: 'a', size: 5 }, again)).size).toBe(5);
    expect(again).not.toHaveBeenCalled();
    expect(c.entries()).toEqual([cacheKey({ id: 1, version: 'a' })]);
  });

  it('skips the size check when the server reports no size', async () => {
    stubCaches();
    const blob = await loadAudioBlob({ id: 1, version: 'a', size: 0 }, async () => audio());
    expect(blob.size).toBe(4);
  });
});
