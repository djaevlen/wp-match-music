import type { APIResponse } from '@playwright/test';
import {
  BOARD_PATH,
  REST,
  STORED_NAME,
  expect,
  fixtureBytes,
  login,
  looksLikeMp3,
  resetBoard,
  restNonce,
  row,
  seedTrack,
  sha256,
  storedFilename,
  strings,
  test,
  users,
  waitForBoard,
  wp,
} from './helpers';

const FIXTURE = 'click-cbr.mp3';
const fixture = fixtureBytes(FIXTURE);
let trackId: number;
let stored: string;
const audioUrl = () => `${REST}/tracks/${trackId}/audio`;

test.beforeAll(() => {
  resetBoard();
  trackId = seedTrack(FIXTURE, 'Access check');
  stored = storedFilename(trackId);
  expect(stored).toMatch(STORED_NAME);
});

/** Everything a client can see of a response: headers and body. */
async function visibleText(res: APIResponse): Promise<string> {
  const headers = res
    .headersArray()
    .map((h) => `${h.name}: ${h.value}`)
    .join('\n');
  return `${headers}\n${(await res.body()).toString('latin1')}`;
}

async function expectNoMp3(res: APIResponse): Promise<void> {
  const body = await res.body();
  expect(res.headers()['content-type'] ?? '').not.toContain('audio/mpeg');
  expect(body.length).not.toBe(fixture.length);
  expect(looksLikeMp3(body)).toBe(false);
}

test.describe('logged out', () => {
  test('logged out is sent to login', async ({ page }) => {
    await page.goto(BOARD_PATH);
    await expect(page).toHaveURL(/wp-login\.php/);
    const url = new URL(page.url());
    expect(url.searchParams.get('redirect_to')).toContain(BOARD_PATH);
  });

  test('logged out cannot fetch audio', async ({ request }) => {
    const res = await request.get(audioUrl());
    expect(res.status()).toBe(401);
    await expectNoMp3(res);
  });

  test('logged out gets no audio bytes by any request shape', async ({ request }) => {
    const url = audioUrl();

    const get = await request.get(url);
    expect(get.status()).toBe(401);
    await expectNoMp3(get);

    // The envelope reports the inner status in a 200 JSON body.
    const envelope = await request.get(`${url}?_envelope=1`);
    await expectNoMp3(envelope);
    expect((await envelope.json()).status).toBe(401);

    // OPTIONS, real or emulated, describes the route; it must not stream the file.
    const options = await request.fetch(url, { method: 'OPTIONS' });
    await expectNoMp3(options);
    const methodParam = await request.post(`${url}?_method=OPTIONS`);
    await expectNoMp3(methodParam);
    const methodHeader = await request.post(url, { headers: { 'X-HTTP-Method-Override': 'OPTIONS' } });
    await expectNoMp3(methodHeader);

    const head = await request.head(url);
    expect(head.status()).toBe(401);
    expect(head.headers()['content-type'] ?? '').not.toContain('audio/mpeg');
    expect(head.headers()['content-length']).not.toBe(String(fixture.length));
  });

  test('logged out cannot list tracks', async ({ request }) => {
    expect((await request.get(`${REST}/tracks`)).status()).toBe(401);
  });

  test('private folder is not browsable', async ({ request }) => {
    const folder = await request.get('/wp-content/uploads/match-music-private/');
    expect([403, 404]).toContain(folder.status());
    // Even the stored name (known here only by asking the server) is not served directly.
    const file = await request.get(`/wp-content/uploads/match-music-private/${stored}`);
    expect([403, 404]).toContain(file.status());
    await expectNoMp3(file);
  });
});

test.describe('user without the play capability', () => {
  test('board and audio are refused with 403', async ({ page }) => {
    await login(page, users.noRole);
    const board = await page.request.get(BOARD_PATH);
    expect(board.status()).toBe(403);
    expect(await board.text()).not.toContain('MatchMusicBoot');

    const nonce = await restNonce(page);
    const audio = await page.request.get(audioUrl(), { headers: { 'X-WP-Nonce': nonce } });
    expect(audio.status()).toBe(403);
    await expectNoMp3(audio);
  });
});

test.describe('subscriber', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, users.subscriber);
    await waitForBoard(page);
  });

  test('subscriber can play but not edit', async ({ page }) => {
    const r = row(page, trackId);
    await expect(r).toHaveAttribute('data-status', 'ready');
    await expect(page.getByRole('button', { name: strings.editor.addMp3 })).toHaveCount(0);
    await expect(page.getByRole('button', { name: strings.editor.edit })).toHaveCount(0);
    await expect(page.getByRole('button', { name: strings.editor.reorder('Access check') })).toHaveCount(0);
    await expect(page.getByRole('slider')).toHaveCount(0);
    // The fade is plain text, not a button that opens the slider.
    await expect(page.getByText(strings.board.fade('2.0'), { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: strings.board.fade('2.0') })).toHaveCount(0);

    await r.getByRole('button', { name: strings.row.play }).click();
    await expect(r).toHaveAttribute('data-status', 'playing');
    await expect(r).toContainText(/playing/);
    await r.getByRole('button', { name: strings.row.stop }).click();
    await expect(r).toHaveAttribute('data-status', 'ready', { timeout: 5_000 });
  });

  test('subscriber write is refused', async ({ page }) => {
    const headers = { 'X-WP-Nonce': await restNonce(page) };
    const patch = await page.request.patch(`${REST}/tracks/${trackId}`, { headers, data: { name: 'Hacked' } });
    expect(patch.status()).toBe(403);
    const del = await page.request.delete(`${REST}/tracks/${trackId}`, { headers });
    expect(del.status()).toBe(403);
    const order = await page.request.put(`${REST}/tracks/order`, { headers, data: { ids: [trackId] } });
    expect(order.status()).toBe(403);
    const fade = await page.request.put(`${REST}/settings`, { headers, data: { fade_ms: 500 } });
    expect(fade.status()).toBe(403);
    const upload = await page.request.post(`${REST}/tracks`, {
      headers,
      multipart: { file: { name: 'short.mp3', mimeType: 'audio/mpeg', buffer: fixtureBytes('short.mp3') } },
    });
    expect(upload.status()).toBe(403);

    // Nothing changed.
    const list = await page.request.get(`${REST}/tracks`, { headers });
    const tracks = (await list.json()) as { id: number; name: string }[];
    expect(tracks.map((t) => [t.id, t.name])).toEqual([[trackId, 'Access check']]);
  });

  test('audio is served intact and uncached', async ({ page }) => {
    const res = await page.request.get(audioUrl(), { headers: { 'X-WP-Nonce': await restNonce(page) } });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('audio/mpeg');
    expect(res.headers()['cache-control']).toContain('no-store');
    const body = await res.body();
    expect(body.length).toBe(fixture.length);
    expect(sha256(body)).toBe(sha256(fixture));
  });

  test('responses never reveal the stored filename', async ({ page }) => {
    const headers = { 'X-WP-Nonce': await restNonce(page) };
    const responses = {
      tracks: await page.request.get(`${REST}/tracks`, { headers }),
      board: await page.request.get(BOARD_PATH),
      audio: await page.request.get(audioUrl(), { headers }),
    };
    for (const [what, res] of Object.entries(responses)) {
      expect(res.status(), what).toBe(200);
      const text = await visibleText(res);
      expect(text, what).not.toMatch(STORED_NAME);
      expect(text, what).not.toContain(stored.replace(/\.mp3$/, ''));
    }
  });

  test('board page is noindex and uncached', async ({ page }) => {
    const res = await page.request.get(BOARD_PATH);
    expect(res.status()).toBe(200);
    expect(res.headers()['x-robots-tag']).toContain('noindex');
    const cache = res.headers()['cache-control'] ?? '';
    expect(cache).toContain('no-cache');
    expect(cache).toContain('no-store');
    expect(cache).toContain('max-age=0');
  });

  test('plain permalinks still reach the board', async ({ page }) => {
    wp('rewrite', 'structure', '');
    wp('rewrite', 'flush');
    try {
      await page.goto('/?mm_board=1');
      await waitForBoard(page);
      await expect(row(page, trackId)).toHaveAttribute('data-status', 'ready');
    } finally {
      wp('rewrite', 'structure', '/%postname%/');
      wp('rewrite', 'flush');
    }
  });
});
