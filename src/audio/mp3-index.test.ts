import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { indexMp3 } from './mp3-index';

const fixture = (name: string) => new Uint8Array(readFileSync(join(process.cwd(), 'tests/fixtures', name)));

describe('indexMp3', () => {
  it('indexes a VBR file with a Xing/LAME header, excluding the header frame', () => {
    const ix = indexMp3(fixture('click-vbr.mp3'));
    expect(ix).toMatchObject({ sampleRate: 44100, channels: 2, samplesPerFrame: 1152, encoderDelay: 576, encoderPadding: 1224 });
    expect(ix.frameOffsets.length).toBe(1150);
    expect(ix.durationSec).toBeCloseTo(30, 6);
    // the first audio frame follows the ID3v2 tag (44 bytes) and the Xing frame
    expect(ix.frameOffsets[0]).toBeGreaterThan(44);
    expect(ix.dataEnd).toBe(fixture('click-vbr.mp3').length);
  });

  it('indexes the same audio without a Xing header; no delay is known', () => {
    const ix = indexMp3(fixture('click-vbr-noxing.mp3'));
    expect(ix.encoderDelay).toBeNull();
    expect(ix.frameOffsets.length).toBe(1150);
    expect(ix.frameOffsets[0]).toBe(44);
    expect(ix.durationSec).toBeCloseTo((1150 * 1152) / 44100, 6);
  });

  it('indexes a CBR file with an Info header', () => {
    const ix = indexMp3(fixture('click-cbr.mp3'));
    expect(ix.frameOffsets.length).toBe(1150);
    expect(ix.durationSec).toBeCloseTo(30, 6);
  });

  it('handles mono files with and without an ID3v2 tag', () => {
    const tagged = indexMp3(fixture('short.mp3'));
    const bare = indexMp3(fixture('short-noid3.mp3'));
    for (const ix of [tagged, bare]) {
      expect(ix).toMatchObject({ channels: 1, sampleRate: 44100, encoderDelay: 576, encoderPadding: 1080 });
      expect(ix.durationSec).toBeCloseTo(2, 6);
    }
    expect(tagged.frameOffsets[0] - bare.frameOffsets[0]).toBe(98);
  });

  it('rejects data that is not mp3', () => {
    expect(() => indexMp3(fixture('fake.mp3'))).toThrow(/No mp3 audio frames/);
  });

  it('skips junk between frames and ignores a trailing ID3v1 tag', () => {
    const src = fixture('click-cbr.mp3');
    const ix0 = indexMp3(src);
    const cut = ix0.frameOffsets[500];
    const junk = new Uint8Array([0xff, 0xfb, 0x00, 0x12, 0x34]);
    const tag = new Uint8Array(128);
    tag.set([0x54, 0x41, 0x47]); // "TAG"
    const b = new Uint8Array(src.length + junk.length + tag.length);
    b.set(src.subarray(0, cut));
    b.set(junk, cut);
    b.set(src.subarray(cut), cut + junk.length);
    b.set(tag, src.length + junk.length);
    const ix = indexMp3(b);
    expect(ix.frameOffsets.length).toBe(1150);
    expect(ix.frameOffsets[500]).toBe(cut + junk.length);
  });
});
