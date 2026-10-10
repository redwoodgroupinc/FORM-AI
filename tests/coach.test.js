import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FormCoach, pointsFromPose } from '../assets/js/engine/coach.js';
import { EXERCISES } from '../assets/js/engine/exercises.js';
import { LM } from '../assets/js/engine/geometry.js';
import { demoFrame, squatPose, repDepth } from '../assets/js/demo/synthetic.js';
import { runSet, fakeExercise, driveValues, ANY_POSE } from './helpers.js';

test('counts every rep of the demo squat set and flags the scripted faults', () => {
  const { coach, events } = runSet(EXERCISES.squat, (t) => demoFrame(t).pose, { durationMs: 2600 * 6 });

  assert.equal(coach.reps, 6);
  assert.equal(coach.partialReps, 0);
  const faults = events.filter((e) => e.type === 'fault').map((e) => e.check.id);
  assert.deepEqual(faults, ['knees_in', 'chest_drop']);

  const perRep = coach.repLog.map((r) => r.faults);
  assert.deepEqual(perRep, [[], [], ['knees_in'], [], ['chest_drop'], []]);
  assert.equal(coach.formScore(), Math.round((100 * 4 + 70 * 2) / 6));
});

test('rep counting survives a low frame rate', () => {
  const { coach } = runSet(EXERCISES.squat, (t) => demoFrame(t).pose, { durationMs: 2600 * 4, fps: 12 });
  assert.equal(coach.reps, 4);
});

test('a squat that stops short of depth is a partial rep, not a rep', () => {
  const shallow = (t) => squatPose(repDepth((t % 2600) / 2600) * 0.55);
  const { coach, events } = runSet(EXERCISES.squat, shallow, { durationMs: 2600 * 2 });

  assert.equal(coach.reps, 0);
  assert.equal(coach.partialReps, 2);
  const partial = events.find((e) => e.type === 'partial');
  assert.equal(partial.cue, EXERCISES.squat.partialCue);
});

test('rushed reps are counted but flagged for tempo', () => {
  const fast = (t) => demoFrame(t, { repMs: 800, pattern: [null] }).pose;
  const { coach, events } = runSet(EXERCISES.squat, fast, { durationMs: 800 * 3, fps: 60 });

  assert.ok(coach.reps >= 2, `expected reps, got ${coach.reps}`);
  assert.ok(coach.repLog.every((r) => r.faults.includes('too_fast')));
  assert.ok(coach.repLog.every((r) => r.score === 85));
  assert.ok(events.some((e) => e.type === 'fault' && e.check.id === 'too_fast'));
});

test('reports missing people and missing joints instead of counting', () => {
  const coach = new FormCoach(EXERCISES.squat);
  assert.equal(coach.update(null, 0).status, 'no_pose');

  const pose = squatPose(0);
  for (const i of [LM.LEFT_KNEE, LM.RIGHT_KNEE, LM.LEFT_ANKLE, LM.RIGHT_ANKLE]) {
    pose.landmarks[i].visibility = 0.1;
  }
  const frame = coach.update(pose, 33);
  assert.equal(frame.status, 'not_visible');
  assert.equal(frame.hint, EXERCISES.squat.frameHint);
  assert.equal(coach.reps, 0);
});

test('works for exercises whose angle grows during the rep', () => {
  const { exercise, input } = fakeExercise({ rest: 90, peak: 160 });
  const coach = new FormCoach(exercise);
  const { events } = driveValues(coach, input, [
    [90, 300], [165, 600], [165, 200], [90, 600], [90, 300],
  ]);
  assert.equal(events.filter((e) => e.type === 'rep').length, 1);
});

test('form faults must persist across frames before they are called', () => {
  const check = {
    id: 'bad', label: 'Bad', cue: 'Fix it', phase: 'active', joints: [], test: (m) => m.bad,
  };
  const { exercise, input } = fakeExercise({ checks: [check] });

  // One bad frame in the middle of a rep: ignored.
  const coachA = new FormCoach(exercise);
  let frame = 0;
  const blip = driveValues(coachA, input, [[160, 200], [90, 700], [160, 700], [160, 300]], {
    metricsAt: () => ({ bad: frame++ === 20 }),
  });
  assert.equal(blip.events.filter((e) => e.type === 'fault').length, 0);
  assert.equal(coachA.reps, 1);
  assert.deepEqual(coachA.repLog[0].faults, []);

  // A sustained fault: called once for the rep, not on every frame.
  const coachB = new FormCoach(exercise);
  const sustained = driveValues(coachB, input, [[160, 200], [90, 700], [160, 700], [160, 300]], {
    metricsAt: (t, value) => ({ bad: value < 140 }),
  });
  assert.equal(sustained.events.filter((e) => e.type === 'fault').length, 1);
  assert.deepEqual(coachB.repLog[0].faults, ['bad']);
  assert.equal(coachB.repLog[0].score, 70);
});

test('peak-phase checks ignore the top of the movement', () => {
  const check = {
    id: 'deep', label: 'Deep', cue: 'x', phase: 'peak', joints: [], test: () => true,
  };
  const { exercise, input } = fakeExercise({ checks: [check] });
  const coach = new FormCoach(exercise);
  // Never goes past 40% depth, so the peak-phase check never runs.
  const { events } = driveValues(coach, input, [[160, 200], [136, 600], [160, 600], [160, 200]]);
  assert.equal(events.filter((e) => e.type === 'fault').length, 0);
});

test('summary aggregates reps, faults and timing', () => {
  const { coach } = runSet(EXERCISES.squat, (t) => demoFrame(t).pose, { durationMs: 2600 * 5 });
  const summary = coach.summary();
  assert.equal(summary.exerciseId, 'squat');
  assert.equal(summary.reps, 5);
  assert.equal(summary.cleanReps, 3);
  assert.deepEqual(summary.faults.map((f) => f.id).sort(), ['chest_drop', 'knees_in']);
  assert.ok(summary.avgRepMs > 1000 && summary.avgRepMs < 2600);
  assert.ok(summary.durationMs > 2600 * 4);

  coach.reset();
  assert.equal(coach.summary().reps, 0);
  assert.equal(coach.formScore(), null);
});

test('falls back to normalized landmarks when world landmarks are missing', () => {
  // Side-on squat: the 2D projection shows the true knee angle.
  const aspect = 9 / 16;
  const { landmarks, worldLandmarks } = squatPose(0.8, { yaw: -Math.PI / 2, aspect });
  const fromWorld = EXERCISES.squat.measure(pointsFromPose({ landmarks, worldLandmarks })).value;
  const fromImage = EXERCISES.squat.measure(pointsFromPose({ landmarks }, aspect)).value;
  assert.ok(Math.abs(fromWorld - fromImage) < 2, `${fromWorld} vs ${fromImage}`);
});

test('a rep picked up mid-way after a tracking gap is not judged for tempo', () => {
  const { exercise, input } = fakeExercise({ minRepMs: 1000 });
  const coach = new FormCoach(exercise);
  driveValues(coach, input, [[160, 300]]);
  // Tracking drops while standing and comes back near the bottom of the next rep.
  const { events } = driveValues(coach, input, [[95, 33], [95, 200], [160, 400], [160, 300]], { start: 2000 });
  assert.equal(coach.reps, 1);
  assert.deepEqual(coach.repLog[0].faults, []);
  assert.equal(events.filter((e) => e.type === 'fault').length, 0);
});

test('a long tracking gap does not blend stale angles into new ones', () => {
  const { exercise, input } = fakeExercise();
  const coach = new FormCoach(exercise);
  input.value = 160;
  coach.update(ANY_POSE, 0);
  input.value = 95;
  const frame = coach.update(ANY_POSE, 5000);
  assert.equal(Math.round(frame.value), 95);
});

test('a corrupt landmark frame is skipped instead of breaking the count', () => {
  const coach = new FormCoach(EXERCISES.squat);
  const bad = squatPose(0);
  bad.worldLandmarks[LM.LEFT_KNEE] = { ...bad.worldLandmarks[LM.LEFT_KNEE], x: Number.NaN };
  bad.worldLandmarks[LM.RIGHT_KNEE] = { ...bad.worldLandmarks[LM.RIGHT_KNEE], x: Number.NaN };
  assert.equal(coach.update(bad, 0).status, 'not_visible');
  for (let t = 33; t <= 2600 * 3; t += 33) coach.update(squatPose(repDepth((t % 2600) / 2600)), t);
  assert.equal(coach.reps, 3);
});

test('a rep seen at full depth in its first moving frame is a rep, not a partial', () => {
  // e.g. a slow device (or the camera pausing for speech) that skips the descent.
  const { exercise, input } = fakeExercise({ rest: 160, peak: 100 });
  const coach = new FormCoach(exercise);
  const { events } = driveValues(coach, input, [[160, 400], [90, 1], [160, 400], [160, 400]], { fps: 2.5 });
  assert.deepEqual(events.map((e) => e.type), ['rep']);
});
