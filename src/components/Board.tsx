import { getBoot } from '@/boot';
import { useBoard } from '@/hooks/useBoard';
import { strings } from '@/strings';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { AddTracks } from './AddTracks';
import { chip, FadeControl } from './FadeControl';
import { TrackList } from './TrackList';

export function Board() {
  const store = useBoard();
  const boot = getBoot();
  const rows = store.rows();
  const stillLoading = rows.some((r) => r.status === 'loading');

  return (
    <main className="mx-auto min-h-dvh max-w-6xl p-4">
      <header className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{strings.appTitle}</h1>
        <div className="flex items-center gap-2">
          {stillLoading && (
            <span className={chip} aria-live="polite">
              {strings.board.loadingProgress(store.loaded(), store.total())}
            </span>
          )}
          <FadeControl store={store} canEdit={boot.canEdit} />
        </div>
      </header>

      {/* Non-blocking: any tap (this one included) starts the audio, and the hint goes. It
          comes back after an interruption, which also says why the music stopped. An overlay
          outside the flow, so showing or hiding it never moves a row under the operator's
          finger; pointer-events-none lets every press reach what is underneath, and the
          window-level gesture listeners see it either way. */}
      {store.listed() && !store.audioRunning() && (
        <div
          role="status"
          className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]"
        >
          <div className="rounded-lg border border-amber-600 bg-amber-100 px-3 py-2 text-sm font-medium text-amber-950 shadow-lg dark:border-amber-400 dark:bg-amber-950 dark:text-amber-50">
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
