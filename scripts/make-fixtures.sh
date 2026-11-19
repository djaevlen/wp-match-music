#!/usr/bin/env bash
# Generates the mp3 test fixtures in tests/fixtures/. Needs ffmpeg with libmp3lame.
# The output is committed; re-run only to change the fixtures.
set -euo pipefail

cd "$(dirname "$0")/.."
out=tests/fixtures
mkdir -p "$out"

ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }

# 220 Hz tone at 0.03, plus a 5 ms 2 kHz burst at 0.9 on every whole second.
click="aevalsrc='0.03*sin(2*PI*220*t)+0.9*sin(2*PI*2000*t)*lt(mod(t,1),0.005)':s=44100:d=30"
tone="aevalsrc='0.03*sin(2*PI*220*t)':s=44100:d=2"

ff -f lavfi -i "$click" -ac 2 -c:a libmp3lame -q:a 4 "$out/click-vbr.mp3"
ff -f lavfi -i "$click" -ac 2 -c:a libmp3lame -q:a 4 -write_xing 0 "$out/click-vbr-noxing.mp3"
ff -f lavfi -i "$click" -ac 2 -c:a libmp3lame -b:a 192k "$out/click-cbr.mp3"

ff -f lavfi -i "$tone" -ac 1 -c:a libmp3lame -b:a 64k -id3v2_version 3 \
  -metadata title="Short tone" -metadata artist="Match Music fixtures" "$out/short.mp3"
ff -f lavfi -i "$tone" -ac 1 -c:a libmp3lame -b:a 64k -id3v2_version 0 "$out/short-noid3.mp3"

printf 'not audio' > "$out/fake.mp3"

# Memory check only (prototype "Load 20 × 4-minute track"): music-like noise and tones,
# LAME V2 like a typical download. About 3.5 MB, so it is gitignored, not committed.
ff -f lavfi -i "anoisesrc=c=pink:a=0.25:s=44100:d=240" \
  -f lavfi -i "aevalsrc='0.2*sin(2*PI*110*t)*(0.5+0.5*sin(2*PI*0.5*t))|0.2*sin(2*PI*165*t)':s=44100:d=240" \
  -filter_complex "[0]aformat=channel_layouts=stereo[n];[n][1]amix=inputs=2:normalize=0" \
  -c:a libmp3lame -q:a 2 "$out/long-4min.mp3"

echo "Fixtures written to $out"
