import { moveId } from './reorder';

test('moves a track up to the place of another', () => {
  expect(moveId([1, 2, 3, 4], 4, 2)).toEqual([1, 4, 2, 3]);
});

test('moves a track down to the place of another', () => {
  expect(moveId([1, 2, 3], 1, 3)).toEqual([2, 3, 1]);
});

test('dropping on itself changes nothing', () => {
  expect(moveId([1, 2, 3], 2, 2)).toEqual([1, 2, 3]);
});

test('unknown ids change nothing and the input is not modified', () => {
  const ids = [1, 2, 3];
  expect(moveId(ids, 9, 2)).toEqual([1, 2, 3]);
  expect(moveId(ids, 1, 9)).toEqual([1, 2, 3]);
  moveId(ids, 3, 1);
  expect(ids).toEqual([1, 2, 3]);
});
