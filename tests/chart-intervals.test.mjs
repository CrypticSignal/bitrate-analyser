import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intervalAtTime, intervalBounds, intervalPath } from '../src/chart-intervals.js';
test('hover selects the containing interval rather than the nearest start', () => {
  const points = [
    { time: 53, duration: 1 },
    { time: 54, duration: 1 },
  ];
  assert.equal(intervalAtTime(points, 53.9), points[0]);
  assert.equal(intervalAtTime(points, 54), points[1]);
});
test('horizontal segments span intervals without vertical connectors or sampled gap bridges', () => {
  const points = [
    { time: 53, duration: 1, rate: 10 },
    { time: 54, duration: 1, rate: 5 },
    { time: 57, duration: 1, rate: 2 },
  ];
  assert.equal(
    intervalPath(
      points,
      'rate',
      { first_timestamp: 53, end_timestamp: 58 },
      (x) => x,
      (y) => y,
    ),
    'M53,10 H54 M54,5 H55 M57,2 H58',
  );
});
test('partial and variable-duration GOP intervals use their true bounds', () => {
  const timeline = { first_timestamp: -0.067, end_timestamp: 57.921 };
  assert.deepEqual(intervalBounds({ time: -1, duration: 1 }, timeline), { start: -0.067, end: 0 });
  assert.deepEqual(intervalBounds({ time: 57, duration: 1 }, timeline), { start: 57, end: 57.921 });
  assert.deepEqual(intervalBounds({ time: 3, duration: 2.5 }, timeline), { start: 3, end: 5.5 });
});
