import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Toaster } from '@/components/ui/sonner';
import { AddTracks } from './AddTracks';

const file = (name: string) => new File(['x'], name, { type: name.endsWith('.txt') ? 'text/plain' : 'audio/mpeg' });

function setup(upload = vi.fn(async (files: File[]) => files.map((f) => ({ file: f })))) {
  const view = render(
    <>
      <Toaster />
      <AddTracks store={{ upload }} canEdit>
        <p>the list</p>
      </AddTracks>
    </>,
  );
  return { upload, ...view };
}

test('non-mp3 files are refused locally', async () => {
  const { upload } = setup();
  const notes = file('notes.txt');
  const mp3 = file('a.MP3');
  fireEvent.drop(screen.getByText('the list'), { dataTransfer: { files: [notes, mp3], types: ['Files'] } });
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  expect(upload.mock.calls[0][0]).toEqual([mp3]);
  expect(await screen.findByText('notes.txt is not an mp3 file.')).toBeInTheDocument();
});

test('only refused files: nothing is uploaded', async () => {
  const { upload } = setup();
  fireEvent.drop(screen.getByText('the list'), { dataTransfer: { files: [file('n.txt')], types: ['Files'] } });
  expect(await screen.findByText('n.txt is not an mp3 file.')).toBeInTheDocument();
  expect(upload).not.toHaveBeenCalled();
});

test('server errors are shown per file', async () => {
  const big = file('big.mp3');
  const { upload } = setup(vi.fn(async () => [{ file: big, error: 'Too large (limit 8 MB)' }]));
  fireEvent.drop(screen.getByText('the list'), { dataTransfer: { files: [big], types: ['Files'] } });
  expect(await screen.findByText('Too large (limit 8 MB)')).toBeInTheDocument();
  expect(upload).toHaveBeenCalledTimes(1);
});

test('the picker takes several mp3 files and uploads the chosen ones', async () => {
  const { upload, container } = setup();
  const input = container.querySelector('input[type=file]') as HTMLInputElement;
  expect(input).toHaveAttribute('accept', '.mp3,audio/mpeg');
  expect(input).toHaveAttribute('multiple');
  const a = file('a.mp3');
  const b = file('b.mp3');
  fireEvent.change(input, { target: { files: [a, b] } });
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  expect(upload.mock.calls[0][0]).toEqual([a, b]);
});

test('shows a progress bar for the file being uploaded', async () => {
  let finish!: () => void;
  const a = file('a.mp3');
  const upload = vi.fn(
    (_files: File[], onProgress: (f: File, n: number) => void) =>
      new Promise<Array<{ file: File }>>((resolve) => {
        onProgress(a, 0.5);
        finish = () => resolve([{ file: a }]);
      }),
  );
  setup(upload as never);
  fireEvent.drop(screen.getByText('the list'), { dataTransfer: { files: [a], types: ['Files'] } });
  const bar = await screen.findByRole('progressbar');
  expect(bar).toHaveAttribute('aria-valuenow', '50');
  expect(screen.getByText('a.mp3')).toBeInTheDocument();
  finish();
  await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
});

test('hidden for viewers', () => {
  render(
    <AddTracks store={{ upload: vi.fn() }} canEdit={false}>
      <p>the list</p>
    </AddTracks>,
  );
  expect(screen.queryByRole('button', { name: 'Add mp3' })).toBeNull();
  expect(screen.getByText('the list')).toBeInTheDocument();
});
