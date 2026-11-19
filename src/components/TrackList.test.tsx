import { fireEvent, render, screen } from '@testing-library/react';
import type { BoardRow } from '@/board-store';
import { TrackList } from './TrackList';

const rows: BoardRow[] = [1, 2, 3, 4, 5].map((id) => ({
  track: { id, name: `Track ${id}`, start_ms: 0, order: id, size: 1, version: 'a' },
  status: 'ready',
}));
const store = () => ({ play: vi.fn(), stop: vi.fn(), retry: vi.fn(), elapsedSec: () => 0, reorder: vi.fn(async () => {}) });

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

test('clicking a row button plays and never reorders', () => {
  const s = store();
  render(<TrackList rows={rows} store={s} canEdit />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Play' })[0]);
  expect(s.play).toHaveBeenCalledWith(1);
  expect(s.reorder).not.toHaveBeenCalled();
});
