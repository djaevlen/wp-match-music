import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import type { Track } from '@/api';
import { decodePeaks } from '@/audio/peaks';
import type { BoardRow, RowStatus } from '@/board-store';
import { EditTrackDialog, type EditTrackStore } from './EditTrackDialog';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/audio/peaks', () => ({ decodePeaks: vi.fn() }));

const track: Track = { id: 7, name: 'Goal', start_ms: 42300, quick_play: true, order: 1, size: 1000, version: 'a' };

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  vi.mocked(decodePeaks).mockResolvedValue({ peaks: new Float32Array(1200), durationSec: 200 });
  // jsdom draws nothing; the canvas is checked in the browser.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(toast.error).mockClear();
});

function fakeStore(rows: BoardRow[]) {
  const listeners = new Set<() => void>();
  const store = {
    current: rows,
    play: vi.fn(),
    stop: vi.fn(),
    positionSec: vi.fn(() => 0),
    durationSec: vi.fn(() => 200),
    audioBlob: vi.fn(async () => new Blob(['mp3'])),
    update: vi.fn(async (_id: number, _patch: { name?: string; start_ms?: number }) => {}),
    remove: vi.fn(async (_id: number) => {}),
    rows: () => store.current,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    /** The board changed: these are now its rows. */
    emit(next: BoardRow[]) {
      store.current = next;
      for (const l of [...listeners]) l();
    },
  };
  return store satisfies EditTrackStore;
}

async function open(status: RowStatus = 'ready', t: Track = track) {
  const row: BoardRow = { track: t, status };
  const store = fakeStore([row]);
  const onOpenChange = vi.fn();
  const view = render(<EditTrackDialog row={row} store={store} open onOpenChange={onOpenChange} />);
  await act(async () => {}); // the waveform decode settles
  const button = (name: string) => screen.getByRole('button', { name });
  const readout = () => screen.getByRole('status', { name: 'Start point' });
  const nameInput = () => screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
  const rerender = (next: BoardRow) =>
    view.rerender(<EditTrackDialog row={next} store={store} open onOpenChange={onOpenChange} />);
  return { store, onOpenChange, button, readout, nameInput, rerender };
}

test('shows the track as saved', async () => {
  const { readout, nameInput } = await open();
  expect(screen.getByRole('dialog', { name: 'Edit track' })).toBeInTheDocument();
  expect(nameInput().value).toBe('Goal');
  expect(readout()).toHaveTextContent('0:42.3');
});

test('opening focuses the dialog, not the name field (no phone keyboard over the waveform)', async () => {
  const { nameInput } = await open();
  expect(screen.getByRole('dialog')).toHaveFocus();
  expect(nameInput()).not.toHaveFocus();
});

test('nudges snap and clamp', async () => {
  const { button, readout } = await open();
  fireEvent.click(button('+ 0.1 s'));
  expect(readout()).toHaveTextContent('0:42.4');
  fireEvent.click(button('− 0.1 s'));
  fireEvent.click(button('− 0.1 s'));
  expect(readout()).toHaveTextContent('0:42.2');
  fireEvent.click(button('+ 1 s'));
  expect(readout()).toHaveTextContent('0:43.2');
  fireEvent.click(button('− 1 s'));
  expect(readout()).toHaveTextContent('0:42.2');
});

test('nudging below zero stops at 0:00.0', async () => {
  const { button, readout } = await open('ready', { ...track, start_ms: 500 });
  fireEvent.click(button('− 1 s'));
  expect(readout()).toHaveTextContent('0:00.0');
});

test('nudging past the end stops just before it', async () => {
  const { button, readout } = await open('ready', { ...track, start_ms: 199900 });
  fireEvent.click(button('+ 1 s'));
  expect(readout()).toHaveTextContent('3:19.9');
  fireEvent.click(button('+ 0.1 s'));
  expect(readout()).toHaveTextContent('3:19.9');
});

test('test plays the draft start', async () => {
  const { button, store } = await open();
  fireEvent.click(button('+ 0.1 s'));
  fireEvent.click(button('Test from start point'));
  expect(store.play).toHaveBeenCalledWith(7, 42400);
});

test('listen plays from zero', async () => {
  const { button, store } = await open();
  fireEvent.click(button('Listen from 0:00'));
  expect(store.play).toHaveBeenCalledWith(7, 0);
});

test('mark here uses the playback position', async () => {
  const { button, store, readout } = await open('playing');
  store.positionSec.mockReturnValue(51.26);
  fireEvent.click(button('Mark here'));
  expect(store.positionSec).toHaveBeenCalledWith(7);
  expect(readout()).toHaveTextContent('0:51.3');
});

test('mark here and stop need this track to be playing', async () => {
  const { button } = await open('ready');
  expect(button('Mark here')).toBeDisabled();
  expect(button('Stop')).toBeDisabled();
});

test('stop stops this track', async () => {
  const { button, store } = await open('playing');
  fireEvent.click(button('Stop'));
  expect(store.stop).toHaveBeenCalledWith(7);
});

test('save sends only the name when only the name changed', async () => {
  const { button, store, nameInput, onOpenChange } = await open();
  fireEvent.change(nameInput(), { target: { value: 'Goal 2' } });
  fireEvent.click(button('Save'));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(store.update).toHaveBeenCalledTimes(1);
  expect(store.update).toHaveBeenCalledWith(7, { name: 'Goal 2' });
});

test('save sends the name and the start point when both changed', async () => {
  const { button, store, nameInput, onOpenChange } = await open();
  fireEvent.change(nameInput(), { target: { value: 'Goal 2' } });
  fireEvent.click(button('+ 0.1 s'));
  fireEvent.click(button('Save'));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(store.update).toHaveBeenCalledWith(7, { name: 'Goal 2', start_ms: 42400 });
});

test('save sends only the start point when only the start point changed', async () => {
  const { button, store, onOpenChange } = await open();
  fireEvent.click(button('− 1 s'));
  fireEvent.click(button('Save'));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(store.update).toHaveBeenCalledWith(7, { start_ms: 41300 });
});

test('the name is sent exactly as typed', async () => {
  const { button, store, nameInput } = await open();
  fireEvent.change(nameInput(), { target: { value: '  <b>Tor</b> & "Jubel"  ' } });
  fireEvent.click(button('Save'));
  await waitFor(() => expect(store.update).toHaveBeenCalledWith(7, { name: '  <b>Tor</b> & "Jubel"  ' }));
});

test('save with nothing changed sends nothing and closes', async () => {
  const { button, store, onOpenChange } = await open();
  fireEvent.click(button('Save'));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(store.update).not.toHaveBeenCalled();
});

test('a failed save says why and keeps the draft open', async () => {
  const { button, store, nameInput, onOpenChange } = await open();
  store.update.mockRejectedValueOnce(new Error('Name is too long.'));
  fireEvent.change(nameInput(), { target: { value: 'Goal 2' } });
  fireEvent.click(button('Save'));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Name is too long.'));
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(nameInput().value).toBe('Goal 2');
  expect(button('Save')).toBeEnabled();
});

test('cancel sends nothing', async () => {
  const { button, store, nameInput, onOpenChange } = await open();
  fireEvent.change(nameInput(), { target: { value: 'Goal 2' } });
  fireEvent.click(button('+ 1 s'));
  fireEvent.click(button('Cancel'));
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(store.update).not.toHaveBeenCalled();
  expect(store.stop).not.toHaveBeenCalled(); // nothing was playing
});

test('blank name disables save', async () => {
  const { button, nameInput } = await open();
  fireEvent.change(nameInput(), { target: { value: '   ' } });
  expect(button('Save')).toBeDisabled();
  fireEvent.change(nameInput(), { target: { value: ' a ' } });
  expect(button('Save')).toBeEnabled();
});

test.each(['playing', 'fading'] as const)('closing stops a preview (%s)', async (status) => {
  const { button, store, onOpenChange } = await open(status);
  fireEvent.click(button('Cancel'));
  expect(store.stop).toHaveBeenCalledWith(7);
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test('closing with Escape stops a preview', async () => {
  const { store, onOpenChange } = await open('playing');
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(store.stop).toHaveBeenCalledWith(7);
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test('saving stops a preview', async () => {
  const { button, store, onOpenChange } = await open('playing');
  fireEvent.click(button('+ 0.1 s'));
  fireEvent.click(button('Save'));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(store.stop).toHaveBeenCalledWith(7);
});

test('delete needs confirmation', async () => {
  const { button, store, onOpenChange } = await open();
  fireEvent.click(button('Delete track'));
  const alert = await screen.findByRole('alertdialog');
  expect(store.remove).not.toHaveBeenCalled();
  fireEvent.click(within(alert).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(store.remove).not.toHaveBeenCalled();
  expect(onOpenChange).not.toHaveBeenCalled();

  fireEvent.click(button('Delete track'));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(store.remove).toHaveBeenCalledWith(7));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(toast.error).not.toHaveBeenCalled();
});

test('deleting a playing track stops it first', async () => {
  const { button, store } = await open('playing');
  const order: string[] = [];
  store.stop.mockImplementation(() => order.push('stop'));
  store.remove.mockImplementation(async () => {
    order.push('remove');
  });
  fireEvent.click(button('Delete track'));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(store.remove).toHaveBeenCalled());
  expect(order).toEqual(['stop', 'remove']);
});

test('the row going away after this dialog deleted it is not reported as a deletion elsewhere', async () => {
  const { button, store, onOpenChange } = await open();
  store.remove.mockImplementation(async () => store.emit([]));
  fireEvent.click(button('Delete track'));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(toast.error).not.toHaveBeenCalled();
});

test('a failed delete says why and keeps the dialog open', async () => {
  const { button, store, onOpenChange } = await open();
  store.remove.mockRejectedValueOnce(new Error('Forbidden.'));
  fireEvent.click(button('Delete track'));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Forbidden.'));
  expect(onOpenChange).not.toHaveBeenCalled();
});

test('a background refresh never overwrites the draft', async () => {
  const { button, nameInput, readout, rerender, store } = await open();
  fireEvent.change(nameInput(), { target: { value: 'Mine' } });
  fireEvent.click(button('+ 0.1 s'));
  const fromServer: BoardRow = { track: { ...track, name: 'Theirs', start_ms: 1000 }, status: 'ready' };
  act(() => store.emit([fromServer]));
  rerender(fromServer);
  expect(nameInput().value).toBe('Mine');
  expect(readout()).toHaveTextContent('0:42.4');
});

test('a track deleted on another device closes the dialog with a message', async () => {
  const { store, onOpenChange } = await open();
  act(() => store.emit([]));
  expect(toast.error).toHaveBeenCalledWith('Goal was deleted on another device.');
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(store.update).not.toHaveBeenCalled();
});

test('decodes the waveform once, from the track audio', async () => {
  const { store, button } = await open();
  fireEvent.click(button('+ 0.1 s'));
  await act(async () => {});
  expect(store.audioBlob).toHaveBeenCalledTimes(1);
  expect(store.audioBlob).toHaveBeenCalledWith(7);
  expect(decodePeaks).toHaveBeenCalledTimes(1);
});

test('a skeleton shows while the waveform decodes', async () => {
  let resolve!: (v: { peaks: Float32Array; durationSec: number }) => void;
  vi.mocked(decodePeaks).mockReturnValueOnce(new Promise((r) => (resolve = r)));
  const row: BoardRow = { track, status: 'ready' };
  render(<EditTrackDialog row={row} store={fakeStore([row])} open onOpenChange={() => {}} />);
  expect(await screen.findByTestId('waveform-skeleton')).toBeInTheDocument();
  await act(async () => resolve({ peaks: new Float32Array(1200), durationSec: 200 }));
  expect(screen.queryByTestId('waveform-skeleton')).toBeNull();
  expect(screen.getByTestId('waveform')).toBeInTheDocument();
});

test('if the waveform cannot be decoded, every other control still works', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(decodePeaks).mockRejectedValueOnce(new Error('EncodingError'));
  const { button, readout, store } = await open();
  expect(warn).toHaveBeenCalled();
  expect(screen.queryByTestId('waveform-skeleton')).toBeNull();
  expect(screen.getByTestId('waveform')).toBeInTheDocument();
  fireEvent.click(button('+ 1 s'));
  expect(readout()).toHaveTextContent('0:43.3');
  fireEvent.click(button('Test from start point'));
  expect(store.play).toHaveBeenCalledWith(7, 43300);
});

test('clicking the waveform sets the start point, snapped', async () => {
  const { readout } = await open();
  const wave = screen.getByTestId('waveform');
  vi.spyOn(wave, 'getBoundingClientRect').mockReturnValue({
    left: 100, width: 400, top: 0, height: 90, right: 500, bottom: 90, x: 100, y: 0, toJSON: () => ({}),
  });
  // 30% of 200 s is 60 s; 0.0123 of the width more is 2.46 s, snapped to 62.5 s
  fireEvent.pointerDown(wave, { clientX: 100 + 400 * 0.3123, pointerId: 1, button: 0 });
  expect(readout()).toHaveTextContent('1:02.5');
  fireEvent.pointerMove(wave, { clientX: 100 + 400 * 0.5, pointerId: 1, buttons: 1 });
  expect(readout()).toHaveTextContent('1:40.0');
  fireEvent.pointerUp(wave, { clientX: 100 + 400 * 0.5, pointerId: 1 });
  fireEvent.pointerMove(wave, { clientX: 100 + 400 * 0.9, pointerId: 1, buttons: 0 });
  expect(readout()).toHaveTextContent('1:40.0');
  fireEvent.pointerDown(wave, { clientX: 999, pointerId: 2, button: 0 });
  expect(readout()).toHaveTextContent('3:19.9');
});
