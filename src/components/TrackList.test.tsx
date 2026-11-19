import { act, fireEvent, render, screen } from '@testing-library/react';
import type { BoardRow } from '@/board-store';
import { toast } from 'sonner';
import { dropReorder, TrackList } from './TrackList';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/audio/peaks', () => ({ decodePeaks: vi.fn(async () => ({ peaks: new Float32Array(10), durationSec: 30 })) }));

const rows: BoardRow[] = [1, 2, 3, 4, 5].map((id) => ({
  track: { id, name: `Track ${id}`, start_ms: 0, order: id, size: 1, version: 'a' },
  status: 'ready',
}));
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => vi.restoreAllMocks());

const store = () => ({
  play: vi.fn(),
  stop: vi.fn(),
  retry: vi.fn(),
  elapsedSec: () => 0,
  reorder: vi.fn(async () => {}),
  positionSec: () => 0,
  durationSec: () => 30,
  audioBlob: async () => new Blob(['mp3']),
  update: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  rows: () => rows,
  subscribe: () => () => {},
});

test('rows keep their order, split into a left and a right column at the midpoint', () => {
  const { container } = render(<TrackList rows={rows} store={store()} canEdit={false} />);
  const lists = container.querySelectorAll('ul');
  expect(lists).toHaveLength(2);
  const idsIn = (ul: Element) => [...ul.querySelectorAll('[data-track-id]')].map((e) => e.getAttribute('data-track-id'));
  expect(idsIn(lists[0])).toEqual(['1', '2', '3']);
  expect(idsIn(lists[1])).toEqual(['4', '5']);
});

test('editors get a named drag handle on every row', () => {
  render(<TrackList rows={rows} store={store()} canEdit />);
  expect(screen.getAllByRole('button', { name: /^Reorder / })).toHaveLength(5);
  expect(screen.getByRole('button', { name: 'Reorder Track 3' })).toBeInTheDocument();
});

test('viewers get no drag handles', () => {
  render(<TrackList rows={rows} store={store()} canEdit={false} />);
  expect(screen.queryByRole('button', { name: /^Reorder / })).toBeNull();
});

test('editors get an Edit button on every wide row and a menu on every narrow row', () => {
  render(<TrackList rows={rows} store={store()} canEdit />);
  expect(screen.getAllByRole('button', { name: /^Edit Track / })).toHaveLength(5);
  expect(screen.getAllByRole('button', { name: /^More for Track / })).toHaveLength(5);
});

test('viewers never see Edit or the row menu', () => {
  render(<TrackList rows={rows} store={store()} canEdit={false} />);
  expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /^More for/ })).toBeNull();
});

test('Edit opens the editor for that track', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); // jsdom draws nothing
  render(<TrackList rows={rows} store={store()} canEdit />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit Track 3' }));
  await act(async () => {});
  const dialog = screen.getByRole('dialog', { name: 'Edit track' });
  expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Track 3');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(dialog).not.toBeInTheDocument();
});

test('the row menu opens the editor too', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  render(<TrackList rows={rows} store={store()} canEdit />);
  const trigger = screen.getByRole('button', { name: 'More for Track 2' });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
  await act(async () => {});
  expect(screen.getByRole('dialog', { name: 'Edit track' })).toBeInTheDocument();
  expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Track 2');
});

test('clicking a row button plays and never reorders', () => {
  const s = store();
  render(<TrackList rows={rows} store={s} canEdit />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Play' })[0]);
  expect(s.play).toHaveBeenCalledWith(1);
  expect(s.reorder).not.toHaveBeenCalled();
});

describe('dropping a dragged row', () => {
  const ids = [1, 2, 3, 4];

  test('saves the moved order', () => {
    const s = store();
    dropReorder(ids, 4, 2, s);
    expect(s.reorder).toHaveBeenCalledTimes(1);
    expect(s.reorder).toHaveBeenCalledWith([1, 4, 2, 3]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  test('says so when the order could not be saved', async () => {
    const s = { reorder: vi.fn(async () => Promise.reject(new Error('no'))) };
    dropReorder(ids, 1, 3, s);
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('The new order could not be saved.'));
  });

  test('dropping on the same place or outside any row does nothing', () => {
    const s = store();
    dropReorder(ids, 2, 2, s);
    dropReorder(ids, 2, null, s);
    expect(s.reorder).not.toHaveBeenCalled();
  });
});
