import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  jointAngle, angleFromVertical, midpoint, toIsotropic, offsetBelowLine, bestSide, LM,
} from '../assets/js/engine/geometry.js';
import { OneEuroFilter } from '../assets/js/engine/filters.js';
import { points } from './helpers.js';

const close = (actual, expected, tolerance = 1e-6) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} ≈ ${expected}`);
};

test('jointAngle measures interior angles in 2D and 3D', () => {
  close(jointAngle({ x: 0, y: -1 }, { x: 0, y: 0 }, { x: 1, y: 0 }), 90);
  close(jointAngle({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }), 180);
  close(jointAngle({ x: 1, y: 1, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }), 60);
  // Degenerate segments do not produce NaN.
  close(jointAngle({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }), 0);
});

test('angleFromVertical treats -y as up', () => {
  close(angleFromVertical({ x: 0, y: -1 }, { x: 0, y: 0 }), 0);
  close(angleFromVertical({ x: 1, y: 0 }, { x: 0, y: 0 }), 90);
  close(angleFromVertical({ x: 1, y: -1 }, { x: 0, y: 0 }), 45);
});

test('midpoint keeps the lower visibility', () => {
  const m = midpoint({ x: 0, y: 0, z: 0, visibility: 0.9 }, { x: 2, y: 4, z: 6, visibility: 0.3 });
  assert.deepEqual(m, { x: 1, y: 2, z: 3, visibility: 0.3 });
});

test('toIsotropic undoes aspect-ratio squashing of normalized landmarks', () => {
  // A 45° line in a 16:9 frame has normalized slope 16/9; isotropic space restores 45°.
  const aspect = 16 / 9;
  const [a, b] = toIsotropic([{ x: 0, y: 0 }, { x: 0.5625, y: 1 }], aspect);
  close(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
});

test('offsetBelowLine is positive when a point hangs below the line', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 2, y: 0 };
  close(offsetBelowLine({ x: 1, y: 0.3 }, a, b), 0.3);
  close(offsetBelowLine({ x: 1, y: -0.2 }, b, a), -0.2);
});

test('bestSide prefers the side the camera sees', () => {
  const pts = points({
    [LM.RIGHT_SHOULDER]: { x: 0, y: 0, visibility: 0.1 },
    [LM.RIGHT_HIP]: { x: 0, y: 0, visibility: 0.1 },
    [LM.RIGHT_KNEE]: { x: 0, y: 0, visibility: 0.1 },
  });
  assert.equal(bestSide(pts), 'left');
});

test('OneEuroFilter passes a constant through and damps jitter', () => {
  const filter = new OneEuroFilter();
  for (let t = 0; t < 1000; t += 33) close(filter.filter(120, t), 120);

  const jittery = new OneEuroFilter();
  let maxDeviation = 0;
  for (let i = 0, t = 0; i < 60; i += 1, t += 33) {
    const noisy = 120 + (i % 2 === 0 ? 4 : -4);
    const out = jittery.filter(noisy, t);
    if (i > 10) maxDeviation = Math.max(maxDeviation, Math.abs(out - 120));
  }
  assert.ok(maxDeviation < 3, `jitter not damped enough: ${maxDeviation}`);
});
