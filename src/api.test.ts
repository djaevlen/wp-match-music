import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, SessionExpiredError, createApi } from './api';
import type { Boot } from './boot';

const boot: Boot = {
  restUrl: 'https://site.test/wp-json/match-music/v1/',
  nonce: 'n1',
  nonceUrl: 'https://site.test/wp-admin/admin-ajax.php?action=mm_nonce',
  canEdit: true,
  maxUploadBytes: 1000,
  loginUrl: 'https://site.test/wp-login.php',
  fadeMs: 1500,
};

const track = { id: 1, name: 'Goal', start_ms: 0, order: 0, size: 10, version: 'a' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends nonce and cookies', async () => {
    fetchMock.mockResolvedValueOnce(json([track]));
    const tracks = await createApi(boot).listTracks();
    expect(tracks).toEqual([track]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://site.test/wp-json/match-music/v1/tracks');
    expect(init.headers['X-WP-Nonce']).toBe('n1');
    expect(init.credentials).toBe('same-origin');
  });

  it('sends JSON bodies for updates, order and settings', async () => {
    fetchMock
      .mockResolvedValueOnce(json(track))
      .mockResolvedValueOnce(json([track]))
      .mockResolvedValueOnce(json({ fade_ms: 900 }))
      .mockResolvedValueOnce(json({ deleted: true }));
    const api = createApi(boot);
    await api.updateTrack(1, { name: 'Goal!' });
    await api.saveOrder([2, 1]);
    expect(await api.saveSettings({ fade_ms: 900 })).toEqual({ fade_ms: 900 });
    await expect(api.deleteTrack(1)).resolves.toBeUndefined();

    const [u1, i1] = fetchMock.mock.calls[0];
    expect(u1).toBe('https://site.test/wp-json/match-music/v1/tracks/1');
    expect(i1.method).toBe('PATCH');
    expect(i1.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(i1.body)).toEqual({ name: 'Goal!' });
    const [u2, i2] = fetchMock.mock.calls[1];
    expect(u2).toBe('https://site.test/wp-json/match-music/v1/tracks/order');
    expect(i2.method).toBe('PUT');
    expect(JSON.parse(i2.body)).toEqual({ ids: [2, 1] });
    expect(fetchMock.mock.calls[2][1].method).toBe('PUT');
    expect(fetchMock.mock.calls[3][1].method).toBe('DELETE');
  });

  it('appends routes to a plain-permalink rest url', async () => {
    fetchMock.mockResolvedValueOnce(json({ fade_ms: 1 }));
    await createApi({ ...boot, restUrl: 'https://site.test/?rest_route=/match-music/v1/' }).getSettings();
    expect(fetchMock.mock.calls[0][0]).toBe('https://site.test/?rest_route=/match-music/v1/settings');
  });

  it('refreshes an expired nonce and retries once', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ code: 'rest_cookie_invalid_nonce', message: 'Cookie check failed', data: { status: 403 } }, 403))
      .mockResolvedValueOnce(new Response('n2'))
      .mockResolvedValueOnce(json([track]));
    const api = createApi(boot);
    await expect(api.listTracks()).resolves.toEqual([track]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe(boot.nonceUrl);
    expect(fetchMock.mock.calls[1][1].credentials).toBe('same-origin');
    expect(fetchMock.mock.calls[2][1].headers['X-WP-Nonce']).toBe('n2');

    // The new nonce is kept for later requests.
    fetchMock.mockResolvedValueOnce(json([track]));
    await api.listTracks();
    expect(fetchMock.mock.calls[3][1].headers['X-WP-Nonce']).toBe('n2');
  });

  it('does not retry a second time', async () => {
    const stale = () =>
      json({ code: 'rest_cookie_invalid_nonce', message: 'Cookie check failed', data: { status: 403 } }, 403);
    fetchMock
      .mockResolvedValueOnce(stale())
      .mockResolvedValueOnce(new Response('n2'))
      .mockResolvedValueOnce(stale());
    await expect(createApi(boot).listTracks()).rejects.toMatchObject({ code: 'rest_cookie_invalid_nonce', status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('401 throws SessionExpiredError', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ code: 'rest_forbidden', message: 'Sorry', data: { status: 401 } }, 401),
    );
    await expect(createApi(boot).listTracks()).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('maps server errors', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ code: 'mm_not_mp3', message: 'Only mp3', data: { status: 415 } }, 415),
    );
    const error = await createApi(boot).deleteTrack(1).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('mm_not_mp3');
    expect(error.message).toBe('Only mp3');
    expect(error.status).toBe(415);
  });

  it('keeps a 403 without the nonce code as an ApiError', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ code: 'rest_forbidden', message: 'Not allowed', data: { status: 403 } }, 403),
    );
    await expect(createApi(boot).listTracks()).rejects.toMatchObject({ code: 'rest_forbidden', status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('survives a non-JSON error body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(createApi(boot).listTracks()).rejects.toMatchObject({ status: 502 });
  });

  it('fetchAudio returns the raw response', async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    const res = await createApi(boot).fetchAudio(7);
    expect(fetchMock.mock.calls[0][0]).toBe('https://site.test/wp-json/match-music/v1/tracks/7/audio');
    expect((await res.arrayBuffer()).byteLength).toBe(3);
  });
});

describe('uploadTrack', () => {
  const instances: FakeXhr[] = [];

  class FakeXhr {
    static responses: Array<{ status: number; body: unknown }> = [];
    method = '';
    url = '';
    headers: Record<string, string> = {};
    withCredentials = false;
    status = 0;
    responseText = '';
    sent: unknown = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
      onprogress: null,
    };
    constructor() {
      instances.push(this);
    }
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    send(body: unknown) {
      this.sent = body;
      const next = FakeXhr.responses.shift()!;
      this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
      this.status = next.status;
      this.responseText = JSON.stringify(next.body);
      this.onload?.();
    }
  }

  const file = (size: number) => new File([new Uint8Array(size)], 'goal.mp3', { type: 'audio/mpeg' });

  beforeEach(() => {
    instances.length = 0;
    FakeXhr.responses = [];
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts multipart with progress, nonce and cookies', async () => {
    FakeXhr.responses = [{ status: 201, body: track }];
    const progress = vi.fn();
    await expect(createApi(boot).uploadTrack(file(10), progress)).resolves.toEqual(track);
    const xhr = instances[0];
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('https://site.test/wp-json/match-music/v1/tracks');
    expect(xhr.headers['X-WP-Nonce']).toBe('n1');
    expect(xhr.withCredentials).toBe(true);
    expect((xhr.sent as FormData).get('file')).toBeInstanceOf(File);
    expect(progress).toHaveBeenCalledWith(0.5);
  });

  it('refuses oversize files before sending', async () => {
    const error = await createApi(boot).uploadTrack(file(1001), vi.fn()).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('mm_too_large');
    expect(instances).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps server errors and an expired session', async () => {
    FakeXhr.responses = [{ status: 415, body: { code: 'mm_not_mp3', message: 'Only mp3', data: { status: 415 } } }];
    await expect(createApi(boot).uploadTrack(file(10), vi.fn())).rejects.toMatchObject({
      code: 'mm_not_mp3',
      status: 415,
    });
    FakeXhr.responses = [{ status: 401, body: { code: 'rest_forbidden', message: 'x', data: { status: 401 } } }];
    await expect(createApi(boot).uploadTrack(file(10), vi.fn())).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('refreshes an expired nonce and retries once', async () => {
    FakeXhr.responses = [
      { status: 403, body: { code: 'rest_cookie_invalid_nonce', message: 'x', data: { status: 403 } } },
      { status: 201, body: track },
    ];
    vi.mocked(fetch).mockResolvedValueOnce(new Response('n2'));
    await expect(createApi(boot).uploadTrack(file(10), vi.fn())).resolves.toEqual(track);
    expect(instances).toHaveLength(2);
    expect(instances[1].headers['X-WP-Nonce']).toBe('n2');
  });
});
