export const SNAP_MS = 100;

/** Round to the nearest 100 ms and clamp to 0..durationMs-100. */
export function snapMs(ms: number, durationMs: number): number {
  const max = Math.max(0, Math.floor((durationMs - SNAP_MS) / SNAP_MS) * SNAP_MS);
  const snapped = Math.round(ms / SNAP_MS) * SNAP_MS;
  return Math.min(max, Math.max(0, snapped));
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 42300 -> "0:42.3" */
export function formatMs(ms: number): string {
  const tenths = Math.floor(Math.max(0, ms) / 100);
  const totalSec = Math.floor(tenths / 10);
  return `${Math.floor(totalSec / 60)}:${pad2(totalSec % 60)}.${tenths % 10}`;
}

/** 7.4 -> "0:07" */
export function formatElapsed(sec: number): string {
  const total = Math.floor(Math.max(0, sec));
  return `${Math.floor(total / 60)}:${pad2(total % 60)}`;
}
