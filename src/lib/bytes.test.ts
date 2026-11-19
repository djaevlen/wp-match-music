import { formatBytes } from './bytes';

test('formats sizes for people', () => {
  expect(formatBytes(8 * 1024 * 1024)).toBe('8 MB');
  expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
  expect(formatBytes(300 * 1024)).toBe('300 KB');
  expect(formatBytes(10)).toBe('1 KB');
});
