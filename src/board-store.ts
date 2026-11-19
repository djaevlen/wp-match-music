import { SessionExpiredError, type Api, type Track } from './api';
import type { Engine, TrackState } from './audio/engine';
import type { Voice } from './audio/voice';

export type RowStatus = 'loading' | 'error' | TrackState;

export interface BoardRow {
  track: Track;
  status: RowStatus;
}

export interface BoardDeps {
  api: Api;
  engine: Engine;
  makeVoice(blob: Blob): Promise<Voice>;
  loadBlob(t: Track): Promise<Blob>;
  prune(keep: Track[]): Promise<void>;
}

const PARALLEL_DOWNLOADS = 3;

interface Entry {
  track: Track; // latest data from the server
  gone: boolean; // deleted on the server; the row stays until the engine lets go of it
  blob: Blob | null; // audio of the voice in the engine
  voiceVersion: string | null; // version of the voice in the engine
  wanted: string | null; // version that should be loaded next
  loading: string | null; // version whose download or voice build is in flight
  failed: string | null; // version whose load failed
  pending: { voice: Voice; version: string; blob: Blob } | null; // new voice waiting for the track to go idle
}

const keyOf = (tracks: Track[]) =>
  tracks
    .map((t) => `${t.id}:${t.version}`)
    .sort()
    .join(',');

/**
 * The board's state: the server's track list, each track's audio, and playback through the
 * engine. Server changes never interrupt a track that is sounding; they land once it is idle.
 */
export class BoardStore {
  private readonly deps: BoardDeps;
  private entries = new Map<number, Entry>();
  private order: number[] = [];
  private fade: number;
  private expired = false;
  private listeners = new Set<() => void>();
  private cachedRows: BoardRow[] | null = null;

  private downloads = 0;
  private voiceQueue: Promise<void> = Promise.resolve(); // voices are built one at a time
  private playedFromMs = new Map<number, number>();

  private refreshing: Promise<void> | null = null;
  private mutations = 0; // bumped by local writes, so an older list does not undo them
  private serverTracks: Track[] | null = null; // the last list the server sent
  private prunedKey: string | null = null;

  constructor(deps: BoardDeps, initialFadeMs: number) {
    this.deps = deps;
    this.fade = initialFadeMs;
    deps.engine.setFadeMs(initialFadeMs);
    deps.engine.subscribe(() => this.onEngineChange());
  }

  // Reading

  rows(): BoardRow[] {
    if (!this.cachedRows) {
      this.cachedRows = this.order.map((id) => {
        const e = this.entries.get(id)!;
        return { track: e.track, status: this.statusOf(id, e) };
      });
    }
    return this.cachedRows;
  }

  fadeMs(): number {
    return this.fade;
  }

  /** Tracks on the server whose audio is ready to play. */
  loaded(): number {
    let n = 0;
    for (const [id, e] of this.entries) if (!e.gone && this.deps.engine.has(id)) n++;
    return n;
  }

  /** Tracks on the server. */
  total(): number {
    let n = 0;
    for (const e of this.entries.values()) if (!e.gone) n++;
    return n;
  }

  /** True once the server has sent a track list. */
  listed(): boolean {
    return this.serverTracks !== null;
  }

  sessionExpired(): boolean {
    return this.expired;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  positionSec(id: number): number {
    return this.deps.engine.positionSec(id);
  }

  durationSec(id: number): number {
    return this.deps.engine.durationSec(id);
  }

  /** Seconds since the current playback of this track started. */
  elapsedSec(id: number): number {
    const fromMs = this.playedFromMs.get(id) ?? this.entries.get(id)?.track.start_ms ?? 0;
    return Math.max(0, this.positionSec(id) - fromMs / 1000);
  }

  // Playback

  play(id: number, fromMs?: number): void {
    const e = this.entries.get(id);
    if (!e || !this.deps.engine.has(id)) return;
    this.playedFromMs.set(id, fromMs ?? e.track.start_ms);
    this.deps.engine.play(id, fromMs);
  }

  stop(id: number): void {
    this.deps.engine.stop(id);
  }

  /** Silences whatever is sounding at once, with no fade (the audio output was interrupted). */
  cutActive(): void {
    const id = this.deps.engine.activeId();
    if (id !== null) this.deps.engine.cut(id);
  }

  // Syncing with the server

  /** Fetches tracks and settings, then brings the board in line. Never rejects. */
  refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const before = this.mutations;
    const [tracks, settings] = await Promise.allSettled([
      this.call(() => this.deps.api.listTracks()),
      this.call(() => this.deps.api.getSettings()),
    ]);
    if (settings.status === 'fulfilled') this.setFade(settings.value.fade_ms);
    if (tracks.status === 'fulfilled' && this.mutations === before) {
      this.serverTracks = tracks.value;
      this.reconcile(tracks.value);
      this.maybePrune();
    }
    this.changed();
  }

  retry(id: number): void {
    const e = this.entries.get(id);
    if (!e || e.failed === null || e.wanted !== null) return;
    e.failed = null;
    e.wanted = e.track.version;
    this.changed();
    this.pumpDownloads();
  }

  async audioBlob(id: number): Promise<Blob> {
    const e = this.entries.get(id);
    if (!e) throw new Error(`No track ${id}`);
    if (e.blob && e.voiceVersion === e.track.version) return e.blob;
    return this.call(() => this.deps.loadBlob(e.track));
  }

  // Editing

  async saveFade(ms: number): Promise<void> {
    const s = await this.call(() => this.deps.api.saveSettings({ fade_ms: ms }));
    this.setFade(s.fade_ms);
    this.changed();
  }

  async upload(
    files: File[],
    onProgress: (file: File, fraction: number) => void,
  ): Promise<Array<{ file: File; error?: string }>> {
    const results: Array<{ file: File; error?: string }> = [];
    for (const file of files) {
      try {
        const t = await this.call(() => this.deps.api.uploadTrack(file, (f) => onProgress(file, f)));
        this.mutations++;
        this.applyTrack(t);
        if (!this.order.includes(t.id)) this.order.push(t.id);
        this.changed();
        this.pumpDownloads();
        results.push({ file });
      } catch (err) {
        results.push({ file, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return results;
  }

  async update(id: number, patch: { name?: string; start_ms?: number }): Promise<void> {
    const t = await this.call(() => this.deps.api.updateTrack(id, patch));
    this.mutations++;
    this.applyTrack(t);
    this.changed();
  }

  async remove(id: number): Promise<void> {
    await this.call(() => this.deps.api.deleteTrack(id));
    this.mutations++;
    this.dropTrack(id);
    this.changed();
  }

  /** Shows the new order at once; reverts and rethrows if the server refuses it. */
  async reorder(ids: number[]): Promise<void> {
    const before = this.order;
    this.mutations++;
    this.order = [...ids.filter((id) => this.entries.has(id)), ...before.filter((id) => !ids.includes(id))];
    this.changed();
    try {
      const tracks = await this.call(() => this.deps.api.saveOrder(ids));
      this.mutations++;
      for (const t of tracks) this.applyTrack(t);
      this.changed();
    } catch (err) {
      this.order = before;
      this.changed();
      throw err;
    }
  }

  // Internals

  private statusOf(id: number, e: Entry): RowStatus {
    const state = this.deps.engine.state(id);
    if (state) return state;
    return e.failed !== null && e.wanted === null ? 'error' : 'loading';
  }

  /** Runs an API call; notes when the login session has expired (logging in again reloads the board). */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SessionExpiredError && !this.expired) {
        this.expired = true;
        this.changed();
      }
      throw err;
    }
  }

  private setFade(ms: number): void {
    this.fade = ms;
    this.deps.engine.setFadeMs(ms);
  }

  private reconcile(tracks: Track[]): void {
    const serverIds = new Set(tracks.map((t) => t.id));
    for (const t of tracks) this.applyTrack(t);
    for (const id of [...this.entries.keys()]) if (!serverIds.has(id)) this.dropTrack(id);

    // Server order; a deleted track that is still sounding keeps its place until it goes.
    const next = tracks.map((t) => t.id);
    this.order.forEach((id, index) => {
      if (!serverIds.has(id) && this.entries.has(id)) next.splice(Math.min(index, next.length), 0, id);
    });
    this.order = next;
    this.pumpDownloads();
  }

  /** Takes in the server's view of one track: new, renamed, re-timed or a new file. */
  private applyTrack(t: Track): void {
    const e = this.entries.get(t.id);
    if (!e) {
      this.entries.set(t.id, {
        track: t,
        gone: false,
        blob: null,
        voiceVersion: null,
        wanted: t.version,
        loading: null,
        failed: null,
        pending: null,
      });
      return;
    }
    const startChanged = e.track.start_ms !== t.start_ms;
    e.track = t;
    if (startChanged && this.deps.engine.has(t.id)) this.deps.engine.setStartMs(t.id, t.start_ms); // deferred while active
    const latest = e.wanted ?? e.pending?.version ?? e.voiceVersion ?? e.failed;
    if (latest !== t.version) {
      e.failed = null;
      e.wanted = t.version;
    }
  }

  /** The track is gone from the server: remove it now if idle, otherwise once it is. */
  private dropTrack(id: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.gone = true;
    e.wanted = null;
    if (e.pending) {
      e.pending.voice.dispose();
      e.pending = null;
    }
    this.deps.engine.remove(id); // the engine defers this while the track plays or fades
    this.sweep();
  }

  private pumpDownloads(): void {
    while (this.downloads < PARALLEL_DOWNLOADS) {
      const id = this.order.find((i) => {
        const e = this.entries.get(i)!;
        return e.wanted !== null && e.loading === null;
      });
      if (id === undefined) return;
      this.startLoad(this.entries.get(id)!);
    }
  }

  private startLoad(e: Entry): void {
    const version = e.wanted!;
    const isCurrent = () => this.entries.get(e.track.id) === e && !e.gone && e.wanted === version;
    const fail = () => {
      e.loading = null;
      if (isCurrent()) {
        e.wanted = null;
        e.failed = version;
      }
      this.changed();
      this.pumpDownloads();
    };

    e.loading = version;
    this.downloads++;
    this.call(() => this.deps.loadBlob(e.track)).then(
      (blob) => {
        this.downloads--;
        this.pumpDownloads();
        this.voiceQueue = this.voiceQueue.then(async () => {
          if (!isCurrent()) {
            e.loading = null;
            this.pumpDownloads();
            return;
          }
          let voice: Voice;
          try {
            voice = await this.deps.makeVoice(blob);
          } catch (err) {
            console.error('Could not prepare track audio', err);
            fail();
            return;
          }
          e.loading = null;
          if (!isCurrent()) {
            voice.dispose();
            this.pumpDownloads();
            return;
          }
          e.wanted = null;
          this.install(e, voice, version, blob);
          this.pumpDownloads();
        });
      },
      () => {
        this.downloads--;
        fail();
      },
    );
  }

  /** Puts a newly built voice into the engine, or holds it until the track is idle. */
  private install(e: Entry, voice: Voice, version: string, blob: Blob): void {
    const { engine } = this.deps;
    const id = e.track.id;
    const state = engine.state(id);
    if (state === 'playing' || state === 'fading') {
      e.pending?.voice.dispose();
      e.pending = { voice, version, blob };
      return;
    }
    if (state) engine.remove(id); // idle: disposes the old voice
    e.voiceVersion = version;
    e.blob = blob;
    engine.add(id, voice, e.track.start_ms);
    this.changed();
  }

  private onEngineChange(): void {
    const { engine } = this.deps;
    for (const e of this.entries.values()) {
      if (e.pending && engine.state(e.track.id) === 'ready') {
        const { voice, version, blob } = e.pending;
        e.pending = null;
        this.install(e, voice, version, blob);
      }
    }
    this.sweep();
    this.changed();
  }

  /** Drops rows of deleted tracks the engine has let go of, then tidies the cache. */
  private sweep(): void {
    let dropped = false;
    for (const [id, e] of this.entries) {
      if (e.gone && !this.deps.engine.has(id)) {
        this.entries.delete(id);
        this.playedFromMs.delete(id);
        dropped = true;
      }
    }
    if (dropped) {
      this.order = this.order.filter((id) => this.entries.has(id));
      this.maybePrune();
      this.changed();
    }
  }

  /**
   * Removes cached audio of tracks no longer on the server. Only with a list the server sent,
   * and only once no deleted track is still sounding.
   */
  private maybePrune(): void {
    if (!this.serverTracks) return;
    for (const e of this.entries.values()) if (e.gone) return;
    const key = keyOf(this.serverTracks);
    if (key === this.prunedKey) return;
    this.prunedKey = key;
    this.deps.prune(this.serverTracks).catch(() => {});
  }

  private changed(): void {
    this.cachedRows = null;
    for (const l of [...this.listeners]) l();
  }
}
