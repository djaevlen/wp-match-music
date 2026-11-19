import { getAudioContext } from './context';

const DEFAULT_BUCKETS = 1200;

/**
 * The loudest sample (max |sample|) in each of `buckets` equal slices of the audio, across all
 * channels. Every sample falls in a bucket; with more buckets than samples, buckets repeat samples.
 */
export function computePeaks(channels: Float32Array[], buckets: number): Float32Array {
  const peaks = new Float32Array(buckets);
  const length = channels.length > 0 ? channels[0].length : 0;
  if (length === 0) return peaks;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * length) / buckets);
    const to = Math.max(from + 1, Math.floor(((b + 1) * length) / buckets));
    let peak = 0;
    for (const data of channels) {
      for (let i = from; i < to; i++) {
        const v = Math.abs(data[i]);
        if (v > peak) peak = v;
      }
    }
    peaks[b] = peak;
  }
  return peaks;
}

/**
 * Decodes the whole track once and reduces it to peaks for drawing. The decoded audio is large
 * (about 70 MB for three minutes of stereo), so nothing keeps it once the peaks are computed.
 */
export async function decodePeaks(
  blob: Blob,
  buckets = DEFAULT_BUCKETS,
): Promise<{ peaks: Float32Array; durationSec: number }> {
  const buffer = await getAudioContext().decodeAudioData(await blob.arrayBuffer());
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  return { peaks: computePeaks(channels, buckets), durationSec: buffer.duration };
}
