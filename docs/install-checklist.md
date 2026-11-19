# Match Music: install checklist

For the person who looks after the club's WordPress site. You do not need to be a developer. Each step says what a pass looks like. If a step does not pass, stop and write down what you saw in the Results section at the end.

You will need: the file `match-music.zip`, an Administrator login for the site, and about an hour. Parts C and D need a phone and a laptop.

## A. Before you install: look up the hosting facts

Do these before installing. Most are in WordPress under Tools > Site Health > Info, or in your hosting control panel.

**A1. WordPress version is 6.4 or newer.**
Where: Dashboard > Updates, or Site Health > Info > WordPress.
Pass: the version number is 6.4 or higher.

**A2. PHP version is 7.4 or newer.**
Where: Site Health > Info > Server. Your host's control panel can change it.
Pass: PHP 7.4 or higher (8.x is fine).

**A3. The site uses HTTPS.**
Where: look at the address bar. It should start with `https://` and show a padlock.
Pass: the padlock shows when you open the site. Without HTTPS the board still works, but phones cannot keep the tracks between visits, so every visit downloads everything again.

**A4. The site is a single site, not a multisite network.**
Where: if the admin menu has "My Sites" or "Network Admin" at the top, it is a network.
Pass: no "My Sites" menu. Match Music does not support multisite.

**A5. The upload limit is at least 15 MB.**
Where: Site Health > Info > Media Handling shows "Max size of an uploaded file" (and "Max size of post data allowed"). The values come from `upload_max_filesize` and `post_max_size`.
Pass: both are 15 MB or more. A normal song is 3 to 12 MB. If it is lower, ask the host to raise `upload_max_filesize` and `post_max_size` to at least 16M (most hosts have this under "PHP settings" in the control panel). Then look again.
Note: the board shows "The file is too large to upload (limit ...)" if a file goes over.

**A6. Permalinks are not "Plain".**
Where: Settings > Permalinks.
Pass: anything except "Plain" is selected. The board is then at `/match-music/`. With "Plain", the board is at `/?mm_board=1` instead; it works, but the address is uglier.

**A7. Page cache or CDN: find out if there is one.**
Where: Plugins list (look for WP Super Cache, W3 Total Cache, WP Rocket, LiteSpeed Cache, WP Fastest Cache and similar), and ask the host whether the site is behind a CDN such as Cloudflare.
Pass: either there is none, or it is set so that **pages for logged-in users are not cached** and **`/wp-json/` is never cached** (usually under "Never cache URLs" or "Exclusions"). Also add `/match-music/` to the never-cache list. Write down which plugin or CDN you found.

**A8. Which web server: Apache or nginx?**
Where: Site Health > Info > Server shows "Web server".
Pass: you know which one it is. If it is **nginx**, read the nginx note in section E before you finish.

## B. Install and activate

**B1. Upload the plugin.**
Where: Plugins > Add New Plugin > Upload Plugin > choose `match-music.zip` > Install Now.
Pass: the page says "Plugin installed successfully."

**B2. Activate it.**
Where: click Activate Plugin.
Pass: "Match Music" is in the Plugins list as Active, with an "Open board" link next to it.

**B3. Open the board.**
Where: click "Open board", or go to `https://your-site/match-music/` (or `https://your-site/?mm_board=1` if permalinks are Plain).
Pass: a page titled "Match music" with an empty list and, as Administrator, an "Add mp3" button. Not a blank page.

If the address shows your site's "page not found" page, go to Settings > Permalinks and press Save Changes once, then try again.

## C. Who can do what

- **Play and stop** (open the board, press Play, press Stop): any logged-in user, whatever their role (Subscriber, Contributor, Author, Editor, Administrator).
- **Edit** (add, rename, reorder and delete tracks, set start points, change the fade): Editors and Administrators only.
- Not logged in: the board sends you to the login page.
- A logged-in user whose account has no role gets a plain "forbidden" page.

To give someone play access, create them a WordPress user with the Subscriber role (Users > Add New). To let them edit, make them an Editor.

## D. Checks after installing

Use a private/incognito window for the logged-out checks.

**D1. Logged out, the board is closed.**
Do: in a private window, open `https://your-site/match-music/`.
Pass: you land on the WordPress login page, and after logging in you arrive on the board.

**D2. Logged out, the track data and audio are closed.**
Do: in the private window (not logged in), open `https://your-site/wp-json/match-music/v1/tracks`. Then open `https://your-site/wp-json/match-music/v1/tracks/1/audio`, and a few other small numbers in place of the `1` (2, 3, 4).
Pass: every one shows an error saying you are not allowed (HTTP 401 or 403), never a list of tracks and never a sound file. The numbers do not need to match real tracks: the site checks who you are before it looks for the track.

**D3. The private folder cannot be browsed.**
Do: open `https://your-site/wp-content/uploads/match-music-private/`.
Pass: "Forbidden" or "Not found". You must not see a list of files.

**D4. The board is not served from a cache.**
A page cache would hand one person's page to someone else. Test it with two different logged-in people.
Do: log in as an Editor or Administrator in your normal browser window and open the board. Open a private/incognito window, log in there as a Subscriber (a user with only the Subscriber role) and open the board.
Pass: the Editor sees the "Add mp3" button and the Subscriber does not. If the Subscriber sees "Add mp3", a cache is serving the Editor's page to other people: go back to A7 and exclude `/match-music/` and logged-in users from the cache.
Optional second check, for the technically curious: in the Editor window, open the browser's developer tools (press F12, or right-click the page > Inspect), choose the Network tab, reload the board, and click the first request in the list (named `match-music/` or similar). Under Response Headers, `Cache-Control` should contain `no-cache` or `no-store`, and there should be no `Age` header and no `X-Cache: HIT` or `cf-cache-status: HIT` line.

**D5. Upload a real song.**
Do: as Editor or Administrator, press "Add mp3" and choose a real mp3 of 8 to 12 MB.
Pass: a new row appears, goes from "loading" to ready, and its Play button works. Do this before D2 if you want D2 to have a track to protect.

**D6. A change on one device shows on another.**
Do: on one device change a track's start point (press Edit on the track, use the + 0.1 s and + 1 s buttons to move the start point, then press Save). On a second device, logged in, refresh the board.
Pass: the second device shows the new start point straight away, with no waiting and no stale value. Do it twice, to be sure it is not a cache.

**D7. Deactivating keeps everything; deleting removes everything.**
Only if you are sure: Plugins > Deactivate keeps your tracks, and Activate brings them back. Plugins > Delete removes tracks, audio files and settings for good. Do not delete the plugin unless you mean to start over.

## E. The nginx note

If the web server is **nginx**, the file `.htaccess` in the plugin's private folder is ignored. The song files are then protected only by their long random names, which nobody can guess. Whether the folder can be browsed depends on the server. To protect it properly, ask the host (or whoever runs the server) to add a rule like this to the site's nginx configuration, then reload nginx:

```nginx
location ^~ /wp-content/uploads/match-music-private/ {
    deny all;
    return 403;
}
```

The board plays the songs through the plugin, so this rule does not stop it working. Pass: D3 shows "Forbidden" (403). On Apache hosts you do not need this.

## F. Checks on real devices

Do these with the club's own phones, on match-day wifi if you can. Use the same track list the club will use: about 20 tracks. On iPhone, turn the ring/silent switch off (flip it so no orange shows), otherwise there is no sound.

**F1. Laptop: Chrome, Firefox and Safari.**
Do: open the board on each, wait until the header stops saying "Loading", press Play on a track, then Stop.
Pass: sound starts the instant you press Play (no noticeable lag). Stop fades out smoothly.

**F2. First press after opening the board makes sound.**
Do: on each phone, open the board fresh, wait until all tracks are ready, and press Play once, as the very first thing you touch.
Pass: the track plays on that first press. You do not have to press twice.

**F3. A track plays on past 30 seconds.**
Do: play a long track (3 minutes or more) and listen to the whole first minute, especially around 13 seconds and 23 seconds.
Pass: no gaps, clicks, repeats or jumps. It keeps going to the end.

**F4. The start point lands in the same place every time.**
Do: press Play, Stop, Play, Stop on a track with a start point several times.
Pass: it begins at the same spot each time.

**F5. A start point set on the laptop is right on the phone.**
Do: on the laptop set a start point; refresh the phone; play.
Pass: the phone begins at the same spot.

**F6. Turning wifi off does not stop Play or Stop.**
Do: load the board, then switch the phone's wifi and mobile data off, and press Play and Stop.
Pass: both still work.

**F7. The screen stays awake while the board is open.**
Do: leave the board open, untouched, for longer than the phone's normal screen timeout.
Pass: the screen does not go dark.

**F8. Locking the phone stops the music (expected).**
Do: play a track, press the phone's lock button, wait 20 seconds, unlock.
Pass: you know what happens. The club has accepted that **locking the phone stops the music**; this is how iPhones treat web audio and cannot be fixed. Write down what you saw after unlocking: is the board still usable, and does Play work again at once? (The board keeps the screen awake by itself, so only pressing the lock button does this.)

**F9. A second visit does not download everything again.**
Do: open the board on a phone and wait until it is fully loaded. Close the browser tab. Open the board again on mobile data or wifi.
Pass: the board is ready in a few seconds, and the header does not count through "Loading 1/20 ... 20/20" with a long wait. (Needs HTTPS; see A3. Private browsing windows do not keep tracks, so use a normal tab.)

**F10. The waveform editor opens for a 4-minute track on a phone.**
Do: as an Editor, upload (or pick) a track that is about 4 minutes long. Tap Edit on it.
Pass: the editor opens within a few seconds and shows the waveform. You can move the start point and save it. The page does not freeze or reload.

**F11. Dragging a real file from the computer onto the board while a track plays.**
Do: on the laptop, play a track. Drag an mp3 file from your desktop or a folder onto the board page and drop it.
Pass: the music keeps playing and the browser does not leave the page or start playing the file by itself. (As Editor it may add the track; as a Subscriber nothing happens. Both are fine.)

## G. Results

Fill this in as you go.

| | |
|---|---|
| Date | |
| Done by | |
| Site address | |
| WordPress version (A1) | |
| PHP version (A2) | |
| HTTPS (A3) | |
| Single site (A4) | |
| Max upload size / post size (A5) | |
| Permalink setting (A6) | |
| Page cache plugin / CDN, and what was excluded (A7) | |
| Web server; nginx rule added? (A8, E) | |
| Installed and activated (B1 to B3) | |
| Logged-out checks D1 to D3 | |
| Not cached (D4) | |
| Real upload worked (D5) | |
| Second device saw the change (D6) | |

Devices

| Device and browser | Version | F1 | F2 | F3 | F4 | F5 | F6 | F7 | F8 | F9 | F10 | F11 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Laptop Chrome | | | | | | | | | | | | |
| Laptop Firefox | | | | | | | | | | | | |
| Laptop Safari | | | | | | | | | | | | |
| Phone 1: | | | | | | | | | | | | |
| Phone 2: | | | | | | | | | | | | |

Write pass, fail or n/a in each box. Notes on anything that did not pass:

&nbsp;

&nbsp;
