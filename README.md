# Match Music

A login-protected jingle board for a handball club's match days, as a WordPress plugin. Logged-in members press a track to play it, press again to fade it out; Editors upload tracks and set where each one starts. The plugin is PHP (`match-music/`); the board is a React app built by Vite into `match-music/build/`.

## Quick play

On a laptop the space bar is the whistle key: with nothing playing it starts a random track, and while a track plays it fades it out, as Stop does. No track repeats until every track has had a turn. Editors can keep a track (a goal jingle, say) out of the random pick with the **Quick play** switch in the edit dialog; such rows show a small marker. Space types normally in text fields and is left alone while a dialog or menu is open; a focused button is pressed with Enter. Design: `docs/superpowers/specs/2026-11-23-quick-play-design.md`.

## Run it locally

Needs Docker, Node 22 and PHP/Composer for the PHP tests.

```sh
npm install
composer install        # PHPUnit
npx wp-env start        # WordPress on http://localhost:8888 (tests site on :8889), admin / password
npm run build           # the board is served from match-music/build/
```

Open http://localhost:8888/match-music/ (log in first). `npm run dev` starts a Vite dev server for the front end only. `.wp-env.json` activates `./match-music` and maps this repo to `wp-content/mm-dev` inside the container.

## Tests

| Command | What it runs |
|---|---|
| `npm test` | Unit tests (Vitest, jsdom) |
| `npm run test:php` | PHPUnit inside wp-env: permissions, upload validation, storage |
| `npm run test:e2e` | Builds, then Playwright (Chromium, Firefox, WebKit) against the local WordPress. It creates its own test users and resets the board |
| `npx playwright test tests/gate` | The audio gate: press-to-sound delay and start-point accuracy on the `prototype/` page (`npm run proto` serves it) |

The gate and the 4-minute memory test use fixtures from `scripts/make-fixtures.sh` (the long one is generated, not committed).

## Build the zip

```sh
npm run zip             # builds, then writes dist/match-music.zip
```

The zip holds a top-level `match-music/` folder with the PHP files and `build/` only (no source maps, no dotfiles other than `build/.vite/manifest.json`, which the plugin needs). Install it with Plugins > Add New > Upload, and follow `docs/install-checklist.md`.

## Where things are

- Design: `docs/superpowers/specs/2026-11-19-match-music-design.md` (section 11 records the change of audio technique)
- Plan: `docs/superpowers/plans/2026-11-19-match-music.md`
- Audio gate results: `docs/audio-gate-results.md`
- Install and device checklist for the club: `docs/install-checklist.md`

## Installing on a WordPress site

Each release on GitHub has a ready-built `match-music.zip`:
<https://github.com/djaevlen/wp-match-music/releases>

- **By hand:** Plugins > Add New > Upload Plugin, choose the zip, activate.
- **With Composer** (for example a Bedrock site using `composer/installers`): add this repository entry, then `composer require djaevlen/wp-match-music`. Change both version numbers when a new release comes out.

```json
{
  "type": "package",
  "package": {
    "name": "djaevlen/wp-match-music",
    "version": "0.1.0",
    "type": "wordpress-plugin",
    "dist": {
      "url": "https://github.com/djaevlen/wp-match-music/releases/download/v0.1.0/match-music.zip",
      "type": "zip"
    },
    "require": { "composer/installers": "^1.0 || ^2.0" },
    "extra": { "installer-name": "match-music" }
  }
}
```

Then follow [docs/install-checklist.md](docs/install-checklist.md).

## Releasing

Bump the version in `match-music/match-music.php` (the `Version:` header and `MATCH_MUSIC_VERSION`), commit, then tag and push: `git tag v0.2.0 && git push origin v0.2.0`. The release workflow runs the unit tests, builds the zip and publishes the release.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
