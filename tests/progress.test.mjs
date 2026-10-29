import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanProgress } from '../src/progress.js';
test('scan estimate handles offsets, reordering, and never reports completion early', () => {
  const update = scanProgress({ start: 10, duration: 20 });
  assert.equal(update(9, 1).percent, 0);
  assert.equal(update(20, 20).percent, 50);
  assert.equal(update(19, 21).percent, 50);
  assert.equal(update(35, 30).percent, 99);
  assert.equal(update(10, 31).percent, 99);
});
test('unknown timeline remains indeterminate with real packet counts', () => {
  for (const timeline of [
    {},
    { start: null, duration: 10 },
    { start: 0, duration: 0 },
    { start: 0, duration: Infinity },
  ]) {
    const result = scanProgress(timeline)(10, 1234);
    assert.equal(result.percent, null);
    assert.equal(result.packets, 1234);
  }
  const update = scanProgress({ start: -2, duration: 4 });
  assert.equal(update(NaN, 1).percent, null);
  assert.equal(update(0, 2).percent, 50);
});
