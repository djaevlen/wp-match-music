import { fireEvent, renderHook } from '@testing-library/react';
import { toast } from 'sonner';
import type { QuickPlayResult } from '@/board-store';
import { useQuickPlayKey } from './useQuickPlayKey';

vi.mock('sonner', () => ({ toast: vi.fn() }));

const space = { code: 'Space', key: ' ' };

let store: { quickPlay: ReturnType<typeof vi.fn<() => QuickPlayResult>> };
let unmount: () => void;

beforeEach(() => {
  store = { quickPlay: vi.fn<() => QuickPlayResult>(() => 'started') };
  unmount = renderHook(() => useQuickPlayKey(store)).unmount;
});
afterEach(() => {
  unmount();
  document.body.replaceChildren();
  vi.mocked(toast).mockClear();
});

const add = (tag: string) => document.body.appendChild(document.createElement(tag));

test('Space calls quickPlay once and is consumed, on key down and key up', () => {
  const button = add('button');
  const onButton = vi.fn();
  button.addEventListener('keydown', onButton); // the listener is capture-phase on window and stops the event
  expect(fireEvent.keyDown(button, space)).toBe(false);
  expect(fireEvent.keyUp(button, space)).toBe(false);
  expect(store.quickPlay).toHaveBeenCalledTimes(1);
  expect(onButton).not.toHaveBeenCalled();
});

test('a held key counts once but stays consumed', () => {
  fireEvent.keyDown(document.body, space);
  expect(fireEvent.keyDown(document.body, { ...space, repeat: true })).toBe(false);
  expect(store.quickPlay).toHaveBeenCalledTimes(1);
});

test.each(['input', 'textarea', 'select'])('Space in a %s is left alone', (tag) => {
  const el = add(tag);
  expect(fireEvent.keyDown(el, space)).toBe(true);
  expect(fireEvent.keyUp(el, space)).toBe(true);
  expect(store.quickPlay).not.toHaveBeenCalled();
});

test('Space in editable text is left alone', () => {
  const el = add('div');
  el.setAttribute('contenteditable', 'true');
  const inner = el.appendChild(document.createElement('span'));
  expect(fireEvent.keyDown(inner, space)).toBe(true);
  expect(store.quickPlay).not.toHaveBeenCalled();
});

test.each(['dialog', 'alertdialog', 'menu'])('Space is left alone while a %s is open', (role) => {
  add('div').setAttribute('role', role);
  expect(fireEvent.keyDown(document.body, space)).toBe(true);
  expect(store.quickPlay).not.toHaveBeenCalled();
});

test.each(['shiftKey', 'ctrlKey', 'altKey', 'metaKey'])('Space with %s is left alone', (mod) => {
  expect(fireEvent.keyDown(document.body, { ...space, [mod]: true })).toBe(true);
  expect(store.quickPlay).not.toHaveBeenCalled();
});

test('other keys are left alone', () => {
  expect(fireEvent.keyDown(document.body, { code: 'Enter', key: 'Enter' })).toBe(true);
  expect(fireEvent.keyUp(document.body, { code: 'Enter', key: 'Enter' })).toBe(true);
  expect(store.quickPlay).not.toHaveBeenCalled();
});

test('a key up is consumed only when its key down was', () => {
  fireEvent.keyDown(add('input'), space);
  expect(fireEvent.keyUp(document.body, space)).toBe(true);
});

test('an empty pool shows the notice', () => {
  store.quickPlay.mockReturnValue('empty');
  fireEvent.keyDown(document.body, space);
  expect(toast).toHaveBeenCalledWith('No tracks are available for quick play.', { id: 'quick-play-empty' });
});

test('starting or stopping shows no notice', () => {
  fireEvent.keyDown(document.body, space);
  expect(toast).not.toHaveBeenCalled();
});

test('unmount removes the listeners', () => {
  unmount();
  expect(fireEvent.keyDown(document.body, space)).toBe(true);
  expect(fireEvent.keyUp(document.body, space)).toBe(true);
  expect(store.quickPlay).not.toHaveBeenCalled();
});

// A worn space bar "bounces": one press arrives as down, up, down within a few tens of
// milliseconds, none of them marked as a repeat.
describe('key bounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('a second press within a tenth of a second is consumed but does nothing', () => {
    fireEvent.keyDown(document.body, space);
    fireEvent.keyUp(document.body, space);
    vi.advanceTimersByTime(30);
    expect(fireEvent.keyDown(document.body, space)).toBe(false);
    expect(fireEvent.keyUp(document.body, space)).toBe(false);
    expect(store.quickPlay).toHaveBeenCalledTimes(1);
  });

  test('a deliberate second press a moment later counts', () => {
    fireEvent.keyDown(document.body, space);
    fireEvent.keyUp(document.body, space);
    vi.advanceTimersByTime(150);
    fireEvent.keyDown(document.body, space);
    expect(store.quickPlay).toHaveBeenCalledTimes(2);
  });

  test('a bounce does not hold off the press after it', () => {
    fireEvent.keyDown(document.body, space);
    vi.advanceTimersByTime(60);
    fireEvent.keyDown(document.body, space); // bounce, ignored
    vi.advanceTimersByTime(60); // 120 ms after the press that counted
    fireEvent.keyDown(document.body, space);
    expect(store.quickPlay).toHaveBeenCalledTimes(2);
  });
});
