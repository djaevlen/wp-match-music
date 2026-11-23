/** Whether Space may pick this track. Only an explicit false keeps it out, so a track sent
 *  without the field (an older plugin behind a newer board) still counts as in. */
export const inQuickPlay = (t: { quick_play?: boolean }): boolean => t.quick_play !== false;

/**
 * The next quick-play track: a random pool track not yet played this round. When every pool
 * track has been played a new round starts, and it never opens with `last` (the track played
 * most recently) unless that is the only one. Null when the pool is empty.
 * `random` returns a number in [0, 1), as Math.random does.
 */
export function pickNext(
  pool: readonly number[],
  played: ReadonlySet<number>,
  last: number | null,
  random: () => number,
): { id: number; newRound: boolean } | null {
  if (pool.length === 0) return null;
  let candidates = pool.filter((id) => !played.has(id));
  const newRound = candidates.length === 0;
  if (newRound) {
    candidates = pool.filter((id) => id !== last);
    if (candidates.length === 0) candidates = [...pool];
  }
  return { id: candidates[Math.floor(random() * candidates.length)], newRound };
}
