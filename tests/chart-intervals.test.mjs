import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clockTime,
  intervalAtTime,
  intervalBounds,
  intervalPath,
  timeAxis,
} from '../src/chart-intervals.js';

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

const labels = (start, end) => timeAxis(start, end).map((tick) => tick.label);

test('time axis labels fall on round times inside the chart', () => {
  assert.deepEqual(labels(-0.08, 3.12), ['0s', '1s', '2s', '3s']);
  assert.deepEqual(labels(1.4, 4.6), ['2s', '3s', '4s']);
  assert.deepEqual(labels(-0.5, 0.5), ['-0.4s', '-0.2s', '0.0s', '0.2s', '0.4s']);
});

test('long time axes use minutes and hours', () => {
  assert.deepEqual(labels(0, 201), ['0:00', '1:00', '2:00', '3:00']);
  assert.deepEqual(labels(0, 5431.7), ['0:00:00', '0:30:00', '1:00:00', '1:30:00']);
  assert.deepEqual(labels(5040, 5043), ['1:24:00', '1:24:01', '1:24:02', '1:24:03']);
});

test('a span too short for round labels shows its exact ends', () => {
  assert.deepEqual(labels(0, 0.004), ['0.000s', '0.004s']);
});

test('clock times round before splitting into minutes and seconds', () => {
  assert.equal(clockTime(59.96, 1), '1:00.0');
  assert.equal(clockTime(-75), '-1:15');
  assert.equal(clockTime(3725, 0, true), '1:02:05');
});
