import type { Boot } from './boot';

export interface Track {
  id: number;
  name: string;
  start_ms: number;
  order: number;
  size: number;
  version: string;
}

export interface Settings {
  fade_ms: number;
}

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export class SessionExpiredError extends Error {
  constructor() {
    super('The session has expired.');
    this.name = 'SessionExpiredError';
  }
}

export interface Api {
  listTracks(): Promise<Track[]>;
  uploadTrack(file: File, onProgress: (fraction: number) => void): Promise<Track>;
  updateTrack(id: number, patch: { name?: string; start_ms?: number }): Promise<Track>;
  deleteTrack(id: number): Promise<void>;
  saveOrder(ids: number[]): Promise<Track[]>;
  fetchAudio(id: number): Promise<Response>;
  getSettings(): Promise<Settings>;
  saveSettings(s: Settings): Promise<Settings>;
}

const NONCE_EXPIRED = 'rest_cookie_invalid_nonce';

/** Error for a non-2xx reply: expired session, or the server's own code and message. */
function errorFor(status: number, text: string): Error {
  if (status === 401) {
    return new SessionExpiredError();
  }
  try {
    const body = JSON.parse(text) as { code?: unknown; message?: unknown };
    if (typeof body.code === 'string') {
      return new ApiError(body.code, typeof body.message === 'string' ? body.message : '', status);
    }
  } catch {
    // Not JSON: fall through.
  }
  return new ApiError('mm_bad_response', `HTTP ${status}`, status);
}

function isNonceExpired(error: Error): boolean {
  return error instanceof ApiError && error.code === NONCE_EXPIRED;
}

export function createApi(boot: Boot): Api {
  let nonce = boot.nonce;

  const urlFor = (route: string) => boot.restUrl + route;

  async function refreshNonce(): Promise<void> {
    const res = await fetch(boot.nonceUrl, { credentials: 'same-origin' });
    nonce = (await res.text()).trim();
  }

  /** Runs `attempt`; on an expired nonce, fetches a fresh one and runs it once more. */
  async function withNonceRetry<T>(attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof Error) || !isNonceExpired(error)) throw error;
      await refreshNonce();
      return attempt();
    }
  }

  function request(route: string, method = 'GET', body?: unknown): Promise<Response> {
    return withNonceRetry(async () => {
      const headers: Record<string, string> = { 'X-WP-Nonce': nonce };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(urlFor(route), {
        method,
        headers,
        credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) throw errorFor(res.status, await res.text());
      return res;
    });
  }

  const json = async <T>(route: string, method?: string, body?: unknown): Promise<T> =>
    (await request(route, method, body)).json() as Promise<T>;

  function upload(file: File, onProgress: (fraction: number) => void): Promise<Track> {
    return withNonceRetry(
      () =>
        new Promise<Track>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', urlFor('tracks'));
          xhr.setRequestHeader('X-WP-Nonce', nonce);
          xhr.withCredentials = true;
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
          };
          xhr.onerror = () => reject(new ApiError('mm_network', 'Network error', 0));
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve(JSON.parse(xhr.responseText) as Track);
            } else {
              reject(errorFor(xhr.status, xhr.responseText));
            }
          };
          const form = new FormData();
          form.append('file', file);
          xhr.send(form);
        }),
    );
  }

  return {
    listTracks: () => json<Track[]>('tracks'),
    uploadTrack(file, onProgress) {
      if (file.size > boot.maxUploadBytes) {
        return Promise.reject(new ApiError('mm_too_large', 'The file is too large.', 413));
      }
      return upload(file, onProgress);
    },
    updateTrack: (id, patch) => json<Track>(`tracks/${id}`, 'PATCH', patch),
    async deleteTrack(id) {
      await request(`tracks/${id}`, 'DELETE');
    },
    saveOrder: (ids) => json<Track[]>('tracks/order', 'PUT', { ids }),
    fetchAudio: (id) => request(`tracks/${id}/audio`),
    getSettings: () => json<Settings>('settings'),
    saveSettings: (s) => json<Settings>('settings', 'PUT', s),
  };
}
