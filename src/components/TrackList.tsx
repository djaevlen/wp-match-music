import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useState } from 'react';
import { EllipsisVertical, GripVertical, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import type { BoardRow, BoardStore } from '@/board-store';
import { moveId } from '@/lib/reorder';
import { cn } from '@/lib/utils';
import { strings } from '@/strings';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EditTrackDialog, type EditTrackStore } from './EditTrackDialog';
import { TrackRow, type TrackRowProps } from './TrackRow';

export interface TrackListProps {
  rows: BoardRow[];
  store: TrackRowProps['store'] & Pick<BoardStore, 'reorder'> & EditTrackStore;
  canEdit: boolean;
}

/** A drop of track `activeId` on `overId`: save the new order, or say it was not saved. */
export function dropReorder(
  ids: number[],
  activeId: number,
  overId: number | null,
  store: Pick<BoardStore, 'reorder'>,
): void {
  if (overId === null || overId === activeId) return;
  store.reorder(moveId(ids, activeId, overId)).catch(() => toast.error(strings.editor.orderNotSaved));
}

/**
 * An editor's row: Edit (wide) or a small menu holding it (narrow), and the drag handle, the
 * only element that starts a drag, so the row's buttons keep their clicks.
 */
function SortableRow({
  row,
  store,
  canEdit,
  onEdit,
}: { row: BoardRow; onEdit: () => void } & Omit<TrackListProps, 'rows'>) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: row.track.id,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('relative', isDragging && 'z-10 opacity-90 shadow-lg')}
    >
      <TrackRow
        row={row}
        store={store}
        canEdit={canEdit}
        editorSlot={
          <>
            <Button
              variant="outline"
              className="hidden sm:inline-flex"
              aria-label={strings.editor.editTrack(row.track.name)}
              onClick={onEdit}
            >
              <Pencil />
              {strings.editor.edit}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-lg"
                  className="text-muted-foreground sm:hidden"
                  aria-label={strings.editor.moreFor(row.track.name)}
                >
                  <EllipsisVertical className="size-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-auto">
                <DropdownMenuItem onSelect={onEdit}>
                  <Pencil />
                  {strings.editor.edit}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              ref={setActivatorNodeRef}
              aria-label={strings.editor.reorder(row.track.name)}
              className="-mr-1 flex size-9 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:bg-muted active:cursor-grabbing"
              {...attributes}
              {...listeners}
            >
              <GripVertical className="size-5" />
            </button>
          </>
        }
      />
    </li>
  );
}

/**
 * One column; from `lg` two columns, filled top to bottom, then left to right. The two columns
 * are explicit lists (split at the midpoint) so that dragging can sort across them; stacked
 * below `lg` they read in the same order.
 */
export function TrackList({ rows, store, canEdit }: TrackListProps) {
  const [editing, setEditing] = useState<number | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{strings.board.noTracks}</p>;
  }

  const ids = rows.map((r) => r.track.id);
  const half = Math.ceil(rows.length / 2);
  const columns = [rows.slice(0, half), rows.slice(half)].filter((c) => c.length > 0);

  const onDragEnd = ({ active, over }: DragEndEvent) =>
    dropReorder(ids, Number(active.id), over ? Number(over.id) : null, store);

  const grid = (
    <div className="grid gap-2 lg:grid-cols-2 lg:gap-x-4">
      {columns.map((column, index) => (
        <ul key={index} className="grid content-start gap-2">
          {column.map((row) =>
            canEdit ? (
              <SortableRow
                key={row.track.id}
                row={row}
                store={store}
                canEdit
                onEdit={() => setEditing(row.track.id)}
              />
            ) : (
              <li key={row.track.id}>
                <TrackRow row={row} store={store} canEdit={false} />
              </li>
            ),
          )}
        </ul>
      ))}
    </div>
  );

  if (!canEdit) return grid;
  const editRow = rows.find((r) => r.track.id === editing);
  return (
    <>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={rectSortingStrategy}>
          {grid}
        </SortableContext>
      </DndContext>
      {editRow && (
        <EditTrackDialog
          key={editRow.track.id}
          row={editRow}
          store={store}
          open
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
    </>
  );
}
