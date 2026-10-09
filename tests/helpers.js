import { LANDMARK_COUNT } from '../assets/js/engine/geometry.js';
import { FormCoach } from '../assets/js/engine/coach.js';

/** A full set of visible landmarks at the origin, with overrides by index. */
export function points(overrides = {}) {
  const pts = Array.from({ length: LANDMARK_COUNT }, () => ({ x: 0, y: 0, z: 0, visibility: 0.99 }));
  for (const [index, p] of Object.entries(overrides)) {
    pts[Number(index)] = { z: 0, visibility: 0.99, ...p };
  }
  return pts;
}

/** Run a FormCoach over `durationMs` of frames from `poseAt(t)` and collect events. */
export function runSet(exercise, poseAt, { durationMs, fps = 30 } = {}) {
  const coach = new FormCoach(exercise);
  const events = [];
  const frameMs = 1000 / fps;
  let last = null;
  for (let t = 0; t <= durationMs; t += frameMs) {
    last = coach.update(poseAt(t), t);
    events.push(...last.events.map((e) => ({ ...e, t })));
  }
  return { coach, events, last };
}

/**
 * Minimal exercise whose measured angle is whatever the test puts in `input.value`,
 * for exercising the rep state machine without building poses.
 */
export function fakeExercise({ rest = 160, peak = 100, minRepMs = 0, checks = [] } = {}) {
  const input = { value: rest, metrics: {} };
  const exercise = {
    id: 'fake',
    name: 'Fake',
    rest,
    peak,
    minRepMs,
    partialCue: 'Go deeper',
    frameHint: 'Step into frame',
    measure: () => ({ value: input.value, arc: null, metrics: input.metrics }),
    checks,
  };
  return { exercise, input };
}

/** Any pose object the coach accepts; fakeExercise ignores its contents. */
export const ANY_POSE = Object.freeze({
  landmarks: Array.from({ length: LANDMARK_COUNT }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 })),
});

/** Drive a fake exercise through a list of [value, durationMs] segments, linearly. */
export function driveValues(coach, input, segments, { fps = 30, start = 0, metricsAt } = {}) {
  const frameMs = 1000 / fps;
  const events = [];
  let t = start;
  let from = segments[0][0];
  for (const [to, duration] of segments) {
    const steps = Math.max(1, Math.round(duration / frameMs));
    for (let i = 1; i <= steps; i += 1) {
      input.value = from + ((to - from) * i) / steps;
      if (metricsAt) input.metrics = metricsAt(t, input.value);
      t += frameMs;
      events.push(...coach.update(ANY_POSE, t).events);
    }
    from = to;
  }
  return { events, t };
}
