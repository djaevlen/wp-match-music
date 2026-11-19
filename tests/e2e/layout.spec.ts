import type { Locator, Page } from '@playwright/test';
import { deleteTracks, expect, login, resetBoard, seedTrack, test, users, waitForBoard } from './helpers';

// Long names must be cut off inside their own row: no row may grow past its column and slide
// under the other column (which once hid the Edit button and drag handle at desktop widths).
const NAMES = [
  'One More Time (Radio Edit) - Daft Punk and a very long featured artist list',
  'Geordie (Radio) - Gabry Ponte with an equally long remix title attached',
  'Short',
  'For Evigt - Volbeat',
];

let ids: number[] = [];

test.beforeAll(() => {
  resetBoard();
  ids = NAMES.map((name) => seedTrack('short.mp3', name));
});
test.afterAll(() => deleteTracks(ids));

type Box = { x: number; y: number; width: number; height: number };
const box = async (l: Locator): Promise<Box> => {
  const b = await l.boundingBox();
  if (!b) throw new Error('element has no box');
  return b;
};
const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  inner.x + inner.width <= outer.x + outer.width + 0.5 &&
  inner.y + inner.height <= outer.y + outer.height + 0.5;
const overlap = (p: Box, q: Box) =>
  p.x < q.x + q.width - 0.5 && q.x < p.x + p.width - 0.5 && p.y < q.y + q.height - 0.5 && q.y < p.y + p.height - 0.5;

async function checkLayout(page: Page) {
  const rows = page.locator('[data-track-id]');
  await expect(rows).toHaveCount(NAMES.length);
  const boxes: Box[] = [];
  for (let i = 0; i < NAMES.length; i++) {
    const r = rows.nth(i);
    const rb = await box(r);
    boxes.push(rb);
    for (const control of await r.locator('button:visible').all()) {
      const cb = await box(control);
      expect(inside(cb, rb), `a button sticks out of row ${i + 1}`).toBe(true);
      // An enabled button must receive a tap at its centre: nothing else lies on top of it.
      // (A disabled button ignores pointer events by design, so the hit test looks through it.)
      if (await control.isDisabled()) continue;
      const hit = await control.evaluate(
        (el, at) => {
          const top = document.elementFromPoint(at.x, at.y);
          return !!top && (top === el || el.contains(top))
            ? true
            : `${el.getAttribute('aria-label') ?? el.textContent} is covered by <${top?.tagName}>`;
        },
        { x: cb.x + cb.width / 2, y: cb.y + cb.height / 2 },
      );
      expect(hit, `row ${i + 1}`).toBe(true);
    }
  }
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++)
      expect(overlap(boxes[i], boxes[j]), `rows ${i + 1} and ${j + 1} overlap`).toBe(false);
}

for (const width of [1024, 1280, 1440, 1920]) {
  test(`long names never push a row under its neighbour at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page, users.editor);
    await waitForBoard(page);
    await checkLayout(page);
  });
}
