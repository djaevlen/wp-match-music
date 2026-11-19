import { expect, test, type Page } from '@playwright/test';
import type { ContinuityResult, GateSummary } from '../../prototype/proto';

const FILES = ['click-vbr.mp3', 'click-vbr-noxing.mp3', 'click-cbr.mp3'];
// The voice under test: 'buffer' (decoded pieces, chosen) unless GATE_VOICE=element
// re-runs the first attempt, the <audio> element, which fails (docs/audio-gate-results.md).
const VOICE = process.env.GATE_VOICE === 'element' ? 'element' : 'buffer';
// Context sample rates: 48 kHz resamples the 44.1 kHz fixtures (typical on phones, and piece
// offsets fall between samples); 44.1 kHz does not.
const RATES = [48000, 44100];

async function open(page: Page, rate: number): Promise<void> {
  // mute=1 silences the speakers only; the meter taps the graph before the muted output.
  await page.goto(`/prototype/?mute=1&voice=${VOICE}&rate=${rate}`);
  for (const file of FILES) {
    await expect(page.locator(`[data-file="${file}"]`)).toHaveAttribute('data-ready', 'true');
  }
}

/** Clicks Measure ×10 for one file and waits for its summary on window.__gate. */
async function measure(page: Page, file: string, rate: number): Promise<GateSummary> {
  await open(page, rate);
  await page.locator(`[data-file="${file}"]`).getByRole('button', { name: 'Measure ×10' }).click();
  const handle = await page.waitForFunction((f) => window.__gate?.[f], file, { timeout: 90_000 });
  return (await handle.jsonValue()) as GateSummary;
}

/** Clicks Continuity 16 s for one file and waits for its result on window.__continuity. */
async function continuity(page: Page, file: string, rate: number): Promise<ContinuityResult> {
  await open(page, rate);
  await page.locator(`[data-file="${file}"]`).getByRole('button', { name: 'Continuity 16 s' }).click();
  const handle = await page.waitForFunction((f) => window.__continuity?.[f], file, { timeout: 60_000 });
  return (await handle.jsonValue()) as ContinuityResult;
}

for (const rate of RATES) {
  for (const file of FILES) {
    test(`gate ${file} @ ${rate} Hz`, async ({ page }) => {
      const g = await measure(page, file, rate);
      test.info().annotations.push({ type: 'gate', description: JSON.stringify(g) });
      expect(g.sampleRate).toBe(rate);
      expect(g.errors).toEqual([]);
      expect(g.maxDelayMs).toBeLessThan(100);
      expect(g.spreadMs).toBeLessThanOrEqual(20);
      expect(Math.abs(g.meanLandedSec - 10.3)).toBeLessThanOrEqual(0.1);
    });
  }
}

test('rapid pressing raises no page errors or unhandled rejections', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.addInitScript(() => {
    const w = window as unknown as { __rejections: string[] };
    w.__rejections = [];
    window.addEventListener('unhandledrejection', (e) => w.__rejections.push(String(e.reason)));
  });
  await open(page, RATES[0]);

  // A real tap first, so the page has user activation as it would on match day.
  const a = page.locator('[data-file="click-vbr.mp3"]');
  await a.getByRole('button', { name: 'Play' }).click();
  await a.getByRole('button', { name: 'Stop' }).click();
  await a.getByRole('button', { name: 'Stop' }).click();

  await page.evaluate(() => {
    const p = window.__proto!;
    p.play('click-vbr.mp3');
    p.play('click-cbr.mp3');
    p.play('click-vbr.mp3');
    p.stop('click-vbr.mp3');
    p.stop('click-vbr.mp3');
  });
  await page.waitForTimeout(1000);

  const rejections = await page.evaluate(() => (window as unknown as { __rejections: string[] }).__rejections);
  expect(pageErrors).toEqual([]);
  expect(rejections).toEqual([]);
  expect(await page.evaluate(() => window.__proto!.states())).toEqual({
    'click-vbr.mp3': 'ready',
    'click-vbr-noxing.mp3': 'ready',
    'click-cbr.mp3': 'ready',
  });
});

for (const rate of RATES) {
  for (const file of FILES) {
    test(`continuity ${file} @ ${rate} Hz: 16 s across piece joins, clicks exactly 1 s apart`, async ({ page }) => {
      const r = await continuity(page, file, rate);
      test.info().annotations.push({ type: 'continuity', description: JSON.stringify(r) });
      expect(r.sampleRate).toBe(rate);
      expect(r.dropouts).toBe(0);
      expect(r.clickGapsSec.length).toBeGreaterThanOrEqual(14);
      for (const gap of r.clickGapsSec) expect(Math.abs(gap - 1)).toBeLessThanOrEqual(0.0005);
    });
  }
}
