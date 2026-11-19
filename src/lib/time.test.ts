import { formatElapsed, formatMs, snapMs } from './time';

test('snapMs rounds to 100 and clamps', () => {
  expect(snapMs(42349, 200000)).toBe(42300);
  expect(snapMs(-50, 200000)).toBe(0);
  expect(snapMs(999999, 200000)).toBe(199900);
});

test('formatMs', () => {
  expect(formatMs(42300)).toBe('0:42.3');
  expect(formatMs(75000)).toBe('1:15.0');
  expect(formatMs(0)).toBe('0:00.0');
});

test('formatElapsed', () => {
  expect(formatElapsed(7.4)).toBe('0:07');
  expect(formatElapsed(65)).toBe('1:05');
});
