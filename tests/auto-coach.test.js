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

// ---------------------------------------------------------------------------
// Regressions from review and robustness testing.

/** Deterministic Gaussian noise, so jitter tests are repeatable. */
function noise(seed = 1) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return (a + 0.5) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

/** MediaPipe-like jitter: ~2 cm in the image plane, ~10 cm in depth, every frame. */
function jitter(pose, gauss, { xy = 0.02, z = 0.1 } = {}) {
  const shake = (p, k) => ({ ...p, x: p.x + gauss() * xy * k, y: p.y + gauss() * xy * k, z: p.z + gauss() * z * k });
  return { landmarks: pose.landmarks.map((p) => shake(p, 0.7)), worldLandmarks: pose.worldLandmarks.map((p) => shake(p, 1)) };
}

const lerpPoints = (a, b, k) => a.map((p, i) => ({
  x: p.x + (b[i].x - p.x) * k, y: p.y + (b[i].y - p.y) * k, z: p.z + (b[i].z - p.z) * k, visibility: p.visibility,
}));

test('half reps of the coached exercise are counted and cued', () => {
  const coach = new AutoCoach();
  run(reps('squat'), 2400 * 2, { coach });
  const shallow = (t) => exercisePose('squat', repDepth(((t - 4833) % 2400) / 2400) * 0.6);
  const { events } = run(shallow, 2400 * 3 - 100, { coach, start: 4833 });
  const partials = events.filter((e) => e.type === 'partial');
  assert.equal(partials.length, 3);
  assert.equal(partials[0].cue, 'Sit deeper. Hips down to knee level');
  assert.equal(coach.summary().sets[0].partialReps, 3);
});

test('one borderline rep does not split a set', () => {
  // Stance wobbles either side of where squat turns into lunge (~0.43 of the way).
  const blends = [0.38, 0.45, 0.4, 0.44, 0.39, 0.45, 0.41, 0.44];
  const pose = (t) => {
    const k = blends[Math.min(blends.length - 1, Math.floor(t / 2400))];
    const d = repDepth((t % 2400) / 2400);
    const s = exercisePose('squat', d);
    const l = exercisePose('lunge', d, { yaw: -0.38 });
    return { landmarks: lerpPoints(s.landmarks, l.landmarks, k), worldLandmarks: lerpPoints(s.worldLandmarks, l.worldLandmarks, k) };
  };
  const { coach, events } = run(pose, 2400 * blends.length - 50);
  assert.equal(events.filter((e) => e.type === 'exercise').length, 1);
  assert.deepEqual(coach.summary().sets.map((s) => [s.exerciseId, s.reps]), [['squat', 8]]);
});

test('raising the hands from curls into a press stance is not called a curl fault', () => {
  const program = [
    { exercise: 'curl', repMs: 2200, faults: [null, null, null] },
    { exercise: 'press', repMs: 2400, faults: [null, null, null] },
  ];
  const { coach, events } = run((t) => programFrame(t, program).pose, programDuration(program) - 50);
  assert.deepEqual(events.filter((e) => e.type === 'fault').map((e) => e.check.id), []);
  assert.deepEqual(coach.summary().sets.map((s) => [s.exerciseId, s.reps]), [['curl', 3], ['press', 3]]);
});

test('the rest timer never closes a set in the middle of a rep', () => {
  const coach = new AutoCoach();
  run(reps('curl'), 2400 * 2, { coach });
  // Stand still for almost the whole break, then do one slow 4 s rep across the deadline.
  const lastRep = 2400 * 2;
  run(() => exercisePose('curl', 0), SET_BREAK_MS - 2500, { coach, start: lastRep + 33 });
  const start = lastRep + SET_BREAK_MS - 2400;
  const slow = run((t) => exercisePose('curl', repDepth((t - start) / 4000)), 4000, { coach, start });
  assert.equal(slow.events.filter((e) => e.type === 'set').length, 0);
  assert.equal(slow.events.find((e) => e.type === 'rep').count, 3);
});

test('a long pause at the top of a rep still counts', () => {
  const coach = new AutoCoach();
  run(reps('press'), 2400 * 2, { coach });
  // Lock out and hold for 10 s before lowering.
  const start = 2400 * 2 + 33;
  const hold = (t) => {
    const local = t - start;
    const depth = local < 900 ? repDepth(local / 2400) : local < 10900 ? 1 : repDepth(0.6 + (local - 10900) / 2400);
    return exercisePose('press', depth);
  };
  const { events } = run(hold, 12000, { coach, start });
  assert.equal(events.filter((e) => e.type === 'rep').length, 1);
});

test('pose jitter does not stop curls and presses from counting', () => {
  for (const exercise of ['curl', 'press']) {
    const gauss = noise(7);
    const { coach, events } = run((t) => jitter(reps(exercise)(t), gauss), 2400 * 8 - 50);
    const counted = events.filter((e) => e.type === 'rep').map((e) => e.exerciseId);
    assert.ok(counted.length >= 6, `${exercise}: ${counted.length}/8`);
    assert.ok(counted.every((id) => id === exercise), `${exercise}: ${counted}`);
    assert.equal(coach.summary().sets.length, 1, exercise);
  }
});

test('standing still with jitter names no exercise and gives no cues', () => {
  const gauss = noise(3);
  const { events } = run(() => jitter(exercisePose('squat', 0), gauss), 15000);
  assert.deepEqual(events.map((e) => e.type), []);
});

/** Like reps(), with a start offset, a range scale (0–1) and extra pose options. */
const repsFrom = (exercise, { repMs = 2400, offset = 0, scale = 1, faults = [], ...opts } = {}) => (t) => exercisePose(
  exercise,
  repDepth(((t - offset) % repMs) / repMs) * scale,
  { fault: faults[Math.floor((t - offset) / repMs)] ?? null, ...opts },
);

test('sitting down between sets closes the set instead of counting a 45-second rep', () => {
  const coach = new AutoCoach();
  run(reps('squat'), 2400 * 3 - 30, { coach });
  let start = 2400 * 3;
  // Sit on a bench (knees bent like the bottom of a squat), rest, then stand up.
  run((t) => exercisePose('squat', 0.9 * Math.min(1, (t - start) / 1200)), 1200, { coach, start });
  start += 1233;
  const seated = run(() => exercisePose('squat', 0.9), 45000, { coach, start });
  assert.deepEqual(seated.events.map((e) => `${e.type}:${e.reason ?? ''}`), ['set:rest']);
  start += 45033;
  const standing = run((t) => exercisePose('squat', 0.9 * (1 - Math.min(1, (t - start) / 1200))), 1500, { coach, start });
  assert.deepEqual(standing.events.filter((e) => e.type === 'rep'), []);
  start += 1533;
  run(repsFrom('squat', { offset: start }), 2400 * 3 - 30, { coach, start });
  const { sets } = coach.summary();
  assert.deepEqual(sets.map((s) => s.reps), [3, 3]);
  assert.ok(sets.every((s) => s.avgRepMs < 5000), 'no rest time counted as a rep');
});

test('brisk reps are counted and told to slow down, not ignored', () => {
  for (const exercise of ['squat', 'curl', 'press']) {
    const { events } = run(reps(exercise, { repMs: 1000 }), 6000 - 30);
    const counted = events.filter((e) => e.type === 'rep');
    assert.ok(counted.length >= 5, `${exercise}: ${counted.length}/6 counted`);
    assert.ok(counted.every((e) => e.exerciseId === exercise), exercise);
    assert.ok(events.some((e) => e.type === 'fault' && e.check.id === 'too_fast'), `${exercise}: tempo cue`);
  }
});

test('faults called out during half reps are kept in the set record', () => {
  const coach = new AutoCoach();
  run(reps('curl'), 2400 * 2 - 30, { coach });
  const start = 2400 * 2;
  const { events } = run(repsFrom('curl', {
    offset: start, scale: 0.75, faults: ['elbowDrift', 'elbowDrift', 'elbowDrift'],
  }), 2400 * 3 - 30, { coach, start });
  const spoken = events.filter((e) => e.type === 'fault').length;
  assert.ok(spoken > 0);
  assert.equal(events.filter((e) => e.type === 'partial').length, 3);
  const [set] = coach.summary().sets;
  assert.deepEqual(set.faults.map((f) => [f.id, f.count]), [['elbow_drift', spoken]]);
});

test('side-on lunges are lunges even when the far hip is hidden', () => {
  const base = (t) => exercisePose('lunge', repDepth((t % 2400) / 2400), { yaw: -Math.PI / 2 });
  const hideFarHip = (pose) => {
    pose.landmarks[24].visibility = 0.3;
    pose.worldLandmarks[24].visibility = 0.3;
    return pose;
  };
  const { coach } = run((t) => hideFarHip(base(t)), 2400 * 3 - 30);
  assert.deepEqual(coach.summary().sets.map((s) => `${s.exerciseId}x${s.reps}`), ['lungex3']);
});

test('average rep time is the time per rep the athlete actually took', () => {
  const { coach } = run(reps('squat', { repMs: 3000 }), 3000 * 4 - 30);
  const [set] = coach.summary().sets;
  assert.equal(set.reps, 4);
  assert.ok(Math.abs(set.avgRepMs - 3000) < 100, `set avgRepMs ${set.avgRepMs}`);
  assert.ok(Math.abs(coach.summary().avgRepMs - 3000) < 100, `workout avgRepMs ${coach.summary().avgRepMs}`);
});
