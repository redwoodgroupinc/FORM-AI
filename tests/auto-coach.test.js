import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AutoCoach, SET_BREAK_MS, HINTS } from '../assets/js/engine/auto-coach.js';
import {
  exercisePose, repDepth, programFrame, programDuration, DEMO_PROGRAM, HERO_PROGRAM,
} from '../assets/js/demo/synthetic.js';

/** Feed `poseAt(t)` for `durationMs` into an AutoCoach; returns the coach and all events. */
function run(poseAt, durationMs, { coach = new AutoCoach(), start = 0, fps = 30 } = {}) {
  const events = [];
  let last = null;
  for (let t = start; t <= start + durationMs; t += 1000 / fps) {
    last = coach.update(poseAt(t), t);
    events.push(...last.events.map((e) => ({ ...e, t })));
  }
  return { coach, events, last };
}

const reps = (exercise, { repMs = 2400, faults = [] } = {}) => (t) => exercisePose(
  exercise,
  repDepth((t % repMs) / repMs),
  { fault: faults[Math.floor(t / repMs)] ?? null },
);

test('recognises the exercise from the first rep and counts it', () => {
  const { coach, events } = run(reps('squat'), 2400 * 3);
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'exercise');
  assert.equal(events[0].exerciseId, 'squat');
  assert.deepEqual(events.filter((e) => e.type === 'rep').map((e) => e.count), [1, 2, 3]);
  assert.equal(coach.exercise.id, 'squat');
  // The first rep is counted on the same frame the exercise is recognised.
  assert.equal(events[1].type, 'rep');
  assert.equal(events[1].t, events[0].t);
});

test('waits for the first rep before naming an exercise', () => {
  const coach = new AutoCoach();
  const frame = coach.update(exercisePose('squat', 0), 0);
  assert.equal(frame.status, 'detecting');
  assert.equal(frame.hint, HINTS.detecting);
  assert.equal(frame.exerciseId, null);
  assert.equal(coach.update(null, 33).status, 'no_pose');
});

test('only the performed exercise is counted, never its look-alikes', () => {
  for (const exercise of ['squat', 'lunge', 'curl', 'press', 'pushup']) {
    const { coach, events } = run(reps(exercise), 2400 * 3);
    const counted = new Set(events.filter((e) => e.type === 'rep').map((e) => e.exerciseId));
    assert.deepEqual([...counted], [exercise], exercise);
    assert.equal(coach.summary().reps, 3, exercise);
  }
});

test('switching exercise closes the set and starts a new one', () => {
  const { coach, events } = run((t) => programFrame(t, DEMO_PROGRAM).pose, programDuration(DEMO_PROGRAM) - 50);
  const order = events.filter((e) => e.type === 'exercise').map((e) => e.exerciseId);
  assert.deepEqual(order, DEMO_PROGRAM.map((s) => s.exercise));

  const closed = events.filter((e) => e.type === 'set');
  assert.equal(closed.length, DEMO_PROGRAM.length - 1);
  assert.ok(closed.every((e) => e.reason === 'switch'));

  const summary = coach.summary();
  assert.deepEqual(summary.sets.map((s) => [s.exerciseId, s.reps]), DEMO_PROGRAM.map((s) => [s.exercise, 3]));
  assert.equal(summary.reps, 15);
});

test('each demo fault is called out once, for the right exercise', () => {
  const { events } = run((t) => programFrame(t, DEMO_PROGRAM).pose, programDuration(DEMO_PROGRAM) - 50);
  const faults = events.filter((e) => e.type === 'fault').map((e) => `${e.exerciseId}:${e.check.id}`);
  assert.deepEqual(faults, [
    'squat:knees_in', 'lunge:lean_forward', 'press:back_arch', 'curl:elbow_drift', 'pushup:hips_sag',
  ]);
});

test('the hero program is recognised the same way', () => {
  const { coach } = run((t) => programFrame(t, HERO_PROGRAM).pose, programDuration(HERO_PROGRAM) - 50);
  assert.deepEqual(
    coach.summary().sets.map((s) => [s.exerciseId, s.reps]),
    HERO_PROGRAM.map((s) => [s.exercise, s.faults.length]),
  );
});

test('a fault on the first rep is still called, once the rep is recognised', () => {
  const { events } = run(reps('squat', { faults: ['kneesIn'] }), 2400);
  const fault = events.find((e) => e.type === 'fault');
  assert.equal(fault.check.id, 'knees_in');
  assert.equal(fault.afterRep, true);
  const rep = events.find((e) => e.type === 'rep');
  assert.deepEqual(rep.rep.faults, ['knees_in']);
});

test('mid-set faults are called during the rep, not after it', () => {
  const { events } = run(reps('squat', { faults: [null, 'kneesIn'] }), 2400 * 2);
  const fault = events.find((e) => e.type === 'fault');
  const secondRep = events.filter((e) => e.type === 'rep')[1];
  assert.ok(!fault.afterRep);
  assert.ok(fault.t < secondRep.t);
  assert.equal(events.filter((e) => e.type === 'fault').length, 1);
});

test('a long rest closes the set; the next rep starts a fresh count', () => {
  const coach = new AutoCoach();
  run(reps('curl'), 2400 * 2, { coach });
  const rest = run(() => exercisePose('curl', 0), SET_BREAK_MS + 1000, { coach, start: 2400 * 2 + 33 });
  const closed = rest.events.find((e) => e.type === 'set');
  assert.equal(closed.reason, 'rest');
  assert.equal(closed.set.reps, 2);

  const start = 2400 * 2 + SET_BREAK_MS + 1100;
  const next = run((t) => reps('curl')(t - start), 2400, { coach, start });
  assert.equal(next.events.find((e) => e.type === 'rep').count, 1);
  // Same exercise after a rest: no new "exercise" announcement.
  assert.equal(next.events.filter((e) => e.type === 'exercise').length, 0);
  assert.deepEqual(coach.summary().sets.map((s) => s.reps), [2, 1]);
});

test('finish closes the open set', () => {
  const { coach } = run(reps('press'), 2400 * 2);
  const events = coach.finish();
  assert.equal(events.length, 1);
  assert.equal(events[0].set.exerciseId, 'press');
  assert.equal(events[0].reason, 'finish');
  assert.deepEqual(coach.finish(), []);
  assert.equal(coach.summary().sets.length, 1);
});

test('standing up between push-up sets is idle, not a framing problem', () => {
  const coach = new AutoCoach();
  run(reps('pushup'), 2400 * 2, { coach });
  const frame = coach.update(exercisePose('curl', 0), 2400 * 2 + 100);
  assert.equal(frame.exerciseId, 'pushup');
  assert.equal(frame.status, 'idle');
});

test('snapshot reports the live set for the HUD', () => {
  const { last } = run(reps('lunge', { faults: [null, 'leanForward'] }), 2400 * 2);
  assert.equal(last.exerciseId, 'lunge');
  assert.equal(last.reps, 2);
  assert.equal(last.cleanReps, 1);
  assert.equal(last.formScore, 85);
  assert.deepEqual(last.faultCounts, { lean_forward: 1 });
});
