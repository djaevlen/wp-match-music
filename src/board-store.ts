import { SessionExpiredError, type Api, type Track } from './api';
import type { Engine, TrackState } from './audio/engine';
import type { Voice } from './audio/voice';

export type RowStatus = 'loading' | 'error' | TrackState;

export interface BoardRow {
  track: Track;
  status: RowStatus;
}

/** The audio output (the shared AudioContext): whether it is running, and a way to start it. */
export interface AudioOutput {
  running(): boolean;
  /** Starts the output; must be called inside a user gesture to succeed. */
  unlock(): Promise<void>;
}

export interface BoardDeps {
  api: Api;
  engine: Engine;
  output: AudioOutput;
  makeVoice(blob: Blob): Promise<Voice>;
  loadBlob(t: Track): Promise<Blob>;
  prune(keep: Track[]): Promise<void>;
}

const PARALLEL_DOWNLOADS = 3;
/**
 * How long a Play pressed while the output was not running may wait for it to start. A jingle
 * that starts seconds after the press is worse than one that does not start at all.
 */
export const PENDING_PRESS_MS = 1000;

interface Entry {
  track: Track; // latest data from the server
  gone: boolean; // deleted on the server; the row stays until the engine lets go of it
  blob: Blob | null; // audio of the voice in the engine
  voiceVersion: string | null; // version of the voice in the engine
  wanted: string | null; // version that should be loaded next
  loading: string | null; // version whose download or voice build is in flight
  failed: string | null; // version whose load failed
  pending: { voice: Voice; version: string; blob: Blob } | null; // new voice waiting for the track to go idle
  heldName: string | null; // server rename of the active track, applied once nothing is active
}

const keyOf = (tracks: Track[]) =>
  tracks
    .map((t) => `${t.id}:${t.version}`)
    .sort()
    .join(',');

/**
 * The board's state: the server's track list, each track's audio, and playback through the
 * engine. Server changes never interrupt a track that is sounding; they land once it is idle.
 * While any track plays or fades, a new server order (and a rename of that track) waits too,
 * so the sounding row never moves under the operator's finger.
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
  private pendingPress: { id: number; fromMs?: number; at: number } | null = null; // Play waiting for the output

  private refreshing: Promise<void> | null = null;
  private mutations = 0; // bumped by local writes, so an older list does not undo them
  private serverTracks: Track[] | null = null; // the last list the server sent
  private heldOrder: number[] | null = null; // server order waiting for nothing to be active
  private listFailed = false; // the last list request failed (not session expiry)
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

  /** True when no track list has arrived yet and the last attempt could not reach the server. */
  loadError(): boolean {
    return !this.listed() && this.listFailed;
  }

  sessionExpired(): boolean {
    return this.expired;
  }

  /** True while the audio output is running, so Play sounds at once. */
  audioRunning(): boolean {
    return this.deps.output.running();
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
  //
  // Invariant: the engine never has an active track while the output is not running. Play
  // reaches the engine only when the output runs; otherwise the press waits (briefly) for it.
  // When the output stops running (iOS interruption, phone locked), the sounding track is cut,
  // so its row never claims to play in silence.

  play(id: number, fromMs?: number): void {
    if (!this.entries.has(id) || !this.deps.engine.has(id)) return;
    if (this.deps.output.running()) {
      // The normal path: synchronous from the click to the engine.
      this.pendingPress = null;
      this.start(id, fromMs);
      return;
    }
    // Not running (first press of the page, or after an interruption): hold the press, and ask
    // for the output while still inside the user's gesture. The row stays ready meanwhile.
    this.pendingPress = { id, fromMs, at: Date.now() };
    this.deps.output.unlock().then(
      () => this.outputChanged(),
      () => {},
    );
  }

  stop(id: number): void {
    if (this.pendingPress?.id === id) this.pendingPress = null;
    this.deps.engine.stop(id);
  }

  /** Silences whatever is sounding at once, with no fade, and drops a waiting Play. */
  cutActive(): void {
    this.pendingPress = null;
    this.cutSounding();
  }

  /**
   * The audio output changed state (or an unlock settled). Running: a Play pressed less than
   * PENDING_PRESS_MS ago starts now; an older one is dropped. Not running: the sounding track
   * is cut; a fresh waiting Play is kept, since the output may only be passing through
   * `interrupted` or `suspended` on its way to running.
   */
  outputChanged(): void {
    const press = this.pendingPress;
    if (press && Date.now() - press.at > PENDING_PRESS_MS) this.pendingPress = null;
    if (this.deps.output.running()) {
      const waiting = this.pendingPress;
      this.pendingPress = null;
      if (waiting) this.start(waiting.id, waiting.fromMs);
    } else {
      this.cutSounding();
    }
    this.changed();
  }

  private start(id: number, fromMs?: number): void {
    const e = this.entries.get(id);
    if (!e || !this.deps.engine.has(id)) return;
    this.playedFromMs.set(id, fromMs ?? e.track.start_ms);
    this.deps.engine.play(id, fromMs);
  }

  private cutSounding(): void {
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
    this.listFailed = tracks.status === 'rejected' && !(tracks.reason instanceof SessionExpiredError);
    // A local write since this refresh began is newer than what it fetched.
    const fresh = this.mutations === before;
    if (settings.status === 'fulfilled' && fresh) this.setFade(settings.value.fade_ms);
    if (tracks.status === 'fulfilled' && fresh) {
      this.serverTracks = tracks.value;
      this.reconcile(tracks.value);
      this.maybePrune(tracks.value);
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
    this.mutations++;
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
        this.applyTrack(t, true);
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
    this.applyTrack(t, true);
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
    const heldBefore = this.heldOrder;
    this.mutations++;
    this.heldOrder = null; // this user's order replaces any server order still waiting
    this.order = [...ids.filter((id) => this.entries.has(id)), ...before.filter((id) => !ids.includes(id))];
    this.changed();
    try {
      const tracks = await this.call(() => this.deps.api.saveOrder(ids));
      this.mutations++;
      for (const t of tracks) this.applyTrack(t, true);
      this.changed();
    } catch (err) {
      this.order = before;
      this.heldOrder = heldBefore;
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
    for (const t of tracks) this.applyTrack(t, false);
    for (const id of [...this.entries.keys()]) if (!serverIds.has(id)) this.dropTrack(id);

    const serverOrder = tracks.map((t) => t.id);
    if (this.deps.engine.activeId() === null) {
      this.order = this.ordered(serverOrder);
    } else {
      // Hold the server order; new tracks join at the end, where they move nothing.
      this.heldOrder = serverOrder;
      this.order = [...this.order, ...serverOrder.filter((id) => !this.order.includes(id))];
    }
    this.pumpDownloads();
  }

  /**
   * The rows in `serverOrder`. A deleted track that is still sounding keeps its place until
   * it goes; tracks the list does not know yet (uploaded since) stay at the end.
   */
  private ordered(serverOrder: number[]): number[] {
    const next = serverOrder.filter((id) => this.entries.has(id));
    this.order.forEach((id, index) => {
      if (!next.includes(id) && this.entries.get(id)?.gone) next.splice(Math.min(index, next.length), 0, id);
    });
    for (const id of this.order) if (!next.includes(id) && this.entries.has(id)) next.push(id);
    return next;
  }

  /** Server changes held while a track was active land once nothing is. */
  private releaseHeld(): boolean {
    if (this.deps.engine.activeId() !== null) return false;
    let released = false;
    for (const e of this.entries.values()) {
      if (e.heldName !== null) {
        e.track = { ...e.track, name: e.heldName };
        e.heldName = null;
        released = true;
      }
    }
    if (this.heldOrder) {
      this.order = this.ordered(this.heldOrder);
      this.heldOrder = null;
      released = true;
    }
    return released;
  }

  /**
   * Takes in one track: new, renamed, re-timed or a new file. `local` is true for this user's
   * own edits, which apply at once; a server rename of the active track waits.
   */
  private applyTrack(t: Track, local: boolean): void {
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
        heldName: null,
      });
      return;
    }
    const startChanged = e.track.start_ms !== t.start_ms;
    if (!local && this.deps.engine.activeId() === t.id && t.name !== e.track.name) {
      e.heldName = t.name;
      e.track = { ...t, name: e.track.name };
    } else {
      e.heldName = null;
      e.track = t;
    }
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
    if (this.pendingPress?.id === id) this.pendingPress = null;
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
      try {
        this.changed();
        this.pumpDownloads();
      } catch (err) {
        console.error('Board update failed', err);
      }
    };

    e.loading = version;
    this.downloads++;
    this.call(() => this.deps.loadBlob(e.track)).then(
      (blob) => {
        this.downloads--;
        this.pumpDownloads();
        // Each link catches everything, so one bad file never stalls the loads behind it.
        this.voiceQueue = this.voiceQueue.then(async () => {
          let voice: Voice | null = null;
          let installed = false;
          try {
            if (!isCurrent()) {
              e.loading = null;
              this.pumpDownloads();
              return;
            }
            voice = await this.deps.makeVoice(blob);
            e.loading = null;
            if (!isCurrent()) {
              voice.dispose();
              this.pumpDownloads();
              return;
            }
            e.wanted = null;
            this.install(e, voice, version, blob);
            installed = true;
            this.pumpDownloads();
          } catch (err) {
            console.error('Could not prepare track audio', err);
            if (!installed) {
              if (voice) this.discardBroken(e, voice, version);
              e.wanted = version; // so fail() sees this load as current and marks the row
              fail();
            }
          }
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
    engine.add(id, voice, e.track.start_ms);
    e.voiceVersion = version;
    e.blob = blob;
    this.changed();
  }

  /**
   * A voice that failed while being installed: make sure the engine does not keep it. The
   * engine holds a track before arming it, so a voice whose arm threw is in there.
   */
  private discardBroken(e: Entry, voice: Voice, version: string): void {
    try {
      if (e.pending?.voice === voice) e.pending = null;
      else if (this.deps.engine.state(e.track.id) === 'ready' && e.voiceVersion !== version) {
        this.deps.engine.remove(e.track.id);
        e.voiceVersion = null;
        e.blob = null;
      }
      voice.dispose();
    } catch (err) {
      console.error('Could not discard track audio', err);
    }
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
    this.releaseHeld();
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
      this.changed();
    }
  }

  /**
   * Removes cached audio of tracks no longer on the server, given the list a refresh has just
   * fetched (every track on the server). Waits for a later refresh while a deleted track is
   * still sounding.
   */
  private maybePrune(serverTracks: Track[]): void {
    for (const e of this.entries.values()) if (e.gone) return;
    const key = keyOf(serverTracks);
    if (key === this.prunedKey) return;
    this.prunedKey = key;
    this.deps.prune(serverTracks).catch(() => {});
  }

  /** Tells listeners; one that throws is logged and never stops the others or the store. */
  private changed(): void {
    this.cachedRows = null;
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch (err) {
        console.error('Board listener failed', err);
      }
    }
  }
}
