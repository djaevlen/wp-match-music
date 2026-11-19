import type { Page } from '@playwright/test';
import {
  REST,
  boardAs,
  expect,
  login,
  resetBoard,
  row,
  rowNamed,
  seedTrack,
  strings,
  test,
  trackOrder,
  uploadFixture,
  users,
  waitForBoard,
} from './helpers';

// One editing story, in order: each test builds on the board the previous one left.
test.describe.configure({ mode: 'serial' });

test.beforeAll(() => resetBoard());

test.beforeEach(async ({ page }) => {
  await login(page, users.editor);
  await waitForBoard(page);
});

const fadeButton = (page: Page) => page.getByRole('button', { name: /^Fade \d+\.\d s$/ });

test('upload, set start, persists', async ({ page }) => {
  await uploadFixture(page, 'click-cbr.mp3');
  const r = rowNamed(page, 'click-cbr');
  await expect(r).toHaveAttribute('data-status', 'ready');
  await expect(r).toContainText(strings.row.startsAt('0:00.0'));

  await r.getByRole('button', { name: strings.editor.editTrack('click-cbr') }).click();
  const dialog = page.getByRole('dialog', { name: strings.editor.title });
  const forward1 = dialog.getByRole('button', { name: strings.editor.forward1, exact: true });
  await expect(forward1).toBeEnabled();
  for (let i = 0; i < 10; i++) await forward1.click();
  const forwardTenth = dialog.getByRole('button', { name: strings.editor.forwardTenth, exact: true });
  for (let i = 0; i < 3; i++) await forwardTenth.click();
  await expect(dialog.getByRole('status', { name: strings.editor.startPoint })).toHaveText('0:10.3');
  await dialog.getByRole('button', { name: strings.editor.save }).click();
  await expect(dialog).toBeHidden();
  await expect(r).toContainText(strings.row.startsAt('0:10.3'));

  await page.reload();
  await waitForBoard(page);
  await expect(rowNamed(page, 'click-cbr')).toContainText(strings.row.startsAt('0:10.3'));
});

test('another user sees the same setup', async ({ browser }) => {
  const sub = await boardAs(browser, users.subscriber);
  const r = rowNamed(sub.page, 'click-cbr');
  await expect(r).toHaveAttribute('data-status', 'ready');
  await expect(r).toContainText(strings.row.startsAt('0:10.3'));
  await sub.context.close();
});

test('fade duration is shared', async ({ page, browser }) => {
  // A real pointer drag on the slider, from 2.0 s down to 0.5 s.
  await fadeButton(page).click();
  const thumb = page.getByRole('slider', { name: strings.editor.fadeLabel });
  await expect(thumb).toHaveAttribute('aria-valuenow', '2000');
  const track = page.locator('[data-slot="slider"]');
  const box = (await track.boundingBox())!;
  const from = (await thumb.boundingBox())!;
  const saved = page.waitForResponse(
    (res) => res.url().includes(`${REST}/settings`) && res.request().method() === 'PUT',
  );
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.05, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(thumb).toHaveAttribute('aria-valuenow', '500');
  expect((await (await saved).json()).fade_ms).toBe(500);
  await page.keyboard.press('Escape');
  await expect(fadeButton(page)).toHaveText(strings.board.fade('0.5'));

  const sub = await boardAs(browser, users.subscriber);
  await expect(sub.page.getByText(strings.board.fade('0.5'), { exact: true })).toBeVisible();
  await sub.context.close();
});

test('fade steps by keyboard in 0.5 s up to 10 s', async ({ page }) => {
  await fadeButton(page).click();
  const thumb = page.getByRole('slider', { name: strings.editor.fadeLabel });
  await thumb.focus();
  await page.keyboard.press('ArrowRight');
  await expect(thumb).toHaveAttribute('aria-valuenow', '1000');
  await page.keyboard.press('End');
  await expect(thumb).toHaveAttribute('aria-valuenow', '10000');
  await expect(thumb).toHaveAttribute('aria-valuemax', '10000');
  await page.keyboard.press('Home');
  await expect(thumb).toHaveAttribute('aria-valuenow', '0');
  const lastSave = page.waitForResponse(
    (res) =>
      res.url().includes(`${REST}/settings`) &&
      res.request().method() === 'PUT' &&
      res.request().postDataJSON()?.fade_ms === 500,
  );
  await page.keyboard.press('ArrowRight');
  await expect(thumb).toHaveAttribute('aria-valuenow', '500');
  await page.keyboard.press('Escape');
  await expect(fadeButton(page)).toHaveText(strings.board.fade('0.5'));

  // The saves go one after another and end on the last value chosen.
  expect((await (await lastSave).json()).fade_ms).toBe(500);
  await page.reload();
  await waitForBoard(page);
  await expect(fadeButton(page)).toHaveText(strings.board.fade('0.5'));
});

test('rejects a fake mp3 with a reason', async ({ page }) => {
  const rows = page.locator('[data-track-id]');
  await expect(rows).toHaveCount(1);
  await uploadFixture(page, 'fake.mp3');
  // The server's reason (rest.php), shown as a toast.
  await expect(page.getByText('Only mp3 files are accepted.')).toBeVisible();
  await expect(rows).toHaveCount(1);
  await page.reload();
  await waitForBoard(page);
  await expect(rows).toHaveCount(1);
});

test('delete removes the row for everyone', async ({ page, browser }) => {
  const sub = await boardAs(browser, users.subscriber);
  await expect(rowNamed(sub.page, 'click-cbr')).toHaveCount(1);

  const r = rowNamed(page, 'click-cbr');
  await r.getByRole('button', { name: strings.editor.editTrack('click-cbr') }).click();
  await page.getByRole('dialog', { name: strings.editor.title }).getByRole('button', { name: strings.editor.deleteTrack }).click();
  const confirm = page.getByRole('alertdialog', { name: strings.editor.deleteTitle('click-cbr') });
  await confirm.getByRole('button', { name: strings.editor.deleteConfirm }).click();
  await expect(r).toHaveCount(0);
  await expect(page.getByText(strings.board.noTracks)).toBeVisible();

  // The other open board drops the row on its next refresh (here: the window regaining focus).
  await sub.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(rowNamed(sub.page, 'click-cbr')).toHaveCount(0);
  await expect(sub.page.getByText(strings.board.noTracks)).toBeVisible();
  await sub.context.close();
});

test('reorder by dragging across the two columns', async ({ page }) => {
  const first = seedTrack('short.mp3', 'First');
  const second = seedTrack('short-noid3.mp3', 'Second');
  await page.reload();
  await waitForBoard(page);

  // At 1280 px the two rows sit side by side, one per column.
  const a = (await row(page, first).boundingBox())!;
  const b = (await row(page, second).boundingBox())!;
  expect(b.x).toBeGreaterThan(a.x + a.width / 2);
  expect(Math.abs(b.y - a.y)).toBeLessThan(5);

  const handle = page.getByRole('button', { name: strings.editor.reorder('First') });
  const h = (await handle.boundingBox())!;
  const target = page.getByRole('button', { name: strings.editor.reorder('Second') });
  const t = (await target.boundingBox())!;
  const saved = page.waitForResponse(
    (res) => res.url().includes(`${REST}/tracks/order`) && res.request().method() === 'PUT',
  );
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 20, h.y + h.height / 2, { steps: 4 });
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 20 });
  await page.mouse.up();
  expect((await saved).status()).toBe(200);
  expect(trackOrder()).toEqual([second, first]);

  await page.reload();
  await waitForBoard(page);
  const now = [(await row(page, first).boundingBox())!, (await row(page, second).boundingBox())!];
  expect(now[1].x).toBeLessThan(now[0].x); // Second is in the left column now
});

test('reorder by keyboard', async ({ page }) => {
  const ids = trackOrder();
  expect(ids).toHaveLength(2);
  const name = (await row(page, ids[0]).getByText(/^(First|Second)$/).textContent())!;
  const handle = page.getByRole('button', { name: strings.editor.reorder(name) });
  const saved = page.waitForResponse(
    (res) => res.url().includes(`${REST}/tracks/order`) && res.request().method() === 'PUT',
  );
  // dnd-kit starts listening for arrow keys a moment after the drag starts (a timer), so the
  // move is repeated until its live region reports the other row; one more ArrowRight from
  // the right column changes nothing.
  await handle.focus();
  await page.keyboard.press('Space');
  await expect(handle).toHaveAttribute('aria-pressed', 'true');
  const overOther = page.getByRole('status').filter({ hasText: `over droppable area ${ids[1]}.` });
  await expect(async () => {
    await page.keyboard.press('ArrowRight');
    await expect(overOther).toHaveCount(1, { timeout: 200 });
  }).toPass();
  await page.keyboard.press('Space');
  expect((await saved).status()).toBe(200);
  expect(trackOrder()).toEqual([ids[1], ids[0]]);
});
