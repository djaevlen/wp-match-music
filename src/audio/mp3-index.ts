/**
 * Index of the MPEG audio Layer III frames in an mp3 file, so that any time
 * range can be cut out as whole frames and decoded on its own.
 */
export interface Mp3Index {
  sampleRate: number;
  channels: number;
  samplesPerFrame: number;
  /** Byte offset of each audio frame (a Xing/Info/VBRI header frame is excluded). */
  frameOffsets: Uint32Array;
  /** Byte offset just past the last audio frame. */
  dataEnd: number;
  /** Encoder delay and padding in samples from a LAME-style tag, or null when absent. */
  encoderDelay: number | null;
  encoderPadding: number | null;
  /** Playable length after delay and padding are removed. */
  durationSec: number;
}

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};

interface FrameHeader {
  size: number;
  sampleRate: number;
  channels: number;
  samplesPerFrame: number;
  sideInfo: number;
  mpeg1: boolean;
}

function readHeader(b: Uint8Array, i: number): FrameHeader | null {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[i + 1] >> 3) & 3;
  const layer = (b[i + 1] >> 1) & 3;
  const brIndex = b[i + 2] >> 4;
  const srIndex = (b[i + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || brIndex === 0 || brIndex === 15 || srIndex === 3) return null;
  const mpeg1 = version === 3;
  const bitrate = (mpeg1 ? BITRATES_V1 : BITRATES_V2)[brIndex] * 1000;
  const sampleRate = RATES[version][srIndex];
  const padding = (b[i + 2] >> 1) & 1;
  const mono = b[i + 3] >> 6 === 3;
  const samplesPerFrame = mpeg1 ? 1152 : 576;
  return {
    size: Math.floor(((samplesPerFrame / 8) * bitrate) / sampleRate) + padding,
    sampleRate,
    channels: mono ? 1 : 2,
    samplesPerFrame,
    sideInfo: mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17,
    mpeg1,
  };
}

const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

/** Reads delay/padding from a Xing/Info (+LAME) or VBRI header frame; null if the frame is audio. */
function readInfoFrame(b: Uint8Array, i: number, h: FrameHeader): { delay: number | null; padding: number | null } | null {
  const x = i + 4 + h.sideInfo;
  const tag = ascii(b, x, 4);
  if (tag === 'Xing' || tag === 'Info') {
    const flags = (b[x + 4] << 24) | (b[x + 5] << 16) | (b[x + 6] << 8) | b[x + 7];
    let p = x + 8;
    if (flags & 1) p += 4;
    if (flags & 2) p += 4;
    if (flags & 4) p += 100;
    if (flags & 8) p += 4;
    // LAME extension (also written by ffmpeg as "Lavc..."): 9-byte encoder string, delay/padding at +21.
    if (p + 24 <= i + h.size && /^[A-Za-z][\x20-\x7e]{3}$/.test(ascii(b, p, 4))) {
      return { delay: (b[p + 21] << 4) | (b[p + 22] >> 4), padding: ((b[p + 22] & 0x0f) << 8) | b[p + 23] };
    }
    return { delay: null, padding: null };
  }
  if (ascii(b, i + 36, 4) === 'VBRI') {
    return { delay: (b[i + 42] << 8) | b[i + 43], padding: null };
  }
  return null;
}

function skipId3v2(b: Uint8Array): number {
  let i = 0;
  while (ascii(b, i, 3) === 'ID3' && i + 10 <= b.length) {
    const size = ((b[i + 6] & 0x7f) << 21) | ((b[i + 7] & 0x7f) << 14) | ((b[i + 8] & 0x7f) << 7) | (b[i + 9] & 0x7f);
    i += 10 + size + (b[i + 5] & 0x10 ? 10 : 0);
  }
  return i;
}

/** A frame start is trusted only if the next frame (or the end of the data) follows it. */
function isFrameAt(b: Uint8Array, i: number, ref?: FrameHeader): FrameHeader | null {
  const h = readHeader(b, i);
  if (!h || (ref && (h.sampleRate !== ref.sampleRate || h.mpeg1 !== ref.mpeg1))) return null;
  const next = i + h.size;
  if (next === b.length) return h;
  const n = readHeader(b, next);
  return n && n.sampleRate === h.sampleRate ? h : null;
}

export function indexMp3(b: Uint8Array): Mp3Index {
  let i = skipId3v2(b);
  let first: FrameHeader | null = null;
  while (i < b.length && !(first = isFrameAt(b, i))) i++;
  if (!first) throw new Error('No mp3 audio frames found');

  let encoderDelay: number | null = null;
  let encoderPadding: number | null = null;
  const info = readInfoFrame(b, i, first);
  if (info) {
    encoderDelay = info.delay;
    encoderPadding = info.padding;
    i += first.size;
  }

  const offsets: number[] = [];
  let end = i;
  while (i < b.length) {
    const h = readHeader(b, i);
    if (h && h.sampleRate === first.sampleRate && h.mpeg1 === first.mpeg1 && i + h.size <= b.length) {
      offsets.push(i);
      i += h.size;
      end = i;
    } else if (ascii(b, i, 3) === 'TAG' || ascii(b, i, 8) === 'APETAGEX') {
      break; // trailing tags
    } else {
      // lost sync: resume at the next trustworthy frame
      i++;
      while (i < b.length && !isFrameAt(b, i, first)) i++;
    }
  }
  if (offsets.length === 0) throw new Error('No mp3 audio frames found');

  const samples = offsets.length * first.samplesPerFrame - (encoderDelay ?? 0) - (encoderPadding ?? 0);
  return {
    sampleRate: first.sampleRate,
    channels: first.channels,
    samplesPerFrame: first.samplesPerFrame,
    frameOffsets: Uint32Array.from(offsets),
    dataEnd: end,
    encoderDelay,
    encoderPadding,
    durationSec: Math.max(0, samples) / first.sampleRate,
  };
}
