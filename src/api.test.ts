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

const track = { id: 1, name: 'Goal', start_ms: 0, quick_play: true, order: 0, size: 10, version: 'a' };

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
    await expect(createApi(boot).listTracks()).rejects.toBeInstanceOf(SessionExpiredError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a logged-out nonce refresh is a session expiry and keeps the old nonce', async () => {
    const stale = () =>
      json({ code: 'rest_cookie_invalid_nonce', message: 'Cookie check failed', data: { status: 403 } }, 403);
    fetchMock
      .mockResolvedValueOnce(stale())
      .mockResolvedValueOnce(new Response('0', { status: 400 }))
      .mockResolvedValueOnce(json([track]));
    const api = createApi(boot);
    await expect(api.listTracks()).rejects.toBeInstanceOf(SessionExpiredError);
    await api.listTracks();
    expect(fetchMock.mock.calls[2][1].headers['X-WP-Nonce']).toBe('n1');
  });

  it('an empty or 0 nonce body with status 200 is a session expiry', async () => {
    const stale = () =>
      json({ code: 'rest_cookie_invalid_nonce', message: 'Cookie check failed', data: { status: 403 } }, 403);
    fetchMock.mockResolvedValueOnce(stale()).mockResolvedValueOnce(new Response('0'));
    await expect(createApi(boot).listTracks()).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('a network failure rejects with ApiError mm_network', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(createApi(boot).listTracks()).rejects.toMatchObject({ code: 'mm_network', status: 0 });
  });

  it('a 2xx non-JSON body rejects with ApiError mm_bad_response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<b>Notice</b>', { status: 200 }));
    await expect(createApi(boot).listTracks()).rejects.toMatchObject({ code: 'mm_bad_response', status: 200 });
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

  /** A fetch that never answers, and rejects as fetch does once its signal aborts. */
  const hangingFetch = (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });

  it('a request that hangs fails after about 15 s', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(hangingFetch);
      const result = createApi(boot).listTracks().catch((e) => e);
      await vi.advanceTimersByTimeAsync(14_000);
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await result).toMatchObject({ code: 'mm_network' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('settings and the nonce refresh time out too', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(hangingFetch);
      const settings = createApi(boot).getSettings().catch((e) => e);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await settings).toMatchObject({ code: 'mm_network' });

      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(json({ code: 'rest_cookie_invalid_nonce', message: 'x', data: { status: 403 } }, 403))
        .mockImplementation(hangingFetch);
      const list = createApi(boot).listTracks().catch((e) => e);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await list).toMatchObject({ code: 'mm_network' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('an audio download that stops sending data fails after about 60 s', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            init.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
            setTimeout(() => controller.enqueue(new Uint8Array([3])), 50_000); // still moving at 50 s
          },
        });
        return new Response(body, { headers: { 'Content-Type': 'audio/mpeg' } });
      });
      const res = await createApi(boot).fetchAudio(7);
      let settled = false;
      const blob = res.blob().then(
        (b) => b,
        (e) => e,
      ).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(100_000); // 50 s after the last data
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await blob).toMatchObject({ name: 'AbortError' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a non-JSON 413 from the web server says the file is too large for the server', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html><h1>413 Request Entity Too Large</h1></html>', { status: 413 }));
    await expect(createApi(boot).listTracks()).rejects.toMatchObject({
      status: 413,
      message: 'The file is too large for the server to accept.',
    });
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
    onabort: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    static abort = false;
    static rawBody: string | null = null;
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
      this.responseText = FakeXhr.rawBody ?? JSON.stringify(next.body);
      if (FakeXhr.abort) this.onabort?.();
      else this.onload?.();
    }
  }

  const file = (size: number) => new File([new Uint8Array(size)], 'goal.mp3', { type: 'audio/mpeg' });

  beforeEach(() => {
    instances.length = 0;
    FakeXhr.responses = [];
    FakeXhr.abort = false;
    FakeXhr.rawBody = null;
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

  it('rejects on a 2xx non-JSON body instead of hanging', async () => {
    FakeXhr.responses = [{ status: 200, body: null }];
    FakeXhr.rawBody = 'Notice: oops {"id":1}';
    await expect(createApi(boot).uploadTrack(file(10), vi.fn())).rejects.toMatchObject({
      code: 'mm_bad_response',
      status: 200,
    });
  });

  it('rejects when the upload is aborted', async () => {
    FakeXhr.responses = [{ status: 0, body: null }];
    FakeXhr.abort = true;
    await expect(createApi(boot).uploadTrack(file(10), vi.fn())).rejects.toMatchObject({ code: 'mm_network' });
  });

  it('a non-JSON 413 on upload says the file is too large for the server', async () => {
    FakeXhr.responses = [{ status: 413, body: null }];
    FakeXhr.rawBody = '<html><center><h1>413 Request Entity Too Large</h1></center><hr>nginx</html>';
    await expect(createApi(boot).uploadTrack(file(10), vi.fn())).rejects.toMatchObject({
      code: 'mm_too_large_server',
      status: 413,
      message: 'The file is too large for the server to accept.',
    });
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
