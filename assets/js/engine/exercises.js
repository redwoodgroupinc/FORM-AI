// Exercise definitions: how to measure each movement and which form faults to watch for.
//
// Each exercise tracks one primary joint angle. `rest` is the angle in the starting
// position and `peak` is the angle the rep has to reach to count. The coach converts the
// angle into 0–1 progress between the two, so the same state machine works whether the
// angle shrinks (squat, curl) or grows (overhead press) during the rep.
//
// `measure(points)` returns null when the required joints are not visible, otherwise
// { value, arc: [a, b, c], metrics, ready?, hint? }. Form checks read from `metrics`.
// Check phases: 'active' = anywhere inside a rep, 'peak' = near the target position.

import {
  LM, SIDES, jointAngle, angleFromVertical, midpoint, distance, isVisible,
  visibility, offsetBelowLine,
} from './geometry.js';

const LEG = (s) => [s.hip, s.knee, s.ankle];
const ARM = (s) => [s.shoulder, s.elbow, s.wrist];

function visibleSides(points, pick) {
  return ['left', 'right'].filter((side) => isVisible(points, pick(SIDES[side])));
}

function sideScore(points, indices) {
  return indices.reduce((sum, i) => sum + visibility(points[i]), 0);
}

function torsoLean(points) {
  if (!isVisible(points, [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_HIP, LM.RIGHT_HIP], 0.4)) {
    // Fall back to whichever side is visible.
    for (const side of ['left', 'right']) {
      const s = SIDES[side];
      if (isVisible(points, [s.shoulder, s.hip])) {
        return angleFromVertical(points[s.shoulder], points[s.hip]);
      }
    }
    return null;
  }
  const shoulders = midpoint(points[LM.LEFT_SHOULDER], points[LM.RIGHT_SHOULDER]);
  const hips = midpoint(points[LM.LEFT_HIP], points[LM.RIGHT_HIP]);
  return angleFromVertical(shoulders, hips);
}

/**
 * Torso lean measured against the athlete's own straight legs (ankles to hips) instead of
 * the camera's vertical, so a phone that is tilted or propped up at an angle doesn't read
 * as leaning. For standing exercises with straight legs (curl, press).
 * `state` (one per coach) averages the leg direction over time: the ankles' depth is noisy,
 * but the legs' true direction barely changes during a set.
 */
function standingLean(points, state) {
  const ankles = [LM.LEFT_ANKLE, LM.RIGHT_ANKLE].filter((i) => isVisible(points, [i]));
  const hipsIdx = [LM.LEFT_HIP, LM.RIGHT_HIP].filter((i) => isVisible(points, [i]));
  const shouldersIdx = [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER].filter((i) => isVisible(points, [i]));
  if (!ankles.length || !hipsIdx.length || !shouldersIdx.length) return torsoLean(points);
  const mean = (idx) => idx.map((i) => points[i]).reduce((m, p, _, a) => ({
    x: m.x + p.x / a.length, y: m.y + p.y / a.length, z: m.z + (p.z ?? 0) / a.length,
  }), { x: 0, y: 0, z: 0 });
  const ankle = mean(ankles);
  const hip = mean(hipsIdx);
  const shoulder = mean(shouldersIdx);
  let up = unit({ x: hip.x - ankle.x, y: hip.y - ankle.y, z: hip.z - ankle.z });
  // Lying or crouching (e.g. push-ups before a set of curls): the legs are no reference.
  if (!up || -up.y < Math.cos(MAX_CAMERA_TILT)) return torsoLean(points);
  if (state) {
    if (state.legUp) {
      up = unit({
        x: state.legUp.x + (up.x - state.legUp.x) * LEG_SMOOTHING,
        y: state.legUp.y + (up.y - state.legUp.y) * LEG_SMOOTHING,
        z: state.legUp.z + (up.z - state.legUp.z) * LEG_SMOOTHING,
      }) ?? up;
    }
    state.legUp = up;
  }
  return jointAngle(shoulder, hip, { x: hip.x + up.x, y: hip.y + up.y, z: hip.z + up.z });
}

/** Per-frame weight of the newest leg direction in standingLean (about 1 s at 30 fps). */
const LEG_SMOOTHING = 0.05;
/** Phones tilted further than this from upright are not corrected for (35°). */
const MAX_CAMERA_TILT = (35 * Math.PI) / 180;

function unit(v) {
  const len = Math.hypot(v.x, v.y, v.z);
  return len > 1e-6 ? { x: v.x / len, y: v.y / len, z: v.z / len } : null;
}

/** Shared check appended to every rep that finishes faster than `minRepMs`. */
export const TEMPO_CHECK = Object.freeze({
  id: 'too_fast',
  label: 'Rushing reps',
  cue: 'Slow down. Control every rep',
  joints: [],
});

const squat = {
  id: 'squat',
  name: 'Squat',
  plural: 'Squats',
  tagline: 'Depth, knee tracking and chest position',
  camera: 'Prop your phone at hip height, 2–3 m away. Stand at a slight angle so both knees are visible.',
  frameHint: 'Step back so your hips, knees and ankles are in frame',
  primaryLabel: 'Knee angle',
  rest: 160,
  peak: 100,
  minRepMs: 1000,
  partialCue: 'Sit deeper. Hips down to knee level',
  measure(points) {
    const sides = visibleSides(points, LEG);
    if (sides.length === 0) return null;

    const angles = sides.map((side) => jointAngle(...LEG(SIDES[side]).map((i) => points[i])));
    const value = angles.reduce((a, b) => a + b, 0) / angles.length;
    const arcSide = sides.length === 2
      ? (sideScore(points, LEG(SIDES.left)) >= sideScore(points, LEG(SIDES.right)) ? 'left' : 'right')
      : sides[0];

    let kneeRatio = null;
    if (sides.length === 2) {
      const ankleSep = Math.abs(points[LM.LEFT_ANKLE].x - points[LM.RIGHT_ANKLE].x);
      const kneeSep = Math.abs(points[LM.LEFT_KNEE].x - points[LM.RIGHT_KNEE].x);
      const legLength = distance(points[LM.LEFT_HIP], points[LM.LEFT_ANKLE]);
      // Only judge knee tracking when the user faces the camera enough to see the gap.
      if (legLength > 0 && ankleSep / legLength > 0.2) kneeRatio = kneeSep / ankleSep;
    }

    return {
      value,
      arc: LEG(SIDES[arcSide]),
      metrics: { kneeAngle: value, kneeRatio, torsoLean: torsoLean(points) },
    };
  },
  checks: [
    {
      id: 'knees_in',
      label: 'Knees caving in',
      cue: 'Push your knees out',
      phase: 'peak',
      joints: [LM.LEFT_KNEE, LM.RIGHT_KNEE],
      test: (m) => m.kneeRatio !== null && m.kneeRatio < 0.8,
    },
    {
      id: 'chest_drop',
      label: 'Back rounding',
      cue: 'Chest up. Keep your back flat',
      phase: 'peak',
      joints: [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_HIP, LM.RIGHT_HIP],
      test: (m) => m.torsoLean !== null && m.torsoLean > 55,
    },
  ],
};

const pushup = {
  id: 'pushup',
  name: 'Push-up',
  plural: 'Push-ups',
  tagline: 'Body line, depth and hip position',
  camera: 'Place your phone on the floor 1.5–2 m to your side so your whole body is visible side-on.',
  frameHint: 'Turn side-on so your shoulder, hip and ankle are in frame',
  primaryLabel: 'Elbow angle',
  rest: 155,
  peak: 90,
  minRepMs: 800,
  partialCue: 'Lower your chest closer to the floor',
  measure(points) {
    const candidates = ['left', 'right'].filter((side) => {
      const s = SIDES[side];
      return isVisible(points, [s.shoulder, s.elbow, s.wrist, s.hip], 0.5)
        && (isVisible(points, [s.ankle], 0.3) || isVisible(points, [s.knee], 0.5));
    });
    if (candidates.length === 0) return null;
    const side = candidates.length === 2
      ? (sideScore(points, ARM(SIDES.left)) >= sideScore(points, ARM(SIDES.right)) ? 'left' : 'right')
      : candidates[0];
    const s = SIDES[side];
    const shoulder = points[s.shoulder];
    const hip = points[s.hip];
    const foot = visibility(points[s.ankle]) >= 0.3 ? points[s.ankle] : points[s.knee];

    const torsoAngle = angleFromVertical(shoulder, hip);
    if (torsoAngle < 50) {
      return {
        value: jointAngle(...ARM(s).map((i) => points[i])),
        arc: ARM(s),
        metrics: {},
        ready: false,
        hint: 'Get into a plank, side-on to the camera',
      };
    }

    const bodyLength = distance(shoulder, foot) || 1;
    return {
      value: jointAngle(...ARM(s).map((i) => points[i])),
      arc: ARM(s),
      metrics: {
        bodyLine: jointAngle(shoulder, hip, foot),
        hipOffset: offsetBelowLine(hip, shoulder, foot) / bodyLength,
      },
    };
  },
  checks: [
    {
      id: 'hips_sag',
      label: 'Hips sagging',
      cue: "Squeeze your glutes. Don't let your hips sag",
      phase: 'active',
      joints: [LM.LEFT_HIP, LM.RIGHT_HIP],
      test: (m) => m.hipOffset > 0.07,
    },
    {
      id: 'hips_pike',
      label: 'Hips piking up',
      cue: 'Lower your hips into a straight line',
      phase: 'active',
      joints: [LM.LEFT_HIP, LM.RIGHT_HIP],
      test: (m) => m.hipOffset < -0.09,
    },
  ],
};

const curl = {
  id: 'curl',
  name: 'Bicep curl',
  plural: 'Bicep curls',
  tagline: 'Elbow position, swinging and range of motion',
  camera: 'Stand facing the camera or slightly side-on, 2 m away, with your upper body and hips in frame.',
  frameHint: 'Make sure your shoulders, elbows and wrists are in frame',
  primaryLabel: 'Elbow angle',
  rest: 150,
  peak: 60,
  minRepMs: 900,
  partialCue: 'Squeeze all the way to the top',
  measure(points, state) {
    const sides = visibleSides(points, ARM);
    if (sides.length === 0) return null;
    // The working arm is the one that is most bent, so alternating curls count per arm.
    const arms = sides.map((side) => {
      const s = SIDES[side];
      return {
        side,
        angle: jointAngle(...ARM(s).map((i) => points[i])),
        drift: angleFromVertical(points[s.shoulder], points[s.elbow]),
      };
    });
    const working = arms.reduce((a, b) => (b.angle < a.angle ? b : a));
    return {
      value: working.angle,
      arc: ARM(SIDES[working.side]),
      metrics: { elbowDrift: working.drift, torsoLean: standingLean(points, state) },
    };
  },
  checks: [
    {
      id: 'elbow_drift',
      label: 'Elbows drifting forward',
      cue: 'Pin your elbows to your sides',
      phase: 'active',
      joints: [LM.LEFT_ELBOW, LM.RIGHT_ELBOW],
      test: (m) => m.elbowDrift > 35,
    },
    {
      id: 'swing',
      label: 'Swinging the torso',
      cue: 'No swinging. Keep your torso still',
      phase: 'active',
      joints: [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_HIP, LM.RIGHT_HIP],
      test: (m) => m.torsoLean !== null && m.torsoLean > 15,
    },
  ],
};

const lunge = {
  id: 'lunge',
  name: 'Lunge',
  plural: 'Lunges',
  tagline: 'Depth, balance and upright torso',
  camera: 'Stand side-on to the camera, 2–3 m away, with room to step forward.',
  frameHint: 'Step back so both legs are in frame',
  primaryLabel: 'Front knee angle',
  rest: 160,
  peak: 105,
  minRepMs: 1000,
  partialCue: 'Drop your back knee closer to the floor',
  measure(points) {
    const sides = visibleSides(points, LEG);
    if (sides.length === 0) return null;
    const legs = sides.map((side) => ({
      side,
      angle: jointAngle(...LEG(SIDES[side]).map((i) => points[i])),
    }));
    const front = legs.reduce((a, b) => (b.angle < a.angle ? b : a));
    // Both knees bend in a lunge. Averaging them cancels pose jitter, whereas taking the
    // smaller angle is biased low by noise and can stop reps from returning to the top.
    const value = legs.reduce((sum, leg) => sum + leg.angle, 0) / legs.length;
    return {
      value,
      arc: LEG(SIDES[front.side]),
      metrics: { torsoLean: torsoLean(points) },
    };
  },
  checks: [
    {
      id: 'lean_forward',
      label: 'Leaning forward',
      cue: 'Stay tall. Chest up over your hips',
      phase: 'peak',
      joints: [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_HIP, LM.RIGHT_HIP],
      test: (m) => m.torsoLean !== null && m.torsoLean > 25,
    },
  ],
};

const press = {
  id: 'press',
  name: 'Overhead press',
  plural: 'Overhead presses',
  tagline: 'Lockout, symmetry and lower-back arch',
  camera: 'Stand facing the camera, 2 m away, with your hands and hips in frame.',
  frameHint: 'Step back so your hands are visible above your head',
  primaryLabel: 'Elbow angle',
  rest: 95,
  // A straight arm reads short of 180° under pose jitter (noise can only bend it), so
  // lockout is judged at 145°. A press that stops around 130° still gets the cue.
  peak: 145,
  minRepMs: 800,
  partialCue: 'Lock out fully overhead',
  measure(points, state) {
    const sides = visibleSides(points, ARM);
    if (sides.length === 0) return null;
    const arms = sides.map((side) => {
      const s = SIDES[side];
      const overhead = points[s.wrist].y < points[s.shoulder].y;
      const angle = jointAngle(...ARM(s).map((i) => points[i]));
      // Hands down by the sides also read as straight elbows, so treat them as rest.
      return { side, overhead, angle: overhead ? angle : press.rest };
    });
    // Single-arm and alternating presses: when only one arm is pushing up (the other hangs
    // or stays racked at the shoulder), judge that arm alone.
    const pushing = arms.filter((a) => a.overhead && a.angle > press.rest + 15);
    const counted = pushing.length === 1 ? pushing : arms;
    const value = counted.reduce((sum, a) => sum + a.angle, 0) / counted.length;
    const pressing = pushing[0] ?? arms.find((a) => a.overhead);

    let wristImbalance = null;
    if (pushing.length === 2) {
      const shoulderWidth = distance(points[LM.LEFT_SHOULDER], points[LM.RIGHT_SHOULDER]) || 1;
      wristImbalance = Math.abs(points[LM.LEFT_WRIST].y - points[LM.RIGHT_WRIST].y) / shoulderWidth;
    }
    return {
      value,
      arc: pressing ? ARM(SIDES[pressing.side]) : null,
      metrics: { torsoLean: standingLean(points, state), wristImbalance },
    };
  },
  checks: [
    {
      id: 'back_arch',
      label: 'Arching the lower back',
      cue: "Brace your core. Don't lean back",
      phase: 'active',
      joints: [LM.LEFT_HIP, LM.RIGHT_HIP, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER],
      test: (m) => m.torsoLean !== null && m.torsoLean > 12,
    },
    {
      id: 'uneven',
      label: 'Uneven press',
      cue: 'Press both arms evenly',
      phase: 'peak',
      joints: [LM.LEFT_WRIST, LM.RIGHT_WRIST],
      test: (m) => m.wristImbalance !== null && m.wristImbalance > 0.35,
    },
  ],
};

export const EXERCISES = Object.freeze({ squat, pushup, curl, lunge, press });
export const EXERCISE_ORDER = ['squat', 'pushup', 'lunge', 'curl', 'press'];
