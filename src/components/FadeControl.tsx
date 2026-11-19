import { useRef, useState } from 'react';
import { toast } from 'sonner';
import type { BoardStore } from '@/board-store';
import { strings } from '@/strings';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';

export const chip = 'rounded-md border px-2 py-0.5 text-xs whitespace-nowrap text-muted-foreground tabular-nums';

const MAX_MS = 10_000;
const STEP_MS = 500;

export interface FadeControlProps {
  store: Pick<BoardStore, 'fadeMs' | 'saveFade'>;
  canEdit: boolean;
}

const label = (ms: number) => strings.board.fade((ms / 1000).toFixed(1));

/** The global fade: a slider in a popover for editors, plain text for everyone else. */
export function FadeControl({ store, canEdit }: FadeControlProps) {
  // The value being dragged or saved; null once the store's own value is the one to show.
  const [draft, setDraft] = useState<number | null>(null);
  // Saves go one after another (keyboard steps arrive faster than the server answers), so the
  // last value chosen is the last one stored; the draft is dropped when none is left waiting.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const waiting = useRef(0);
  const ms = draft ?? store.fadeMs();

  if (!canEdit) return <span className={chip}>{label(ms)}</span>;

  const commit = (value: number) => {
    setDraft(value);
    waiting.current++;
    queue.current = queue.current.then(async () => {
      try {
        await store.saveFade(value);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : strings.editor.fadeNotSaved);
      } finally {
        if (--waiting.current === 0) setDraft(null);
      }
    });
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={`${chip} h-auto`}>
          {label(ms)}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <Slider
          aria-label={strings.editor.fadeLabel}
          min={0}
          max={MAX_MS}
          step={STEP_MS}
          value={[ms]}
          onValueChange={([v]) => setDraft(v)}
          onValueCommit={([v]) => commit(v)}
        />
      </PopoverContent>
    </Popover>
  );
}
