import type { Page } from '@playwright/test';
import {
  REST,
  expect,
  fixtureBytes,
  login,
  mutedAudio,
  now,
  recordStatuses,
  resetBoard,
  row,
  rowNamed,
  seedTrack,
  setFadeMs,
  statusesOf,
  strings,
  test,
  users,
  waitForBoard,
  type User,
} from './helpers';

// Two tracks, A and B; A starts at 0:10.3. The fade is 0.5 s unless a test says otherwise.
const FADE_MS = 500;
let a: number;
let b: number;

test.beforeAll(() => {
  resetBoard();
  a = seedTrack('click-cbr.mp3', 'Track A', 10_300);
  b = seedTrack('click-vbr.mp3', 'Track B');
});

test.beforeEach(() => setFadeMs(FADE_MS));

async function openBoard(page: Page, user: User = users.subscriber): Promise<void> {
  await login(page, user);
  await waitForBoard(page);
  await expect(row(page, a)).toHaveAttribute('data-status', 'ready');
  await expect(row(page, b)).toHaveAttribute('data-status', 'ready');
  await recordStatuses(page);
}

const button = (page: Page, id: number, name: string) =>
  row(page, id).getByTestId('row-wide-controls').getByRole('button', { name, exact: true });

test('play, fade, ready', async ({ page }) => {
  await openBoard(page);
  const r = row(page, a);
  await expect(r).toContainText(strings.row.startsAt('0:10.3'));

  await button(page, a, strings.row.play).click();
  await expect(r).toHaveAttribute('data-status', 'playing');
  await expect(r).toContainText(/\d:\d\d playing/);
  // Web Audio really runs (its clock moves), into a muted output. When the Play press is the
  // page's first gesture, the row turns 'playing' only once the context runs (see "Play as the
  // first gesture" below); Chromium carries the login click's activation over, so it may
  // already run here.
  await expect.poll(async () => (await mutedAudio(page))[0]?.state).toBe('running');
  const [first] = await mutedAudio(page);
  expect(first.muted).toBe(true);
  await expect.poll(async () => (await mutedAudio(page))[0].time).toBeGreaterThan(first.time);
  await expect(button(page, a, strings.row.stop)).toBeEnabled();
  await expect(button(page, b, strings.row.stop)).toBeDisabled();

  const stoppedAt = await now(page);
  await button(page, a, strings.row.stop).click();
  await expect(r).toHaveAttribute('data-status', 'ready', { timeout: FADE_MS + 1_000 });
  await expect(r).toContainText(strings.row.startsAt('0:10.3'));

  // It faded for about the fade duration before it was ready again.
  const after = (await statusesOf(page, a)).filter((s) => s.t >= stoppedAt);
  expect(after.map((s) => s.status)).toEqual(['fading', 'ready']);
  const faded = after[1].t - after[0].t;
  expect(faded).toBeGreaterThanOrEqual(FADE_MS - 50);
  expect(faded).toBeLessThanOrEqual(FADE_MS + 1_000);
});

/** Reloads the board, so the page has had no gesture yet and its audio is not running. */
async function reloadWithoutGesture(page: Page): Promise<void> {
  await page.reload();
  await waitForBoard(page);
  await expect(row(page, a)).toHaveAttribute('data-status', 'ready');
  expect((await mutedAudio(page))[0].state).not.toBe('running');
}

const soundHint = (page: Page) => page.getByRole('status').filter({ hasText: strings.board.enableSound });

test('a fresh page asks for a tap, and a tap anywhere clears the hint', async ({ page }) => {
  await openBoard(page);
  await reloadWithoutGesture(page);
  await expect(soundHint(page)).toBeVisible();

  await page.getByRole('heading', { name: strings.appTitle }).click();
  await expect(soundHint(page)).toBeHidden();
  expect((await mutedAudio(page))[0].state).toBe('running');
});

for (const size of [
  { width: 1280, height: 800 },
  { width: 375, height: 800 },
]) {
  test(`the sound hint never moves a row or covers Play (${size.width}px)`, async ({ page }) => {
    await page.setViewportSize(size);
    await openBoard(page);
    await reloadWithoutGesture(page);
    await expect(soundHint(page)).toBeVisible();

    const before = await row(page, a).boundingBox();
    const hint = await soundHint(page).boundingBox();
    const play = await row(page, a)
      .getByRole('button', { name: strings.row.play, exact: true })
      .filter({ visible: true })
      .boundingBox();
    expect(before && hint && play).toBeTruthy();
    const overlaps =
      hint!.x < play!.x + play!.width &&
      play!.x < hint!.x + hint!.width &&
      hint!.y < play!.y + play!.height &&
      play!.y < hint!.y + hint!.height;
    expect(overlaps).toBe(false);

    await page.getByRole('heading', { name: strings.appTitle }).click();
    await expect(soundHint(page)).toBeHidden();
    const after = await row(page, a).boundingBox();
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
  });
}

test('Play as the first gesture: the row never says playing before the audio runs', async ({ page }) => {
  await openBoard(page);
  await reloadWithoutGesture(page);
  await recordStatuses(page);

  await button(page, a, strings.row.play).click();
  await expect(row(page, a)).toHaveAttribute('data-status', 'playing');
  await expect(soundHint(page)).toBeHidden();
  const playing = (await statusesOf(page, a)).filter((s) => s.status === 'playing');
  expect(playing).toHaveLength(1);
  expect(playing[0].audio).toBe('running');

  await button(page, a, strings.row.stop).click();
  await expect(row(page, a)).toHaveAttribute('data-status', 'ready', { timeout: FADE_MS + 1_000 });
});

test('a swipe or double tap on a phone cannot reload or zoom the board', async ({ page }) => {
  await openBoard(page);
  const style = await page.evaluate(() => ({
    html: getComputedStyle(document.documentElement).overscrollBehaviorY,
    body: getComputedStyle(document.body).overscrollBehaviorY,
    touch: getComputedStyle(document.body).touchAction,
  }));
  expect(style).toEqual({ html: 'none', body: 'none', touch: 'manipulation' });
});

test('one track at a time', async ({ page }) => {
  await openBoard(page);
  await button(page, a, strings.row.play).click();
  await expect(row(page, a)).toHaveAttribute('data-status', 'playing');

  const switchedAt = await now(page);
  await button(page, b, strings.row.play).click();
  await expect(row(page, b)).toHaveAttribute('data-status', 'playing');
  await expect(row(page, a)).toHaveAttribute('data-status', 'ready');
  // A was cut, not faded.
  expect((await statusesOf(page, a)).filter((s) => s.t >= switchedAt).map((s) => s.status)).toEqual(['ready']);

  await button(page, b, strings.row.stop).click();
  await expect(row(page, b)).toHaveAttribute('data-status', 'ready', { timeout: FADE_MS + 1_000 });
});

test('play during fade restarts', async ({ page }) => {
  setFadeMs(2_000);
  await openBoard(page);
  await expect(page.getByText(strings.board.fade('2.0'), { exact: true })).toBeVisible();
  const r = row(page, a);

  await button(page, a, strings.row.play).click();
  await expect(r).toHaveAttribute('data-status', 'playing');
  await button(page, a, strings.row.stop).click();
  await expect(r).toHaveAttribute('data-status', 'fading');
  await button(page, a, strings.row.play).click();
  await expect(r).toHaveAttribute('data-status', 'playing');

  // The cancelled fade would have ended 2 s after Stop; 2.5 s later the track still plays.
  const restartedAt = await now(page);
  await page.waitForTimeout(2_500); // asserting that nothing happens: there is no state to await
  await expect(r).toHaveAttribute('data-status', 'playing');
  expect((await statusesOf(page, a)).filter((s) => s.t > restartedAt)).toEqual([]);

  // Stop pressed a second time during a fade cuts at once.
  await button(page, a, strings.row.stop).click();
  await expect(r).toHaveAttribute('data-status', 'fading');
  await button(page, a, strings.row.stop).click();
  await expect(r).toHaveAttribute('data-status', 'ready', { timeout: 1_000 });
});

test('narrow layout toggle', async ({ page }) => {
  // A 2 s fade leaves time to look at the toggle while the row fades.
  const fadeMs = 2_000;
  setFadeMs(fadeMs);
  await page.setViewportSize({ width: 375, height: 800 });
  await openBoard(page);
  const toggle = row(page, a).getByTestId('row-toggle');
  await expect(row(page, a).getByTestId('row-wide-controls')).toBeHidden();
  await expect(toggle).toHaveAccessibleName(strings.row.play);

  await toggle.click();
  await expect(row(page, a)).toHaveAttribute('data-status', 'playing');
  await expect(toggle).toHaveAccessibleName(strings.row.stop);

  await toggle.click();
  // During the fade the toggle already offers Play (spec 7.4).
  await expect(row(page, a)).toHaveAttribute('data-status', 'fading');
  await expect(toggle).toHaveAccessibleName(strings.row.play);
  expect(await row(page, a).getAttribute('data-status')).toBe('fading'); // still fading when checked
  await expect(row(page, a)).toHaveAttribute('data-status', 'ready', { timeout: fadeMs + 1_000 });
  await expect(toggle).toHaveAccessibleName(strings.row.play);
  expect((await statusesOf(page, a)).map((s) => s.status)).toEqual(['playing', 'fading', 'ready']);
});

/** Drops a real mp3 file on the page header; returns whether the drop's default was prevented. */
async function dropFileOnHeader(page: Page, name: string): Promise<boolean> {
  const bytes = [...fixtureBytes(name)];
  return page.evaluate(
    ({ bytes, name }) => {
      const header = document.querySelector('header')!;
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], name, { type: 'audio/mpeg' }));
      const fire = (type: string) =>
        header.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
      fire('dragenter');
      fire('dragover');
      return !fire('drop');
    },
    { bytes, name },
  );
}

for (const [who, user] of [
  ['Subscriber', users.subscriber],
  ['Editor', users.editor],
] as const) {
  test(`a file dropped while playing never leaves the board (${who})`, async ({ page }) => {
    await openBoard(page, user);
    const url = page.url();
    const before = await page.locator('[data-track-id]').count();
    await button(page, a, strings.row.play).click();
    await expect(row(page, a)).toHaveAttribute('data-status', 'playing');
    const startedAt = await now(page);
    const uploads: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith(`${REST}/tracks`)) uploads.push(req.url());
    });

    // The drop's default (opening the file in the tab) is prevented, for everyone.
    expect(await dropFileOnHeader(page, 'short.mp3')).toBe(true);

    if (user === users.editor) {
      // An editor's dropped file is uploaded, and the playing track plays on.
      await expect(rowNamed(page, 'short')).toHaveAttribute('data-status', 'ready');
      await expect(page.locator('[data-track-id]')).toHaveCount(before + 1);
    }
    expect(page.url()).toBe(url);
    await expect(row(page, a)).toHaveAttribute('data-status', 'playing');
    expect((await statusesOf(page, a)).filter((s) => s.t > startedAt)).toEqual([]);

    await button(page, a, strings.row.stop).click();
    await expect(row(page, a)).toHaveAttribute('data-status', 'ready', { timeout: FADE_MS + 1_000 });
    expect(page.url()).toBe(url);
    expect(uploads).toHaveLength(user === users.editor ? 1 : 0);
    await expect(page.locator('[data-track-id]')).toHaveCount(user === users.editor ? before + 1 : before);
  });
}
