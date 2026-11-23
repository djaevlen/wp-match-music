# Quick Play Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The space bar starts a random quick-play track when the board is silent and stops the playing track otherwise; a per-track switch keeps goal tracks out of the pool.

**Architecture:** The server stores one more value per track (`quick_play`) and serves it with the rest of the track. The board store gains `quickPlay()`, which decides between stop and start and draws the next track with a pure picker that remembers the current round. A small hook owns the Space key and calls the store; the edit dialog gets a switch and the row a marker.

**Tech Stack:** PHP 7.4+, WordPress 6.4+, PHPUnit; TypeScript, React, shadcn/ui (radix-nova), lucide, sonner; Vitest, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-23-quick-play-design.md`. Read it before any task. It builds on `docs/superpowers/specs/2026-11-19-match-music-design.md` ("the original spec").

## Global Constraints

- PHP 7.4+, no PHP 8-only syntax. WordPress 6.4+.
- JSON field names are snake_case and the TypeScript types mirror them exactly: the field is `quick_play`.
- Post meta key `_mm_quick_play`, stored as the string `'1'` or `'0'`. A track with no stored value is on.
- Only a real boolean is accepted for `quick_play`; anything else is error `mm_invalid_quick_play`, HTTP 400.
- Editing stays Editor and Administrator only; Space works for everyone who can play.
- All UI text is English and lives in `src/strings.ts`. Exact copy:
  - `board.quickPlayHint`: `Space: quick play`
  - `board.quickPlayEmpty`: `No tracks are available for quick play.`
  - `editor.quickPlay`: `Quick play`
  - `editor.quickPlayHelp`: `Included when Space picks a random track`
  - `row.notInQuickPlay`: `Not in quick play`
- No other keyboard shortcut, no on-screen quick-play button, no track types.
- Every rule in the original spec's section 7.4 and every anti-goal still holds (one track at a time, no cut on Stop, no delay on Play).
- Work on a branch `feat/quick-play`, not `main`. Commit after every task. Task 1's commit also adds the spec and this plan. Never commit `node_modules`, `vendor`, `match-music/build`, `dist`.
- Commands: `npx vitest run <file>`, `npm run test:php -- --filter <Class>` (wp-env running: `npx wp-env start`), `npm run build && npx playwright test <file>` for end to end, `npx tsc --noEmit` (no new errors).

## Review Focus

Conditions the spec implies but does not spell out. Each has a test in the task named.

1. **A track that arrives without `quick_play`** (the board's script is newer than the plugin's PHP for a moment during an update, or a cached reply): it is in the pool and shows no marker. Only an explicit `false` is off. Task 2, Task 4.
2. **Space as the page's first gesture, audio output not yet running:** the track starts once the output runs, as a clicked Play does, and it counts as played only when it actually starts. Task 2.
3. **The pool changes mid-round** (a track is switched off or deleted on another device): Space never picks it afterwards, and the round carries on with what is left. Task 2.
4. **A pool of exactly one track:** Space starts it every time, and Space during its fade restarts it; the key never goes dead. Task 2.
5. **The switch is turned off for the track that is playing:** the sound is not interrupted; the track is simply never picked again. Task 2.

---

### Task 1: Server stores and serves `quick_play`

**Files:**
- Modify: `match-music/includes/tracks.php` (`get_track`, `update_track`, new validator)
- Modify: `match-music/includes/rest.php` (`rest_error_statuses`, `rest_update_track`)
- Test: `tests/php/TracksTest.php`, `tests/php/RestTest.php`

**Interfaces:**
- Produces: every track array and REST track object has `quick_play` (bool), placed after `start_ms`: keys are `id, name, start_ms, quick_play, order, size, version`. `PATCH /tracks/{id}` accepts `quick_play`.

- [ ] **Step 1: Write the failing tests**

In `TracksTest.php`:

```php
public function test_quick_play_defaults_on_and_round_trips() {
	$id = create_track( 'Goal', $this->tmp_copy(), 'goal.mp3' );
	$this->assertSame( '', get_post_meta( $id, '_mm_quick_play', true ) ); // nothing stored yet
	$this->assertTrue( get_track( $id )['quick_play'] );
	$this->assertFalse( update_track( $id, [ 'quick_play' => false ] )['quick_play'] );
	$this->assertSame( '0', get_post_meta( $id, '_mm_quick_play', true ) );
	$this->assertFalse( get_track( $id )['quick_play'] );
	$this->assertTrue( update_track( $id, [ 'quick_play' => true ] )['quick_play'] );
	$this->assertSame( '1', get_post_meta( $id, '_mm_quick_play', true ) );
}

public function test_quick_play_must_be_a_boolean() {
	$id = create_track( 'Goal', $this->tmp_copy(), 'goal.mp3' );
	foreach ( [ 'false', 'true', 0, 1, null, '', [] ] as $bad ) {
		$this->assertSame( 'mm_invalid_quick_play', update_track( $id, [ 'quick_play' => $bad ] )->get_error_code() );
	}
	// An invalid field stops the whole update: the name is not written either.
	update_track( $id, [ 'name' => 'Changed', 'quick_play' => 'no' ] );
	$this->assertSame( 'Goal', get_track( $id )['name'] );
	$this->assertTrue( get_track( $id )['quick_play'] );
}
```

In `RestTest.php`: change the key list in `test_upload` to `[ 'id', 'name', 'start_ms', 'quick_play', 'order', 'size', 'version' ]`, and add:

```php
public function test_quick_play_over_rest() {
	$id = $this->track();
	$this->assertTrue( $this->dispatch( 'GET', '/tracks' )->get_data()[0]['quick_play'] );
	$this->assertFalse( $this->dispatch( 'PATCH', "/tracks/$id", [ 'quick_play' => false ] )->get_data()['quick_play'] );
	$this->assertFalse( $this->dispatch( 'GET', '/tracks' )->get_data()[0]['quick_play'] );
	$bad = $this->dispatch( 'PATCH', "/tracks/$id", [ 'quick_play' => 'false' ] );
	$this->assertSame( 400, $bad->get_status() );
	$this->assertSame( 'mm_invalid_quick_play', $bad->get_data()['code'] );
}
```

In `test_denied_requests_change_nothing`, add a Subscriber `PATCH` with `[ 'quick_play' => false ]` and assert `get_track( $id )['quick_play']` is still `true`.

- [ ] **Step 2: Run them and see them fail**

Run: `npm run test:php -- --filter 'TracksTest|RestTest'`
Expected: FAIL (undefined index `quick_play`).

- [ ] **Step 3: Implement**

- `validate_quick_play( $value )` in `tracks.php`: returns the bool when `is_bool( $value )`, else `WP_Error( 'mm_invalid_quick_play', 'Quick play must be true or false.' )`.
- `get_track`: `'quick_play' => '0' !== get_post_meta( $post->ID, '_mm_quick_play', true )`, after `start_ms`.
- `update_track`: when the key is present (`array_key_exists`, so `null` is validated too), validate `quick_play` alongside name and start (all validation before any write, as today), then `update_post_meta( $id, '_mm_quick_play', $quick ? '1' : '0' )`.
- `create_track` writes nothing for it.
- `rest.php`: add `'mm_invalid_quick_play' => 400` to `rest_error_statuses()` and `'quick_play' => true` to the allowed keys in `rest_update_track`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npm run test:php`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add match-music/includes tests/php docs/superpowers
git commit -m "feat: per-track quick_play setting on the server"
```

---

### Task 2: The store's `quickPlay()` and the picker

**Files:**
- Create: `src/lib/quick-pick.ts`, `src/lib/quick-pick.test.ts`
- Modify: `src/api.ts` (`Track`, new `TrackPatch`, `Api.updateTrack`)
- Modify: `src/board-store.ts` (`BoardDeps.random`, `update`, `start`, new `quickPlay`)
- Test: `src/board-store.test.ts`
- Modify: every test file with a `Track` literal (`src/**/*.test.ts(x)`): add `quick_play: true` so they type-check.

**Interfaces:**
- Consumes: Task 1's `quick_play` field.
- Produces:
  - `src/api.ts`: `Track.quick_play: boolean`; `export type TrackPatch = { name?: string; start_ms?: number; quick_play?: boolean }`; `Api.updateTrack(id: number, patch: TrackPatch): Promise<Track>`.
  - `src/lib/quick-pick.ts`:
    - `inQuickPlay(t: { quick_play?: boolean }): boolean`, true unless `quick_play === false`.
    - `pickNext(pool: readonly number[], played: ReadonlySet<number>, last: number | null, random: () => number): { id: number; newRound: boolean } | null`.
  - `src/board-store.ts`: `export type QuickPlayResult = 'started' | 'stopped' | 'empty'`; `BoardStore.quickPlay(): QuickPlayResult`; `BoardStore.update(id: number, patch: TrackPatch): Promise<void>`; `BoardDeps.random?: () => number` (default `Math.random`).

- [ ] **Step 1: Write the failing picker tests** (`src/lib/quick-pick.test.ts`)

```ts
import { inQuickPlay, pickNext } from './quick-pick';

const seq = (...values: number[]) => () => values.shift() ?? 0;

test('draws from pool tracks not yet played, in pool order by the random number', () => {
  expect(pickNext([1, 2, 3], new Set(), null, () => 0)).toEqual({ id: 1, newRound: false });
  expect(pickNext([1, 2, 3], new Set(), null, () => 0.99)).toEqual({ id: 3, newRound: false });
  expect(pickNext([1, 2, 3], new Set([1, 3]), 3, () => 0.99)).toEqual({ id: 2, newRound: false });
});
test('played ids outside the pool are ignored', () => {
  expect(pickNext([1, 2], new Set([9]), 9, () => 0)).toEqual({ id: 1, newRound: false });
});
test('when all are played a new round starts without the last track', () => {
  expect(pickNext([1, 2, 3], new Set([1, 2, 3]), 3, () => 0.99)).toEqual({ id: 2, newRound: true });
  expect(pickNext([1, 2, 3], new Set([1, 2, 3]), 1, () => 0)).toEqual({ id: 2, newRound: true });
});
test('a pool of one is picked every time', () => {
  expect(pickNext([5], new Set([5]), 5, seq(0.5))).toEqual({ id: 5, newRound: true });
});
test('an empty pool gives nothing', () => {
  expect(pickNext([], new Set([1]), 1, () => 0)).toBeNull();
});
test('only an explicit false is out of quick play', () => {
  expect(inQuickPlay({ quick_play: true })).toBe(true);
  expect(inQuickPlay({})).toBe(true);
  expect(inQuickPlay({ quick_play: false })).toBe(false);
});
```

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run src/lib/quick-pick.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/quick-pick.ts`**

Candidates are the pool ids not in `played`, in pool order. If there are none, it is a new round: candidates are the pool without `last`, or the whole pool if that leaves nothing. The pick is `candidates[Math.floor(random() * candidates.length)]`.

- [ ] **Step 4: Run and see them pass**

Run: `npx vitest run src/lib/quick-pick.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing store tests** (`src/board-store.test.ts`)

Add `quick_play: true` to the `track()` helper's defaults, let `setup` take `random` in its options and pass it to the store's deps, and add this helper:

```ts
/** A board whose tracks are all loaded and ready. */
async function ready(tracks: Track[], opts: { random?: () => number } = {}) {
  const s = setup(tracks, { autoLoad: true, ...opts });
  await s.store.refresh();
  await flush();
  return s;
}
const seq = (...values: number[]) => () => values.shift() ?? 0;
```

```ts
test('quickPlay on a silent board starts a pool track from its start point', async () => {
  const s = await ready([track(1, { start_ms: 5000 })]);
  expect(s.store.quickPlay()).toBe('started');
  expect(s.engine.state(1)).toBe('playing');
  expect(s.voiceOf(1).last()).toEqual(['start', 5]);
});

test('quickPlay on a playing track stops it like Stop, however it was started', async () => {
  const s = await ready([track(1), track(2)]);
  s.store.play(2);
  expect(s.store.quickPlay()).toBe('stopped');
  expect(s.engine.state(2)).toBe('fading');
  expect(s.voiceOf(2).last()).toEqual(['fadeOut', 2]);
});

test('quickPlay during a fade starts the next track and cuts the fading one', async () => {
  const s = await ready([track(1), track(2)], { random: () => 0 });
  s.store.quickPlay(); // starts 1
  s.store.quickPlay(); // fades 1
  expect(s.store.quickPlay()).toBe('started');
  expect(s.engine.state(1)).toBe('ready');
  expect(s.engine.state(2)).toBe('playing');
});

test('no track repeats within a round, and a new round never opens with the last track', async () => {
  // Fourth draw: without the rule, 0.99 over [1, 2, 3] would repeat track 3.
  const s = await ready([track(1), track(2), track(3)], { random: seq(0, 0, 0, 0.99) });
  const started: number[] = [];
  for (let i = 0; i < 4; i++) {
    s.store.quickPlay();
    started.push(s.engine.activeId()!);
    s.store.cutActive();
  }
  expect(started).toEqual([1, 2, 3, 2]);
});

test('a track started by hand counts as played in the round', async () => {
  const s = await ready([track(1), track(2)], { random: () => 0 });
  s.store.play(1);
  s.store.cutActive();
  s.store.quickPlay();
  expect(s.engine.activeId()).toBe(2);
});

test('switched-off and still-loading tracks are never picked', async () => {
  const s = setup([track(1, { quick_play: false }), track(2), track(3)], { random: () => 0 });
  await s.store.refresh();
  await s.resolveLoad(1);
  await s.resolveLoad(3); // track 2 is still loading
  for (let i = 0; i < 4; i++) {
    expect(s.store.quickPlay()).toBe('started');
    expect(s.engine.activeId()).toBe(3);
    s.store.cutActive();
  }
});

test('with nothing in the pool quickPlay reports empty and plays nothing', async () => {
  const s = await ready([track(1, { quick_play: false })]);
  expect(s.store.quickPlay()).toBe('empty');
  expect(s.engine.activeId()).toBeNull();
});

test('a pool of one starts every time, and Space during its fade restarts it', async () => {
  const s = await ready([track(1)]);
  s.store.quickPlay();
  s.store.cutActive();
  expect(s.store.quickPlay()).toBe('started');
  s.store.quickPlay(); // fades it
  expect(s.store.quickPlay()).toBe('started');
  expect(s.engine.state(1)).toBe('playing');
  expect(s.voiceOf(1).names().slice(-2)).toEqual(['cancelFade', 'start']);
});

test('a track without the field is in the pool', async () => {
  const legacy = track(1);
  delete (legacy as Partial<Track>).quick_play;
  const s = await ready([legacy]);
  expect(s.store.quickPlay()).toBe('started');
});

test('with the output not running quickPlay waits like Play, and counts the track only once it starts', async () => {
  const s = await ready([track(1), track(2)], { random: () => 0 });
  s.output.state = 'suspended';
  expect(s.store.quickPlay()).toBe('started');
  expect(s.output.unlock).toHaveBeenCalledTimes(1);
  expect(s.engine.activeId()).toBeNull();
  vi.advanceTimersByTime(PENDING_PRESS_MS + 1); // the press is dropped; nothing ever started
  s.output.state = 'running';
  s.store.outputChanged();
  expect(s.engine.activeId()).toBeNull();
  s.store.quickPlay();
  expect(s.engine.activeId()).toBe(1); // track 1 was not used up by the lost press
});

test('a track switched off or deleted elsewhere mid-round is not picked', async () => {
  const s = await ready([track(1), track(2), track(3)], { random: () => 0 });
  s.store.quickPlay(); // 1
  s.store.cutActive();
  s.setServer([track(1), track(2, { quick_play: false })]); // 2 off, 3 deleted
  await s.store.refresh();
  await flush();
  expect(s.store.quickPlay()).toBe('started');
  expect(s.engine.activeId()).toBe(1); // the only one left: a new round
});

test('switching off the playing track does not interrupt it, and it is not picked again', async () => {
  const s = await ready([track(1), track(2)], { random: () => 0 });
  s.store.quickPlay(); // 1
  s.api.updateTrack.mockResolvedValueOnce(track(1, { quick_play: false }));
  await s.store.update(1, { quick_play: false });
  expect(s.api.updateTrack).toHaveBeenCalledWith(1, { quick_play: false });
  expect(s.engine.state(1)).toBe('playing');
  expect(s.voiceOf(1).names()).not.toContain('halt');
  s.store.cutActive();
  for (let i = 0; i < 3; i++) {
    s.store.quickPlay();
    expect(s.engine.activeId()).toBe(2);
    s.store.cutActive();
  }
});
```

Import `PENDING_PRESS_MS` from `./board-store`.

- [ ] **Step 6: Run and see them fail**

Run: `npx vitest run src/board-store.test.ts`
Expected: FAIL (`quickPlay` is not a function).

- [ ] **Step 7: Implement in `src/api.ts` and `src/board-store.ts`**

- `quickPlay()`: if the engine's active track is `playing`, call `this.stop(active)` and return `'stopped'`. Otherwise (nothing active, or the active track is fading) build the pool: ids in board order whose entry is not `gone`, passes `inQuickPlay`, and is in the engine (`engine.has`). `pickNext(pool, played, last, random)`; `null` returns `'empty'`. On `newRound` clear the played set. Then `this.play(id)` and return `'started'`.
- The round (`played: Set<number>`, `last: number | null`) is recorded in the private `start()`, the one place every play reaches the engine, so clicks, Space and editor previews all count and a press that never starts does not.
- The engine is not changed.

- [ ] **Step 8: Run the tests and type-check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS; no new type errors (after adding `quick_play: true` to the `Track` literals in the other test files).

- [ ] **Step 9: Commit**

```bash
git add src
git commit -m "feat: store quickPlay with a no-repeat round"
```

---

### Task 3: The Space key, the header hint and the empty notice

**Files:**
- Create: `src/hooks/useQuickPlayKey.ts`, `src/hooks/useQuickPlayKey.test.tsx`
- Modify: `src/components/Board.tsx`, `src/components/Board.test.tsx`, `src/strings.ts`

**Interfaces:**
- Consumes: `BoardStore.quickPlay(): QuickPlayResult` (Task 2).
- Produces: `useQuickPlayKey(store: Pick<BoardStore, 'quickPlay'>): void`; `strings.board.quickPlayHint`, `strings.board.quickPlayEmpty`.

- [ ] **Step 1: Write the failing hook tests** (`src/hooks/useQuickPlayKey.test.tsx`)

Mock sonner as the other tests do (`vi.mock('sonner', () => ({ toast: vi.fn() }))`). Render the hook with `renderHook(() => useQuickPlayKey(store))` where `store = { quickPlay: vi.fn(() => 'started') }`. `fireEvent` returns `false` when the event's default was prevented.

```ts
const space = { code: 'Space', key: ' ' };

test('Space calls quickPlay once and is consumed, on key down and key up', () => {
  const button = document.body.appendChild(document.createElement('button'));
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
  const el = document.body.appendChild(document.createElement(tag));
  expect(fireEvent.keyDown(el, space)).toBe(true);
  expect(fireEvent.keyUp(el, space)).toBe(true);
  expect(store.quickPlay).not.toHaveBeenCalled();
});
test('Space in editable text is left alone', () => { /* a div with contenteditable="true" */ });
test.each(['dialog', 'alertdialog', 'menu'])('Space is left alone while a %s is open', (role) => {
  const overlay = document.body.appendChild(document.createElement('div'));
  overlay.setAttribute('role', role);
  expect(fireEvent.keyDown(document.body, space)).toBe(true);
  expect(store.quickPlay).not.toHaveBeenCalled();
});
test.each(['shiftKey', 'ctrlKey', 'altKey', 'metaKey'])('Space with %s is left alone', (mod) => {
  expect(fireEvent.keyDown(document.body, { ...space, [mod]: true })).toBe(true);
  expect(store.quickPlay).not.toHaveBeenCalled();
});
test('other keys are left alone', () => {
  expect(fireEvent.keyDown(document.body, { code: 'Enter', key: 'Enter' })).toBe(true);
});
test('a key up is consumed only when its key down was', () => {
  const input = document.body.appendChild(document.createElement('input'));
  fireEvent.keyDown(input, space);
  expect(fireEvent.keyUp(document.body, space)).toBe(true);
});
test('an empty pool shows the notice', () => {
  store.quickPlay.mockReturnValue('empty');
  fireEvent.keyDown(document.body, space);
  expect(toast).toHaveBeenCalledWith('No tracks are available for quick play.', { id: 'quick-play-empty' });
});
test('unmount removes the listeners', () => { /* after unmount, keyDown returns true and quickPlay is not called */ });
```

Clean `document.body` between tests.

In `Board.test.tsx`: add `quickPlay: vi.fn(() => 'started')` to `fakeStore`, and:

```ts
test('the header hints at quick play on wide screens only, and Space reaches the store', () => {
  const store = fakeStore({ listed: () => true });
  render(<Board />);
  const hint = screen.getByText('Space: quick play');
  expect(hint).toHaveClass('hidden', 'sm:inline');
  fireEvent.keyDown(document.body, { code: 'Space', key: ' ' });
  expect(store.quickPlay).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run src/hooks/useQuickPlayKey.test.tsx src/components/Board.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `useQuickPlayKey`: `keydown` and `keyup` listeners on `window` in the capture phase. A key down is "ours" when `event.code === 'Space'`, no modifier is held, the target is not an `input`, `textarea`, `select` or editable element (test with `closest('[contenteditable]:not([contenteditable="false"])')`; jsdom has no `isContentEditable`), and `document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')` finds nothing (Radix renders these only while open; the fade popover's content has `role="dialog"`). When ours: `preventDefault()` and `stopPropagation()`, remember it so the matching key up is consumed the same way, and unless `event.repeat`, call `store.quickPlay()`; on `'empty'`, `toast(strings.board.quickPlayEmpty, { id: 'quick-play-empty' })`.
- `Board.tsx`: call `useQuickPlayKey(store)`; in the header, before the fade control, a `<span className={cn(chip, 'hidden sm:inline')}>` with `strings.board.quickPlayHint`.
- Add the two strings.

- [ ] **Step 4: Run and see them pass**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat: space bar quick play, with a header hint"
```

---

### Task 4: The switch in the edit dialog and the row marker

**Files:**
- Create: `src/components/ui/switch.tsx` (via `npx shadcn@latest add switch`; match the import style of the other files in `src/components/ui`)
- Modify: `src/components/EditTrackDialog.tsx`, `src/components/EditTrackDialog.test.tsx`
- Modify: `src/components/TrackRow.tsx`, `src/components/TrackRow.test.tsx`
- Modify: `src/strings.ts`

**Interfaces:**
- Consumes: `TrackPatch`, `BoardStore.update(id, patch: TrackPatch)`, `inQuickPlay` (Task 2).
- Produces: `strings.editor.quickPlay`, `strings.editor.quickPlayHelp`, `strings.row.notInQuickPlay`; the marker is `data-testid="row-no-quick-play"`.

- [ ] **Step 1: Write the failing tests**

`EditTrackDialog.test.tsx` (the track literal gains `quick_play: true`; the fake store's `update` takes a `TrackPatch`):

```ts
test('the switch shows the saved setting, with its help line', async () => {
  await open();
  expect(screen.getByRole('switch', { name: 'Quick play' })).toBeChecked();
  expect(screen.getByText('Included when Space picks a random track')).toBeInTheDocument();
});
test('a track without the field shows the switch on', async () => { /* open with quick_play deleted: checked */ });
test('turning the switch off is a draft until Save, then sends only quick_play', async () => {
  const { store } = await open();
  fireEvent.click(screen.getByRole('switch', { name: 'Quick play' }));
  expect(store.update).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(store.update).toHaveBeenCalledWith(7, { quick_play: false }));
});
test('a switch toggled and toggled back sends nothing', async () => { /* two clicks, Save: update not called */ });
test('cancel after toggling sends nothing', async () => { /* click switch, Cancel: update not called */ });
```

Use whatever `open()` returns today; adjust only if it does not expose the store.

`TrackRow.test.tsx` (make the track a parameter of `renderRow`):

```ts
test('a row out of quick play shows the marker', () => {
  renderRow('ready', { track: { ...track, quick_play: false } });
  expect(screen.getByTestId('row-no-quick-play')).toHaveAccessibleName('Not in quick play');
});
test('a row in quick play, or without the field, shows no marker', () => {
  // quick_play: true, then the field deleted
  expect(screen.queryByTestId('row-no-quick-play')).toBeNull();
});
test('the marker stays while the row plays', () => { /* status 'playing', quick_play false: marker present */ });
```

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run src/components/EditTrackDialog.test.tsx src/components/TrackRow.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Dialog: a `Switch` labelled `strings.editor.quickPlay` with `strings.editor.quickPlayHelp` as its description, between the name field and the start-point section. Its draft starts from `inQuickPlay(row.track)`, is kept in the `saved` snapshot like name and start point, and joins the patch as `quick_play` only when it differs from the snapshot.
- Row: when `!inQuickPlay(track)`, the lucide `Ban` icon in the status line between the status text and the buttons, muted, `role="img"`, `aria-label` and `title` set to `strings.row.notInQuickPlay`, `data-testid="row-no-quick-play"`. It must not change the row's height.
- Add the three strings.

- [ ] **Step 4: Run and see them pass**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat: quick play switch in the editor and a marker on the row"
```

---

### Task 5: End to end in real browsers

**Files:**
- Create: `tests/e2e/quick-play.spec.ts`
- Modify: `tests/e2e/helpers.ts` (new `setQuickPlay`)
- Modify: `tests/e2e/editor.spec.ts` (`reorder by keyboard`)
- Modify: `README.md` (a short note on quick play where using the board is described)

**Interfaces:**
- Consumes: everything above.
- Produces: `setQuickPlay(id: number, on: boolean): void` in `helpers.ts`, through `wpPhp` and `\MatchMusic\update_track`.

- [ ] **Step 1: Write the tests** (`tests/e2e/quick-play.spec.ts`)

Seed once: `Track A`, `Track B`, `Track C` (in the pool) and `Goal` (`setQuickPlay(goal, false)`), from the click fixtures. Default fade 500 ms; a test that needs another fade calls `setFadeMs` before it opens the board. Open the board as the Subscriber unless stated, wait for every row to be `ready`, and `recordStatuses(page)`.

1. `Space after a mouse click on Play fades that track instead of pressing its button`: click A's Play with the mouse, wait for `playing`, `page.keyboard.press('Space')`. A becomes `fading` then `ready`; `statusesOf(page, a)` holds exactly one `playing`; no other row left `ready`.
2. `Space starts a pool track, never the switched-off one, and does not repeat within a round`: with `setFadeMs(0)`, six times: press Space, read the id of the row with `data-status="playing"`, press Space, wait for no row playing. The first three ids are A, B and C in some order; the fourth differs from the third; `Goal` never appears. The `Goal` row shows the marker (`getByTestId('row-no-quick-play')`).
3. `Space during a fade starts another track`: `setFadeMs(5000)`; Space (X plays), Space (X fades), Space. A different row is `playing` and X is `ready`.
4. `holding Space does not start and stop`: call `page.keyboard.down('Space')` five times (Playwright marks every call after the first as a repeat), then `page.keyboard.up('Space')`. Exactly one row is `playing`, and its recorded statuses hold no `fading`.
5. `Space types in the name field and starts nothing` (Editor): open A's edit dialog, focus the name field, type `X Y` with the keyboard. The field's value contains `X Y`; no row is `playing`. Press Escape, then Space on the board: a row is `playing`.
6. `the switch is saved and reaches a second session` (Editor): open B's dialog, turn `Quick play` off, Save. B's row shows the marker; after `page.reload()` it still does; `boardAs(browser, users.subscriber)` shows it too. Turn it back on at the end.
7. `the header hint shows on a laptop and not on a phone`: visible at 1280 wide; with `boardAs(browser, users.subscriber, { width: 390, height: 844 })` it is hidden.

In `editor.spec.ts`, `reorder by keyboard`: before picking up, focus the drag handle and press Space; assert the order is unchanged and a row is `playing`, then press Space again and wait for no row sounding. Replace the two `Space` presses that pick up and drop with `Enter`. The expected final order stays as it is.

- [ ] **Step 2: Run in all three browsers**

Run: `npm run build && npx playwright test tests/e2e/quick-play.spec.ts tests/e2e/editor.spec.ts`
Expected: PASS in `e2e-chromium`, `e2e-firefox` and `e2e-webkit`.

If test 1 fails in one browser (Space still clicks the focused button), the fix belongs in `useQuickPlayKey`: on a consumed key down, also blur the focused element when it is a `button`. Add a unit test for it in Task 3's file, then rerun.

- [ ] **Step 3: Run everything**

Run: `npx vitest run && npm run test:php && npm run test:e2e`
Expected: PASS, all suites.

- [ ] **Step 4: Add the README note and commit**

```bash
git add tests/e2e README.md
git commit -m "test: quick play end to end; keyboard reorder uses Enter"
```
