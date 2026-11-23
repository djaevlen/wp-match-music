# Quick play with the space bar: design

Date: 2026-11-23
Status: approved 2026-11-23

Short design for a small change to Match Music. Builds on
`2026-11-19-match-music-design.md` ("the original spec"); section numbers below
refer to it.

Items marked **(decided)** were chosen by the club. Items marked **(my call)** were
filled in by the designer and can be overruled.

## 1. Intent

A handball or floorball match stops every time the referee blows the whistle, and
the club plays music in each break to keep the hall lively while players
substitute or get ready. There are many breaks, they come without warning, and
most of them need "some music now", not a particular song. Finding a row and
clicking it is too slow for that.

So the space bar becomes the whistle key: one press starts a track, the next
press fades it out.

## 2. Goals

- **(decided)** Space with nothing sounding starts a random track from its saved
  start point.
- **(decided)** Space while a track plays does what its Stop button does: fade out
  over the global fade duration.
- **(decided)** Some tracks (goal tracks) can be kept out of the random pool.
- **(my call)** Variety: no track repeats until every pool track has had a turn.

## 3. Non-goals

- Any other keyboard shortcut. The original spec's non-goal "Keyboard shortcuts"
  is lifted for the space bar only.
- An on-screen quick-play button, or anything else for phones. **(my call)**
- Track types or categories, or a key for a random goal track.
- Remembering the shuffle between page loads or sharing it between devices.

## 4. Anti-goals

- Space starting a track whose switch is off.
- Space typing into a text field also starting or stopping music.
- A held or bouncing key starting a track and fading it straight away.
- Space after a mouse click on a row re-pressing that row's button instead of
  doing quick play.
- Any anti-goal of the original spec (notably: two tracks at once, an audible
  delay, an abrupt cut on Stop).

## 5. Approaches

How a track is kept out of the pool:

1. **An on/off switch per track, saved on the site. Chosen (decided).** One new
   saved value, one switch in the edit dialog, one marker on the row. Covers goal
   tracks and anything else later (walk-on music, an anthem).
2. A type per track (Break or Goal). Same amount of work and opens the door to a
   "random goal" key, but every track must be one or the other, so other
   hand-started tracks have no honest home.
3. Remembered per device. No server change, but the person preparing at home and
   the person running the match would each set it up; that breaks the shared
   setup the board is built on.
4. By track name or list position. Invisible rules that break on rename or
   reorder.

## 6. Design

### 6.1 The quick play setting

- Each track gets `quick_play` (true or false). Stored as post meta
  `_mm_quick_play` beside `_mm_start_ms`.
- **(my call)** Default is on: new uploads, and every existing track that has no
  stored value yet. After updating, the club switches it off once per goal track.
- `GET /tracks` returns it on every track. `PATCH /tracks/{id}` accepts it next to
  `name` and `start_ms`; anything but a real boolean is rejected like an invalid
  start point. Same permission as the other track fields: Editor and
  Administrator only (section 7.1).
- It reaches other devices the way a start point does (section 7.9).

### 6.2 Editing

- The edit dialog gets a "Quick play" switch with one line of help ("Included
  when Space picks a random track"). Like name and start point it is a draft
  until Save.
- **(my call)** A row whose switch is off shows a small muted marker in its status
  line, labelled "Not in quick play", visible to everyone, so the operator can see
  what Space will never pick.

```
┌──────────────────────────────┐  ┌──────────────────────────────┐
│ Thunderstruck                │  │ Goal horn                    │
│ starts 0:42     [Play][Stop] │  │ starts 0:03 ⊘   [Play][Stop] │
└──────────────────────────────┘  └──────────────────────────────┘
```

### 6.3 What Space does

| Board state | Space |
|---|---|
| Nothing sounding | Starts the next quick-play track |
| A track playing at full volume | Stops it, exactly as its Stop button would |
| A track fading out | **(my call)** Starts the next quick-play track; the fading one is cut, as with any Play on another track (section 7.4) |
| No pool track available | Nothing plays; a short notice says there is nothing to quick play |

- "Playing" means any track, however it was started (Space or a click).
- The fading row departs from "exactly like Stop", where a second Stop cuts to
  silence. Reason, the same as the phone toggle in section 7.4: a second whistle
  right after play resumes is the likelier need, and it wants music.
- Starting goes through the store's normal Play path, so the wait for the audio
  output on the very first press of a page works as it does for a click.

### 6.4 Picking the next track **(my call)**

- The pool: tracks with the switch on whose audio is loaded and ready.
- The board remembers which tracks have been played in the current round. The
  next track is drawn at random from pool tracks not yet played this round.
- When none are left, a new round starts: the played list is cleared and the draw
  is made from the whole pool except the track played last (unless it is the only
  one).
- Every track that starts counts as played, whether Space or a click started it,
  so Space will not pick what the operator just played by hand.
- The round is kept in memory on that device and starts fresh on page load.
- The random source is injectable so the behaviour can be unit-tested.

### 6.5 The key

- One listener on the window, in the capture phase, for the Space key with no
  modifier held.
- Ignored when: the event is an auto-repeat from a held key; the focus is in a
  text field or other editable element; a dialog, menu or popover is open (edit
  dialog, delete confirmation, row menu, fade control).
- Otherwise it is consumed, on key down and key up, so the page does not scroll
  and a focused button is not pressed. **(my call)** This means Space no longer
  presses a focused button or picks up a drag handle on the board itself; Enter
  still does both.
- **(my call)** On laptop-width screens the header shows a small muted hint,
  "Space: quick play", so the match-day operator who did not set the board up
  knows it is there.
- Available to everyone who can play (Subscriber and up).

## 7. Risks to verify in a real browser

- Browsers differ on whether cancelling key down or key up stops Space from
  clicking a focused button. Cover with an end-to-end test: click Play on a row
  with the mouse, press Space, and the track must fade rather than restart.
- The drag handle's keyboard support listens for Space itself; confirm the window
  listener wins and that Enter still reorders.

## 8. Testing

- PHP: a track with no stored value reads as on; PATCH saves true and false and
  rejects non-booleans; a Subscriber cannot change it.
- Store: every row of the table in 6.3; no repeat within a round; a new round
  never opens with the last track; a switched-off or still-loading track is never
  picked; a hand-started track counts as played.
- Key handling: repeat, text field and open dialog are ignored; modifiers are
  ignored.
- Components: the switch saves with Save and not before; the marker shows only on
  switched-off rows.
- End to end: the two checks in section 7, and Space never starting a
  switched-off track over many presses.

## 9. Left to the builder

- The marker's icon and the exact wording of the hint, help line and notice.
- Whether the editor's Test and Listen previews count as played in the round.
- Where the key listener lives (the board hook or one of its own).
- Adding the shadcn Switch component.
