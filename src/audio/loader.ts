export const CACHE_NAME = 'match-music-audio-v1';

type TrackRef = { id: number; version: string };

/** Cache Storage key: changes whenever the track's file does. */
export function cacheKey(t: TrackRef): string {
  return `/mm-audio/${t.id}/${t.version}`;
}

let persistAsked = false;

function askForPersistence(): void {
  if (persistAsked) return;
  persistAsked = true;
  try {
    navigator.storage?.persist?.().catch(() => {});
  } catch {
    // Persistence is a nicety.
  }
}

/** The audio cache, or null when Cache Storage is missing or refuses to open. */
async function openCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

/** True when the blob has the size the server reported (0 means the server does not know). */
const rightSize = (blob: Blob, size: number) => size <= 0 || blob.size === size;

/**
 * The track's mp3 as a Blob: from Cache Storage when present, otherwise
 * downloaded once and stored. Without a working Cache Storage it is a plain fetch.
 * A download whose size differs from the track's is rejected and never kept (the row shows
 * its error and Retry), since a cached copy is never fetched again for that version.
 */
export async function loadAudioBlob(
  t: TrackRef & { size: number },
  fetchAudio: (id: number) => Promise<Response>,
): Promise<Blob> {
  askForPersistence();
  const key = cacheKey(t);
  const cache = await openCache();

  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const blob = await hit.blob();
        if (rightSize(blob, t.size)) return blob;
        await cache.delete(key); // kept before sizes were checked: fetch it again
      }
    } catch {
      // Treat an unreadable cache as a miss.
    }
  }

  const blob = await (await fetchAudio(t.id)).blob();
  if (!rightSize(blob, t.size)) {
    throw new Error(`Track ${t.id}: downloaded ${blob.size} bytes, expected ${t.size}`);
  }
  if (cache) {
    try {
      await cache.put(key, new Response(blob, { headers: { 'Content-Type': blob.type || 'audio/mpeg' } }));
    } catch {
      // Out of quota or blocked: the audio still plays, it just is not kept.
    }
  }
  return blob;
}

/** Deletes every cached track that is not in `keep`. */
export async function pruneCache(keep: TrackRef[]): Promise<void> {
  const cache = await openCache();
  if (!cache) return;
  try {
    const wanted = new Set(keep.map(cacheKey));
    for (const request of await cache.keys()) {
      const { pathname } = new URL(request.url, location.href);
      if (!wanted.has(pathname)) await cache.delete(request);
    }
  } catch {
    // Pruning is housekeeping; ignore failures.
  }
}
