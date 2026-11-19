import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { strings } from '../../src/strings';

export { expect, strings };

export const BASE_URL = 'http://localhost:8888';
export const BOARD_PATH = '/match-music/';
export const REST = '/wp-json/match-music/v1';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FIXTURES = path.join(ROOT, 'tests/fixtures');

// Test accounts for the local wp-env site only; global-setup.ts creates them.
export interface User {
  login: string;
  password: string;
  role: string; // '' for no role at all
}
export const users = {
  subscriber: { login: 'mm_sub', password: 'THFHlNXSntrKO0uGWVhYINA0', role: 'subscriber' },
  editor: { login: 'mm_editor', password: 'bRdqG5UxMQT6woRGj98DoNVq', role: 'editor' },
  noRole: { login: 'mm_norole', password: 'mu07g09rFIoW0DIOorQFDokl', role: '' },
} satisfies Record<string, User>;

// --- WordPress, through wp-cli in the wp-env container -------------------------------------

/** Runs `wp <args>` in wp-env's cli container and returns its stdout. */
export function wp(...args: string[]): string {
  return execFileSync('npx', ['wp-env', 'run', 'cli', 'wp', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Runs PHP in WordPress with `input` available as `$in` (passed as base64 JSON, no quoting issues). */
export function wpPhp(code: string, input: unknown = null): string {
  const payload = Buffer.from(JSON.stringify(input)).toString('base64');
  return wp('eval', `$in = json_decode( base64_decode( '${payload}' ), true ); ${code}`);
}

/** Deletes every track (and its file) and resets the settings option to the defaults. */
export function resetBoard(): void {
  wpPhp(`
    $ids = get_posts( [ 'post_type' => 'mm_track', 'post_status' => 'any', 'numberposts' => -1, 'fields' => 'ids' ] );
    foreach ( $ids as $id ) { \\MatchMusic\\delete_track( (int) $id ) || wp_delete_post( $id, true ); }
    delete_option( 'match_music_settings' );
  `);
}

/** Creates a track from a fixture file (copied, since storing moves the file). Returns its id. */
export function seedTrack(fixture: string, name: string, startMs = 0): number {
  const out = wpPhp(
    `
    $tmp = wp_tempnam( 'mm-e2e' );
    copy( WP_CONTENT_DIR . '/mm-dev/tests/fixtures/' . $in['fixture'], $tmp );
    $id = \\MatchMusic\\create_track( $in['name'], $tmp, $in['fixture'] );
    if ( is_wp_error( $id ) ) { WP_CLI::error( $id->get_error_message() ); }
    if ( $in['start'] ) { \\MatchMusic\\update_track( $id, [ 'start_ms' => $in['start'] ] ); }
    echo $id;
  `,
    { fixture, name, start: startMs },
  );
  return Number(out);
}

export function setFadeMs(ms: number): void {
  wpPhp(`\\MatchMusic\\set_fade_ms( (int) $in );`, ms);
}

export function trackOrder(): number[] {
  return JSON.parse(wpPhp(`echo wp_json_encode( wp_list_pluck( \\MatchMusic\\list_tracks(), 'id' ) );`));
}

/** The random name the file is stored under; read on the server, only to search responses for it. */
export function storedFilename(id: number): string {
  return wpPhp(`echo get_post_meta( (int) $in, '_mm_file', true );`, id);
}

// --- Fixtures ------------------------------------------------------------------------------

export function fixtureBytes(name: string): Buffer {
  return readFileSync(path.join(FIXTURES, name));
}

export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** True when the bytes look like the start of an mp3: an ID3 tag or an MPEG frame sync. */
export function looksLikeMp3(body: Buffer): boolean {
  if (body.length >= 3 && body.subarray(0, 3).toString('latin1') === 'ID3') return true;
  return body.length >= 2 && body[0] === 0xff && (body[1] & 0xe0) === 0xe0;
}

export const STORED_NAME = /[0-9a-f]{32}\.mp3/;

// --- Browser -------------------------------------------------------------------------------

/**
 * Silences the page's Web Audio output while the graph keeps running: every context's
 * `destination` becomes a gain node at 0 in front of the real one. Self-contained (it is
 * serialised into the page).
 */
function muteWebAudio(): void {
  const w = window as unknown as Record<string, { prototype: object } | undefined>;
  const Base = w.BaseAudioContext ?? w.AudioContext;
  if (!Base) return;
  const real = Object.getOwnPropertyDescriptor(Base.prototype, 'destination');
  if (!real?.get) return;
  const muted = new WeakMap<object, AudioNode>();
  Object.defineProperty(Base.prototype, 'destination', {
    configurable: true,
    get(this: BaseAudioContext) {
      let gain = muted.get(this);
      if (!gain) {
        const g = this.createGain();
        g.gain.value = 0;
        g.connect(real.get!.call(this) as AudioNode);
        muted.set(this, g);
        ((window as unknown as { __mutedContexts?: BaseAudioContext[] }).__mutedContexts ??= []).push(this);
        gain = g;
      }
      return gain;
    },
  });
}

/** Every page in these tests plays into a muted output. */
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.addInitScript(muteWebAudio);
    await use(context);
  },
});

/** A second, independent browser session (its own cookies and cache), muted like the first. */
export async function newSession(browser: Browser, viewport = { width: 1280, height: 800 }): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport });
  await context.addInitScript(muteWebAudio);
  return context;
}

/** Logs in through the WordPress login form; lands on the board (or its 403 page). */
export async function login(page: Page, user: User): Promise<void> {
  await page.goto(`/wp-login.php?redirect_to=${encodeURIComponent(BOARD_PATH)}`);
  await page.locator('#user_login').fill(user.login);
  await page.locator('#user_pass').fill(user.password);
  await page.locator('#wp-submit').click();
  await page.waitForURL((url) => !url.pathname.endsWith('/wp-login.php'));
}

/** A new session logged in as `user`, on the board with every track ready. */
export async function boardAs(browser: Browser, user: User, viewport?: { width: number; height: number }) {
  const context = await newSession(browser, viewport);
  const page = await context.newPage();
  await login(page, user);
  await waitForBoard(page);
  return { context, page };
}

/** The board is up and no row is still loading. */
export async function waitForBoard(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: strings.appTitle })).toBeVisible();
  await expect(page.locator('[data-status="loading"]')).toHaveCount(0);
}

export const row = (page: Page, id: number) => page.locator(`[data-track-id="${id}"]`);

/** A row by its exact track name. */
export const rowNamed = (page: Page, name: string) =>
  page.locator('[data-track-id]').filter({ has: page.getByText(name, { exact: true }) });

/** A REST nonce for the logged-in session of `page` (WordPress core's rest-nonce action). */
export async function restNonce(page: Page): Promise<string> {
  const res = await page.request.get('/wp-admin/admin-ajax.php?action=rest-nonce');
  expect(res.status()).toBe(200);
  return (await res.text()).trim();
}

/** Picks a fixture through the "Add mp3" button's file chooser. */
export async function uploadFixture(page: Page, name: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: strings.editor.addMp3 }).click();
  await (await chooser).setFiles(path.join(FIXTURES, name));
}

export interface StatusChange {
  id: number;
  status: string;
  t: number; // performance.now() in the page
  audio: string; // state of the page's audio context when the change was seen ('' if none yet)
}

/** Starts recording every row's data-status change in the page, with timestamps. */
export async function recordStatuses(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __statuses: StatusChange[]; __mutedContexts?: BaseAudioContext[] };
    w.__statuses = [];
    new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target as HTMLElement;
        w.__statuses.push({
          id: Number(el.dataset.trackId),
          status: el.dataset.status ?? '',
          t: performance.now(),
          audio: w.__mutedContexts?.[0]?.state ?? '',
        });
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-status'] });
  });
}

export async function statusesOf(page: Page, id: number): Promise<StatusChange[]> {
  const all = await page.evaluate(() => (window as unknown as { __statuses: StatusChange[] }).__statuses);
  return all.filter((s) => s.id === id);
}

export const now = (page: Page) => page.evaluate(() => performance.now());

/** State and clock of every audio context whose output was muted (see muteWebAudio). */
export function mutedAudio(page: Page): Promise<{ state: string; time: number; muted: boolean }[]> {
  return page.evaluate(() =>
    ((window as unknown as { __mutedContexts?: BaseAudioContext[] }).__mutedContexts ?? []).map((c) => ({
      state: c.state,
      time: c.currentTime,
      muted: c.destination instanceof GainNode && c.destination.gain.value === 0,
    })),
  );
}
