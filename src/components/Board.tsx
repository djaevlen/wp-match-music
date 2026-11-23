import { getBoot } from '@/boot';
import { useBoard } from '@/hooks/useBoard';
import { useQuickPlayKey } from '@/hooks/useQuickPlayKey';
import { cn } from '@/lib/utils';
import { strings } from '@/strings';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { AddTracks } from './AddTracks';
import { chip, FadeControl } from './FadeControl';
import { TrackList } from './TrackList';

export function Board() {
  const store = useBoard();
  useQuickPlayKey(store);
  const boot = getBoot();
  const rows = store.rows();
  const stillLoading = rows.some((r) => r.status === 'loading');

  return (
    <main className="mx-auto min-h-dvh max-w-6xl p-4 pb-[calc(env(safe-area-inset-bottom)+5rem)]">
      <header className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{strings.appTitle}</h1>
        <div className="flex items-center gap-2">
          {stillLoading && (
            <span className={chip} aria-live="polite">
              {strings.board.loadingProgress(store.loaded(), store.total())}
            </span>
          )}
          {/* The key only exists on a keyboard, so the hint stays off phone-width screens. */}
          <span className={cn(chip, 'hidden sm:inline')}>{strings.board.quickPlayHint}</span>
          <FadeControl store={store} canEdit={boot.canEdit} />
        </div>
      </header>

      {/* Non-blocking: any tap (this one included) starts the audio, and the hint goes. It
          comes back after an interruption, which also says why the music stopped. An overlay
          outside the flow, so showing or hiding it never moves a row under the operator's
          finger. The wrapper lets presses through (no invisible strip blocks a row); the chip
          itself takes them, so tapping it can never press a Play button underneath, and the
          window-level capture listeners still see the tap and unlock the audio. The constant
          bottom padding on main lets the last row scroll clear of the chip. */}
      {store.listed() && !store.audioRunning() && (
        <div
          role="status"
          className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]"
        >
          <div className="pointer-events-auto rounded-lg border border-amber-600 bg-amber-100 px-3 py-2 text-sm font-medium text-amber-950 shadow-lg dark:border-amber-400 dark:bg-amber-950 dark:text-amber-50">
            {strings.board.enableSound}
          </div>
        </div>
      )}

      {store.sessionExpired() && (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm"
        >
          <span>{strings.errors.sessionExpired}</span>
          {/* A new tab: leaving the board would stop the music (spec 7.9). */}
          <a className="font-medium underline underline-offset-4" href={boot.loginUrl} target="_blank" rel="noopener">
            {strings.board.logIn}
          </a>
        </div>
      )}

      {store.loadError() && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{strings.board.unreachable}</span>
          <Button variant="outline" size="sm" onClick={() => void store.refresh()}>
            {strings.board.retry}
          </Button>
        </div>
      )}

      <AddTracks store={store} canEdit={boot.canEdit}>
        {store.listed() && <TrackList rows={rows} store={store} canEdit={boot.canEdit} />}
      </AddTracks>
      <Toaster />
    </main>
  );
}
