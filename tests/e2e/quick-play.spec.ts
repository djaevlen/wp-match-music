import type { Page } from '@playwright/test';
import {
  boardAs,
  expect,
  login,
  recordStatuses,
  resetBoard,
  row,
  seedTrack,
  setFadeMs,
  setQuickPlay,
  statusesOf,
  strings,
  test,
  users,
  waitForBoard,
  type User,
} from './helpers';

// Three tracks in the quick-play pool (A, B, C) and one kept out of it (Goal). The fade is
// 0.5 s unless a test sets another before it opens the board.
const FADE_MS = 500;
let a: number;
let b: number;
let c: number;
let goal: number;

test.beforeAll(() => {
  resetBoard();
  a = seedTrack('click-cbr.mp3', 'Track A');
  b = seedTrack('click-vbr.mp3', 'Track B');
  c = seedTrack('click-vbr-noxing.mp3', 'Track C');
  goal = seedTrack('click-vbr.mp3', 'Goal');
  setQuickPlay(goal, false);
});

test.beforeEach(() => setFadeMs(FADE_MS));

async function openBoard(page: Page, user: User = users.subscriber): Promise<void> {
  await login(page, user);
  await waitForBoard(page);
  for (const id of [a, b, c, goal]) {
    await expect(row(page, id)).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  }
  await recordStatuses(page);
}

const playing = (page: Page) => page.locator('[data-status="playing"]');
const sounding = (page: Page) => page.locator('[data-status="playing"], [data-status="fading"]');
const marker = (page: Page, id: number) => row(page, id).getByTestId('row-no-quick-play');

/** A deliberate press: the board ignores a second press within 100 ms of the last (key bounce). */
async function space(page: Page): Promise<void> {
  await page.waitForTimeout(150);
  await page.keyboard.press('Space');
}

/** The id of the one row that is playing. */
async function playingId(page: Page): Promise<number> {
  await expect(playing(page)).toHaveCount(1);
  return Number(await playing(page).getAttribute('data-track-id'));
}

test('Space after a mouse click on Play fades that track instead of pressing its button', async ({ page }) => {
  await openBoard(page);
  await row(page, a)
    .getByTestId('row-wide-controls')
    .getByRole('button', { name: strings.row.play, exact: true })
    .click();
  await expect(row(page, a)).toHaveAttribute('data-status', 'playing');

  await space(page);
  await expect(row(page, a)).toHaveAttribute('data-status', 'ready', { timeout: FADE_MS + 2_000 });

  // It played once, faded and stopped: Space did not press the focused Play button again.
  expect((await statusesOf(page, a)).map((s) => s.status)).toEqual(['playing', 'fading', 'ready']);
  for (const id of [b, c, goal]) expect(await statusesOf(page, id)).toEqual([]);
});

test('Space after a mouse click on Stop starts the next track', async ({ page }) => {
  await openBoard(page);
  const wide = row(page, a).getByTestId('row-wide-controls');
  await wide.getByRole('button', { name: strings.row.play, exact: true }).click();
  await expect(row(page, a)).toHaveAttribute('data-status', 'playing');
  // The Stop button is disabled once the fade ends, while it may still hold the focus.
  await wide.getByRole('button', { name: strings.row.stop, exact: true }).click();
  await expect(row(page, a)).toHaveAttribute('data-status', 'ready', { timeout: FADE_MS + 2_000 });

  await space(page);
  expect(await playingId(page)).not.toBe(a); // A was just played by hand
});

test('a bouncing key counts as one press', async ({ page }) => {
  await openBoard(page);
  await space(page);
  await page.keyboard.press('Space'); // down, up, down within a few milliseconds
  const id = await playingId(page);
  await page.waitForTimeout(FADE_MS);
  await expect(row(page, id)).toHaveAttribute('data-status', 'playing');
  expect((await statusesOf(page, id)).map((s) => s.status)).toEqual(['playing']);
});

test('Space starts a pool track, never the switched-off one, and does not repeat within a round', async ({
  page,
}) => {
  setFadeMs(0);
  await openBoard(page);
  await expect(marker(page, goal)).toBeVisible();
  await expect(marker(page, a)).toHaveCount(0);

  const started: number[] = [];
  for (let i = 0; i < 6; i++) {
    await space(page);
    started.push(await playingId(page));
    await space(page);
    await expect(sounding(page)).toHaveCount(0);
  }
  expect([...started.slice(0, 3)].sort()).toEqual([a, b, c].sort());
  expect([...started.slice(3)].sort()).toEqual([a, b, c].sort());
  expect(started[3]).not.toBe(started[2]); // a new round never opens with the last track
  expect(started).not.toContain(goal);
});

test('Space during a fade starts another track', async ({ page }) => {
  setFadeMs(5000);
  await openBoard(page);
  await space(page);
  const first = await playingId(page);
  await space(page);
  await expect(row(page, first)).toHaveAttribute('data-status', 'fading');

  await space(page);
  const second = await playingId(page);
  expect(second).not.toBe(first);
  await expect(row(page, first)).toHaveAttribute('data-status', 'ready');
});

test('holding Space does not start and stop', async ({ page }) => {
  await openBoard(page);
  // Playwright marks every key down after the first as an auto-repeat.
  for (let i = 0; i < 5; i++) await page.keyboard.down('Space');
  await page.keyboard.up('Space');
  const id = await playingId(page);
  await page.waitForTimeout(FADE_MS);
  await expect(row(page, id)).toHaveAttribute('data-status', 'playing');
  expect((await statusesOf(page, id)).map((s) => s.status)).toEqual(['playing']);
});

test('Space types in the name field and starts nothing', async ({ page }) => {
  await openBoard(page, users.editor);
  await row(page, a)
    .getByRole('button', { name: strings.editor.editTrack('Track A') })
    .click();
  const dialog = page.getByRole('dialog', { name: strings.editor.title });
  const name = dialog.getByRole('textbox', { name: strings.editor.name });
  await name.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' X Y');
  await expect(name).toHaveValue('Track A X Y');
  // Space on a button inside the dialog belongs to the dialog too.
  await dialog.getByRole('button', { name: strings.editor.cancel }).focus();
  await space(page);
  await expect(dialog).toBeHidden();
  expect(await sounding(page).count()).toBe(0);
  for (const id of [a, b, c, goal]) expect(await statusesOf(page, id)).toEqual([]);
  await expect(row(page, a)).toContainText('Track A');

  // Back on the board the key is quick play again.
  await space(page);
  await playingId(page);
});

test('the switch is saved and reaches a second session', async ({ page, browser }) => {
  await openBoard(page, users.editor);
  await row(page, b)
    .getByRole('button', { name: strings.editor.editTrack('Track B') })
    .click();
  const dialog = page.getByRole('dialog', { name: strings.editor.title });
  const quick = dialog.getByRole('switch', { name: strings.editor.quickPlay });
  await expect(quick).toBeChecked();
  await quick.click();
  await expect(quick).not.toBeChecked();
  await dialog.getByRole('button', { name: strings.editor.save }).click();
  await expect(dialog).toBeHidden();
  await expect(marker(page, b)).toBeVisible();

  await page.reload();
  await waitForBoard(page);
  await expect(marker(page, b)).toBeVisible();

  const sub = await boardAs(browser, users.subscriber);
  await expect(marker(sub.page, b)).toBeVisible();
  await expect(marker(sub.page, a)).toHaveCount(0);
  await sub.context.close();
  setQuickPlay(b, true);
});

test('the header hint shows on a laptop and not on a phone', async ({ page, browser }) => {
  await openBoard(page);
  await expect(page.getByText(strings.board.quickPlayHint)).toBeVisible();

  const phone = await boardAs(browser, users.subscriber, { width: 390, height: 844 });
  await expect(phone.page.getByText(strings.board.quickPlayHint)).toBeHidden();
  await phone.context.close();
});
