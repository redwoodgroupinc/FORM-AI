// Procedural squatter: builds a full 33-point pose for any squat depth.
// It powers the landing-page animation and the in-app demo set, and gives the tests
// realistic input. The poses are run through the same FormCoach as live camera frames.

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
const FLOOR_Y = SHIN + THIGH; // standing hips sit at y = 0, +y points down

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (v, k) => ({ x: v.x * k, y: v.y * k, z: v.z * k });

/**
 * @param {number} depth 0 = standing, 1 = bottom of the squat
 * @param {object} [opts]
 * @param {number} [opts.kneesIn] 0–1, how much the knees cave inward
 * @param {number} [opts.chestDrop] 0–1, extra forward lean (rounded back)
 * @param {number} [opts.yaw] body rotation relative to the camera, radians
 * @param {number} [opts.sway] small sideways shift in metres
 * @param {number} [opts.aspect] frame width / height for the normalized landmarks
 * @param {number} [opts.frameScale] fraction of the frame height per metre
 * @param {number} [opts.floor] normalized y of the floor line
 */
export function squatPose(depth, {
  kneesIn = 0, chestDrop = 0, yaw = -0.38, sway = 0, aspect = 9 / 16, frameScale = 0.4, floor = 0.9,
} = {}) {
  const d = clamp01(depth);
  const kneeAngle = 175 - 95 * d;
  const shinLean = 38 * d * DEG;
  const thighLean = (180 - kneeAngle) * DEG - shinLean;
  const torsoLean = (38 * d + 32 * chestDrop * d) * DEG;
  const armRaise = 82 * d * DEG;

  const p = new Array(LANDMARK_COUNT);
  const sides = [
    { sign: 1, ankle: LM.LEFT_ANKLE, knee: LM.LEFT_KNEE, hip: LM.LEFT_HIP, heel: LM.LEFT_HEEL, toe: LM.LEFT_FOOT_INDEX, shoulder: LM.LEFT_SHOULDER, elbow: LM.LEFT_ELBOW, wrist: LM.LEFT_WRIST },
    { sign: -1, ankle: LM.RIGHT_ANKLE, knee: LM.RIGHT_KNEE, hip: LM.RIGHT_HIP, heel: LM.RIGHT_HEEL, toe: LM.RIGHT_FOOT_INDEX, shoulder: LM.RIGHT_SHOULDER, elbow: LM.RIGHT_ELBOW, wrist: LM.RIGHT_WRIST },
  ];

  for (const s of sides) {
    const ankle = { x: s.sign * ANKLE_HALF + sway, y: FLOOR_Y, z: 0 };
    const kneeHalf = ANKLE_HALF + 0.03 * d - 0.13 * kneesIn * d;
    const knee = {
      x: s.sign * kneeHalf + sway,
      y: ankle.y - SHIN * Math.cos(shinLean),
      z: -SHIN * Math.sin(shinLean),
    };
    const hip = {
      x: s.sign * HIP_HALF + sway,
      y: knee.y - THIGH * Math.cos(thighLean),
      z: knee.z + THIGH * Math.sin(thighLean),
    };
    p[s.ankle] = ankle;
    p[s.knee] = knee;
    p[s.hip] = hip;
    p[s.heel] = { x: ankle.x, y: FLOOR_Y + 0.05, z: 0.06 };
    p[s.toe] = { x: s.sign * (ANKLE_HALF + 0.035) + sway, y: FLOOR_Y + 0.06, z: -0.17 };
  }

  const hipMid = scale(add(p[LM.LEFT_HIP], p[LM.RIGHT_HIP]), 0.5);
  const torsoDir = { x: 0, y: -Math.cos(torsoLean), z: -Math.sin(torsoLean) };
  const neck = add(hipMid, scale(torsoDir, TORSO));
  const armDir = { x: 0, y: Math.cos(armRaise), z: -Math.sin(armRaise) };

  for (const s of sides) {
    const shoulder = add(neck, { x: s.sign * SHOULDER_HALF, y: 0, z: 0 });
    const elbow = add(shoulder, scale(armDir, UPPER_ARM));
    const wrist = add(add(elbow, scale(armDir, FOREARM)), { x: -s.sign * 0.03 * d, y: 0, z: 0 });
    p[s.shoulder] = shoulder;
    p[s.elbow] = elbow;
    p[s.wrist] = wrist;
    const hand = add(wrist, scale(armDir, 0.08));
    const [pinky, index, thumb] = s.sign > 0
      ? [LM.LEFT_PINKY, LM.LEFT_INDEX, LM.LEFT_THUMB]
      : [LM.RIGHT_PINKY, LM.RIGHT_INDEX, LM.RIGHT_THUMB];
    p[pinky] = add(hand, { x: s.sign * 0.02, y: 0, z: 0 });
    p[index] = hand;
    p[thumb] = add(hand, { x: -s.sign * 0.02, y: -0.01, z: 0 });
  }

  const nose = add(add(neck, scale(torsoDir, 0.2)), { x: 0, y: 0, z: -0.09 });
  p[LM.NOSE] = nose;
  const face = [
    [1, 0.02, -0.03, 0.02], [2, 0.035, -0.03, 0.02], [3, 0.05, -0.03, 0.025],
    [4, -0.02, -0.03, 0.02], [5, -0.035, -0.03, 0.02], [6, -0.05, -0.03, 0.025],
    [7, 0.075, -0.01, 0.09], [8, -0.075, -0.01, 0.09],
    [9, 0.025, 0.04, 0.01], [10, -0.025, 0.04, 0.01],
  ];
  for (const [i, dx, dy, dz] of face) p[i] = add(nose, { x: dx, y: dy, z: dz });

  // Rotate around the vertical axis, then express in both landmark spaces.
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const rotated = p.map((pt) => ({
    x: pt.x * cos - pt.z * sin,
    y: pt.y,
    z: pt.x * sin + pt.z * cos,
  }));
  const rHipMid = scale(add(rotated[LM.LEFT_HIP], rotated[LM.RIGHT_HIP]), 0.5);

  const worldLandmarks = rotated.map((pt) => ({
    x: pt.x - rHipMid.x,
    y: pt.y - rHipMid.y,
    z: pt.z - rHipMid.z,
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

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Fault pattern for the looping demo set: clean, clean, knees in, clean, chest drop, clean. */
export const DEMO_PATTERN = [null, null, 'kneesIn', null, 'chestDrop', null];

/** Depth (0–1) over one rep cycle `t` in [0, 1): stand, descend, pause, drive up, stand. */
export function repDepth(t) {
  if (t < 0.1) return 0;
  if (t < 0.5) return easeInOut((t - 0.1) / 0.4);
  if (t < 0.6) return 1;
  if (t < 0.95) return 1 - easeInOut((t - 0.6) / 0.35);
  return 0;
}

/** Pose for a looping demo set at `elapsedMs` since the set started. */
export function demoFrame(elapsedMs, {
  repMs = 2600, pattern = DEMO_PATTERN, aspect = 9 / 16, frameScale, floor,
} = {}) {
  const repIndex = Math.floor(elapsedMs / repMs);
  const t = (elapsedMs % repMs) / repMs;
  const depth = repDepth(t);
  const fault = pattern[repIndex % pattern.length];
  const sway = 0.012 * Math.sin(elapsedMs / 900);
  return {
    repIndex,
    depth,
    fault,
    pose: squatPose(depth, {
      kneesIn: fault === 'kneesIn' ? 1 : 0,
      chestDrop: fault === 'chestDrop' ? 1 : 0,
      sway,
      aspect,
      frameScale,
      floor,
    }),
  };
}
