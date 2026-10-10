import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EXERCISES, EXERCISE_ORDER } from '../assets/js/engine/exercises.js';
import { LM, jointAngle } from '../assets/js/engine/geometry.js';
import { squatPose } from '../assets/js/demo/synthetic.js';
import { points } from './helpers.js';

const failing = (exercise, metrics) => exercise.checks.filter((c) => c.test(metrics)).map((c) => c.id);

test('every exercise is complete and its order list matches', () => {
  assert.deepEqual([...EXERCISE_ORDER].sort(), Object.keys(EXERCISES).sort());
  for (const ex of Object.values(EXERCISES)) {
    for (const key of ['id', 'name', 'plural', 'camera', 'frameHint', 'primaryLabel', 'partialCue']) {
      assert.equal(typeof ex[key], 'string', `${ex.id}.${key}`);
    }
    assert.notEqual(ex.rest, ex.peak);
    assert.ok(ex.minRepMs > 0);
    for (const check of ex.checks) {
      assert.ok(['active', 'peak'].includes(check.phase), `${ex.id}.${check.id} phase`);
      assert.equal(typeof check.cue, 'string');
    }
  }
});

test('squat: knee angle, knees caving and chest drop', () => {
  const standing = EXERCISES.squat.measure(squatPose(0).worldLandmarks);
  assert.ok(standing.value > 165);

  const good = EXERCISES.squat.measure(squatPose(1).worldLandmarks);
  assert.ok(good.value < EXERCISES.squat.peak);
  assert.deepEqual(failing(EXERCISES.squat, good.metrics), []);

  const kneesIn = EXERCISES.squat.measure(squatPose(1, { kneesIn: 1 }).worldLandmarks);
  assert.deepEqual(failing(EXERCISES.squat, kneesIn.metrics), ['knees_in']);

  const rounded = EXERCISES.squat.measure(squatPose(1, { chestDrop: 1 }).worldLandmarks);
  assert.deepEqual(failing(EXERCISES.squat, rounded.metrics), ['chest_drop']);
});

test('squat: knee tracking is not judged from a side view', () => {
  const side = EXERCISES.squat.measure(squatPose(1, { kneesIn: 1, yaw: -Math.PI / 2 }).worldLandmarks);
  assert.equal(side.metrics.kneeRatio, null);
});

// Side-on plank, +y down: wrists under shoulders, feet on the floor.
function plank({ hipY = 0.3, elbowBend = false } = {}) {
  const left = {
    [LM.LEFT_SHOULDER]: { x: 0, y: 0 },
    [LM.LEFT_ELBOW]: elbowBend ? { x: 0.25, y: 0.25 } : { x: 0, y: 0.3 },
    [LM.LEFT_WRIST]: { x: 0, y: 0.6 },
    [LM.LEFT_HIP]: { x: 0.75, y: hipY },
    [LM.LEFT_KNEE]: { x: 1.1, y: 0.45 },
    [LM.LEFT_ANKLE]: { x: 1.5, y: 0.6 },
  };
  const hidden = { visibility: 0.05 };
  return points({
    ...left,
    [LM.RIGHT_SHOULDER]: { x: 0, y: 0, ...hidden },
    [LM.RIGHT_ELBOW]: { x: 0, y: 0.3, ...hidden },
    [LM.RIGHT_WRIST]: { x: 0, y: 0.6, ...hidden },
    [LM.RIGHT_HIP]: { x: 0.75, y: hipY, ...hidden },
    [LM.RIGHT_KNEE]: { x: 1.1, y: 0.45, ...hidden },
    [LM.RIGHT_ANKLE]: { x: 1.5, y: 0.6, ...hidden },
  });
}

test('push-up: straight body passes, sagging and piking hips are flagged', () => {
  const ex = EXERCISES.pushup;
  const good = ex.measure(plank());
  assert.notEqual(good.ready, false);
  assert.ok(good.value > 170);
  assert.deepEqual(failing(ex, good.metrics), []);

  assert.deepEqual(failing(ex, ex.measure(plank({ hipY: 0.45 })).metrics), ['hips_sag']);
  assert.deepEqual(failing(ex, ex.measure(plank({ hipY: 0.1 })).metrics), ['hips_pike']);

  const bent = ex.measure(plank({ elbowBend: true }));
  assert.ok(bent.value < 100, `elbow angle ${bent.value}`);
});

test('push-up: standing up is not a plank', () => {
  const standing = EXERCISES.pushup.measure(squatPose(0, { yaw: -Math.PI / 2 }).worldLandmarks);
  assert.equal(standing.ready, false);
  assert.match(standing.hint, /plank/i);
});

function curlPose({ elbowX = 0, wristY = -0.05, wristX = -0.25, torsoX = 0 } = {}) {
  return points({
    [LM.LEFT_SHOULDER]: { x: torsoX, y: -0.5 },
    [LM.LEFT_ELBOW]: { x: elbowX, y: -0.2 },
    [LM.LEFT_WRIST]: { x: wristX, y: wristY },
    [LM.LEFT_HIP]: { x: 0, y: 0 },
    [LM.LEFT_ANKLE]: { x: 0, y: 0.85 },
    [LM.RIGHT_SHOULDER]: { x: torsoX, y: -0.5, visibility: 0.05 },
    [LM.RIGHT_ELBOW]: { x: elbowX, y: -0.2, visibility: 0.05 },
    [LM.RIGHT_WRIST]: { x: wristX, y: wristY, visibility: 0.05 },
    [LM.RIGHT_HIP]: { x: 0, y: 0, visibility: 0.05 },
    [LM.RIGHT_ANKLE]: { x: 0, y: 0.85, visibility: 0.05 },
  });
}

test('curl: elbow drift and torso swing', () => {
  const ex = EXERCISES.curl;
  const good = ex.measure(curlPose());
  assert.deepEqual(failing(ex, good.metrics), []);

  const drift = ex.measure(curlPose({ elbowX: -0.25 }));
  assert.ok(failing(ex, drift.metrics).includes('elbow_drift'));

  const swing = ex.measure(curlPose({ torsoX: 0.2 }));
  assert.ok(failing(ex, swing.metrics).includes('swing'));
});

test('curl: the most-bent arm is the working arm', () => {
  const pts = points({
    [LM.LEFT_SHOULDER]: { x: 0.2, y: -0.5 },
    [LM.LEFT_ELBOW]: { x: 0.2, y: -0.2 },
    [LM.LEFT_WRIST]: { x: 0.2, y: 0.1 },
    [LM.RIGHT_SHOULDER]: { x: -0.2, y: -0.5 },
    [LM.RIGHT_ELBOW]: { x: -0.2, y: -0.2 },
    [LM.RIGHT_WRIST]: { x: -0.2, y: -0.45, z: -0.1 },
  });
  const m = EXERCISES.curl.measure(pts);
  assert.ok(m.value < 60, `expected right arm angle, got ${m.value}`);
  assert.deepEqual(m.arc, [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST]);
});

function pressPose({ leftWristY = -0.95, rightWristY = -0.95, rightElbowY = -0.75, lean = 0 } = {}) {
  return points({
    [LM.LEFT_SHOULDER]: { x: 0.19 + lean, y: -0.5 },
    [LM.RIGHT_SHOULDER]: { x: -0.19 + lean, y: -0.5 },
    [LM.LEFT_ELBOW]: { x: 0.21 + lean, y: -0.75 },
    [LM.RIGHT_ELBOW]: { x: -0.21 + lean, y: rightElbowY },
    [LM.LEFT_WRIST]: { x: 0.22 + lean, y: leftWristY },
    [LM.RIGHT_WRIST]: { x: -0.22 + lean, y: rightWristY },
    [LM.LEFT_HIP]: { x: 0.1, y: 0 },
    [LM.RIGHT_HIP]: { x: -0.1, y: 0 },
    [LM.LEFT_ANKLE]: { x: 0.1, y: 0.85 },
    [LM.RIGHT_ANKLE]: { x: -0.1, y: 0.85 },
  });
}

/** Rotate a pose in the image plane, as a phone propped at an angle would see it. */
function tilt(pts, degrees) {
  const a = (degrees * Math.PI) / 180;
  return pts.map((p) => ({ ...p, x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) }));
}

test('press: lockout, uneven arms, back arch and arms-down handling', () => {
  const ex = EXERCISES.press;
  const lockout = ex.measure(pressPose());
  assert.ok(lockout.value > ex.peak);
  assert.deepEqual(failing(ex, lockout.metrics), []);

  // Both arms pressing, one well short of the other.
  assert.ok(failing(ex, ex.measure(pressPose({ rightElbowY: -0.62, rightWristY: -0.78 })).metrics).includes('uneven'));
  assert.ok(failing(ex, ex.measure(pressPose({ lean: -0.15 })).metrics).includes('back_arch'));

  // Arms hanging by the sides are straight too, but must read as rest, not lockout.
  const armsDown = ex.measure(points({
    [LM.LEFT_SHOULDER]: { x: 0.19, y: -0.5 },
    [LM.RIGHT_SHOULDER]: { x: -0.19, y: -0.5 },
    [LM.LEFT_ELBOW]: { x: 0.2, y: -0.2 },
    [LM.RIGHT_ELBOW]: { x: -0.2, y: -0.2 },
    [LM.LEFT_WRIST]: { x: 0.2, y: 0.05 },
    [LM.RIGHT_WRIST]: { x: -0.2, y: 0.05 },
  }));
  assert.equal(armsDown.value, ex.rest);
  assert.equal(armsDown.arc, null);
});

test('press and curl: a tilted phone is not mistaken for leaning', () => {
  for (const degrees of [-16, 16]) {
    const press = EXERCISES.press.measure(tilt(pressPose(), degrees));
    assert.deepEqual(failing(EXERCISES.press, press.metrics), [], `press tilted ${degrees}°`);
    const curl = EXERCISES.curl.measure(tilt(curlPose(), degrees));
    assert.deepEqual(failing(EXERCISES.curl, curl.metrics), [], `curl tilted ${degrees}°`);
  }
  // A real lean is still caught when the phone is tilted.
  const leaning = EXERCISES.press.measure(tilt(pressPose({ lean: -0.15 }), 10));
  assert.ok(failing(EXERCISES.press, leaning.metrics).includes('back_arch'));
});

test('press: a single-arm press counts and is not called uneven', () => {
  const ex = EXERCISES.press;
  const oneArm = ex.measure(points({
    [LM.LEFT_SHOULDER]: { x: 0.19, y: -0.5 },
    [LM.RIGHT_SHOULDER]: { x: -0.19, y: -0.5 },
    [LM.LEFT_ELBOW]: { x: 0.21, y: -0.75 },
    [LM.LEFT_WRIST]: { x: 0.22, y: -0.95 },
    [LM.RIGHT_ELBOW]: { x: -0.2, y: -0.2 },
    [LM.RIGHT_WRIST]: { x: -0.2, y: 0.05 },
    [LM.LEFT_HIP]: { x: 0.1, y: 0 },
    [LM.RIGHT_HIP]: { x: -0.1, y: 0 },
    [LM.LEFT_ANKLE]: { x: 0.1, y: 0.85 },
    [LM.RIGHT_ANKLE]: { x: -0.1, y: 0.85 },
  }));
  assert.ok(oneArm.value > ex.peak, `single-arm lockout read as ${oneArm.value}`);
  assert.deepEqual(failing(ex, oneArm.metrics), []);

  // The other dumbbell racked at the shoulder (wrist above it, elbow bent) is not pressing.
  const racked = ex.measure(pressPose({ rightElbowY: -0.3, rightWristY: -0.55 }));
  assert.ok(racked.value > ex.peak, `lockout with the other arm racked read as ${racked.value}`);
  assert.deepEqual(failing(ex, racked.metrics), []);
});

test('lunge: both knees drive the count, the front knee gets the angle, lean is flagged', () => {
  const ex = EXERCISES.lunge;
  const pts = points({
    [LM.LEFT_HIP]: { x: 0, y: 0 },
    [LM.LEFT_KNEE]: { x: -0.4, y: 0.05 },
    [LM.LEFT_ANKLE]: { x: -0.4, y: 0.45 },
    [LM.RIGHT_HIP]: { x: 0, y: 0 },
    [LM.RIGHT_KNEE]: { x: 0.1, y: 0.42 },
    [LM.RIGHT_ANKLE]: { x: 0.5, y: 0.44 },
    [LM.LEFT_SHOULDER]: { x: -0.3, y: -0.45 },
    [LM.RIGHT_SHOULDER]: { x: -0.3, y: -0.45 },
  });
  const m = ex.measure(pts);
  assert.deepEqual(m.arc, [LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE]);
  const front = jointAngle(pts[LM.LEFT_HIP], pts[LM.LEFT_KNEE], pts[LM.LEFT_ANKLE]);
  const back = jointAngle(pts[LM.RIGHT_HIP], pts[LM.RIGHT_KNEE], pts[LM.RIGHT_ANKLE]);
  assert.ok(Math.abs(m.value - (front + back) / 2) < 1e-9);
  assert.ok(m.value < ex.peak, `average knee angle ${m.value}`);
  assert.deepEqual(failing(ex, m.metrics), ['lean_forward']);
});
