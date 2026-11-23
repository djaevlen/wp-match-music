import { fireEvent, render, screen } from '@testing-library/react';
import type { BoardStore } from '@/board-store';
import { Board } from './Board';

const fake = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('@/hooks/useBoard', () => ({ useBoard: () => fake.store }));

function fakeStore(overrides: Partial<Record<keyof BoardStore, unknown>> = {}) {
  const store = {
    rows: () => [],
    fadeMs: () => 2000,
    loaded: () => 0,
    total: () => 0,
    listed: () => false,
    loadError: () => false,
    sessionExpired: () => false,
    audioRunning: () => true,
    refresh: vi.fn(async () => {}),
    play: vi.fn(),
    stop: vi.fn(),
    retry: vi.fn(),
    elapsedSec: () => 0,
    ...overrides,
  };
  fake.store = store;
  return store;
}

beforeEach(() => {
  window.MatchMusicBoot = {
    restUrl: '/wp-json/match-music/v1/',
    nonce: 'n',
    nonceUrl: '/nonce',
    canEdit: false,
    maxUploadBytes: 1000,
    loginUrl: '/wp-login.php?redirect_to=board',
    fadeMs: 2000,
  };
});
afterEach(() => {
  delete window.MatchMusicBoot;
});

test('an unreachable server is reported with a retry', () => {
  const store = fakeStore({ loadError: () => true });
  render(<Board />);
  expect(screen.getByText('The server could not be reached.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(store.refresh).toHaveBeenCalledTimes(1);
});

test('no unreachable message once the list has arrived', () => {
  fakeStore({ listed: () => true, loadError: () => false });
  render(<Board />);
  expect(screen.queryByText('The server could not be reached.')).toBeNull();
  expect(screen.getByText('No tracks yet.')).toBeInTheDocument();
});

test('session expiry shows a log-in link that opens in a new tab, so the board keeps playing', () => {
  fakeStore({ listed: () => true, sessionExpired: () => true });
  render(<Board />);
  expect(screen.getByRole('alert')).toHaveTextContent('The session has expired.');
  const link = screen.getByRole('link', { name: 'Log in' });
  expect(link).toHaveAttribute('href', '/wp-login.php?redirect_to=board');
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener');
});

test('asks for a tap while the audio is not running', () => {
  fakeStore({ listed: () => true, audioRunning: () => false });
  render(<Board />);
  expect(screen.getByRole('status')).toHaveTextContent('Tap anywhere to enable sound');
});

test('the tap hint is a fixed, click-through overlay, not part of the layout flow', () => {
  fakeStore({ listed: () => true, audioRunning: () => false });
  render(<Board />);
  const status = screen.getByRole('status');
  expect(status).toHaveClass('fixed', 'pointer-events-none');
  // The chip takes the tap itself, so it never presses a Play button underneath.
  expect(status.firstElementChild).toHaveClass('pointer-events-auto');
});

test('no tap hint once the audio runs, or before the list arrives', () => {
  fakeStore({ listed: () => true, audioRunning: () => true });
  const { unmount } = render(<Board />);
  expect(screen.queryByText('Tap anywhere to enable sound')).toBeNull();
  unmount();
  fakeStore({ listed: () => false, audioRunning: () => false });
  render(<Board />);
  expect(screen.queryByText('Tap anywhere to enable sound')).toBeNull();
});

test('header shows the fade and loading progress', () => {
  fakeStore({
    listed: () => true,
    fadeMs: () => 2500,
    loaded: () => 1,
    total: () => 2,
    rows: () => [
      { track: { id: 1, name: 'A', start_ms: 0, quick_play: true, order: 1, size: 1, version: 'a' }, status: 'ready' },
      { track: { id: 2, name: 'B', start_ms: 0, quick_play: true, order: 2, size: 1, version: 'a' }, status: 'loading' },
    ],
  });
  render(<Board />);
  expect(screen.getByText('Fade 2.5 s')).toBeInTheDocument();
  expect(screen.getByText('Loading 1/2')).toBeInTheDocument();
});
