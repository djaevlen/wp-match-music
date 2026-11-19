import { computePeaks, decodePeaks } from './peaks';

const decodeAudioData = vi.fn();
vi.mock('./context', () => ({ getAudioContext: () => ({ decodeAudioData }) }));

test('the loudest sample of each bucket', () => {
  expect(Array.from(computePeaks([new Float32Array([0, 0.5, -1, 0.25])], 2))).toEqual([0.5, 1]);
});

test('the loudest sample across channels', () => {
  expect(
    Array.from(computePeaks([new Float32Array([0.1, 0.1]), new Float32Array([-0.9, 0.2])], 1)),
  ).toEqual([new Float32Array([0.9])[0]]);
});

test('buckets that do not divide the samples evenly still cover every sample', () => {
  const peaks = computePeaks([new Float32Array([0, 0, 0, 0, 0, 0, 0, 0.75])], 3);
  expect(peaks).toHaveLength(3);
  expect(peaks[2]).toBe(0.75);
});

test('more buckets than samples', () => {
  expect(Array.from(computePeaks([new Float32Array([0.5, -0.25])], 4))).toEqual([0.5, 0.5, 0.25, 0.25]);
});

test('no audio gives silent buckets', () => {
  expect(Array.from(computePeaks([], 2))).toEqual([0, 0]);
  expect(Array.from(computePeaks([new Float32Array(0)], 2))).toEqual([0, 0]);
});

test('decodes the blob once and returns its peaks and length', async () => {
  const left = new Float32Array([0, 0.5, -1, 0.25]);
  decodeAudioData.mockResolvedValueOnce({
    numberOfChannels: 1,
    duration: 4 / 44100,
    getChannelData: () => left,
  });
  const result = await decodePeaks(new Blob(['mp3']), 2);
  expect(decodeAudioData).toHaveBeenCalledTimes(1);
  expect(decodeAudioData.mock.calls[0][0]).toBeInstanceOf(ArrayBuffer);
  expect(Array.from(result.peaks)).toEqual([0.5, 1]);
  expect(result.durationSec).toBe(4 / 44100);
  expect(Object.keys(result).sort()).toEqual(['durationSec', 'peaks']);
});

test('defaults to 1200 buckets', async () => {
  decodeAudioData.mockResolvedValueOnce({
    numberOfChannels: 1,
    duration: 1,
    getChannelData: () => new Float32Array(2400),
  });
  expect((await decodePeaks(new Blob(['mp3']))).peaks).toHaveLength(1200);
});
