# Match Music Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A WordPress plugin that serves a login-protected, full-screen "jingle board" where each mp3 plays from a saved start point and fades out on Stop.

**Architecture:** A PHP plugin (`match-music/`) owns data (private custom post type, private file folder, one option), a REST API and a standalone board page. A React app, built by Vite into the plugin, talks to that API. Audio runs through a framework-free engine (state machine) driving one `Voice` per track; the first `Voice` is an `<audio>` element behind a Web Audio gain node, and it must pass a measured gate (Task 2) before any UI is built.

**Tech Stack:** PHP 7.4+, WordPress 6.4+, `@wordpress/env`, PHPUnit 9; TypeScript, React, Vite, Tailwind, shadcn/ui, dnd-kit; Vitest, Testing Library, Playwright; ffmpeg (fixtures only).

**Spec:** `docs/superpowers/specs/2026-11-19-match-music-design.md`. Read it before any task. Section numbers below refer to it.

## Global Constraints

- WordPress 6.4+, PHP 7.4+. No PHP 8-only syntax. Single site only.
- HTTPS assumed, but the board must work without Cache Storage.
- Plugin name `Match Music`, slug/text domain `match-music`, PHP namespace `MatchMusic`.
- Board address `/match-music/`, filter `match_music_board_slug`.
- Play capability `read` (filter `match_music_play_capability`); edit capability `edit_others_posts` (filter `match_music_edit_capability`).
- Fade: 0 to 10000 ms in 500 ms steps, default 2000.
- Start points: whole ms, snapped to 100 ms, never negative.
- mp3 only. Files live in `{uploads basedir}/match-music-private/` under `bin2hex(random_bytes(16)) . '.mp3'`; never media-library attachments; the stored filename never leaves the server.
- File protection must not rely on `.htaccess` alone.
- REST namespace `match-music/v1`, cookie + `X-WP-Nonce` auth. JSON field names are snake_case and the TypeScript types mirror them exactly.
- All UI text is English and lives in `src/strings.ts`.
- Non-goals (spec section 3) stay out: no looping, playlists, per-track volume, keyboard shortcuts, replace-audio, PWA.
- Commit after every task. Never commit `node_modules`, `vendor`, `match-music/build`, `.superpowers`, `dist`.

## Review Focus

1. **Real-world mp3 files:** an uppercase `.MP3` extension, a file with an ID3v2 tag, and a file with no tag at all must all upload. Test in Task 4.
2. **Track names with punctuation:** `Rock & Roll "Live" – Åge` must come back from the API character-for-character, with no HTML entities, and an empty name must be refused. Tests in Tasks 4 and 5.
3. **Frantic pressing:** Play A, Play B, Play A within the same tick, or Stop twice, must never leave two tracks sounding or throw an unhandled `play()` rejection. Tests in Tasks 1 and 2.
4. **The setup changes while a track is playing:** a track deleted or re-timed from another device must not interrupt the track that is sounding; the change lands once it is idle. Test in Task 8.
5. **Upload over the server limit:** when PHP drops the body (`$_FILES` empty) or reports `UPLOAD_ERR_INI_SIZE`, the user gets a message naming the limit, not a crash; the client refuses oversize files before sending. Tests in Tasks 5 and 7.

## File Structure

```
package.json  tsconfig.json  vite.config.ts  components.json  .gitignore
.wp-env.json  composer.json  phpunit.xml.dist  playwright.config.ts
src/
  main.tsx  index.css  boot.ts  strings.ts  api.ts  board-store.ts
  lib/time.ts
  audio/voice.ts  engine.ts  context.ts  element-voice.ts  loader.ts  peaks.ts
  hooks/useBoard.ts
  components/Board.tsx TrackList.tsx TrackRow.tsx FadeControl.tsx
             AddTracks.tsx EditTrackDialog.tsx Waveform.tsx  ui/ (shadcn)
prototype/index.html  proto.ts            # audio gate page, dev only
match-music/                              # the plugin; this folder is what ships
  match-music.php  uninstall.php
  includes/capabilities.php settings.php storage.php tracks.php rest.php board-page.php
  build/                                  # Vite output, gitignored
tests/php/  tests/e2e/  tests/gate/  tests/fixtures/
scripts/make-fixtures.sh  scripts/zip.mjs
docs/install-checklist.md  docs/audio-gate-results.md
```

Unit tests sit beside their source as `*.test.ts(x)`.

---

### Task 1: Audio engine state machine

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `.gitignore`
- Create: `src/audio/voice.ts`, `src/audio/engine.ts`, `src/lib/time.ts`
- Test: `src/audio/engine.test.ts`, `src/lib/time.test.ts`

**Interfaces:**
- Produces:

```ts
// src/audio/voice.ts
export interface Voice {
  readonly durationSec: number;
  arm(startSec: number): void;      // paused, positioned at startSec, gain 1
  start(fromSec: number): void;     // audible from fromSec at gain 1
  halt(): void;                     // silent and paused at once
  fadeOut(seconds: number): void;   // ramp gain to 0; does not pause
  cancelFade(): void;               // gain back to 1
  positionSec(): number;
  onEnded(cb: () => void): void;
  dispose(): void;
}

// src/audio/engine.ts
export type TrackState = 'ready' | 'playing' | 'fading';
export interface EngineTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export class Engine {
  constructor(timers?: EngineTimers);               // defaults to globalThis timers
  add(id: number, voice: Voice, startMs: number): void;   // arms the voice
  remove(id: number): void;                         // deferred until idle; then dispose()
  has(id: number): boolean;
  setStartMs(id: number, startMs: number): void;    // deferred until idle; then arm()
  setFadeMs(ms: number): void;
  play(id: number, fromMs?: number): void;          // fromMs overrides the saved start once
  stop(id: number): void;                           // playing→fading (or halt if fade 0); fading→halt; else no-op
  state(id: number): TrackState | undefined;
  activeId(): number | null;                        // the playing or fading track
  positionSec(id: number): number;
  durationSec(id: number): number;
  subscribe(listener: () => void): () => void;      // called after every state change
}

// src/lib/time.ts
export const SNAP_MS = 100;
export function snapMs(ms: number, durationMs: number): number; // round to 100, clamp to 0..durationMs-100
export function formatMs(ms: number): string;       // 42300 -> "0:42.3", 75000 -> "1:15.0"
export function formatElapsed(sec: number): string; // 7.4 -> "0:07"
```

- [ ] **Step 1: Set up the repo and tooling**

`git init`; `.gitignore` with `node_modules`, `vendor`, `match-music/build`, `.superpowers`, `dist`, `test-results`, `playwright-report`. Install `vite`, `typescript`, `vitest`, `jsdom`, `react`, `react-dom`, `@vitejs/plugin-react`, `@types/react`, `@types/react-dom`. Scripts: `"test": "vitest run"`, `"dev": "vite"`. Vitest environment `jsdom`. Commit the existing `docs/` folder as the first commit.

- [ ] **Step 2: Write the failing tests**

`engine.test.ts` uses a `FakeVoice` that records calls as `[name, arg]` tuples and exposes `fireEnded()`, with `vi.useFakeTimers()`.

```ts
const setup = () => { const e = new Engine(); const a = new FakeVoice(200), b = new FakeVoice(200);
  e.add(1, a, 42300); e.add(2, b, 5000); e.setFadeMs(2000); return { e, a, b }; };

test('add arms at the start point', () => { expect(setup().a.calls).toEqual([['arm', 42.3]]); });
test('play starts from the start point', () => { const { e, a } = setup(); e.play(1);
  expect(a.last()).toEqual(['start', 42.3]); expect(e.state(1)).toBe('playing'); expect(e.activeId()).toBe(1); });
test('stop fades, then halts and re-arms', () => { const { e, a } = setup(); e.play(1); e.stop(1);
  expect(a.last()).toEqual(['fadeOut', 2]); expect(e.state(1)).toBe('fading');
  vi.advanceTimersByTime(2000);
  expect(a.calls.slice(-2)).toEqual([['halt'], ['arm', 42.3]]); expect(e.state(1)).toBe('ready'); expect(e.activeId()).toBeNull(); });
test('fade 0 halts at once', () => { const { e, a } = setup(); e.setFadeMs(0); e.play(1); e.stop(1);
  expect(a.names()).not.toContain('fadeOut'); expect(e.state(1)).toBe('ready'); });
test('playing another track cuts the first without a fade', () => { const { e, a, b } = setup(); e.play(1); e.play(2);
  expect(a.names()).not.toContain('fadeOut'); expect(a.calls.slice(-2)).toEqual([['halt'], ['arm', 42.3]]);
  expect(e.state(1)).toBe('ready'); expect(b.last()).toEqual(['start', 5]); });
test('playing another track during a fade cancels the pending halt', () => { const { e, a } = setup();
  e.play(1); e.stop(1); e.play(2); const n = a.calls.length; vi.advanceTimersByTime(5000); expect(a.calls.length).toBe(n); });
test('play during own fade restarts at full volume', () => { const { e, a } = setup(); e.play(1); e.stop(1); e.play(1);
  expect(a.calls.slice(-2)).toEqual([['cancelFade'], ['start', 42.3]]); vi.advanceTimersByTime(5000); expect(e.state(1)).toBe('playing'); });
test('second stop during a fade cuts at once', () => { const { e, a } = setup(); e.play(1); e.stop(1); e.stop(1);
  expect(a.calls.slice(-2)).toEqual([['halt'], ['arm', 42.3]]); expect(e.state(1)).toBe('ready'); });
test('stop on an idle track does nothing', () => { const { e, a } = setup(); e.stop(1); expect(a.calls.length).toBe(1); });
test('ended re-arms', () => { const { e, a } = setup(); e.play(1); a.fireEnded();
  expect(e.state(1)).toBe('ready'); expect(a.last()).toEqual(['arm', 42.3]); });
test('fromMs overrides once', () => { const { e, a } = setup(); e.setFadeMs(0); e.play(1, 0);
  expect(a.last()).toEqual(['start', 0]); e.stop(1); expect(a.last()).toEqual(['arm', 42.3]); });
test('setStartMs re-arms when idle, waits when active', () => { const { e, a } = setup(); e.setFadeMs(0);
  e.setStartMs(1, 10000); expect(a.last()).toEqual(['arm', 10]);
  e.play(1); e.setStartMs(1, 20000); expect(a.last()).toEqual(['start', 10]); e.stop(1); expect(a.last()).toEqual(['arm', 20]); });
test('remove waits until idle, then disposes', () => { const { e, a } = setup(); e.setFadeMs(0); e.play(1); e.remove(1);
  expect(e.has(1)).toBe(true); e.stop(1); expect(e.has(1)).toBe(false); expect(a.last()).toEqual(['dispose']); });
test('A, B, A in one tick leaves only A sounding', () => { const { e, a, b } = setup(); e.play(1); e.play(2); e.play(1);
  expect(e.activeId()).toBe(1); expect(b.last()).toEqual(['arm', 5]); expect(a.last()).toEqual(['start', 42.3]); });
test('subscribers hear every state change', () => { const { e } = setup(); const fn = vi.fn(); e.subscribe(fn);
  e.play(1); e.stop(1); vi.advanceTimersByTime(2000); expect(fn).toHaveBeenCalledTimes(3); });
```

`time.test.ts`:

```ts
expect(snapMs(42349, 200000)).toBe(42300); expect(snapMs(-50, 200000)).toBe(0); expect(snapMs(999999, 200000)).toBe(199900);
expect(formatMs(42300)).toBe('0:42.3'); expect(formatMs(75000)).toBe('1:15.0'); expect(formatMs(0)).toBe('0:00.0');
expect(formatElapsed(7.4)).toBe('0:07'); expect(formatElapsed(65)).toBe('1:05');
```

- [ ] **Step 3: Run `npm test`.** Expected: FAIL, modules not found.
- [ ] **Step 4: Implement `Engine`, `Voice` and the time helpers** to the signatures above. The engine keeps at most one active id and one pending fade timer.
- [ ] **Step 5: Run `npm test`.** Expected: PASS.
- [ ] **Step 6: Commit** `feat: audio engine state machine`.

---

### Task 2: Element voice, prototype page and the audio gate

This task ends in a go/no-go decision (spec section 8). Do not start Tasks 6 to 10 until the gate is recorded as passed. Tasks 3 to 5 are server-only and may proceed while waiting for the phone test.

**Files:**
- Create: `src/audio/context.ts`, `src/audio/element-voice.ts`
- Create: `prototype/index.html`, `prototype/proto.ts`
- Create: `scripts/make-fixtures.sh`, `tests/fixtures/*.mp3`
- Create: `playwright.config.ts`, `tests/gate/gate.spec.ts`, `docs/audio-gate-results.md`

**Interfaces:**
- Consumes: `Voice`, `Engine` from Task 1.
- Produces:

```ts
// src/audio/context.ts
export function getAudioContext(): AudioContext;   // one shared instance
export function unlockAudio(): Promise<void>;      // resume(); call inside a user gesture

// src/audio/element-voice.ts
export function createElementVoice(
  ctx: AudioContext, src: string, destination?: AudioNode   // default ctx.destination
): Promise<Voice>;   // resolves after 'loadedmetadata'; rejects on the element's 'error'
```

`createElementVoice` rules: `new Audio()` with `preload = 'auto'`, routed `MediaElementAudioSourceNode → GainNode → destination`. `fadeOut(s)` is `setValueAtTime(current, now)` then `linearRampToValueAtTime(0, now + s)`. `arm`, `start` and `cancelFade` call `cancelScheduledValues` and set gain to 1. `start` skips the seek when `currentTime` is already within 1 ms of `fromSec`. A rejected `play()` promise with name `AbortError` is swallowed; others are logged. `dispose` pauses, disconnects and clears `src`.

Fixtures (all generated by `scripts/make-fixtures.sh` with ffmpeg, then committed):

| File | Content |
|---|---|
| `click-vbr.mp3` | 30 s, 44.1 kHz stereo; 220 Hz tone at amplitude 0.03 plus a 5 ms 2 kHz burst at amplitude 0.9 on every whole second; `libmp3lame -q:a 4` |
| `click-vbr-noxing.mp3` | same, with `-write_xing 0` |
| `click-cbr.mp3` | same audio, `-b:a 192k` |
| `short.mp3` | 2 s of the tone, mono, `-b:a 64k`, with an ID3v2 tag |
| `short-noid3.mp3` | same, `-id3v2_version 0` |
| `fake.mp3` | the text `not audio` |

Source expression: `aevalsrc='0.03*sin(2*PI*220*t)+0.9*sin(2*PI*2000*t)*lt(mod(t,1),0.005)':s=44100:d=30`.

- [ ] **Step 1: Generate and commit the fixtures.** Verify with `ffprobe` that the three click files are 30 s and that `click-vbr.mp3` reports a variable bitrate.

- [ ] **Step 2: Build the prototype page**

`npm run proto` runs `vite --host` and serves `/prototype/`. The page:
- loads the three click fixtures by URL and also accepts local mp3 files;
- has a start-point field (default 10.3 s), a fade field (default 2 s), and Play / Stop per file, wired through `Engine` and `createElementVoice`;
- has a **Measure ×10** button per file. Each run records the press time, calls `engine.play`, and timestamps on the audio clock (AudioWorklet or ScriptProcessor, resolution 6 ms or better) the first block with peak above 0.01 (`tSignal`) and the first with peak above 0.5 (`tClick`). Then `delayMs = tSignal − tPress` and `landedSec = 11 − (tClick − tSignal)` for a 10.3 s start. It cuts the track and waits 300 ms between runs;
- shows per-run values and a summary: max delay, landing spread (max − min), mean landing, `navigator.userAgent`; exposes the summary as `window.__gate` and has a Copy results button.

- [ ] **Step 3: Write the automated gate**

`tests/gate/gate.spec.ts`, run in Playwright projects `chromium`, `firefox`, `webkit` against the `proto` dev server:

```ts
for (const file of ['click-vbr.mp3', 'click-vbr-noxing.mp3', 'click-cbr.mp3'])
  test(`gate ${file}`, async ({ page }) => {
    const g = await measure(page, file);            // clicks Measure ×10, awaits window.__gate
    expect(g.maxDelayMs).toBeLessThan(100);
    expect(g.spreadMs).toBeLessThanOrEqual(20);
    expect(Math.abs(g.meanLandedSec - 10.3)).toBeLessThanOrEqual(0.1);
    test.info().annotations.push({ type: 'gate', description: JSON.stringify(g) });
  });
```

Also add a rapid-press check: fire Play A, Play B, Play A and Stop, Stop from one `page.evaluate`; assert no `pageerror` and no `unhandledrejection` events.

- [ ] **Step 4: Run `npx playwright test tests/gate`.** Record every project's numbers in `docs/audio-gate-results.md`.

- [ ] **Step 5: Phone check (needs the user).** Run `npm run proto`, give the user the Network URL ending `/prototype/`, and ask them to open it on their phone on the same wifi, tap Measure ×10 on each file, press Copy results, and also say whether Play sounds instant and Stop fades smoothly. On iPhone the ring/silent switch must be off. Add the results to `docs/audio-gate-results.md`.

- [ ] **Step 6: Decide.**
  - All pass marks met on every browser tested: record "Gate passed" and continue.
  - Otherwise: write a second `Voice` implementation behind the same interface (for example an `AudioBufferSourceNode` fed from a decoded window around the start point), re-run Steps 4 and 5, and check phone memory with 20 four-minute tracks. Every rule in spec 7.4 and every anti-goal must still hold. If the only fix changes behaviour the club would notice, stop and ask the user.

- [ ] **Step 7: Commit** `feat: element voice and audio gate`.

---

### Task 3: Plugin skeleton, capabilities and settings

**Files:**
- Create: `match-music/match-music.php`, `match-music/includes/capabilities.php`, `match-music/includes/settings.php`
- Create: `.wp-env.json`, `composer.json`, `phpunit.xml.dist`, `tests/php/bootstrap.php`
- Test: `tests/php/CapabilitiesTest.php`, `tests/php/SettingsTest.php`

**Interfaces:**
- Produces (namespace `MatchMusic`; global constants `MATCH_MUSIC_FILE`, `MATCH_MUSIC_VERSION`):

```php
function play_cap(): string;        // apply_filters('match_music_play_capability', 'read')
function edit_cap(): string;        // apply_filters('match_music_edit_capability', 'edit_others_posts')
function can_play(): bool;
function can_edit(): bool;
function get_fade_ms(): int;        // option 'match_music_settings'['fade_ms'], default 2000
function set_fade_ms(int $ms): int; // round to nearest 500, clamp 0..10000, save, return stored value
```

- [ ] **Step 1: Set up the local WordPress**

`.wp-env.json`: `"plugins": ["./match-music"]`, `"mappings": {"wp-content/mm-dev": "."}`, `"phpVersion": "7.4"` (if wp-env cannot provide 7.4, use the lowest it offers and add an `npm run lint:php` that runs `php -l` over `match-music/` in a `php:7.4-cli` container). `composer.json` requires `phpunit/phpunit ^9` and `yoast/phpunit-polyfills`. `bootstrap.php` loads the WordPress test library from `WP_TESTS_DIR` and the plugin via `muplugins_loaded`. Script `"test:php": "wp-env run tests-cli --env-cwd=wp-content/mm-dev vendor/bin/phpunit"`. Plugin header: `Requires at least: 6.4`, `Requires PHP: 7.4`.

- [ ] **Step 2: Write the failing tests**

```php
// CapabilitiesTest
public function test_roles() {
  $this->assertFalse( can_play() ); $this->assertFalse( can_edit() );           // logged out
  wp_set_current_user( self::factory()->user->create( [ 'role' => 'subscriber' ] ) );
  $this->assertTrue( can_play() );  $this->assertFalse( can_edit() );
  wp_set_current_user( self::factory()->user->create( [ 'role' => 'author' ] ) );
  $this->assertFalse( can_edit() );
  wp_set_current_user( self::factory()->user->create( [ 'role' => 'editor' ] ) );
  $this->assertTrue( can_play() );  $this->assertTrue( can_edit() );
}
public function test_caps_are_filterable() {
  add_filter( 'match_music_edit_capability', function () { return 'read'; } );
  wp_set_current_user( self::factory()->user->create( [ 'role' => 'subscriber' ] ) );
  $this->assertTrue( can_edit() );
}
// SettingsTest
$this->assertSame( 2000, get_fade_ms() );
$this->assertSame( 2500, set_fade_ms( 2300 ) ); $this->assertSame( 2500, get_fade_ms() );
$this->assertSame( 0, set_fade_ms( -5 ) );      $this->assertSame( 10000, set_fade_ms( 99999 ) );
```

- [ ] **Step 3: Run `npx wp-env start`, `composer install` inside the container, then `npm run test:php`.** Expected: FAIL, functions undefined.
- [ ] **Step 4: Implement** the bootstrap file and the two include files.
- [ ] **Step 5: Run `npm run test:php`.** Expected: PASS.
- [ ] **Step 6: Commit** `feat: plugin skeleton, capabilities, settings`.

---

### Task 4: Private file storage and the track data layer

**Files:**
- Create: `match-music/includes/storage.php`, `match-music/includes/tracks.php`, `match-music/uninstall.php`
- Modify: `match-music/match-music.php` (require the files, register the post type on `init`)
- Test: `tests/php/StorageTest.php`, `tests/php/TracksTest.php`

**Interfaces:**
- Produces:

```php
function private_dir(): string;      // trailing slash; creates the folder, a deny-all .htaccess (Apache 2.2 and 2.4 syntax) and an empty index.php
function is_mp3(string $path, string $client_name): bool;
   // extension is "mp3" (case-insensitive) AND the file starts with "ID3"
   // OR byte0 === 0xFF and (byte1 & 0xE0) === 0xE0
function store_file(string $source_path): string;   // rename, falling back to copy + unlink; returns the new filename
function file_path(string $filename): string;       // private_dir() . basename($filename)

function register_track_type(): void;  // 'mm_track': public false, show_ui false, show_in_rest false, exclude_from_search true
function create_track(string $name, string $source_path, string $original_name); // int id | WP_Error; start 0, appended last
function get_track(int $id): ?array;
function list_tracks(): array;         // by menu_order, then ID
function update_track(int $id, array $fields);  // array | WP_Error; keys 'name', 'start_ms'
function delete_track(int $id): bool;  // force-deletes the post and unlinks the file
function set_order(array $ids);        // true | WP_Error; $ids must be a permutation of all track ids
function track_file(int $id): ?string; // absolute path, or null when the file is gone
function purge_all(): void;            // every track, the private folder, the option
```

Track array: `['id' => int, 'name' => string, 'start_ms' => int, 'order' => int, 'size' => int, 'version' => string]`. `name` is the raw `post_title`, never `get_the_title()`. `version` is a random token set at creation. Meta keys: `_mm_file`, `_mm_start_ms`, `_mm_size`, `_mm_original_name`, `_mm_version`.

Validation: `name` is `sanitize_text_field`'d, must be non-empty and at most 200 characters, else `WP_Error('mm_invalid_name')`. `start_ms` must be an integer from 0 to 86400000, rounded to the nearest 100, else `WP_Error('mm_invalid_start')`. Bad order gives `WP_Error('mm_invalid_order')`. Unknown id gives `WP_Error('mm_not_found')`.

`uninstall.php` guards on `WP_UNINSTALL_PLUGIN`, loads the includes and calls `purge_all()`.

- [ ] **Step 1: Write the failing tests** (fixtures are copied to a temp path before each use)

```php
// StorageTest
$dir = private_dir();
$this->assertFileExists( $dir . '.htaccess' ); $this->assertFileExists( $dir . 'index.php' );
$this->assertStringContainsString( 'match-music-private', $dir );
$this->assertTrue(  is_mp3( $fx . 'short.mp3', 'short.mp3' ) );          // ID3 tag
$this->assertTrue(  is_mp3( $fx . 'short-noid3.mp3', 'SHORT.MP3' ) );    // frame sync, uppercase extension
$this->assertFalse( is_mp3( $fx . 'fake.mp3', 'fake.mp3' ) );
$this->assertFalse( is_mp3( $fx . 'short.mp3', 'short.wav' ) );
// TracksTest
$id = create_track( 'Goal', $tmp, 'goal.mp3' ); $t = get_track( $id );
$this->assertSame( 0, $t['start_ms'] ); $this->assertSame( 'Goal', $t['name'] );
$this->assertMatchesRegularExpression( '/^[0-9a-f]{32}\.mp3$/', get_post_meta( $id, '_mm_file', true ) );
$this->assertFileExists( track_file( $id ) );
$this->assertEmpty( get_posts( [ 'post_type' => 'attachment', 'post_status' => 'any' ] ) );
$this->assertArrayNotHasKey( 'file', $t );
$second = create_track( 'Timeout', $tmp2, 't.mp3' );
$this->assertSame( [ $id, $second ], wp_list_pluck( list_tracks(), 'id' ) );

$name = 'Rock & Roll "Live" – Åge';
$this->assertSame( $name, update_track( $id, [ 'name' => $name ] )['name'] );
$this->assertSame( 'mm_invalid_name', update_track( $id, [ 'name' => '   ' ] )->get_error_code() );
$this->assertSame( 42300, update_track( $id, [ 'start_ms' => 42349 ] )['start_ms'] );
$this->assertSame( 'mm_invalid_start', update_track( $id, [ 'start_ms' => -1 ] )->get_error_code() );

$this->assertTrue( set_order( [ $second, $id ] ) );
$this->assertSame( [ $second, $id ], wp_list_pluck( list_tracks(), 'id' ) );
$this->assertSame( 'mm_invalid_order', set_order( [ $id ] )->get_error_code() );

$path = track_file( $id ); unlink( $path ); $this->assertNull( track_file( $id ) );
$path2 = track_file( $second ); delete_track( $second );
$this->assertFileDoesNotExist( $path2 ); $this->assertNull( get_track( $second ) );

$type = get_post_type_object( 'mm_track' );
$this->assertFalse( $type->public ); $this->assertFalse( $type->show_in_rest ); $this->assertTrue( $type->exclude_from_search );

create_track( 'X', $tmp3, 'x.mp3' ); purge_all();
$this->assertSame( [], list_tracks() ); $this->assertDirectoryDoesNotExist( $dir ); $this->assertFalse( get_option( 'match_music_settings' ) );
```

- [ ] **Step 2: Run `npm run test:php`.** Expected: FAIL.
- [ ] **Step 3: Implement** `storage.php`, `tracks.php`, `uninstall.php`.
- [ ] **Step 4: Run `npm run test:php`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: private storage and track data layer`.

---

### Task 5: REST API

**Files:**
- Create: `match-music/includes/rest.php`
- Modify: `match-music/match-music.php`
- Test: `tests/php/RestTest.php`

**Interfaces:**
- Consumes: everything from Tasks 3 and 4.
- Produces: routes under `match-music/v1`.

| Route | Cap | Request | Success |
|---|---|---|---|
| `GET /tracks` | play | | 200, Track[] |
| `POST /tracks` | edit | multipart, field `file` | 201, Track; name is the filename without extension |
| `PATCH /tracks/(?P<id>\d+)` | edit | JSON `{name?, start_ms?}` | 200, Track |
| `DELETE /tracks/(?P<id>\d+)` | edit | | 200, `{"deleted": true}` |
| `PUT /tracks/order` | edit | JSON `{ids: int[]}` | 200, Track[] |
| `GET /tracks/(?P<id>\d+)/audio` | play | | 200, the mp3 bytes |
| `GET /settings` | play | | 200, `{"fade_ms": int}` |
| `PUT /settings` | edit | JSON `{fade_ms: int}` | 200, `{"fade_ms": int}` |

Errors (`{code, message}`): logged out 401 and missing capability 403 (use `rest_authorization_required_code()`); `mm_no_file` 400, with the limit from `size_format( wp_max_upload_size() )` in the message; `mm_too_large` 413 for `UPLOAD_ERR_INI_SIZE`, `UPLOAD_ERR_FORM_SIZE` or size above `wp_max_upload_size()`, same limit in the message; `mm_not_mp3` 415; `mm_not_found` 404; `mm_file_missing` 404; `mm_invalid_name`, `mm_invalid_start`, `mm_invalid_order`, `mm_invalid_fade` 400 (`fade_ms` must be an integer).

Audio route: the callback returns a `WP_REST_Response` with headers `Content-Type: audio/mpeg`, `Content-Length`, `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`. A `rest_pre_serve_request` filter, matching this route and a 200 response, clears output buffers, sends the headers, streams the file with `readfile` and returns `true`. The path comes only from `track_file( $id )`.

- [ ] **Step 1: Write the failing tests**

```php
/** @dataProvider matrix */
public function test_permissions( $method, $route, $anon, $subscriber, $editor ) { /* dispatch as each user, assert status */ }
public function matrix() { return [
  [ 'GET',    '/tracks',           401, 200, 200 ],
  [ 'POST',   '/tracks',           401, 403, 201 ],
  [ 'PATCH',  '/tracks/{id}',      401, 403, 200 ],
  [ 'DELETE', '/tracks/{id}',      401, 403, 200 ],
  [ 'PUT',    '/tracks/order',     401, 403, 200 ],
  [ 'GET',    '/tracks/{id}/audio',401, 200, 200 ],
  [ 'GET',    '/settings',         401, 200, 200 ],
  [ 'PUT',    '/settings',         401, 403, 200 ],
]; }

// as editor
$r = $this->upload( 'short.mp3', 'Goal Song.mp3' );          // set_file_params
$this->assertSame( 201, $r->get_status() ); $this->assertSame( 'Goal Song', $r->get_data()['name'] );
$this->assertSame( [ 'id', 'name', 'start_ms', 'order', 'size', 'version' ], array_keys( $r->get_data() ) );
$this->assertSame( 415, $this->upload( 'fake.mp3', 'fake.mp3' )->get_status() );
$none = $this->dispatch( 'POST', '/tracks' );                 // PHP dropped the body
$this->assertSame( 'mm_no_file', $none->get_data()['code'] );
$this->assertStringContainsString( size_format( wp_max_upload_size() ), $none->get_data()['message'] );
$this->assertSame( 413, $this->upload( 'short.mp3', 'a.mp3', UPLOAD_ERR_INI_SIZE )->get_status() );

$name = 'Rock & Roll "Live" – Åge';
$this->assertSame( $name, $this->dispatch( 'PATCH', "/tracks/$id", [ 'name' => $name ] )->get_data()['name'] );
$this->assertSame( $name, $this->dispatch( 'GET', '/tracks' )->get_data()[0]['name'] );
$this->assertSame( 42300, $this->dispatch( 'PATCH', "/tracks/$id", [ 'start_ms' => 42349 ] )->get_data()['start_ms'] );
$this->assertSame( 404, $this->dispatch( 'PATCH', '/tracks/999999', [ 'name' => 'x' ] )->get_status() );

$a = $this->dispatch( 'GET', "/tracks/$id/audio" ); $h = $a->get_headers();
$this->assertSame( 'audio/mpeg', $h['Content-Type'] ); $this->assertSame( 'private, no-store', $h['Cache-Control'] );
$this->assertSame( (string) filesize( track_file( $id ) ), (string) $h['Content-Length'] );
unlink( track_file( $id ) );
$this->assertSame( 'mm_file_missing', $this->dispatch( 'GET', "/tracks/$id/audio" )->get_data()['code'] );

$this->assertSame( 2500, $this->dispatch( 'PUT', '/settings', [ 'fade_ms' => 2300 ] )->get_data()['fade_ms'] );
$this->assertSame( 400, $this->dispatch( 'PUT', '/settings', [ 'fade_ms' => 'abc' ] )->get_status() );
```

- [ ] **Step 2: Run `npm run test:php`.** Expected: FAIL.
- [ ] **Step 3: Implement `rest.php`** and register it on `rest_api_init`.
- [ ] **Step 4: Run `npm run test:php`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: REST API`.

---

### Task 6: Board page and front-end shell

**Files:**
- Create: `match-music/includes/board-page.php`
- Modify: `match-music/match-music.php` (activation and deactivation hooks, plugin action link)
- Create: `src/main.tsx`, `src/index.css`, `src/boot.ts`, `src/strings.ts`, `src/components/Board.tsx`, `components.json`, `src/components/ui/*`
- Modify: `vite.config.ts`, `package.json`
- Test: `tests/php/BoardPageTest.php`

**Interfaces:**
- Produces:

```php
function board_slug(): string;   // apply_filters('match_music_board_slug', 'match-music')
function board_url(): string;    // home_url('/match-music/'); with plain permalinks home_url('/?mm_board=1')
function boot_data(): array;
function render_board(): void;   // on template_redirect when query var mm_board is set
```

```ts
// src/boot.ts
export interface Boot { restUrl: string; nonce: string; nonceUrl: string; canEdit: boolean;
  maxUploadBytes: number; loginUrl: string; fadeMs: number }
export function getBoot(): Boot;   // reads window.MatchMusicBoot
```

`boot_data()` returns exactly those keys: `restUrl = rest_url('match-music/v1/')`, `nonce = wp_create_nonce('wp_rest')`, `nonceUrl = admin_url('admin-ajax.php?action=rest-nonce')`, `canEdit = can_edit()`, `maxUploadBytes = wp_max_upload_size()`, `loginUrl = wp_login_url( board_url() )`, `fadeMs = get_fade_ms()`.

`render_board()`: logged out calls `auth_redirect()`; logged in without the play capability calls `wp_die()` with status 403; otherwise `nocache_headers()`, header `X-Robots-Tag: noindex, nofollow`, and a complete HTML document: robots meta, viewport meta, `<title>Match music</title>`, the CSS and module script named in `build/.vite/manifest.json` for entry `src/main.tsx`, `<div id="root">`, and `window.MatchMusicBoot` via `wp_json_encode`. No theme template, `wp_head` or `wp_footer`. Then `exit`.

Rewrite rule `^{slug}/?$` to `index.php?mm_board=1` at priority `top`; `mm_board` registered as a query var; rules flushed on activation and deactivation. Add an "Open board" link to the plugin's row on the Plugins screen.

Vite: `base: './'`, `build.outDir: 'match-music/build'`, `build.manifest: true`, input `src/main.tsx`. Tailwind and shadcn/ui initialised with components `button dialog alert-dialog input label slider popover progress sonner dropdown-menu`.

- [ ] **Step 1: Write the failing PHP tests**

```php
wp_set_current_user( $subscriber ); $b = boot_data();
$this->assertSame( [ 'restUrl','nonce','nonceUrl','canEdit','maxUploadBytes','loginUrl','fadeMs' ], array_keys( $b ) );
$this->assertFalse( $b['canEdit'] ); $this->assertSame( 2000, $b['fadeMs'] );
$this->assertStringEndsWith( '/match-music/v1/', $b['restUrl'] );
wp_set_current_user( $editor ); $this->assertTrue( boot_data()['canEdit'] );

$this->set_permalink_structure( '/%postname%/' );
$this->assertStringEndsWith( '/match-music/', board_url() );
$this->set_permalink_structure( '' );
$this->assertStringContainsString( 'mm_board=1', board_url() );
add_filter( 'match_music_board_slug', function () { return 'kampmusik'; } );
$this->set_permalink_structure( '/%postname%/' );
$this->assertStringEndsWith( '/kampmusik/', board_url() );
```

- [ ] **Step 2: Run `npm run test:php`.** Expected: FAIL.
- [ ] **Step 3: Implement `board-page.php`** and the activation hooks.
- [ ] **Step 4: Build the shell.** `Board` renders the heading from `strings.ts` (`"Match music"`). `npm run build`.
- [ ] **Step 5: Verify.** `npm run test:php` passes. In a browser at `http://localhost:8888/match-music/`: logged out lands on `wp-login.php`; after logging in as `admin` the heading shows, the page has no theme markup, and the console has no errors.
- [ ] **Step 6: Commit** `feat: standalone board page and front-end shell`.

---

### Task 7: API client and audio loader

**Files:**
- Create: `src/api.ts`, `src/audio/loader.ts`
- Test: `src/api.test.ts`, `src/audio/loader.test.ts`

**Interfaces:**
- Consumes: `Boot` from Task 6.
- Produces:

```ts
// src/api.ts
export interface Track { id: number; name: string; start_ms: number; order: number; size: number; version: string }
export interface Settings { fade_ms: number }
export class ApiError extends Error { code: string; status: number }
export class SessionExpiredError extends Error {}
export interface Api {
  listTracks(): Promise<Track[]>;
  uploadTrack(file: File, onProgress: (fraction: number) => void): Promise<Track>;  // XMLHttpRequest, for progress
  updateTrack(id: number, patch: { name?: string; start_ms?: number }): Promise<Track>;
  deleteTrack(id: number): Promise<void>;
  saveOrder(ids: number[]): Promise<Track[]>;
  fetchAudio(id: number): Promise<Response>;
  getSettings(): Promise<Settings>;
  saveSettings(s: Settings): Promise<Settings>;
}
export function createApi(boot: Boot): Api;

// src/audio/loader.ts
export const CACHE_NAME = 'match-music-audio-v1';
export function cacheKey(t: { id: number; version: string }): string;   // `/mm-audio/${id}/${version}`
export function loadAudioBlob(t: { id: number; version: string }, fetchAudio: (id: number) => Promise<Response>): Promise<Blob>;
export function pruneCache(keep: Array<{ id: number; version: string }>): Promise<void>;
```

Client rules: every request sends `X-WP-Nonce` and `credentials: 'same-origin'`. On 403 with code `rest_cookie_invalid_nonce`, GET `boot.nonceUrl` (plain-text nonce), store it and retry once. On 401 throw `SessionExpiredError`. Any other non-2xx throws `ApiError` with the server's `code` and `message`. `uploadTrack` rejects with `ApiError` code `mm_too_large` before sending when `file.size > boot.maxUploadBytes`.

Loader rules: look in Cache Storage first; on a miss fetch, store, and return. When `caches` is undefined, or any cache call throws, fall back to a plain fetch. `pruneCache` deletes every entry not in `keep`. Call `navigator.storage.persist()` once, ignoring the result.

- [ ] **Step 1: Write the failing tests** (mocked `fetch`, a small in-memory `caches` stub)

```ts
test('sends nonce and cookies', ...)        // headers['X-WP-Nonce'] === 'n1', credentials 'same-origin'
test('refreshes an expired nonce and retries once', ...)  // 403 rest_cookie_invalid_nonce → GET nonceUrl → retry with 'n2' → resolves
test('401 throws SessionExpiredError', ...)
test('maps server errors', ...)             // {code:'mm_not_mp3',message:'Only mp3'} → ApiError, code 'mm_not_mp3', status 415
test('refuses oversize files before sending', ...) // size > maxUploadBytes → ApiError 'mm_too_large', no request made
test('cache miss fetches and stores', ...)  // fetchAudio called once, cache has cacheKey
test('cache hit skips the network', ...)    // second load: fetchAudio still called once
test('new version re-downloads', ...)       // version 'b' → fetchAudio called twice
test('works without Cache Storage', ...)    // caches undefined → resolves with a Blob
test('pruneCache removes stale entries', ...) // keeps {1,'a'}; deletes {1,'old'} and {2,'x'}
```

- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement `api.ts` and `loader.ts`.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: API client and cached audio loader`.

---

### Task 8: The board for playing

**Files:**
- Create: `src/board-store.ts`, `src/hooks/useBoard.ts`, `src/components/TrackList.tsx`, `src/components/TrackRow.tsx`
- Modify: `src/components/Board.tsx`, `src/strings.ts`
- Test: `src/board-store.test.ts`, `src/components/TrackRow.test.tsx`

**Interfaces:**
- Consumes: `Engine`, `Voice`, `createElementVoice`, `unlockAudio`, `Api`, `Track`, `loadAudioBlob`, `pruneCache`, `formatMs`, `formatElapsed`.
- Produces:

```ts
// src/board-store.ts
export type RowStatus = 'loading' | 'error' | TrackState;
export interface BoardRow { track: Track; status: RowStatus }
export interface BoardDeps { api: Api; engine: Engine;
  makeVoice(blob: Blob): Promise<Voice>;
  loadBlob(t: Track): Promise<Blob>; prune(keep: Track[]): Promise<void> }
export class BoardStore {
  constructor(deps: BoardDeps, initialFadeMs: number);
  rows(): BoardRow[]; fadeMs(): number; loaded(): number; total(): number; sessionExpired(): boolean;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;                 // fetch tracks + settings, then reconcile
  retry(id: number): void;
  audioBlob(id: number): Promise<Blob>;
  play(id: number, fromMs?: number): void; stop(id: number): void;
  positionSec(id: number): number; durationSec(id: number): number;
  saveFade(ms: number): Promise<void>;
  upload(files: File[], onProgress: (file: File, fraction: number) => void): Promise<Array<{ file: File; error?: string }>>;
  update(id: number, patch: { name?: string; start_ms?: number }): Promise<void>;
  remove(id: number): Promise<void>;
  reorder(ids: number[]): Promise<void>;    // optimistic; reverts and rethrows on failure
}
// src/hooks/useBoard.ts
export function useBoard(): BoardStore;     // creates the store once, subscribes, starts the sync loop and wake lock
```

Store rules:
- Audio downloads run three at a time, in list order.
- Reconcile against the server list: new id → load and `engine.add`; missing id → `engine.remove` (the engine defers while it is active), then drop the row and prune the cache once it is gone; changed `start_ms` → `engine.setStartMs`; changed `version` → load the new blob, then swap voices once the track is idle; changed name or order → update rows.
- A failed load sets that row to `error` and leaves the others alone. `retry` loads it again.
- `SessionExpiredError` from any call sets `sessionExpired`; playback of loaded tracks is untouched.

Hook rules: refresh on mount, on `visibilitychange` to visible, on window `focus`, and every 60 s. Call `unlockAudio()` on the first `pointerdown`. Request `navigator.wakeLock.request('screen')` on mount and whenever the page becomes visible; ignore failures.

UI (spec 7.3, mockup `.superpowers/brainstorm/*/content/board-layout.html`, option A):
- Header: title, `Loading 7/20` while `loaded < total`, fade shown as `Fade 2.0 s` (read-only in this task), a session-expired banner linking to `boot.loginUrl`.
- `TrackList`: one column; at the `lg` breakpoint two columns filled top to bottom, then left to right.
- `TrackRow`: root element has `data-status={status}` and `data-track-id`. Wide layout: name, status text, Play, Stop, and a slot for editor controls. Status text is `starts 0:42.3` when ready, `0:07 playing` while playing (updated about four times a second), `fading` while fading. Stop is enabled only when the status is `playing` or `fading`. Play is disabled while `loading`. `error` shows a message and a Retry button. Narrow layout (below `sm`): name plus one large toggle, `data-testid="row-toggle"`, which is Stop when the status is `playing` and Play otherwise.
- The playing row is highlighted; the fading row has its own style.

- [ ] **Step 1: Write the failing tests**

```ts
// board-store.test.ts: fake api, real Engine with FakeVoice from Task 1, controllable loadBlob promises
test('new tracks load and become ready', ...)            // status 'loading' → 'ready'; loaded() counts up to total()
test('downloads run three at a time in list order', ...) // 5 tracks: loadBlob called for ids 1,2,3 only until one resolves
test('a failed load marks only that row', ...)           // row 2 'error', rows 1 and 3 'ready'; retry(2) → 'ready'
test('a changed start point reaches the engine', ...)    // refresh with start_ms 10000 → voice last call ['arm', 10]
test('a start point changed while playing waits', ...)   // play(1); refresh with new start → no arm until stop completes
test('a track deleted elsewhere keeps playing, then disappears', ...)
   // play(1); refresh without track 1 → rows() still has it, state 'playing'; stop + timers → row gone, prune called
test('a new version swaps after the track is idle', ...) // old voice disposed only once not active
test('session expiry does not stop playback', ...)       // api throws SessionExpiredError → sessionExpired() true, state(1) 'playing'
test('reorder reverts on failure', ...)

// TrackRow.test.tsx
test('ready', ...)    // text 'starts 0:42.3'; Play enabled; Stop disabled
test('playing', ...)  // data-status 'playing'; text matches /0:07 playing/; Stop enabled; toggle labelled Stop
test('fading', ...)   // text 'fading'; Stop enabled; toggle labelled Play
test('loading', ...)  // Play disabled
test('error', ...)    // Retry button calls retry(id)
test('viewer sees no editor controls', ...)  // canEdit false → no Edit button, no drag handle
```

- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement** the store, hook and components.
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Verify in the browser.** `npm run build`; create two tracks with `wp-env run cli wp eval` calling `MatchMusic\create_track` on copies of `click-cbr.mp3`; open the board: both rows load, Play starts sound, Stop fades over 2 s, Play on the other row cuts the first. Check the narrow layout at a 375 px viewport.
- [ ] **Step 6: Commit** `feat: playable board`.

---

### Task 9: Editor controls: fade, upload, reorder

**Files:**
- Create: `src/components/FadeControl.tsx`, `src/components/AddTracks.tsx`, `src/lib/reorder.ts`
- Modify: `src/components/Board.tsx`, `src/components/TrackList.tsx`, `src/components/TrackRow.tsx`, `src/strings.ts`
- Test: `src/components/FadeControl.test.tsx`, `src/components/AddTracks.test.tsx`, `src/lib/reorder.test.ts`

**Interfaces:**
- Consumes: `BoardStore` from Task 8.
- Produces: `export function moveId(ids: number[], fromId: number, toId: number): number[]`.

Behaviour:
- `FadeControl`: for editors a popover with a slider, 0 to 10 s in 0.5 s steps, showing the value as `2.0 s`; it calls `saveFade(ms)` when the slider is released. For others it renders the read-only text from Task 8.
- `AddTracks` (editors only): an `Add mp3` button opening a multi-file picker (`accept=".mp3,audio/mpeg"`), and a drop zone covering the list. Files whose name does not end in `.mp3` (case-insensitive) are refused client-side with a message; the rest go to `store.upload`. A per-file progress bar shows while uploading. Each failure shows the server's message in a toast, including the size limit for oversize files.
- Reorder (editors only): a drag handle on each row using dnd-kit, working with mouse and touch across both columns. On drop the new order is `moveId(...)` passed to `store.reorder`; on failure a toast says the order was not saved.

- [ ] **Step 1: Write the failing tests**

```ts
expect(moveId([1, 2, 3, 4], 4, 2)).toEqual([1, 4, 2, 3]);
expect(moveId([1, 2, 3], 1, 3)).toEqual([2, 3, 1]);
expect(moveId([1, 2, 3], 2, 2)).toEqual([1, 2, 3]);

test('editor commits a new fade', ...)        // slider to 3.5 → saveFade(3500) called once
test('viewer sees the value only', ...)       // text 'Fade 2.0 s', no slider role
test('non-mp3 files are refused locally', ...) // drop notes.txt + a.MP3 → upload called with [a.MP3]; message for notes.txt
test('server errors are shown per file', ...)  // upload resolves [{file, error:'Too large (limit 8 MB)'}] → that text visible
test('hidden for viewers', ...)               // canEdit false → no 'Add mp3' button
```

- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Verify in the browser as `admin`:** upload two fixtures at once, drag the second above the first, change the fade to 0.5 s, reload: all three changes persist. Log in as a Subscriber: none of the controls are present.
- [ ] **Step 6: Commit** `feat: fade control, upload and reorder`.

---

### Task 10: Edit dialog with waveform

**Files:**
- Create: `src/audio/peaks.ts`, `src/components/Waveform.tsx`, `src/components/EditTrackDialog.tsx`
- Modify: `src/components/TrackRow.tsx`, `src/strings.ts`
- Test: `src/audio/peaks.test.ts`, `src/components/EditTrackDialog.test.tsx`

**Interfaces:**
- Consumes: `BoardStore`, `BoardRow`, `snapMs`, `formatMs`, `getAudioContext`.
- Produces:

```ts
// src/audio/peaks.ts
export function computePeaks(channels: Float32Array[], buckets: number): Float32Array; // max |sample| per bucket across channels
export function decodePeaks(blob: Blob, buckets?: number): Promise<{ peaks: Float32Array; durationSec: number }>; // default 1200; keeps no reference to the AudioBuffer

// src/components/Waveform.tsx
export function Waveform(props: { peaks: Float32Array | null; durationMs: number; startMs: number;
  playheadMs: number | null; onChange(startMs: number): void }): JSX.Element;

// src/components/EditTrackDialog.tsx
export function EditTrackDialog(props: { row: BoardRow; store: BoardStore; open: boolean;
  onOpenChange(open: boolean): void }): JSX.Element;
```

Behaviour (spec 7.6, mockup `.superpowers/brainstorm/*/content/edit-start-point.html`):
- Opened from an Edit button on the wide row and from a small menu on the narrow row; editors only.
- The dialog holds a draft `{ name, startMs }`. Nothing reaches the server until Save.
- Waveform: canvas; a skeleton while `decodePeaks` runs; the region before the marker dimmed; click or drag sets the draft start through `snapMs`; the playhead follows `store.positionSec` while this track plays.
- Buttons, with these exact labels: `− 1 s`, `− 0.1 s`, `+ 0.1 s`, `+ 1 s`, `Test from start point`, `Listen from 0:00`, `Mark here`, `Stop`, `Delete track`, `Cancel`, `Save`.
- `Test from start point` → `store.play(id, draft.startMs)`. `Listen from 0:00` → `store.play(id, 0)`. `Mark here` → `snapMs(store.positionSec(id) * 1000, durationMs)`. `Stop` → `store.stop(id)`.
- `Save` → `store.update(id, { name, start_ms })` with only the fields that changed, then close. Save is disabled while the name is blank.
- Closing by any route stops this track if it is active. `Cancel` discards the draft.
- `Delete track` asks for confirmation in an alert dialog, then `store.remove(id)`.

- [ ] **Step 1: Write the failing tests**

```ts
// peaks.test.ts
expect(Array.from(computePeaks([new Float32Array([0, .5, -1, .25])], 2))).toEqual([.5, 1]);
expect(Array.from(computePeaks([new Float32Array([.1, .1]), new Float32Array([-.9, .2])], 1))).toEqual([.9]);

// EditTrackDialog.test.tsx: fake store, row { start_ms: 42300 }, durationSec 200
test('nudges snap and clamp', ...)   // '+ 0.1 s' → readout '0:42.4'; at 500 ms '− 1 s' → '0:00.0'; at 199900 '+ 1 s' stays '3:19.9'
test('test plays the draft start', ...)  // after '+ 0.1 s', 'Test from start point' → play(id, 42400)
test('listen plays from zero', ...)      // play(id, 0)
test('mark here uses the playback position', ...) // positionSec → 51.26 → readout '0:51.3'
test('save sends only what changed', ...) // rename to 'Goal 2' → update(id, { name: 'Goal 2' }); nudge too → { name, start_ms }
test('cancel sends nothing', ...)
test('blank name disables save', ...)
test('closing stops a preview', ...)     // activeId === id on close → stop(id)
test('delete needs confirmation', ...)   // remove not called until the alert dialog is confirmed
```

- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Verify in the browser** with `click-cbr.mp3`: the waveform shows a spike every second; click near 10 s, nudge to 10.3, `Test from start point` starts 0.7 s before a click; Save; the row reads `starts 0:10.3` and Play matches the test.
- [ ] **Step 6: Commit** `feat: track editor with waveform`.

---

### Task 11: End-to-end tests

**Files:**
- Modify: `playwright.config.ts` (add an `e2e` project set: chromium, firefox, webkit; `baseURL` `http://localhost:8888`)
- Create: `tests/e2e/global-setup.ts`, `tests/e2e/helpers.ts`, `tests/e2e/access.spec.ts`, `tests/e2e/editor.spec.ts`, `tests/e2e/playback.spec.ts`

**Interfaces:**
- Consumes: the built plugin in wp-env; row attributes `data-status`, `data-track-id` from Task 8.

Global setup, via `wp-env run cli wp ...`: set permalinks to `/%postname%/`, create users `mm_sub` (subscriber) and `mm_editor` (editor) with test passwords kept in `helpers.ts`, delete all `mm_track` posts, reset the option. `helpers.ts` exports `login(page, user)` and `uploadFixture(page, name)`.

- [ ] **Step 1: Write the tests**

```ts
// access.spec.ts
test('logged out is sent to login', ...)        // goto /match-music/ → URL contains wp-login.php and redirect_to
test('logged out cannot fetch audio', ...)      // request GET /wp-json/match-music/v1/tracks/{id}/audio → 401
test('private folder is not browsable', ...)    // GET /wp-content/uploads/match-music-private/ → 403 or 404
test('responses never reveal the stored filename', ...) // GET /tracks JSON and board HTML contain no /[0-9a-f]{32}\.mp3/
test('subscriber can play but not edit', ...)   // no 'Add mp3', no Edit, no slider; Play works
test('subscriber write is refused', ...)        // PATCH with a valid nonce → 403
test('audio is served intact and uncached', ...) // 200, content-type audio/mpeg, body length = fixture size, cache-control has no-store
test('plain permalinks still reach the board', ...) // switch structure to '' → /?mm_board=1 shows the board; restore

// editor.spec.ts
test('upload, set start, persists', ...)   // upload click-cbr.mp3 → 'starts 0:00.0'; Edit; '+ 1 s' ×10, '+ 0.1 s' ×3; Save
                                           // → 'starts 0:10.3'; reload → still 'starts 0:10.3'
test('another user sees the same setup', ...) // new context as mm_sub → row 'click-cbr', 'starts 0:10.3'
test('fade duration is shared', ...)       // editor sets 0.5 s → subscriber sees 'Fade 0.5 s' after reload
test('rejects a fake mp3 with a reason', ...) // upload fake.mp3 → error text visible, no new row
test('delete removes the row for everyone', ...)

// playback.spec.ts (fade 0.5 s, two tracks A and B)
test('play, fade, ready', ...)   // Play A → data-status 'playing' and text /playing/; Stop → 'fading' → within 1.5 s 'ready', 'starts 0:10.3'
test('one track at a time', ...) // Play A, Play B → A 'ready', B 'playing'
test('play during fade restarts', ...) // fade 2 s; Play A, Stop, Play → 'playing' and still 'playing' 2.5 s later
test('narrow layout toggle', ...) // viewport 375×800: toggle starts A, same toggle stops it
```

- [ ] **Step 2: Run `npm run build && npx playwright test tests/e2e`.** Expected: PASS in all three browsers. Fix the product, not the test, for any failure that reflects the spec.
- [ ] **Step 3: Commit** `test: end-to-end coverage`.

---

### Task 12: Package, check the live site, install

Needs the user for site access and for the go-ahead to install.

**Files:**
- Create: `scripts/zip.mjs`, `docs/install-checklist.md`, `README.md`
- Modify: `package.json` (`"zip": "npm run build && node scripts/zip.mjs"`)

- [ ] **Step 1: Write the zip script.** Output `dist/match-music.zip` with a top-level `match-music/` folder holding the PHP files and `build/`.

Run: `npm run zip && unzip -l dist/match-music.zip`
Expected: lists `match-music/match-music.php`, `match-music/uninstall.php`, `match-music/build/.vite/manifest.json`; lists nothing from `node_modules`, `tests`, `src`, `vendor`.

- [ ] **Step 2: Fresh-install test.** `npx wp-env clean all`, install the zip with `wp plugin install dist/match-music.zip --activate`, open `/match-music/`. Then deactivate (tracks survive reactivation) and delete the plugin (tracks, folder and option are gone).

- [ ] **Step 3: Write `docs/install-checklist.md`** covering: install and activate; where the board is; Subscriber vs Editor; then the checks below, each with what a pass looks like.

- [ ] **Step 4: Check the live site before installing (ask the user for access).** Record in the checklist: WordPress version (6.4+), PHP version (7.4+), HTTPS, web server, `upload_max_filesize` and `post_max_size`, permalink setting, and any page-cache plugin or CDN. If the upload limit is under 15 MB, tell the user it needs raising and how. If the server is nginx, give the user a `location` rule denying `/wp-content/uploads/match-music-private/` and say that without it the files are protected by their unguessable names only.

- [ ] **Step 5: Install on the live site, only after the user says to.** Then run and record:
  - logged out: the board redirects to login; an audio URL returns 401;
  - `/wp-content/uploads/match-music-private/` is not browsable;
  - the board page and `GET /tracks` are not served from a cache (two requests, differing nonce; change a start point and see it at once);
  - an edit on one device appears on a second after a refresh;
  - upload a real 8 to 12 MB mp3.

- [ ] **Step 6: Manual device checklist with the user** (spec section 9): laptop Chrome, Firefox, Safari; the user's phone. Press-to-sound feels instant; the fade is smooth; the start point lands the same every time; a start point set on the laptop is right on the phone; turning wifi off after loading does not stop Play or Stop; the screen stays awake. iPhone: ring/silent switch off.

- [ ] **Step 7: Commit** `chore: packaging and install checklist`.
