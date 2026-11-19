import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Upload } from 'lucide-react';
import { toast } from 'sonner';
import type { BoardStore } from '@/board-store';
import { cn } from '@/lib/utils';
import { strings } from '@/strings';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';

export interface AddTracksProps {
  store: Pick<BoardStore, 'upload'>;
  canEdit: boolean;
  /** The list; for editors it becomes the drop zone. */
  children: ReactNode;
}

const isMp3 = (file: File) => file.name.toLowerCase().endsWith('.mp3');
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/** Editors: the Add mp3 button, a drop zone around the list and per-file upload progress. */
export function AddTracks({ store, canEdit, children }: AddTracksProps) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<Map<File, number>>(new Map());
  const [over, setOver] = useState(false);

  if (!canEdit) return <>{children}</>;

  const send = async (chosen: File[]) => {
    const files = chosen.filter(isMp3);
    for (const f of chosen) if (!isMp3(f)) toast.error(strings.editor.notMp3(f.name));
    if (files.length === 0) return;
    setProgress((p) => new Map([...p, ...files.map((f) => [f, 0] as const)]));
    try {
      const results = await store.upload(files, (file, fraction) =>
        setProgress((p) => (p.has(file) ? new Map(p).set(file, fraction) : p)),
      );
      for (const r of results) if (r.error) toast.error(r.error);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress((p) => {
        const next = new Map(p);
        for (const f of files) next.delete(f);
        return next;
      });
    }
  };

  return (
    <div
      className={cn('rounded-lg', over && 'ring-2 ring-primary ring-offset-4 ring-offset-background')}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(false);
        void send(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => input.current?.click()}>
          <Upload />
          {strings.editor.addMp3}
        </Button>
        {over && <span className="text-sm text-muted-foreground">{strings.editor.dropHere}</span>}
        <input
          ref={input}
          type="file"
          hidden
          multiple
          accept=".mp3,audio/mpeg"
          onChange={(e) => {
            void send(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>

      {progress.size > 0 && (
        <ul className="mb-3 grid gap-2" aria-live="polite">
          {[...progress].map(([file, fraction]) => (
            <li key={`${file.name}:${file.size}:${file.lastModified}`} className="grid gap-1 text-sm">
              <span className="truncate">{file.name}</span>
              <Progress value={Math.round(fraction * 100)} aria-label={file.name} />
            </li>
          ))}
        </ul>
      )}

      {children}
    </div>
  );
}
