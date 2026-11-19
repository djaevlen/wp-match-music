// Audio gate prototype (spec section 8). Dev-only test page, not product UI.
import { Engine } from '../src/audio/engine';
import { getAudioContext, unlockAudio } from '../src/audio/context';
import { createBufferVoice } from '../src/audio/buffer-voice';
import { createElementVoice } from './element-voice';
import { snapMs } from '../src/lib/time';

const FIXTURES = ['click-vbr.mp3', 'click-vbr-noxing.mp3', 'click-cbr.mp3'];
const RUNS = 10;
const CONTINUITY_SEC = 16; // from 10.3 s: clicks 11..26 s, across piece joins at 13.3 s and 23.3 s
const MAX_GAP_ERROR_MS = 0.5;
const GAP_MS = 300;
const RUN_TIMEOUT_MS = 3000;
const SIGNAL_LEVEL = 0.01;
const CLICK_LEVEL = 0.5;

export interface GateRun {
  delayMs: number;
  landedSec: number;
}

export interface GateSummary {
  file: string;
  voice: string;
  startSec: number;
  runs: GateRun[];
  errors: string[];
  maxDelayMs: number;
  spreadMs: number;
  meanLandedSec: number;
  meter: string;
  sampleRate: number;
  baseLatencyMs: number | null;
  outputLatencyMs: number | null;
  userAgent: string;
}

export interface ContinuityResult {
  file: string;
  voice: string;
  seconds: number;
  clickGapsSec: number[];
  maxGapErrorMs: number;
  dropouts: number;
  meter: string;
  sampleRate: number;
  userAgent: string;
}

declare global {
  interface Window {
    __gate?: Record<string, GateSummary>;
    __continuity?: Record<string, ContinuityResult>;
    __proto?: {
      play(file: string): void;
      stop(file: string): void;
      states(): Record<string, string>;
      continuity(file: string, seconds?: number): Promise<ContinuityResult>;
    };
  }
}

// ---------------------------------------------------------------------------
// Level meter on the audio clock. The same detector runs in an AudioWorklet
// (secure contexts) or a ScriptProcessor (plain http on a phone), at sample
// resolution. 'signal' = first sample above SIGNAL_LEVEL after 50 ms of quiet;
// 'click' = first sample above CLICK_LEVEL after 100 ms without one.

interface DetectorState {
  quiet: number;
  sinceClick: number;
}

// Self-contained: its source is also injected into the worklet scope.
function detect(
  st: DetectorState,
  channels: Float32Array[],
  frames: number,
  sampleRate: number,
  signalLevel: number,
  clickLevel: number,
  emit: (kind: 'signal' | 'click', offset: number) => void,
): void {
  const quietNeeded = 0.05 * sampleRate;
  const clickGap = 0.1 * sampleRate;
  for (let i = 0; i < frames; i++) {
    let peak = 0;
    for (let c = 0; c < channels.length; c++) {
      const v = Math.abs(channels[c][i]);
      if (v > peak) peak = v;
    }
    if (peak > signalLevel) {
      if (st.quiet >= quietNeeded) emit('signal', i);
      st.quiet = 0;
    } else {
      st.quiet++;
    }
    if (peak > clickLevel) {
      if (st.sinceClick >= clickGap) emit('click', i);
      st.sinceClick = 0;
    } else {
      st.sinceClick++;
    }
  }
}

interface LevelEvent {
  kind: 'signal' | 'click';
  t: number; // seconds on ctx.currentTime's clock
}

interface Meter {
  kind: string;
  events: LevelEvent[];
}

async function createMeter(ctx: AudioContext, input: AudioNode): Promise<Meter> {
  const events: LevelEvent[] = [];
  if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    const code = `
const detect = (${detect.toString()});
class GateMeter extends AudioWorkletProcessor {
  constructor() { super(); this.st = { quiet: Infinity, sinceClick: Infinity }; }
  process(inputs) {
    const input = inputs[0] || [];
    const frames = input.length ? input[0].length : 128;
    const frame0 = currentFrame;
    detect(this.st, input, frames, sampleRate, ${SIGNAL_LEVEL}, ${CLICK_LEVEL},
      (kind, i) => this.port.postMessage({ kind, frame: frame0 + i }));
    return true;
  }
}
registerProcessor('gate-meter', GateMeter);`;
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(ctx, 'gate-meter');
      node.port.onmessage = (e: MessageEvent<{ kind: LevelEvent['kind']; frame: number }>) => {
        events.push({ kind: e.data.kind, t: e.data.frame / ctx.sampleRate });
      };
      input.connect(node);
      node.connect(ctx.destination); // silent; keeps the node pulled
      return { kind: 'audioworklet (128-frame blocks, sample resolution)', events };
    } catch (err) {
      console.warn('AudioWorklet unavailable, falling back to ScriptProcessor', err);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const st: DetectorState = { quiet: Infinity, sinceClick: Infinity };
  const sp = ctx.createScriptProcessor(256, 2, 1);
  sp.onaudioprocess = (e) => {
    const buf = e.inputBuffer;
    const channels: Float32Array[] = [];
    for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));
    e.outputBuffer.getChannelData(0).fill(0);
    const t0 = e.playbackTime ?? ctx.currentTime;
    detect(st, channels, buf.length, ctx.sampleRate, SIGNAL_LEVEL, CLICK_LEVEL, (kind, i) =>
      events.push({ kind, t: t0 + i / ctx.sampleRate }),
    );
  };
  input.connect(sp);
  sp.connect(ctx.destination);
  return { kind: 'scriptprocessor (256 frames, sample resolution)', events };
}

// ---------------------------------------------------------------------------
// Page wiring

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const startInput = $<HTMLInputElement>('start');
const fadeInput = $<HTMLInputElement>('fade');
const tracksEl = $<HTMLDivElement>('tracks');
const summaryEl = $<HTMLTableSectionElement>('summary');
const resultsEl = $<HTMLTextAreaElement>('results');

const params = new URLSearchParams(location.search);
// ?rate=48000 (or 44100) forces the context's sample rate, so the gate can run with and
// without resampling 44.1 kHz files. Without it the page uses the shared context.
const forcedRate = Number(params.get('rate')) || 0;
const ctx = forcedRate ? new AudioContext({ sampleRate: forcedRate }) : getAudioContext();
const unlock = forcedRate ? () => (ctx.state === 'running' ? Promise.resolve() : ctx.resume()) : unlockAudio;
const engine = new Engine();
// Voices -> meterInput -> output -> speakers. The meter taps meterInput, upstream of
// output, so ?mute=1 (used by the automated gate) silences the speakers without
// changing what is measured. The manual/phone page stays audible by default.
const muted = params.get('mute') === '1';
// 'buffer' (decoded pieces, the default) or 'element' (<audio>, the first attempt).
const voiceKind = params.get('voice') === 'element' ? 'element' : 'buffer';
const makeVoice = voiceKind === 'element' ? createElementVoice : createBufferVoice;
const meterInput = ctx.createGain();
const output = ctx.createGain();
output.gain.value = muted ? 0 : 1;
meterInput.connect(output);
output.connect(ctx.destination);
const meterReady = createMeter(ctx, meterInput);

interface Row {
  id: number;
  name: string;
  el: HTMLElement;
  status: HTMLElement;
  runsEl: HTMLElement;
  buttons: HTMLButtonElement[];
}

const rows: Row[] = [];
const gate: Record<string, GateSummary> = {};
const continuityResults: Record<string, ContinuityResult> = {};
let nextId = 1;
let measuring = false;
let meterKind = '';

$('ua').textContent = navigator.userAgent;

/** The start field as whole ms, snapped to 100 ms and clamped to the track. */
function startMsFor(durationSec: number): number {
  const sec = Number(startInput.value);
  const ms = Number.isFinite(sec) ? Math.round(sec * 1000) : 0;
  return snapMs(ms, durationSec * 1000);
}

function fadeMs(): number {
  const sec = Number(fadeInput.value);
  return Number.isFinite(sec) ? Math.min(10000, Math.max(0, Math.round(sec * 2) * 500)) : 2000;
}

startInput.addEventListener('change', () => {
  for (const r of rows) if (engine.has(r.id)) engine.setStartMs(r.id, startMsFor(engine.durationSec(r.id)));
});
fadeInput.addEventListener('change', () => engine.setFadeMs(fadeMs()));
engine.setFadeMs(fadeMs());

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.disabled = true;
  b.addEventListener('click', onClick);
  return b;
}

function addRow(name: string, src: string): void {
  const id = nextId++;
  const el = document.createElement('section');
  el.className = 'track';
  el.dataset.file = name;
  const header = document.createElement('header');
  const title = document.createElement('span');
  title.textContent = name;
  const status = document.createElement('span');
  status.className = 'status';
  status.textContent = 'loading…';
  header.append(title, status);

  const play = button('Play', () => {
    void unlock();
    engine.play(id);
  });
  const stop = button('Stop', () => engine.stop(id));
  const measureBtn = button('Measure ×10', () => void measure(row));
  const continuityBtn = button(`Continuity ${CONTINUITY_SEC} s`, () => void continuity(row));
  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  buttons.append(play, stop, measureBtn, continuityBtn);
  const runsEl = document.createElement('div');
  runsEl.className = 'runs';
  el.append(header, buttons, runsEl);
  tracksEl.append(el);

  const row: Row = { id, name, el, status, runsEl, buttons: [play, stop, measureBtn, continuityBtn] };
  rows.push(row);

  makeVoice(ctx, src, meterInput).then(
    (voice) => {
      engine.add(id, voice, startMsFor(voice.durationSec));
      el.dataset.ready = 'true';
      for (const b of row.buttons) b.disabled = measuring;
    },
    (err: unknown) => {
      status.textContent = `failed to load: ${String(err)}`;
      el.dataset.ready = 'error';
    },
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitForEvent(
  meter: Meter,
  kind: LevelEvent['kind'],
  after: number,
  timeoutMs: number,
): Promise<LevelEvent | null> {
  const until = performance.now() + timeoutMs;
  while (performance.now() < until) {
    const hit = meter.events.find((e) => e.kind === kind && e.t >= after);
    if (hit) return hit;
    await sleep(5);
  }
  return null;
}

function cut(id: number): void {
  engine.setFadeMs(0);
  engine.stop(id);
  engine.setFadeMs(fadeMs());
}

async function measure(row: Row): Promise<void> {
  if (measuring || !engine.has(row.id)) return;
  // Inside the tap: resume the context, and play-then-cut once so iOS lets
  // this element play from the timer-driven runs below. Nothing is rendered.
  const unlocked = unlock();
  engine.play(row.id);
  cut(row.id);

  measuring = true;
  for (const r of rows) for (const b of r.buttons) b.disabled = true;
  row.runsEl.textContent = 'measuring…';
  const startSec = startMsFor(engine.durationSec(row.id)) / 1000;
  const nextWholeSec = Math.ceil(startSec);
  const runs: GateRun[] = [];
  const errors: string[] = [];
  const lines: string[] = [];

  try {
    await unlocked;
    const meter = await meterReady;
    meterKind = meter.kind;
    await sleep(GAP_MS);
    for (let n = 1; n <= RUNS; n++) {
      meter.events.length = 0;
      const tPress = ctx.currentTime;
      engine.play(row.id);
      const sig = await waitForEvent(meter, 'signal', tPress - 0.02, RUN_TIMEOUT_MS);
      const click = sig && (await waitForEvent(meter, 'click', sig.t, RUN_TIMEOUT_MS));
      cut(row.id);
      if (!sig || !click) {
        const msg = `run ${n}: no ${sig ? 'click' : 'signal'} within ${RUN_TIMEOUT_MS} ms`;
        errors.push(msg);
        lines.push(msg);
      } else {
        const run = {
          delayMs: round((sig.t - tPress) * 1000, 1),
          landedSec: round(nextWholeSec - (click.t - sig.t), 4),
        };
        runs.push(run);
        lines.push(`run ${String(n).padStart(2)}: delay ${run.delayMs.toFixed(1)} ms, landed ${run.landedSec.toFixed(4)} s`);
      }
      row.runsEl.textContent = lines.join('\n');
      await sleep(GAP_MS);
    }
  } catch (err) {
    errors.push(String(err));
  } finally {
    measuring = false;
    for (const r of rows) for (const b of r.buttons) b.disabled = r.el.dataset.ready !== 'true';
  }

  gate[row.name] = summarise(row.name, startSec, runs, errors);
  window.__gate = { ...gate };
  renderSummary();
}

/** Plays one file across piece joins; gaps between clicks should all be 1 s, with no dropouts. */
async function continuity(row: Row, seconds = CONTINUITY_SEC): Promise<ContinuityResult | undefined> {
  if (measuring || !engine.has(row.id)) return;
  const unlocked = unlock(); // inside the tap, as in measure()
  engine.play(row.id);
  cut(row.id);

  measuring = true;
  for (const r of rows) for (const b of r.buttons) b.disabled = true;
  row.runsEl.textContent = `continuity: playing ${seconds} s…`;
  let result: ContinuityResult;
  try {
    await unlocked;
    const meter = await meterReady;
    meterKind = meter.kind;
    await sleep(GAP_MS);
    meter.events.length = 0;
    const tPress = ctx.currentTime;
    engine.play(row.id);
    await sleep(seconds * 1000);
    cut(row.id);
    const mine = meter.events.filter((e) => e.t >= tPress - 0.02);
    const clicks = mine.filter((e) => e.kind === 'click').map((e) => e.t);
    const gaps = clicks.slice(1).map((t, i) => round(t - clicks[i], 6));
    result = {
      file: row.name,
      voice: voiceKind,
      seconds,
      clickGapsSec: gaps,
      maxGapErrorMs: gaps.length ? round(Math.max(...gaps.map((g) => Math.abs(g - 1))) * 1000, 3) : NaN,
      dropouts: Math.max(0, mine.filter((e) => e.kind === 'signal').length - 1),
      meter: meterKind,
      sampleRate: ctx.sampleRate,
      userAgent: navigator.userAgent,
    };
  } finally {
    measuring = false;
    for (const r of rows) for (const b of r.buttons) b.disabled = r.el.dataset.ready !== 'true';
  }
  row.runsEl.textContent =
    `continuity: ${result.clickGapsSec.length} click gaps, max error ${result.maxGapErrorMs} ms ` +
    `(≤ ${MAX_GAP_ERROR_MS}), dropouts ${result.dropouts}`;
  continuityResults[row.name] = result;
  window.__continuity = { ...continuityResults };
  renderSummary();
  return result;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function summarise(file: string, startSec: number, runs: GateRun[], errors: string[]): GateSummary {
  const delays = runs.map((r) => r.delayMs);
  const landed = runs.map((r) => r.landedSec);
  const has = runs.length > 0;
  const l = latencyMs();
  return {
    file,
    voice: voiceKind,
    startSec,
    runs,
    errors,
    maxDelayMs: has ? Math.max(...delays) : NaN,
    spreadMs: has ? round((Math.max(...landed) - Math.min(...landed)) * 1000, 1) : NaN,
    meanLandedSec: has ? round(landed.reduce((a, b) => a + b, 0) / landed.length, 4) : NaN,
    meter: meterKind,
    sampleRate: ctx.sampleRate,
    baseLatencyMs: l.base,
    outputLatencyMs: l.output,
    userAgent: navigator.userAgent,
  };
}

function cell(text: string, pass?: boolean): HTMLTableCellElement {
  const td = document.createElement('td');
  td.textContent = text;
  if (pass !== undefined) td.className = pass ? 'pass' : 'fail';
  return td;
}

function renderSummary(): void {
  summaryEl.replaceChildren(
    ...Object.values(gate).map((g) => {
      const tr = document.createElement('tr');
      const ok = g.errors.length === 0;
      tr.append(
        cell(g.file + (ok ? '' : ` (${g.errors.length} failed runs)`), ok ? undefined : false),
        cell(`${g.maxDelayMs} ms`, g.maxDelayMs < 100),
        cell(`${g.spreadMs} ms`, g.spreadMs <= 20),
        cell(`${g.meanLandedSec} s`, Math.abs(g.meanLandedSec - g.startSec) <= 0.1),
      );
      return tr;
    }),
  );
  $('continuity-summary').replaceChildren(
    ...Object.values(continuityResults).map((c) => {
      const tr = document.createElement('tr');
      tr.append(
        cell(c.file),
        cell(`${c.maxGapErrorMs} ms (${c.clickGapsSec.length} gaps)`, c.clickGapsSec.length >= 14 && c.maxGapErrorMs <= MAX_GAP_ERROR_MS),
        cell(String(c.dropouts), c.dropouts === 0),
      );
      return tr;
    }),
  );
  renderMeta();
  resultsEl.value = resultsText();
}

function latencyMs(): { base: number | null; output: number | null } {
  const c = ctx as AudioContext & { outputLatency?: number };
  return {
    base: typeof c.baseLatency === 'number' ? round(c.baseLatency * 1000, 1) : null,
    output: typeof c.outputLatency === 'number' ? round(c.outputLatency * 1000, 1) : null,
  };
}

function renderMeta(): void {
  const l = latencyMs();
  $('meta').textContent =
    `Voice: ${voiceKind}. Sample rate ${ctx.sampleRate} Hz. Meter: ${meterKind || 'not started'}. ` +
    `Base latency ${l.base ?? 'n/a'} ms, output latency ${l.output ?? 'n/a'} ms ` +
    `(not included in delay: add output latency to max delay and compare with 100 ms).`;
}

function resultsText(): string {
  return JSON.stringify(
    { userAgent: navigator.userAgent, voice: voiceKind, sampleRate: ctx.sampleRate, results: gate, continuity: continuityResults },
    null,
    2,
  );
}

$('copy').addEventListener('click', () => {
  const text = resultsEl.value || resultsText();
  const done = (msg: string) => ($('copied').textContent = msg);
  const fallback = () => {
    // Clipboard API needs a secure context; a phone on plain http lands here.
    resultsEl.focus();
    resultsEl.select();
    resultsEl.setSelectionRange(0, text.length);
    done(document.execCommand('copy') ? 'Copied.' : 'Select the text below and copy it.');
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => done('Copied.'), fallback);
  } else {
    fallback();
  }
});

$<HTMLInputElement>('local').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  for (const f of Array.from(input.files ?? [])) addRow(f.name, URL.createObjectURL(f));
  input.value = '';
});

setInterval(() => {
  for (const r of rows) {
    if (r.el.dataset.ready !== 'true') continue;
    const state = engine.state(r.id) ?? '';
    r.status.textContent = `${state} ${engine.positionSec(r.id).toFixed(1)} / ${engine.durationSec(r.id).toFixed(1)} s`;
  }
}, 100);

// Hooks for the automated gate's rapid-press check.
const rowFor = (file: string) => rows.find((r) => r.name === file);
window.__proto = {
  play: (file) => rowFor(file)?.buttons[0].click(),
  stop: (file) => rowFor(file)?.buttons[1].click(),
  states: () => Object.fromEntries(rows.map((r) => [r.name, engine.state(r.id) ?? 'none'])),
  continuity: async (file, seconds) => {
    const result = await continuity(rowFor(file)!, seconds);
    if (!result) throw new Error('busy or not loaded');
    return result;
  },
};

const voiceEl = $('voice');
for (const [kind, label] of [
  ['buffer', 'decoded pieces'],
  ['element', '<audio> element'],
] as const) {
  const q = new URLSearchParams(params);
  q.set('voice', kind);
  const a = document.createElement('a');
  a.href = `?${q}`;
  a.textContent = label;
  if (kind === voiceKind) a.setAttribute('aria-current', 'true');
  voiceEl.append(' ', a);
}

// Step 6 memory check: 20 separate copies (each fetched and held on its own, as 20 tracks would be).
$<HTMLButtonElement>('memtest').addEventListener('click', (e) => {
  (e.currentTarget as HTMLButtonElement).disabled = true;
  for (let n = 1; n <= 20; n++) addRow(`long-4min.mp3 #${n}`, `/tests/fixtures/long-4min.mp3?copy=${n}`);
});

renderMeta();
for (const f of FIXTURES) addRow(f, `/tests/fixtures/${f}`);
