# Match Music: design

Date: 2026-11-19
Status: awaiting approval

A WordPress plugin that gives a handball club a shared "jingle board". The person
running sound at a match presses Play on a track and it starts right at the drop;
pressing Stop fades it out.

Items marked **(decided)** were chosen by the club. Items marked **(my call)** were
filled in by the designer and can be overruled.

## 1. Intent

Every time play stops in a handball match (goal, timeout, suspension, 7-metre
throw), the club wants a burst of music. A song's intro is useless for that: the
music must start at the drop, so each track needs a start point the club sets
itself. When play resumes, the music must fade out rather than cut.

Tracks are prepared before the match, possibly at home by one person, and run on
match day by another person on another device. So the setup lives on the club's
WordPress site and is the same for everyone.

## 2. Goals

- Upload mp3 files into a shared track list. Expected size: up to 20 tracks.
- Each track has Play and Stop, and an editable start point.
- One global fade-out duration, applied when Stop is pressed.
- Track list, start points and fade duration are stored on the WordPress site and
  shared by all users and devices. **(decided)**
- Delivered as a WordPress plugin, installed as one zip. **(decided)**
- UI built with shadcn/ui. **(decided)**
- Runs mostly on a laptop, and is easy to use on a phone. **(decided)**
- The mp3 files are not publicly reachable and do not appear in the media library.
  **(decided)**

## 3. Non-goals

Not in this version. Each is something a builder might be tempted to add.

- Playlists, auto-advance, looping, crossfades, fade-in.
- Per-track volume or per-track fade duration.
- Replacing the audio of an existing track (delete and upload again instead).
- Playback sync between devices. Pressing Play on one device plays on that device
  only.
- Audio formats other than mp3.
- Keyboard shortcuts.
- Installable/offline app (PWA). The board needs the site to load; see section 7
  for what works without a connection once loaded.
- Multiple boards, teams or seasons. There is one track list.
- Any scoreboard or match-clock function.

## 4. Anti-goals

The plugin has failed if any of these happen, even if every feature works.

- An audible delay between pressing Play and hearing sound.
- Music cutting off abruptly on Stop (when fade duration is above zero).
- Two tracks sounding at once.
- Playback stuttering or dying mid-match because of a network problem.
- An mp3 being downloadable by someone who is not logged in.
- A Subscriber being able to change tracks, start points or the fade duration.
- The start point heard in the editor differing from what match-day Play produces
  on the same device.

## 5. Constraints and unknowns

- It installs into an existing WordPress site the designer has not seen. WordPress
  version, PHP version, web server (Apache or nginx), PHP upload limit and whether
  a CDN or page cache sits in front are all unknown.
- **(decided)** The site is a normal single site, not a multisite network.
  Multisite is not supported in this version.
- **(my call)** Target WordPress 6.4+ and PHP 7.4+, so it runs on older shared
  hosting. Do not use PHP 8-only syntax.
- **(my call)** HTTPS is assumed. Without it the browser cache used in section 7
  is unavailable and tracks are re-downloaded on every load; the board must still
  work.
- Because the web server is unknown, file protection must not depend on
  `.htaccess` alone (nginx ignores it).
- Local tooling available to the builder: Docker, wp-cli, PHP 8.4, Node 22.

## 6. Approaches

### Where the track data lives

1. **In the browser only (IndexedDB).** A static page, no backend, works offline.
   The list exists on one device only. Rejected by the club: they want it shared.
2. **On the WordPress site, via a plugin.** Shared for everyone, needs login and a
   small server API. **Chosen (decided).**

### Who can reach the board and the audio

1. Public board. Anyone finding the page could pull the mp3s through it.
2. Secret link with a random key. No accounts needed; weaker.
3. **Login required to play. Chosen (decided):** minimum role Subscriber.

### Where the board appears in WordPress

1. **Its own full-screen page served by the plugin. Chosen (decided).** No theme
   markup or CSS around it, so shadcn/Tailwind cannot collide with the theme, and
   the whole screen is the track list.
2. A shortcode inside a theme page. Feels like part of the site, but theme CSS and
   Tailwind's reset fight, and theme chrome wastes space on a phone.
3. A wp-admin page. Least work, but Subscribers would run a match from the
   dashboard, which is poor on a phone.

### How audio is played **(my call)**

1. **One `<audio>` element per track, fed from a locally cached copy of the file,
   routed through a Web Audio gain node for the fade. Chosen.** Low memory, works
   on phones, and iOS ignores `audio.volume` so the gain node is required there
   anyway.
2. Decode every track fully into memory (`AudioBuffer`). Sample-accurate and
   instant, but roughly 80 MB per 4-minute track: about 1.6 GB for 20 tracks. Too
   heavy for a phone and risky on a laptop.
3. Stream from the server with range requests on each Play. No preload, but every
   Play waits on the hall's wifi. Violates the first anti-goal.

## 7. Design

### 7.1 Roles **(decided: Subscriber to play; my call: Editor to edit)**

| Action | Not logged in | Subscriber, Contributor, Author | Editor, Administrator |
|---|---|---|---|
| Open the board, play, stop | No, sent to login | Yes | Yes |
| Download audio through the plugin | No | Yes | Yes |
| Upload, rename, reorder, delete, set start point | No | No | Yes |
| Change fade duration | No | No | Yes |

- Play capability: `read`. Edit capability: `edit_others_posts`. **(my call)** Both
  are filterable (`match_music_play_capability`, `match_music_edit_capability`).
- A logged-in user without the play capability gets a plain 403 page.

### 7.2 The board page

- Served by the plugin at `/match-music/` **(my call: name and address)**, through
  a rewrite rule. The plugin outputs a complete standalone HTML document. The theme
  is not loaded. The slug is filterable.
- Not logged in: redirect to the WordPress login, then back to the board.
- The page sends no-cache headers and `noindex`.
- Rewrite rules are flushed on activation and deactivation.

### 7.3 Layout **(decided: list layout, mockup approved)**

Header: title, fade duration, "Add mp3" (editors only), loading progress.

Laptop, one row per track:

```
Match music                                   [Fade 2.0 s] [+ Add mp3]
┌──────────────────────────────────────────────────────────────────┐
│ ⠿ Goal                 starts 0:42.3   [▶ Play] [■ Stop]  [Edit] │
│ ⠿ Timeout              0:07 playing    [▶ Play] [■ Stop]  [Edit] │  ← highlighted
│ ⠿ 2-minute suspension  starts 1:15.0   [▶ Play] [■ Stop]  [Edit] │
└──────────────────────────────────────────────────────────────────┘
```

- **(my call)** On wide screens the rows split into two columns, filled top to
  bottom then left to right, so 20 tracks fit without scrolling. One column
  otherwise.
- The playing row is highlighted and shows elapsed time since the start point. A
  fading row shows a distinct "fading" state.
- Stop is enabled only on the row that is playing.
- Edit, the drag handle, "Add mp3" and the fade control are rendered for editors
  only. Others see the fade value read-only.
- A row whose audio is not yet loaded shows a loading state and its Play is
  disabled. A row whose audio failed to load shows an error and a retry.

Phone: one column. Each row is the track name and one large button that toggles
between Play and Stop. **(my call)** Editors reach Edit through a small menu on the
row.

### 7.4 Playback behaviour **(proposed by designer, accepted by the club)**

- **Play** starts the track from its saved start point at full volume.
- **Stop** fades the volume to silence over the global fade duration, then pauses.
  A fade duration of 0 stops at once.
- **One track at a time.** Play on another track cuts the current one immediately,
  with no fade, and starts the new one.
- **Play during a fade-out** of the same track cancels the fade and restarts from
  the start point at full volume.
- **(my call)** **Stop pressed a second time during a fade** cuts immediately.
- **(my call)** **Phone, single toggle button:** it shows Stop while the track
  plays at full volume and switches to Play as soon as a fade begins. So on a
  phone, a tap during a fade restarts the track from the start point; there is no
  cut-immediately on a phone, the fade simply finishes. Reason: a second stoppage
  right after the first is the likelier need, and waiting out a short fade is
  harmless.
- A track left alone plays to its end and stops. No looping.
- After any stop or end, the track is made ready at its start point again.

### 7.5 Fade duration **(decided: one global setting; my call: range)**

- 0 to 10 seconds in 0.5 second steps, default 2.0. Stored on the server, shared.
- A change applies to the next Stop press on every device once that device has
  refreshed its data (section 7.9).

### 7.6 Editing a track **(mockup approved)**

A dialog opened from Edit on a row:

- Name field.
- Waveform of the whole song with a draggable start marker. Clicking the waveform
  moves the marker there. The part before the marker is dimmed.
- Start time readout with nudge buttons: −1 s, −0.1 s, +0.1 s, +1 s.
- "Test from start point": plays exactly what match-day Play will play.
- "Listen from 0:00": plays from the beginning with a moving playhead.
- "Mark here": sets the marker to the current playback position.
- Stop.
- Delete track (with confirmation), Cancel, Save. Save stores name and start point
  on the server. Nothing is saved before Save is pressed.

Rules:

- **(my call)** Start points snap to 0.1 seconds and are stored as whole
  milliseconds. Clamped to between 0 and just before the end of the track.
- The preview uses the same audio engine and the same audio element as match-day
  playback, so what is heard here is what Play produces. The one-track-at-a-time
  rule applies to previews too.
- The waveform is computed in the browser when the dialog opens, by decoding that
  one track; the decoded data is released when the dialog closes. It is a visual
  guide only; the ear, via "Test from start point", is the authority.

### 7.7 Adding and managing tracks

- "Add mp3" accepts several files at once, by file picker or drag and drop, with
  per-file progress.
- A new track is named after its filename without the extension, starts at 0:00,
  and is added to the end of the list.
- Editors reorder tracks by dragging a handle. The order is shared.
- Rejected uploads say why: not an mp3, or larger than the site's upload limit (the
  limit is shown).
- **(my call)** No hard cap on the number of tracks. The layout is tuned for about
  20.

### 7.8 Audio loading and readiness

- When the board opens, every track's file is fetched through the plugin's audio
  endpoint, a few at a time, in list order.
- Each file is stored in the browser's Cache Storage, keyed by track id and a file
  version token, so later visits on that device load without downloading. Cached
  files for deleted tracks are removed. Persistent storage is requested, best
  effort.
- Each track gets an `<audio>` element fed from the local copy, connected through
  its own gain node to one shared `AudioContext`. The element is held paused at the
  start point so Play is immediate. The context is resumed on the first user
  gesture.
- Once tracks are loaded, playing and stopping need no network at all.
- **(my call)** A screen wake lock is requested while the board is open, best
  effort, so the device does not sleep mid-match.
- First open on a device downloads everything: roughly 100 to 200 MB for 20
  tracks. The header shows progress ("Loading 7/20").
- Consequence accepted: the mp3s remain in the browser storage of any logged-in
  member who opened the board.

### 7.9 Staying in step between devices **(my call)**

- The track list and settings are re-fetched when the window regains focus and
  about once a minute, but never applied to a track while it is playing or fading.
- A changed start point re-readies that track. A new file version triggers a
  download. A removed track disappears.
- The REST nonce is refreshed through WordPress core's `rest-nonce` ajax action
  when a request is rejected for an expired nonce.
- If the login session expires mid-match, playback of loaded tracks keeps working.
  Edits and reloads prompt the user to log in again.

### 7.10 Server side

Data:

- Tracks: a non-public custom post type (not shown in wp-admin, not in search, not
  in the core REST API). Title is the track name, `menu_order` is the position.
  Meta: stored filename, start point in ms, file size, original filename, version
  token.
- Settings: one option holding the fade duration in ms.

Files:

- Stored under the uploads directory in a dedicated private folder, **not** as
  media library attachments.
- Each file gets a random 128-bit name. The name is never sent to the browser; the
  browser only knows track ids.
- The folder also gets an `.htaccess` deny rule and an empty `index.php`. On nginx
  the unguessable name is the protection.
- Deleting a track deletes its file.

REST API, namespace `match-music/v1`, cookie + nonce authentication:

| Route | Capability | Purpose |
|---|---|---|
| `GET /tracks` | play | List: id, name, start ms, order, size, version |
| `POST /tracks` | edit | Upload one mp3 (multipart), creates a track |
| `PATCH /tracks/{id}` | edit | Update name and/or start point |
| `DELETE /tracks/{id}` | edit | Delete track and file |
| `PUT /tracks/order` | edit | Save the full order as a list of ids |
| `GET /tracks/{id}/audio` | play | Stream the mp3 |
| `GET /settings` | play | Fade duration |
| `PUT /settings` | edit | Update fade duration |

- The audio route streams the file with `Content-Type: audio/mpeg`,
  `Content-Length`, and `Cache-Control: private, no-store`, so no shared cache or
  CDN keeps a copy. The path is built only from stored meta, never from request
  input.
- Uploads are validated server-side: upload error, size against the site limit,
  and real file type (must be mp3), not just the extension.
- All text input is sanitised; numeric input is range-checked.

Lifecycle **(my call)**: deactivating keeps all data. Deleting the plugin from
WordPress removes tracks, files and settings.

### 7.11 Front end

- React, TypeScript, Vite, Tailwind, shadcn/ui. Built assets ship inside the
  plugin; the site needs no Node.
- The audio engine is a plain TypeScript module with no React in it, so the
  behaviour in 7.4 can be unit-tested as a state machine.
- **(decided)** UI text is English. **(my call)** It is kept in one place so it
  can be translated later.

## 8. Risks to verify early

- **Seek accuracy.** `<audio>` seeking in variable-bitrate mp3s can be imprecise
  and can differ between browsers. This is a gate: build a bare prototype of the
  audio engine first and measure it with a VBR test file in Chrome, Firefox and
  Safari (desktop and iOS) before building the UI. Pass marks **(my call)**:
  - Press-to-sound delay: under 100 ms.
  - Same device and browser, repeated Play: lands within 20 ms of itself.
  - Between browsers, same saved start point: within 100 ms (one snap step).

  If the gate fails, the builder may choose a different audio technique without
  asking, as long as every rule in 7.4 and every anti-goal still holds and memory
  stays reasonable on a phone. If the only workable fix would change behaviour the
  club would notice (for example a limit on how long a track can play), stop and
  ask the club.
- **iOS Safari.** Confirm blob-fed `<audio>` through a gain node fades correctly,
  and that 20 preloaded elements are tolerated.
- **Hosting.** A low PHP upload limit will reject normal mp3s (typically 5 to
  12 MB). The plugin reports the limit; raising it is a hosting task.
- **Caches in front of the site.** The board page and REST responses for
  logged-in users must not be cached by a page-cache plugin or CDN.

**(decided)** The builder can get access to the club's live site; the details are
to be requested from the club when needed. Use it to check the hosting facts in
section 5 before building the upload and file-protection parts, and to run these
checks after install: the upload limit, that the board and an audio URL are
refused when logged out, that the private folder is not reachable by URL, and
that an edit made on one device shows up on a second.

**(decided)** The club tests the early audio prototype on their own phone. Which
phone (iPhone or Android) is not yet known, so the prototype must be handed over
in a form that works on either.

## 9. Testing

- PHP tests in a local WordPress (wp-env): the permission table in 7.1 for every
  route as anonymous, Subscriber and Editor; upload validation; delete removes the
  file; audio route refuses anonymous requests.
- Unit tests for the audio engine with mocked audio elements: every rule in 7.4.
- End-to-end in a real browser against local WordPress: a Subscriber sees the
  board with no edit controls; an Editor uploads a fixture mp3, sets a start
  point, plays (position matches the start point) and stops (paused after the
  fade).
- Manual checklist on real devices: laptop Chrome, Firefox, Safari; iPhone Safari;
  Android Chrome. Press-to-sound delay, fade smoothness, start-point repeatability.

## 10. Left to the builder

- Repository and plugin file layout, and the script that produces the zip.
- State and data-fetching approach in React; which shadcn components; the
  drag-and-drop library.
- How waveform peaks are computed and drawn.
- Download concurrency and the exact refresh interval.
- Exact visual styling within shadcn defaults, following the approved mockups in
  `.superpowers/brainstorm/`.
