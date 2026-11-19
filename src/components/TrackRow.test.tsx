import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { Track } from '@/api';
import type { RowStatus } from '@/board-store';
import { TrackRow } from './TrackRow';

const track: Track = { id: 7, name: 'Goal', start_ms: 42300, order: 1, size: 1000, version: 'a' };

function renderRow(status: RowStatus, { canEdit = false, editorSlot = undefined as React.ReactNode } = {}) {
  const store = {
    play: vi.fn(),
    stop: vi.fn(),
    retry: vi.fn(),
    elapsedSec: vi.fn(() => 7.4),
  };
  const view = render(<TrackRow row={{ track, status }} store={store} canEdit={canEdit} editorSlot={editorSlot} />);
  const root = view.container.querySelector('[data-track-id]') as HTMLElement;
  const wide = (name: 'Play' | 'Stop') => within(screen.getByTestId('row-wide-controls')).getByRole('button', { name });
  return { store, root, wide, toggle: () => screen.getByTestId('row-toggle'), unmount: view.unmount };
}

test('ready', () => {
  const { root, wide, toggle, store } = renderRow('ready');
  expect(root).toHaveAttribute('data-status', 'ready');
  expect(root).toHaveAttribute('data-track-id', '7');
  expect(root).toHaveTextContent('Goal');
  expect(root).toHaveTextContent('starts 0:42.3');
  expect(wide('Play')).toBeEnabled();
  expect(wide('Stop')).toBeDisabled();
  expect(toggle()).toHaveAccessibleName('Play');
  fireEvent.click(wide('Play'));
  expect(store.play).toHaveBeenCalledWith(7);
  fireEvent.click(toggle());
  expect(store.play).toHaveBeenCalledTimes(2);
});

test('playing', () => {
  const { root, wide, toggle, store } = renderRow('playing');
  expect(root).toHaveAttribute('data-status', 'playing');
  expect(root).toHaveTextContent(/0:07 playing/);
  expect(wide('Stop')).toBeEnabled();
  expect(toggle()).toHaveAccessibleName('Stop');
  fireEvent.click(toggle());
  expect(store.stop).toHaveBeenCalledWith(7);
  fireEvent.click(wide('Stop'));
  expect(store.stop).toHaveBeenCalledTimes(2);
});

test('playing time updates while the track plays', () => {
  vi.useFakeTimers();
  try {
    const { root, store } = renderRow('playing');
    store.elapsedSec.mockReturnValue(9.1);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(root).toHaveTextContent(/0:09 playing/);
  } finally {
    vi.useRealTimers();
  }
});

test('fading', () => {
  const { root, wide, toggle, store } = renderRow('fading');
  expect(root).toHaveAttribute('data-status', 'fading');
  expect(root).toHaveTextContent('fading');
  expect(wide('Stop')).toBeEnabled();
  expect(toggle()).toHaveAccessibleName('Play');
  fireEvent.click(toggle());
  expect(store.play).toHaveBeenCalledWith(7);
});

test('loading', () => {
  const { root, wide, toggle } = renderRow('loading');
  expect(root).toHaveAttribute('data-status', 'loading');
  expect(wide('Play')).toBeDisabled();
  expect(wide('Stop')).toBeDisabled();
  expect(toggle()).toBeDisabled();
});

test('error', () => {
  const { root, store } = renderRow('error');
  expect(root).toHaveAttribute('data-status', 'error');
  expect(root).toHaveTextContent('Could not load');
  expect(screen.queryByRole('button', { name: 'Play' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(store.retry).toHaveBeenCalledWith(7);
});

test('viewer sees no editor controls', () => {
  const slot = <button type="button">Edit</button>;
  const viewer = renderRow('ready', { canEdit: false, editorSlot: slot });
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  viewer.unmount();
  renderRow('ready', { canEdit: true, editorSlot: slot });
  expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
});
