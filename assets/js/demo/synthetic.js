// Procedural athlete: builds full 33-point poses for every supported exercise, with
// optional form faults. It powers the landing-page animation and the in-app demo, and
// gives the tests realistic input. The poses run through the same engine as live frames.
//
// Body frame: x = the person's left, y = down, z = behind them (they face -z, towards
// the camera when yaw = 0). The floor sits at y = FLOOR_Y; standing hips at y = 0.

import { LM, LANDMARK_COUNT } from '../engine/geometry.js';

const DEG = Math.PI / 180;
const SHIN = 0.44;
const THIGH = 0.44;
const TORSO = 0.52;
const UPPER_ARM = 0.29;
const FOREARM = 0.27;
const ANKLE_HALF = 0.16;
const HIP_HALF = 0.1;
const SHOULDER_HALF = 0.19;
const FLOOR_Y = SHIN + THIGH;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const v3 = (x, y, z) => ({ x, y, z });
const add = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const scale = (v, k) => v3(v.x * k, v.y * k, v.z * k);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (v) => Math.hypot(v.x, v.y, v.z);
const norm = (v) => scale(v, 1 / (len(v) || 1));
const lerp3 = (a, b, t) => v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
const mid = (a, b) => scale(add(a, b), 0.5);

const SIDES = [
  {
    sign: 1, ankle: LM.LEFT_ANKLE, knee: LM.LEFT_KNEE, hip: LM.LEFT_HIP, heel: LM.LEFT_HEEL,
    toe: LM.LEFT_FOOT_INDEX, shoulder: LM.LEFT_SHOULDER, elbow: LM.LEFT_ELBOW, wrist: LM.LEFT_WRIST,
    pinky: LM.LEFT_PINKY, index: LM.LEFT_INDEX, thumb: LM.LEFT_THUMB,
  },
  {
    sign: -1, ankle: LM.RIGHT_ANKLE, knee: LM.RIGHT_KNEE, hip: LM.RIGHT_HIP, heel: LM.RIGHT_HEEL,
    toe: LM.RIGHT_FOOT_INDEX, shoulder: LM.RIGHT_SHOULDER, elbow: LM.RIGHT_ELBOW, wrist: LM.RIGHT_WRIST,
    pinky: LM.RIGHT_PINKY, index: LM.RIGHT_INDEX, thumb: LM.RIGHT_THUMB,
  },
];
const [LEFT, RIGHT] = SIDES;

/** Two-bone IK: the middle joint for a limb from `root` to `end`, bending towards `pole`. */
function solveMiddle(root, end, l1, l2, pole) {
  const toEnd = sub(end, root);
  const dist = Math.min(len(toEnd), l1 + l2 - 1e-6);
  const dir = norm(toEnd);
  const perp = norm(sub(pole, scale(dir, dot(pole, dir))));
  const cosA = Math.max(-1, Math.min(1, (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist)));
  const a = Math.acos(cosA);
  return add(root, add(scale(dir, l1 * Math.cos(a)), scale(perp, l1 * Math.sin(a))));
}

function standingLegs(p, sway = 0) {
  for (const s of SIDES) {
    const ankle = v3(s.sign * 0.14 + sway, FLOOR_Y, 0);
    p[s.ankle] = ankle;
    p[s.knee] = v3(s.sign * 0.12 + sway, FLOOR_Y - SHIN, -0.01);
    p[s.hip] = v3(s.sign * HIP_HALF + sway, 0, 0);
    p[s.heel] = v3(ankle.x, FLOOR_Y + 0.05, 0.06);
    p[s.toe] = v3(s.sign * 0.17 + sway, FLOOR_Y + 0.06, -0.17);
  }
}

/** Torso from the hips, leaning forward (positive degrees) or back (negative). */
function torso(p, leanDeg) {
  const lean = leanDeg * DEG;
  const dir = v3(0, -Math.cos(lean), -Math.sin(lean));
  const neck = add(mid(p[LM.LEFT_HIP], p[LM.RIGHT_HIP]), scale(dir, TORSO));
  for (const s of SIDES) p[s.shoulder] = add(neck, v3(s.sign * SHOULDER_HALF, 0, 0));
  p[LM.NOSE] = add(add(neck, scale(dir, 0.2)), v3(0, 0, -0.09));
  return { neck, dir };
}

function hands(p) {
  for (const s of SIDES) {
    const dir = norm(sub(p[s.wrist], p[s.elbow]));
    const hand = add(p[s.wrist], scale(dir, 0.08));
    p[s.index] = hand;
    p[s.pinky] = add(hand, v3(s.sign * 0.02, 0, 0));
    p[s.thumb] = add(hand, v3(-s.sign * 0.02, -0.01, 0));
  }
}

const FACE = [
  [1, 0.02, -0.03, 0.02], [2, 0.035, -0.03, 0.02], [3, 0.05, -0.03, 0.025],
  [4, -0.02, -0.03, 0.02], [5, -0.035, -0.03, 0.02], [6, -0.05, -0.03, 0.025],
  [7, 0.075, -0.01, 0.09], [8, -0.075, -0.01, 0.09],
  [9, 0.025, 0.04, 0.01], [10, -0.025, 0.04, 0.01],
];

function face(p) {
  for (const [i, dx, dy, dz] of FACE) p[i] = add(p[LM.NOSE], v3(dx, dy, dz));
}

/**
 * Rotate the body-frame points to face the camera at `yaw` and express them as MediaPipe
 * world landmarks (metres, centred on the hips) and normalized image landmarks.
 */
function project(p, { yaw = 0, aspect = 9 / 16, frameScale = 0.4, floor = 0.9, shiftZ = 0 } = {}) {
  hands(p);
  face(p);
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const rotated = p.map((pt) => {
    const z = pt.z + shiftZ;
    return v3(pt.x * cos - z * sin, pt.y, pt.x * sin + z * cos);
  });
  const hips = mid(rotated[LM.LEFT_HIP], rotated[LM.RIGHT_HIP]);
  const worldLandmarks = rotated.map((pt) => ({
    x: pt.x - hips.x,
    y: pt.y - hips.y,
    z: pt.z - hips.z,
    visibility: 0.98,
  }));
  const landmarks = rotated.map((pt) => ({
    x: 0.5 + (pt.x * frameScale) / aspect,
    y: floor - (FLOOR_Y - pt.y) * frameScale,
    z: pt.z * frameScale,
    visibility: 0.98,
  }));
  return { landmarks, worldLandmarks };
}

/**
 * Squat. `depth` 0 = standing, 1 = bottom.
 * Faults: kneesIn (knees cave), chestDrop (rounded back / excessive lean).
 */
export function squatPose(depth, {
  kneesIn = 0, chestDrop = 0, yaw = -0.38, sway = 0, ...view
} = {}) {
  const d = clamp01(depth);
  const kneeAngle = 175 - 95 * d;
  const shinLean = 38 * d * DEG;
  const thighLean = (180 - kneeAngle) * DEG - shinLean;
  const p = new Array(LANDMARK_COUNT);

  for (const s of SIDES) {
    const ankle = v3(s.sign * ANKLE_HALF + sway, FLOOR_Y, 0);
    const kneeHalf = ANKLE_HALF + 0.03 * d - 0.13 * kneesIn * d;
    const knee = v3(
      s.sign * kneeHalf + sway,
      ankle.y - SHIN * Math.cos(shinLean),
      -SHIN * Math.sin(shinLean),
    );
    p[s.ankle] = ankle;
    p[s.knee] = knee;
    p[s.hip] = v3(s.sign * HIP_HALF + sway, knee.y - THIGH * Math.cos(thighLean), knee.z + THIGH * Math.sin(thighLean));
    p[s.heel] = v3(ankle.x, FLOOR_Y + 0.05, 0.06);
    p[s.toe] = v3(s.sign * (ANKLE_HALF + 0.035) + sway, FLOOR_Y + 0.06, -0.17);
  }

  torso(p, 38 * d + 32 * chestDrop * d);
  const armRaise = 82 * d * DEG;
  const armDir = v3(0, Math.cos(armRaise), -Math.sin(armRaise));
  for (const s of SIDES) {
    p[s.elbow] = add(p[s.shoulder], scale(armDir, UPPER_ARM));
    p[s.wrist] = add(add(p[s.elbow], scale(armDir, FOREARM)), v3(-s.sign * 0.03 * d, 0, 0));
  }
  return project(p, { yaw, ...view });
}

/**
 * Static lunge (split squat), left foot forward. `depth` 0 = tall, 1 = bottom.
 * Faults: leanForward (torso tips over the front knee).
 */
export function lungePose(depth, { leanForward = 0, yaw = -1.15, sway = 0, ...view } = {}) {
  const d = clamp01(depth);
  const p = new Array(LANDMARK_COUNT);
  const front = LEFT;
  const back = RIGHT;
  const hipY = 0.1 + 0.42 * d;

  p[front.ankle] = v3(0.12 + sway, FLOOR_Y, -0.4);
  p[front.heel] = v3(0.12 + sway, FLOOR_Y + 0.05, -0.34);
  p[front.toe] = v3(0.14 + sway, FLOOR_Y + 0.06, -0.57);
  p[back.ankle] = v3(-0.12 + sway, FLOOR_Y - 0.03, 0.45);
  p[back.heel] = v3(-0.12 + sway, FLOOR_Y - 0.06, 0.53);
  p[back.toe] = v3(-0.13 + sway, FLOOR_Y + 0.06, 0.3);
  for (const s of SIDES) p[s.hip] = v3(s.sign * HIP_HALF + sway, hipY, 0.02);
  p[front.knee] = solveMiddle(p[front.hip], p[front.ankle], THIGH, SHIN, v3(0, 0, -1));
  p[back.knee] = solveMiddle(p[back.hip], p[back.ankle], THIGH, SHIN, v3(0, 0.6, -1));

  torso(p, 6 * d + 34 * leanForward * d);
  const hang = v3(0, Math.cos(10 * DEG), -Math.sin(10 * DEG));
  for (const s of SIDES) {
    p[s.elbow] = add(p[s.shoulder], scale(hang, UPPER_ARM));
    p[s.wrist] = add(p[s.elbow], scale(hang, FOREARM));
  }
  return project(p, { yaw, ...view });
}

/**
 * Bicep curl, both arms. `amount` 0 = arms hanging, 1 = fully curled.
 * Faults: elbowDrift (upper arm swings forward), swing (torso leans back).
 */
export function curlPose(amount, { elbowDrift = 0, swing = 0, yaw = -0.55, sway = 0, ...view } = {}) {
  const a = clamp01(amount);
  const p = new Array(LANDMARK_COUNT);
  standingLegs(p, sway);
  torso(p, -22 * swing * a);

  const elbowAngle = 165 - 125 * a;
  const drift = (4 + 44 * elbowDrift * a) * DEG;
  const forearmAngle = drift + (180 - elbowAngle) * DEG;
  const upper = v3(0, Math.cos(drift), -Math.sin(drift));
  const forearm = v3(0, Math.cos(forearmAngle), -Math.sin(forearmAngle));
  for (const s of SIDES) {
    p[s.elbow] = add(p[s.shoulder], scale(upper, UPPER_ARM));
    p[s.wrist] = add(p[s.elbow], scale(forearm, FOREARM));
  }
  return project(p, { yaw, ...view });
}

/**
 * Overhead press. `amount` 0 = hands at the shoulders, 1 = locked out overhead.
 * Faults: uneven (right arm lags behind), backArch (leaning back).
 */
export function pressPose(amount, { uneven = 0, backArch = 0, yaw = -0.3, sway = 0, ...view } = {}) {
  const a = clamp01(amount);
  const p = new Array(LANDMARK_COUNT);
  standingLegs(p, sway);
  torso(p, -20 * backArch * a);

  for (const s of SIDES) {
    // An uneven press locks the right arm out lower and wider than the left.
    const reach = s === RIGHT ? 90 - 38 * uneven : 90;
    const beta = (-15 + reach * a) * DEG;
    const upper = norm(v3(s.sign * Math.cos(beta), -Math.sin(beta), -0.25));
    const forearm = norm(lerp3(v3(0, -1, 0), upper, a ** 2));
    p[s.elbow] = add(p[s.shoulder], scale(upper, UPPER_ARM));
    p[s.wrist] = add(p[s.elbow], scale(forearm, FOREARM));
  }
  return project(p, { yaw, ...view });
}

/**
 * Push-up, seen side-on. `depth` 0 = arms locked, 1 = chest near the floor.
 * Faults: hipSag (hips drop), hipPike (hips pushed up).
 */
export function pushupPose(depth, {
  hipSag = 0, hipPike = 0, yaw = Math.PI / 2 - 0.12, ...view
} = {}) {
  const d = clamp01(depth);
  const p = new Array(LANDMARK_COUNT);
  const shoulderHeight = 0.58 - 0.33 * d;
  for (const s of SIDES) {
    p[s.shoulder] = v3(s.sign * SHOULDER_HALF, FLOOR_Y - shoulderHeight, 0);
    p[s.wrist] = v3(s.sign * 0.24, FLOOR_Y - 0.02, -0.02);
    p[s.elbow] = solveMiddle(p[s.shoulder], p[s.wrist], UPPER_ARM, FOREARM, v3(s.sign * 0.6, 0, 1));
    p[s.ankle] = v3(s.sign * 0.1, FLOOR_Y - 0.1, 1.42);
    p[s.heel] = v3(s.sign * 0.1, FLOOR_Y - 0.17, 1.47);
    p[s.toe] = v3(s.sign * 0.1, FLOOR_Y - 0.01, 1.36);
  }
  for (const s of SIDES) {
    const line = sub(p[s.ankle], p[s.shoulder]);
    const hip = add(p[s.shoulder], scale(line, 0.37));
    hip.y += 0.15 * hipSag - 0.2 * hipPike;
    p[s.hip] = hip;
    p[s.knee] = lerp3(hip, p[s.ankle], 0.52);
  }
  p[LM.NOSE] = add(mid(p[LM.LEFT_SHOULDER], p[LM.RIGHT_SHOULDER]), v3(0, -0.03, -0.24));

  // Lying down is ~1.7 m long, so fit it to the frame width and centre it.
  const aspect = view.aspect ?? 9 / 16;
  const frameScale = Math.min(view.frameScale ?? 0.4, (0.7 * aspect) / 1.75);
  return project(p, { yaw, ...view, frameScale, shiftZ: -0.62 });
}

const POSERS = {
  squat: (amount, fault, opts) => squatPose(amount, {
    kneesIn: fault === 'kneesIn' ? 1 : 0, chestDrop: fault === 'chestDrop' ? 1 : 0, ...opts,
  }),
  lunge: (amount, fault, opts) => lungePose(amount, { leanForward: fault === 'leanForward' ? 1 : 0, ...opts }),
  curl: (amount, fault, opts) => curlPose(amount, {
    elbowDrift: fault === 'elbowDrift' ? 1 : 0, swing: fault === 'swing' ? 1 : 0, ...opts,
  }),
  press: (amount, fault, opts) => pressPose(amount, {
    uneven: fault === 'uneven' ? 1 : 0, backArch: fault === 'backArch' ? 1 : 0, ...opts,
  }),
  pushup: (amount, fault, opts) => pushupPose(amount, {
    hipSag: fault === 'hipSag' ? 1 : 0, hipPike: fault === 'hipPike' ? 1 : 0, ...opts,
  }),
};

/** Faults each synthetic exercise can act out, for tests and demos. */
export const SYNTHETIC_FAULTS = Object.freeze({
  squat: ['kneesIn', 'chestDrop'],
  lunge: ['leanForward'],
  curl: ['elbowDrift', 'swing'],
  press: ['uneven', 'backArch'],
  pushup: ['hipSag', 'hipPike'],
});

/** Pose for `exercise` at `amount` (0–1 through the rep), optionally acting out `fault`. */
export function exercisePose(exercise, amount, { fault = null, ...opts } = {}) {
  return POSERS[exercise](amount, fault, opts);
}

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Depth (0–1) over one rep cycle `t` in [0, 1): stand, descend, pause, drive up, stand. */
export function repDepth(t) {
  if (t < 0.1) return 0;
  if (t < 0.5) return easeInOut((t - 0.1) / 0.4);
  if (t < 0.6) return 1;
  if (t < 0.95) return 1 - easeInOut((t - 0.6) / 0.35);
  return 0;
}

/** Fault pattern for a looping squat set: clean, clean, knees in, clean, chest drop, clean. */
export const DEMO_PATTERN = [null, null, 'kneesIn', null, 'chestDrop', null];

/** Pose for a looping squat set at `elapsedMs` since the set started. */
export function demoFrame(elapsedMs, {
  repMs = 2600, pattern = DEMO_PATTERN, ...opts
} = {}) {
  const repIndex = Math.floor(elapsedMs / repMs);
  const depth = repDepth((elapsedMs % repMs) / repMs);
  const fault = pattern[repIndex % pattern.length];
  const sway = 0.012 * Math.sin(elapsedMs / 900);
  return { repIndex, depth, fault, pose: exercisePose('squat', depth, { fault, sway, ...opts }) };
}

/** The landing-page hero: three standing exercises the coach has to tell apart. */
export const HERO_PROGRAM = Object.freeze([
  { exercise: 'squat', repMs: 2600, faults: [null, null, 'kneesIn', null] },
  { exercise: 'press', repMs: 2400, faults: [null, 'backArch', null] },
  { exercise: 'curl', repMs: 2200, faults: [null, 'elbowDrift', null, null] },
]);

/** The in-app demo: all five exercises, back to back, one fault each. */
export const DEMO_PROGRAM = Object.freeze([
  { exercise: 'squat', repMs: 2600, faults: [null, 'kneesIn', null] },
  { exercise: 'lunge', repMs: 2800, faults: [null, 'leanForward', null] },
  { exercise: 'press', repMs: 2400, faults: [null, 'backArch', null] },
  { exercise: 'curl', repMs: 2200, faults: [null, 'elbowDrift', null] },
  { exercise: 'pushup', repMs: 2400, faults: [null, 'hipSag', null] },
]);

const TRANSITION_MS = 1100;

function programLayout(program) {
  let t = 0;
  const segments = program.map((seg) => {
    const start = t;
    const duration = seg.repMs * seg.faults.length;
    t += duration + TRANSITION_MS;
    return { ...seg, start, duration };
  });
  return { segments, total: t };
}

/**
 * Pose for a looping multi-exercise program at `elapsedMs`. Between exercises the body
 * blends from one starting position to the next.
 * @returns {{pose, exercise: string|null, segmentIndex: number, repIndex: number, fault: string|null}}
 */
export function programFrame(elapsedMs, program = DEMO_PROGRAM, opts = {}) {
  const { segments, total } = programLayout(program);
  const t = ((elapsedMs % total) + total) % total;
  const sway = 0.012 * Math.sin(elapsedMs / 900);
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const local = t - seg.start;
    if (local < seg.duration) {
      const repIndex = Math.floor(local / seg.repMs);
      const fault = seg.faults[repIndex] ?? null;
      const depth = repDepth((local % seg.repMs) / seg.repMs);
      const pose = exercisePose(seg.exercise, depth, { fault, sway, ...opts });
      return { pose, exercise: seg.exercise, segmentIndex: i, repIndex, fault };
    }
    if (local < seg.duration + TRANSITION_MS) {
      const next = segments[(i + 1) % segments.length];
      const k = easeInOut((local - seg.duration) / TRANSITION_MS);
      const from = exercisePose(seg.exercise, 0, { sway, ...opts });
      const to = exercisePose(next.exercise, 0, { sway, ...opts });
      const blend = (a, b) => a.map((p, j) => ({ ...lerp3(p, b[j], k), visibility: p.visibility }));
      return {
        pose: {
          landmarks: blend(from.landmarks, to.landmarks),
          worldLandmarks: blend(from.worldLandmarks, to.worldLandmarks),
        },
        exercise: null,
        segmentIndex: i,
        repIndex: -1,
        fault: null,
      };
    }
  }
  return programFrame(0, program, opts);
}

/** Total length of one loop of `program`, in milliseconds. */
export function programDuration(program = DEMO_PROGRAM) {
  return programLayout(program).total;
}
