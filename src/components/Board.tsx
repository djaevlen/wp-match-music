import { getBoot } from '@/boot';
import { useBoard } from '@/hooks/useBoard';
import { strings } from '@/strings';
import { TrackList } from './TrackList';

const chip = 'rounded-md border px-2 py-0.5 text-xs whitespace-nowrap text-muted-foreground tabular-nums';

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
          <span className={chip}>{strings.board.fade((store.fadeMs() / 1000).toFixed(1))}</span>
        </div>
      </header>

      {store.sessionExpired() && (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm"
        >
          <span>{strings.errors.sessionExpired}</span>
          <a className="font-medium underline underline-offset-4" href={boot.loginUrl}>
            {strings.board.logIn}
          </a>
        </div>
      )}

      {store.listed() && <TrackList rows={rows} store={store} canEdit={boot.canEdit} />}
    </main>
  );
}
