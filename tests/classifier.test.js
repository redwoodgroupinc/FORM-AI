import { test } from 'node:test';
import assert from 'node:assert/strict';

import { frameFeatures, classifySpan, EXERCISE_IDS } from '../assets/js/engine/classifier.js';
import { pointsFromPose } from '../assets/js/engine/coach.js';
import { LM } from '../assets/js/engine/geometry.js';
import { exercisePose, repDepth, SYNTHETIC_FAULTS } from '../assets/js/demo/synthetic.js';

/** Features for one full rep cycle of `exercise`. */
function repFeatures(exercise, opts = {}, { repMs = 2400, fps = 30 } = {}) {
  const out = [];
  for (let t = 0; t < repMs; t += 1000 / fps) {
    out.push(frameFeatures(pointsFromPose(exercisePose(exercise, repDepth(t / repMs), opts))));
  }
  return out;
}

// Camera angles each exercise should be recognised from (radians of body yaw).
const VIEWS = {
  squat: [0, -0.38, -0.8, -1.3],
  lunge: [-0.6, -1.15, -1.5],
  curl: [0, -0.55, -1.2],
  press: [0, -0.3, -0.9],
  pushup: [Math.PI / 2 - 0.12, Math.PI / 2 + 0.3, -Math.PI / 2],
};

for (const exercise of EXERCISE_IDS) {
  test(`recognises ${exercise} from several angles, with and without form faults`, () => {
    for (const yaw of VIEWS[exercise]) {
      for (const fault of [null, ...SYNTHETIC_FAULTS[exercise]]) {
        const verdict = classifySpan(repFeatures(exercise, { yaw, fault }));
        assert.equal(verdict.exerciseId, exercise, `yaw ${yaw}, fault ${fault}: ${JSON.stringify(verdict.scores)}`);
        assert.ok(verdict.confidence >= 0.9);
      }
    }
  });
}

test('standing still is not an exercise', () => {
  const still = Array.from({ length: 60 }, () => frameFeatures(pointsFromPose(exercisePose('curl', 0))));
  assert.equal(classifySpan(still).exerciseId, null);
});

test('too few frames are not enough to decide', () => {
  assert.equal(classifySpan(repFeatures('squat').slice(0, 3)).exerciseId, null);
  assert.equal(classifySpan([]).exerciseId, null);
});

test('frames without a visible torso are ignored', () => {
  const pose = exercisePose('squat', 0.5);
  for (const i of [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER]) pose.worldLandmarks[i].visibility = 0.1;
  for (const i of [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER]) pose.landmarks[i].visibility = 0.1;
  assert.equal(frameFeatures(pointsFromPose(pose)), null);
});

test('stance features separate squat and lunge feet', () => {
  const squat = frameFeatures(pointsFromPose(exercisePose('squat', 1)));
  const lunge = frameFeatures(pointsFromPose(exercisePose('lunge', 1)));
  assert.ok(squat.stanceForeAft < 0.15, `squat fore-aft ${squat.stanceForeAft}`);
  assert.ok(lunge.stanceForeAft > 0.6, `lunge fore-aft ${lunge.stanceForeAft}`);
});

test('a deep squat with a rounded back is still standing, not a push-up', () => {
  const verdict = classifySpan(repFeatures('squat', { fault: 'chestDrop' }));
  assert.equal(verdict.exerciseId, 'squat');
  assert.equal(verdict.scores.pushup, 0);
});
