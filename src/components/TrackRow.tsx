import { useEffect, useState, type ReactNode } from 'react';
import { Play, RotateCw, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { BoardRow, BoardStore, RowStatus } from '@/board-store';
import { formatElapsed, formatMs } from '@/lib/time';
import { strings } from '@/strings';
import { Button } from '@/components/ui/button';

const TICK_MS = 250;

export interface TrackRowProps {
  row: BoardRow;
  store: Pick<BoardStore, 'play' | 'stop' | 'retry' | 'elapsedSec'>;
  canEdit: boolean;
  /** Editor controls (Edit, drag handle); rendered only when canEdit. */
  editorSlot?: ReactNode;
}

/** Re-renders every `ms` while `active`. */
function useTick(active: boolean, ms: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const handle = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(handle);
  }, [active, ms]);
}

function statusText(status: RowStatus, startMs: number, elapsedSec: () => number): string {
  switch (status) {
    case 'ready':
      return strings.row.startsAt(formatMs(startMs));
    case 'playing':
      return strings.row.playing(formatElapsed(elapsedSec()));
    case 'fading':
      return strings.row.fading;
    case 'loading':
      return strings.row.loading;
    case 'error':
      return strings.row.loadFailed;
  }
}

const solidPlay = 'bg-emerald-600 text-white hover:bg-emerald-700';
const solidStop = 'bg-destructive text-white hover:bg-destructive/90';

export function TrackRow({ row, store, canEdit, editorSlot }: TrackRowProps) {
  const { track, status } = row;
  const id = track.id;
  useTick(status === 'playing', TICK_MS);

  const canPlay = status === 'ready' || status === 'playing' || status === 'fading';
  const canStop = status === 'playing' || status === 'fading';
  // Phone toggle: Stop only at full volume; once a fade begins it offers Play (spec 7.4).
  const toggleStops = status === 'playing';

  return (
    <div
      data-status={status}
      data-track-id={id}
      className={cn(
        'flex min-h-14 items-center gap-2 rounded-lg border bg-card px-3 py-2 transition-colors sm:min-h-0',
        'data-[status=playing]:border-emerald-500 data-[status=playing]:bg-emerald-500/10 data-[status=playing]:ring-1 data-[status=playing]:ring-emerald-500',
        'data-[status=fading]:border-amber-500 data-[status=fading]:border-dashed data-[status=fading]:bg-amber-500/10',
        'data-[status=error]:border-destructive/50',
      )}
    >
      <span className="min-w-0 flex-1 truncate font-medium">{track.name}</span>
      <span
        className={cn(
          'shrink-0 text-xs tabular-nums',
          status === 'error' ? 'text-destructive' : 'hidden text-muted-foreground sm:inline',
          status === 'fading' && 'text-amber-700 dark:text-amber-400',
        )}
      >
        {statusText(status, track.start_ms, () => store.elapsedSec(id))}
      </span>

      {status === 'error' ? (
        <Button variant="outline" onClick={() => store.retry(id)}>
          <RotateCw />
          {strings.row.retry}
        </Button>
      ) : (
        <>
          <div data-testid="row-wide-controls" className="hidden shrink-0 gap-1.5 sm:flex">
            <Button
              variant={status === 'playing' ? 'outline' : 'default'}
              className={cn(status !== 'playing' && canPlay && solidPlay)}
              disabled={!canPlay}
              onClick={() => store.play(id)}
            >
              <Play />
              {strings.row.play}
            </Button>
            <Button
              variant={canStop ? 'default' : 'outline'}
              className={cn(canStop && solidStop)}
              disabled={!canStop}
              onClick={() => store.stop(id)}
            >
              <Square />
              {strings.row.stop}
            </Button>
          </div>
          <Button
            data-testid="row-toggle"
            aria-label={toggleStops ? strings.row.stop : strings.row.play}
            className={cn('h-12 w-16 shrink-0 sm:hidden [&_svg]:size-6', toggleStops ? solidStop : solidPlay)}
            disabled={!canPlay}
            onClick={() => (toggleStops ? store.stop(id) : store.play(id))}
          >
            {toggleStops ? <Square /> : <Play />}
          </Button>
        </>
      )}

      {canEdit && editorSlot}
    </div>
  );
}
