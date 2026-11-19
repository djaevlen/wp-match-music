import type { BoardRow } from '@/board-store';
import { strings } from '@/strings';
import { TrackRow, type TrackRowProps } from './TrackRow';

export interface TrackListProps {
  rows: BoardRow[];
  store: TrackRowProps['store'];
  canEdit: boolean;
}

/** One column; from `lg` two columns, filled top to bottom, then left to right. */
export function TrackList({ rows, store, canEdit }: TrackListProps) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{strings.board.noTracks}</p>;
  }
  return (
    <ul className="lg:columns-2 lg:gap-4">
      {rows.map((row) => (
        <li key={row.track.id} className="mb-2 break-inside-avoid">
          <TrackRow row={row} store={store} canEdit={canEdit} />
        </li>
      ))}
    </ul>
  );
}
