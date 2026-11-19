import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { formatElapsed, formatMs } from '@/lib/time';

export interface WaveformProps {
  /** Loudest sample per slice of the track; null draws a plain bar (the audio could not be decoded). */
  peaks: Float32Array | null;
  durationMs: number;
  startMs: number;
  /** Where playback is, while this track plays. */
  playheadMs: number | null;
  /** A click or drag at this point of the track (not yet snapped). */
  onChange(startMs: number): void;
}

const pct = (ms: number, durationMs: number) =>
  durationMs > 0 ? `${Math.min(100, Math.max(0, (ms / durationMs) * 100))}%` : '0%';

/** Axis labels: whole steps that give at most five labels, plus the length at the end. */
function axisTicks(durationMs: number): number[] {
  const steps = [5, 10, 15, 30, 60, 120, 300, 600].map((s) => s * 1000);
  const step = steps.find((s) => durationMs / s <= 5) ?? steps[steps.length - 1];
  const ticks: number[] = [];
  for (let t = 0; t < durationMs * 0.9; t += step) ticks.push(t);
  return ticks;
}

function draw(canvas: HTMLCanvasElement, peaks: Float32Array | null, width: number, height: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const w = canvas.width;
  const h = canvas.height;
  const mid = h / 2;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = getComputedStyle(canvas).color;

  let loudest = 0;
  if (peaks) for (const p of peaks) loudest = Math.max(loudest, p);
  if (!peaks || loudest === 0) {
    const bar = Math.max(1, Math.round(2 * ratio));
    ctx.fillRect(0, Math.round(mid - bar / 2), w, bar);
    return;
  }
  const reach = mid - 2 * ratio;
  const n = peaks.length;
  for (let x = 0; x < w; x++) {
    const from = Math.floor((x * n) / w);
    const to = Math.max(from + 1, Math.floor(((x + 1) * n) / w));
    let peak = 0;
    for (let i = from; i < to; i++) peak = Math.max(peak, peaks[i]);
    const half = Math.max(ratio / 2, (peak / loudest) * reach);
    ctx.fillRect(x, mid - half, 1, half * 2);
  }
}

/**
 * The track's waveform with its start point: a red line over a canvas, the part before it
 * dimmed. Pressing anywhere moves the start point there; dragging moves it along.
 */
export function Waveform({ peaks, durationMs, startMs, playheadMs, onChange }: WaveformProps) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const dragging = useRef<number | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (canvas.current && size.width > 0) draw(canvas.current, peaks, size.width, size.height);
  }, [peaks, size]);

  const pick = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || durationMs <= 0) return;
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onChange(fraction * durationMs);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragging.current = e.pointerId;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pick(e.clientX);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current === e.pointerId) pick(e.clientX);
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current === e.pointerId) dragging.current = null;
  };

  const start = pct(startMs, durationMs);
  const labelOnLeft = durationMs > 0 && startMs / durationMs > 0.8;

  return (
    <div>
      <div
        ref={box}
        data-testid="waveform"
        className="relative h-[90px] cursor-pointer touch-none overflow-hidden rounded-lg border bg-background select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <canvas ref={canvas} aria-hidden className="absolute inset-0 size-full text-muted-foreground" />
        <div aria-hidden className="absolute inset-y-0 left-0 bg-background/65" style={{ width: start }} />
        {playheadMs !== null && (
          <div
            aria-hidden
            data-testid="waveform-playhead"
            className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-emerald-600"
            style={{ left: pct(playheadMs, durationMs) }}
          />
        )}
        <div aria-hidden className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-destructive" style={{ left: start }}>
          <span
            className={`absolute top-1 rounded bg-destructive px-1.5 py-px text-[11px] font-semibold whitespace-nowrap text-white tabular-nums ${labelOnLeft ? 'right-1.5' : 'left-1.5'}`}
          >
            {formatMs(startMs)}
          </span>
        </div>
      </div>
      {durationMs > 0 && (
        <div aria-hidden className="relative mt-1 h-4 text-[11px] text-muted-foreground tabular-nums">
          {axisTicks(durationMs).map((t) => (
            <span
              key={t}
              className={`absolute ${t === 0 ? '' : '-translate-x-1/2'}`}
              style={{ left: pct(t, durationMs) }}
            >
              {formatElapsed(t / 1000)}
            </span>
          ))}
          <span className="absolute right-0">{formatElapsed(durationMs / 1000)}</span>
        </div>
      )}
    </div>
  );
}
