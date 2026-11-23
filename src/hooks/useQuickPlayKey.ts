import { useEffect } from 'react';
import { toast } from 'sonner';
import type { BoardStore } from '@/board-store';
import { strings } from '@/strings';

// Anything open on top of the board keeps Space for itself: the edit dialog, the delete
// confirmation, a row menu, the fade popover (Radix renders these only while they are open).
const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"]';
// jsdom has no isContentEditable, so the attribute is tested instead.
const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function isQuickPlayPress(e: KeyboardEvent): boolean {
  if (e.code !== 'Space' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return false;
  if (e.target instanceof Element && e.target.closest(TYPING)) return false;
  return document.querySelector(OVERLAY) === null;
}

/**
 * The space bar is the board's quick-play key: it starts a random track, or stops the one
 * playing (see BoardStore.quickPlay). The press is taken in the capture phase and consumed on
 * key down and key up, so it neither scrolls the page nor presses whichever button was clicked
 * last; a button that has focus is still pressed with Enter. A held key counts once.
 */
export function useQuickPlayKey(store: Pick<BoardStore, 'quickPlay'>): void {
  useEffect(() => {
    let consumed = false; // the Space now held down was taken by quick play
    const consume = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      consumed = isQuickPlayPress(e);
      if (!consumed) return;
      consume(e);
      if (e.repeat) return;
      if (store.quickPlay() === 'empty') toast(strings.board.quickPlayEmpty, { id: 'quick-play-empty' });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !consumed) return;
      consumed = false;
      consume(e);
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [store]);
}
