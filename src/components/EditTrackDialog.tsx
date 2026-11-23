import { useEffect, useId, useRef, useState } from 'react';
import { Play, Square } from 'lucide-react';
import { toast } from 'sonner';
import type { TrackPatch } from '@/api';
import { decodePeaks } from '@/audio/peaks';
import type { BoardRow, BoardStore } from '@/board-store';
import { inQuickPlay } from '@/lib/quick-pick';
import { formatMs, snapMs } from '@/lib/time';
import { strings } from '@/strings';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Waveform } from './Waveform';

export type EditTrackStore = Pick<
  BoardStore,
  'play' | 'stop' | 'positionSec' | 'durationSec' | 'audioBlob' | 'update' | 'remove' | 'rows' | 'subscribe'
>;

export interface EditTrackDialogProps {
  row: BoardRow;
  store: EditTrackStore;
  open: boolean;
  onOpenChange(open: boolean): void;
}

type Wave = { state: 'decoding' } | { state: 'ready'; peaks: Float32Array; durationMs: number } | { state: 'failed' };

const isActive = (row: BoardRow) => row.status === 'playing' || row.status === 'fading';
const message = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);

/**
 * Editors set a track's name and start point here. Everything is a draft until Save; previews
 * play through the board's own engine and voice, so Test sounds exactly like Play after saving.
 */
export function EditTrackDialog({ row, store, open, onOpenChange }: EditTrackDialogProps) {
  const latest = useRef(row);
  latest.current = row;

  // Every way out (Cancel, Save, Escape, the X, a click outside) stops this track's preview.
  const close = () => {
    if (isActive(latest.current)) store.stop(latest.current.track.id);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[620px]"
        // Focus the dialog, not the name field: on a phone that would open the keyboard over
        // the waveform, and setting the start point is what the dialog is mostly for.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).focus();
        }}
      >
        <EditTrackForm row={row} store={store} close={close} done={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/** Mounted while the dialog is open, so each opening starts a fresh draft from the saved track. */
function EditTrackForm({
  row,
  store,
  close,
  done,
}: {
  row: BoardRow;
  store: EditTrackStore;
  close: () => void;
  done: () => void;
}) {
  const id = row.track.id;
  const nameId = useId();
  const quickId = useId();
  const quickHelpId = useId();
  const [saved] = useState(() => ({
    name: row.track.name,
    startMs: row.track.start_ms,
    quickPlay: inQuickPlay(row.track),
  }));
  const [name, setName] = useState(saved.name);
  const [startMs, setStartMs] = useState(saved.startMs);
  const [quickPlay, setQuickPlay] = useState(saved.quickPlay);
  const [wave, setWave] = useState<Wave>({ state: 'decoding' });
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);

  const active = isActive(row);
  const canPlay = active || row.status === 'ready';
  const durationMs = Math.round(store.durationSec(id) * 1000) || (wave.state === 'ready' ? wave.durationMs : 0);

  // The waveform: decoded once per opening; only the peaks are kept.
  useEffect(() => {
    let live = true;
    store
      .audioBlob(id)
      .then((blob) => decodePeaks(blob))
      .then(
        ({ peaks, durationSec }) => live && setWave({ state: 'ready', peaks, durationMs: durationSec * 1000 }),
        (err: unknown) => {
          console.warn('Could not draw the waveform', err);
          if (live) setWave({ state: 'failed' });
        },
      );
    return () => {
      live = false;
    };
  }, [store, id]);

  // The playhead follows playback while this track sounds.
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const tick = () => {
      setPlayheadMs(store.positionSec(id) * 1000);
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [active, store, id]);

  // Deleted on another device: close with a message rather than fail on Save. The store tells
  // its listeners as soon as the row is gone; a deletion from this dialog is expected.
  const deleting = useRef(false);
  const handlers = useRef({ close, trackName: row.track.name });
  handlers.current = { close, trackName: row.track.name };
  useEffect(() => {
    let reported = false;
    return store.subscribe(() => {
      if (reported || deleting.current || store.rows().some((r) => r.track.id === id)) return;
      reported = true;
      toast.error(strings.editor.deletedElsewhere(handlers.current.trackName));
      handlers.current.close();
    });
  }, [store, id]);

  const setStart = (ms: number) => {
    if (durationMs > 0) setStartMs(snapMs(ms, durationMs));
  };
  const nudge = (deltaMs: number) => setStart(startMs + deltaMs);

  const save = async () => {
    const patch: TrackPatch = {};
    if (name !== saved.name) patch.name = name;
    if (startMs !== saved.startMs) patch.start_ms = startMs;
    if (quickPlay !== saved.quickPlay) patch.quick_play = quickPlay;
    if (Object.keys(patch).length === 0) return close();
    setBusy(true);
    try {
      await store.update(id, patch);
      close();
    } catch (err) {
      setBusy(false);
      toast.error(message(err, strings.editor.notSaved));
    }
  };

  const remove = async () => {
    deleting.current = true;
    setBusy(true);
    if (isActive(row)) store.stop(id);
    try {
      await store.remove(id);
      done();
    } catch (err) {
      deleting.current = false;
      setBusy(false);
      toast.error(message(err, strings.editor.notDeleted));
    }
  };

  const noDuration = durationMs <= 0;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{strings.editor.title}</DialogTitle>
      </DialogHeader>

      <div className="grid gap-1.5">
        <Label htmlFor={nameId}>{strings.editor.name}</Label>
        <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="grid gap-0.5">
          <Label htmlFor={quickId}>{strings.editor.quickPlay}</Label>
          <p id={quickHelpId} className="text-xs text-muted-foreground">
            {strings.editor.quickPlayHelp}
          </p>
        </div>
        <Switch id={quickId} aria-describedby={quickHelpId} checked={quickPlay} onCheckedChange={setQuickPlay} />
      </div>

      <div className="grid gap-1.5">
        <p className="text-xs text-muted-foreground">{strings.editor.startPointHelp}</p>
        {wave.state === 'decoding' ? (
          <div data-testid="waveform-skeleton" className="mb-5 h-[90px] animate-pulse rounded-lg bg-muted" />
        ) : (
          <Waveform
            peaks={wave.state === 'ready' ? wave.peaks : null}
            durationMs={durationMs}
            startMs={startMs}
            playheadMs={active ? playheadMs : null}
            onChange={setStart}
          />
        )}
      </div>

      <div className="grid grid-cols-[1fr_1fr_auto_1fr_1fr] items-center gap-1.5 sm:flex sm:flex-wrap">
        <Button variant="outline" className="px-1 sm:px-2.5" disabled={noDuration} onClick={() => nudge(-1000)}>
          {strings.editor.back1}
        </Button>
        <Button variant="outline" className="px-1 sm:px-2.5" disabled={noDuration} onClick={() => nudge(-100)}>
          {strings.editor.backTenth}
        </Button>
        <output
          aria-label={strings.editor.startPoint}
          aria-live="polite"
          className="rounded-md border bg-background px-3 py-0.5 text-center text-xl font-bold tabular-nums"
        >
          {formatMs(startMs)}
        </output>
        <Button variant="outline" className="px-1 sm:px-2.5" disabled={noDuration} onClick={() => nudge(100)}>
          {strings.editor.forwardTenth}
        </Button>
        <Button variant="outline" className="px-1 sm:px-2.5" disabled={noDuration} onClick={() => nudge(1000)}>
          {strings.editor.forward1}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap">
        <Button
          className="col-span-2 bg-emerald-600 text-white hover:bg-emerald-700"
          disabled={!canPlay}
          onClick={() => store.play(id, startMs)}
        >
          <Play />
          {strings.editor.test}
        </Button>
        <Button variant="outline" disabled={!canPlay} onClick={() => store.play(id, 0)}>
          <Play />
          {strings.editor.listen}
        </Button>
        <Button disabled={!active || noDuration} onClick={() => setStart(store.positionSec(id) * 1000)}>
          {strings.editor.markHere}
        </Button>
        <Button variant="outline" className="col-span-2" disabled={!active} onClick={() => store.stop(id)}>
          <Square />
          {strings.editor.stop}
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
        <Button variant="destructive" disabled={busy} onClick={() => setConfirming(true)}>
          {strings.editor.deleteTrack}
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" disabled={busy} onClick={close}>
            {strings.editor.cancel}
          </Button>
          <Button disabled={busy || name.trim() === ''} onClick={() => void save()}>
            {strings.editor.save}
          </Button>
        </div>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{strings.editor.deleteTitle(row.track.name)}</AlertDialogTitle>
            <AlertDialogDescription>{strings.editor.deleteText}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{strings.editor.cancel}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()}>
              {strings.editor.deleteConfirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
