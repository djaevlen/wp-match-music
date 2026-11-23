import { inQuickPlay, pickNext } from './quick-pick';

const seq = (...values: number[]) => () => values.shift() ?? 0;

test('draws from pool tracks not yet played, in pool order by the random number', () => {
  expect(pickNext([1, 2, 3], new Set(), null, () => 0)).toEqual({ id: 1, newRound: false });
  expect(pickNext([1, 2, 3], new Set(), null, () => 0.99)).toEqual({ id: 3, newRound: false });
  expect(pickNext([1, 2, 3], new Set([1, 3]), 3, () => 0.99)).toEqual({ id: 2, newRound: false });
});

test('played ids outside the pool are ignored', () => {
  expect(pickNext([1, 2], new Set([9]), 9, () => 0)).toEqual({ id: 1, newRound: false });
});

test('when all are played a new round starts without the last track', () => {
  expect(pickNext([1, 2, 3], new Set([1, 2, 3]), 3, () => 0.99)).toEqual({ id: 2, newRound: true });
  expect(pickNext([1, 2, 3], new Set([1, 2, 3]), 1, () => 0)).toEqual({ id: 2, newRound: true });
});

test('a pool of one is picked every time', () => {
  expect(pickNext([5], new Set([5]), 5, seq(0.5))).toEqual({ id: 5, newRound: true });
});

test('an empty pool gives nothing', () => {
  expect(pickNext([], new Set([1]), 1, () => 0)).toBeNull();
});

test('only an explicit false is out of quick play', () => {
  expect(inQuickPlay({ quick_play: true })).toBe(true);
  expect(inQuickPlay({})).toBe(true);
  expect(inQuickPlay({ quick_play: false })).toBe(false);
});
