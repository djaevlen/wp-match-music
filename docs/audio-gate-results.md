# Audio gate results (spec section 8)

Date: 2026-11-19. Machine: macOS (Apple Silicon), Playwright 1.65.1 (Chromium, Firefox, WebKit builds), headless, muted.

**Status: automated gate passed with the decoded-pieces voice (`src/audio/buffer-voice.ts`). The `<audio>` element voice failed and is not to be used for playback. The phone check is pending. The gate is not recorded as passed until it is done.**

## Pass marks

| Mark | Rule | Test |
|---|---|---|
| Press-to-sound delay | under 100 ms | `maxDelayMs < 100` over 10 presses |
| Repeat landing | same device and browser within 20 ms of itself | `spreadMs` (max − min landing) ≤ 20 |
| Between browsers | within 100 ms of the saved start | `|meanLandedSec − 10.3| ≤ 0.1` |

## How it is measured

- `prototype/` page, start point 10.3 s, fixtures `tests/fixtures/click-*.mp3` (220 Hz tone at 0.03 with a 5 ms 2 kHz click at 0.9 on every whole second).
- A level meter on the audio graph (an AudioWorklet, or a ScriptProcessor on plain http) timestamps samples on the audio clock, to the sample. `tSignal` is the first sample above 0.01 after silence. `tClick` is the first sample above 0.5.
- `delayMs = tSignal − ctx.currentTime at the press`. This is the time until the graph renders sound. It excludes the device's fixed output latency, which the page also reports (Chromium 16 ms, Firefox 7.4 ms, WebKit 1 ms here).
- `landedSec = 11 − (tClick − tSignal)`: where in the song playback actually began.
- `?mute=1` (used by the tests) sets a gain node after the meter to 0, so automated runs make no sound. Chromium also gets `--mute-audio` and Firefox `media.volume_scale=0.0`. All three mute only the final output. Muted and unmuted runs gave identical numbers.
- **Harness check:** the same meter, fed by a plain `AudioBufferSourceNode` started at 10.3 s, read delay 0.4 ms, landing 10.3003 s and spread 0 in all three engines. So the meter is accurate, and the failures below belong to the `<audio>` element, not to the harness.

## Attempt 1: `<audio>` element voice (`src/audio/element-voice.ts`): FAILED

`GATE_VOICE=element npx playwright test tests/gate` (that run predates the `rate` parameter). Every element run used the device's default context rate, 48 000 Hz, against the 44.1 kHz files.

| Browser | File | Max delay ms | Spread ms | Mean landing s | Result |
|---|---|---|---|---|---|
| Chromium | click-vbr | 201.5 | 77.7 | 10.465 | fail (delay, spread, landing) |
| Chromium | click-vbr-noxing | 209.0 | 0 | 10.283 | fail (delay) |
| Chromium | click-cbr | 45.6 | 0 | 10.316 | pass |
| Firefox | click-vbr | 160.6 | 0 | 10.345 | fail (delay) |
| Firefox | click-vbr-noxing | — | — | — | fail: no sound in any run |
| Firefox | click-cbr | 11.4 | 0 | 10.326 | pass |
| WebKit | click-vbr | 273.9 | 649.9 | 10.215 | fail (delay, spread) |
| WebKit | click-vbr-noxing | 277.9 | 1459 | 10.171 | fail (delay, spread) |
| WebKit | click-cbr | 114.1 | 931.7 | 10.139 | fail (delay, spread) |

What was found:

- **Not a headless artefact:** headed Chromium and headed WebKit gave the same numbers.
- **Chromium, VBR:** sound starts about 200 ms after the press (43 ms for CBR). On click-vbr the first audible sample is song time 10.47 s, not 10.3 s: Chromium's play clock starts at the press, but the first ~160 ms of audio after the seek is missing. The first press after loading behaves differently (122 ms, 10.395 s), hence the 78 ms spread. A richer 83 kbps VBR test file did better (71 ms) but showed the same first-press jump (69 ms spread).
- **Firefox, VBR without a Xing header:** after the seek to 10.3 s, playback jumps to 33.2 s and the track ends at once. Firefox seeks by the first frame's bitrate and lands past the end of the file. The track never sounds.
- **WebKit, all files:** the first press is about 270 ms late. Later presses give a ~20 ms burst of stale audio from where the track was last stopped, then the real audio starts somewhere between 20 and 370 ms later. Mid-play continuity is fine; the start is not. Playwright's WebKit is not Safari, so real Safari was not measured.
- Rapid pressing (Play A, Play B, Play A, Stop, Stop in one tick) raised no page errors or unhandled `play()` rejections in any browser.

## Attempt 2: decoded-pieces voice (`src/audio/buffer-voice.ts`): PASSED (automated)

The voice indexes the mp3's frames and decodes the song a few seconds at a time from the stored file. It plays the pieces back to back with `AudioBufferSourceNode`s, scheduled on the audio clock. An idle track holds only 3 s decoded at its start point, so Play needs no decoding. While playing it keeps 12 to 22 s decoded ahead. The fade, the one-track rule and every other 7.4 rule run through the unchanged `Engine`. There is no limit on how long a track plays.

`npx playwright test tests/gate`: 39/39 passed. The gate and continuity tests each run at two context sample rates, forced with `?rate=`. At 48 000 Hz the 44.1 kHz fixtures are resampled (as on most phones), so piece offsets fall between samples. At 44 100 Hz nothing is resampled. Each result below records the rate it ran at.

| Browser | Rate Hz | File | Max delay ms | Output latency ms | Spread ms | Mean landing s | Result |
|---|---|---|---|---|---|---|---|
| Chromium | 48000 | click-vbr / noxing / cbr | 18.0 / 15.4 / 15.4 | 16 | 0 / 0 / 0 | 10.3003 all | pass |
| Chromium | 44100 | click-vbr / noxing / cbr | 15.4 / 21.2 / 15.4 | 16 | 0 / 0 / 0 | 10.3003 all | pass |
| Firefox | 48000 | click-vbr / noxing / cbr | 15.4 / 15.4 / 15.4 | 7.4 | 0 / 0 / 0 | 10.3003 all | pass |
| Firefox | 44100 | click-vbr / noxing / cbr | 15.4 / 15.4 / 15.4 | 8.2 | 0 / 0 / 0 | 10.3003 all | pass |
| WebKit | 48000 | click-vbr / noxing / cbr | 15.0 / 15.0 / 15.0 | 1 | 0 / 0 / 0 | 10.3119 all | pass |
| WebKit | 44100 | click-vbr / noxing / cbr | 15.0 / 15.0 / 15.0 | 1 | 0 / 0 / 0 | 10.3119 all | pass |

Worst max delay plus output latency: Chromium, 21.2 + 16 = 37 ms (limit 100).

Continuity, from the "Continuity 16 s" button: 16 s from 10.3 s, across the piece joins at 13.3 s and 23.3 s.

| Browser | Rate Hz | Max click-gap error ms (vbr / noxing / cbr) | Gaps | Dropouts | Result |
|---|---|---|---|---|---|
| Chromium | 48000 | 0 / 0 / 0.021 | 15 each | 0 | pass |
| Chromium | 44100 | 0 / 0 / 0 | 15 each | 0 | pass |
| Firefox | 48000 | 0 / 0 / 0.021 | 15 each | 0 | pass |
| Firefox | 44100 | 0 / 0 / 0 | 15 each | 0 | pass |
| WebKit | 48000 | 0 / 0 / 0 | 15 each | 0 | pass |
| WebKit | 44100 | 0 / 0 / 0 | 15 each | 0 | pass |

- **Start lead.** The delay includes a deliberate lead before the first piece starts: the larger of 15 ms and the context's base latency plus one 128-frame render quantum. Here every engine's base latency is ≤ 5.4 ms, so the lead is 15 ms on all three. A phone with a larger base latency gets a longer lead, so its first piece is never late; a late first piece would sound late and overlap the next one 3 s later. The "Continuity 16 s" button measures exactly that seam on the device.
- **Refill.** Refill runs on a 250 ms timer and also on each piece's `ended` event from the audio thread, which keeps arriving when timers are throttled. If refill does stall past the scheduled audio, playback carries on from the playhead rather than decoding the audio it missed (unit-tested).
- WebKit lands 11.6 ms later than the others, because its mp3 decoder drops the standard 529-sample decoder delay. Between browsers that is well inside 100 ms. It is constant per device, so the editor and match-day Play still agree.
- **Rapid pressing:** no page errors or unhandled rejections in any browser, and all tracks ready afterwards.
- **Plain-http fallback (as on a phone; device default 48 000 Hz; from the first round, before the lead change):** loading the page via the LAN address drops AudioWorklet, and the ScriptProcessor meter takes over. It read 26 ms delay (the meter's own buffering adds ~10 ms), spread 0, landing 10.3003 s (WebKit 10.3119 s) in all three engines. One of four Chromium continuity runs showed a single 2.67 ms (one render quantum) blip away from any piece boundary. The other three were clean, which points to ScriptProcessor timestamping, not playback.
- **Memory, desktop Chromium:** "Memory test: load 20 × 4-minute track" loads 20 separate copies of a 240 s, 117 kbps file. Settled after forced GC, process memory rose 7 to 13 MB with one track playing; the `<audio>` voice rose 22 to 108 MB. Loading briefly costs more (+90 to +195 MB), because each file is read whole once to index it. This is indicative only; the phone check is the real test.

## Phone check: pending

To be done with the user (plan Task 2 Step 5). Run `npm run proto` and open the Network URL ending `/prototype/` on the phone, on the same wifi. The decoded voice is the default; `?voice=element` shows the first attempt for comparison. Before the memory test, run `scripts/make-fixtures.sh`: the 4-minute file is generated, not committed.

Instructions for the person testing:

1. On iPhone, turn the ring/silent switch off.
2. On each of the three click files, tap **Measure ×10**.
   - **Delay:** add `maxDelayMs` and `outputLatencyMs` (both in the copied results; output latency is also shown under the tables). The sum must be under 100 ms.
   - **Spread** must be ≤ 20 ms. **Mean landing** must be 10.3 ± 0.1 s.
3. On each file, tap **Continuity 16 s**: every click gap within 0.5 ms of 1 s, and 0 dropouts. This measures the joins between decoded pieces at 13.3 s and 23.3 s, which only the decoded voice has.
4. Tap **Copy results** and paste it below. The result includes the sample rate, meter and voice.
5. Press Play on one track and let it play past 30 s: no gaps, flams or jumps (listen around 13 s and 23 s after Play).
6. While a track plays, lock the screen once for about 20 s, then unlock: does it still play, and in time?
7. Tap **Memory test: load 20 × 4-minute track**, then Play/Stop a few of them. Does the page survive, and are Play/Stop still instant? Note memory if the phone shows it (for example Safari Web Inspector, or Chrome remote debugging).
8. Say whether Play sounds instant and Stop fades smoothly.

Record:

- Device / OS / browser:
- Copied results (Measure ×10 and Continuity for click-vbr, click-vbr-noxing, click-cbr):
- maxDelayMs + outputLatencyMs per file:
- Play instant? Stop fades smoothly?
- Played past 30 s without a glitch?
- Screen lock while playing:
- Memory test (20 × 4-minute): page survives? memory?
- Decision:
