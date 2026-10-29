import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateBandwidth } from '../src/bandwidth.js';

test('bandwidth estimate applies overhead then headroom without changing measured rate', () => {
  const estimate = estimateBandwidth(10, 5, 20);
  assert.equal(estimate.base_mbps, 10);
  assert.equal(estimate.with_overhead_mbps, 10.5);
  assert.equal(estimate.estimate_mbps, 12.6);
  assert.equal(estimateBandwidth(10, 0, 0).estimate_mbps, 10);
  assert.equal(estimateBandwidth(0, 5, 20).estimate_mbps, 0);
});

test('unavailable rates and invalid percentages fail rather than produce misleading estimates', () => {
  for (const rate of [null, NaN, -1, Infinity]) {
    assert.throws(() => estimateBandwidth(rate), /No measured/);
  }
  for (const percent of [-1, 1001, NaN, Infinity]) {
    assert.throws(() => estimateBandwidth(1, percent, 20), /between/);
  }
});
