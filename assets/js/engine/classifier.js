// Exercise recognition. Every frame is reduced to a few posture features; a span of
// frames (one rep's worth of movement) is then scored against each exercise.
//
// The cues are deliberately simple and view-independent, because they come from
// MediaPipe's metric 3D world landmarks:
//   - lying vs standing         torso and legs both far from vertical (a deep, rounded
//                               squat tips the torso but keeps the legs under the hips)
//   - legs vs arms doing work   range of knee angle (plus hip drop) vs range of elbow angle
//   - squat vs lunge            feet side by side vs split front-to-back while bent
//   - curl vs overhead press    hands stay below the shoulders vs travel above the head

import {
  LM, SIDES, jointAngle, angleFromVertical, midpoint, distance, isVisible,
} from './geometry.js';

export const EXERCISE_IDS = ['squat', 'lunge', 'pushup', 'curl', 'press'];

/** Minimum score for a span to count as a recognised exercise. */
export const MIN_CONFIDENCE = 0.5;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function sideAngle(points, a, b, c) {
  return isVisible(points, [a, b, c]) ? jointAngle(points[a], points[b], points[c]) : null;
}

/**
 * Posture features for one frame of landmarks (metric world space, +y down).
 * Returns null when the torso isn't visible enough to say anything.
 */
export function frameFeatures(points) {
  const shoulders = [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER].filter((i) => isVisible(points, [i]));
  const hips = [LM.LEFT_HIP, LM.RIGHT_HIP].filter((i) => isVisible(points, [i]));
  if (shoulders.length === 0 || hips.length === 0) return null;

  const avg = (idx) => idx.map((i) => points[i]).reduce((m, p, _, arr) => ({
    x: m.x + p.x / arr.length, y: m.y + p.y / arr.length, z: m.z + (p.z ?? 0) / arr.length,
  }), { x: 0, y: 0, z: 0 });
  const shoulderMid = avg(shoulders);
  const hipMid = avg(hips);
  const torsoLength = distance(shoulderMid, hipMid) || 1;

  const knees = {};
  const elbows = {};
  const wristLift = {};
  for (const side of ['left', 'right']) {
    const s = SIDES[side];
    knees[side] = sideAngle(points, s.hip, s.knee, s.ankle);
    elbows[side] = sideAngle(points, s.shoulder, s.elbow, s.wrist);
    wristLift[side] = isVisible(points, [s.shoulder, s.wrist])
      ? (points[s.shoulder].y - points[s.wrist].y) / torsoLength
      : null;
  }

  // Leg length from thigh + shin, which doesn't shrink when the knee bends.
  let legLength = null;
  for (const side of ['left', 'right']) {
    const s = SIDES[side];
    if (isVisible(points, [s.hip, s.knee, s.ankle])) {
      legLength = distance(points[s.hip], points[s.knee]) + distance(points[s.knee], points[s.ankle]);
      break;
    }
  }

  let hipHeight = null;
  let legLean = null;
  let stanceForeAft = null;
  let stanceLateral = null;
  const anklesVisible = isVisible(points, [LM.LEFT_ANKLE, LM.RIGHT_ANKLE]);
  if (legLength && anklesVisible) {
    const ankleMid = midpoint(points[LM.LEFT_ANKLE], points[LM.RIGHT_ANKLE]);
    hipHeight = (ankleMid.y - hipMid.y) / legLength;
    legLean = angleFromVertical(hipMid, ankleMid);
    if (hips.length === 2) {
      // Split the ankle-to-ankle vector into side-to-side (along the hips) and
      // front-to-back components on the floor plane.
      const hx = points[LM.LEFT_HIP].x - points[LM.RIGHT_HIP].x;
      const hz = (points[LM.LEFT_HIP].z ?? 0) - (points[LM.RIGHT_HIP].z ?? 0);
      const hLen = Math.hypot(hx, hz) || 1;
      const ax = points[LM.LEFT_ANKLE].x - points[LM.RIGHT_ANKLE].x;
      const az = (points[LM.LEFT_ANKLE].z ?? 0) - (points[LM.RIGHT_ANKLE].z ?? 0);
      const lateral = (ax * hx + az * hz) / hLen;
      const foreAft = Math.sqrt(Math.max(0, ax * ax + az * az - lateral * lateral));
      stanceLateral = Math.abs(lateral) / legLength;
      stanceForeAft = foreAft / legLength;
    }
  }

  return {
    torsoLean: angleFromVertical(shoulderMid, hipMid),
    legLean,
    kneeLeft: knees.left,
    kneeRight: knees.right,
    elbowLeft: elbows.left,
    elbowRight: elbows.right,
    wristLiftLeft: wristLift.left,
    wristLiftRight: wristLift.right,
    hipHeight,
    stanceForeAft,
    stanceLateral,
  };
}

function values(frames, pick) {
  const out = [];
  for (const f of frames) {
    const v = pick(f);
    if (v !== null && v !== undefined && Number.isFinite(v)) out.push(v);
  }
  return out;
}

function percentile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Robust spread: 95th minus 5th percentile, so one bad frame can't fake a movement. */
function spread(list) {
  if (list.length < 3) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  return percentile(sorted, 0.95) - percentile(sorted, 0.05);
}

function median(list) {
  if (list.length === 0) return null;
  return percentile([...list].sort((a, b) => a - b), 0.5);
}

const minOf = (a, b) => (a === null ? b : b === null ? a : Math.min(a, b));

/**
 * Score a span of frame features (typically one rep) against every exercise.
 * @param {Array<object|null>} frames output of frameFeatures, in time order
 * @returns {{exerciseId: string|null, confidence: number, scores: Record<string, number>}}
 */
export function classifySpan(frames) {
  const scores = Object.fromEntries(EXERCISE_IDS.map((id) => [id, 0]));
  const valid = frames.filter(Boolean);
  if (valid.length < 5) return { exerciseId: null, confidence: 0, scores };

  const lying = (f) => f.torsoLean > 55 && (f.legLean === null || f.legLean > 45);
  const horizontal = valid.filter(lying).length / valid.length;

  const kneeMin = values(valid, (f) => minOf(f.kneeLeft, f.kneeRight));
  const kneeRange = spread(kneeMin);
  const hipDrop = spread(values(valid, (f) => f.hipHeight));

  const leftRange = spread(values(valid, (f) => f.elbowLeft));
  const rightRange = spread(values(valid, (f) => f.elbowRight));
  const armRange = Math.max(leftRange, rightRange);
  const workingArm = leftRange >= rightRange ? 'Left' : 'Right';
  const lifts = values(valid, (f) => f[`wristLift${workingArm}`]);
  const overheadShare = lifts.length ? lifts.filter((l) => l > 0.35).length / lifts.length : 0;

  if (horizontal >= 0.6) {
    scores.pushup = clamp01((armRange - 15) / 30);
  } else {
    const upright = 1 - clamp01((horizontal - 0.2) / 0.4);
    const legs = clamp01((kneeRange - 20) / 30) * clamp01((hipDrop - 0.04) / 0.1);
    const arms = clamp01((armRange - 25) / 40);

    // Judge stance while the knees are bent, where squat and lunge differ most.
    let foreAft = null;
    if (kneeMin.length) {
      const bentBelow = Math.min(...kneeMin) + kneeRange * 0.5;
      foreAft = median(values(valid, (f) => (minOf(f.kneeLeft, f.kneeRight) ?? Infinity) <= bentBelow
        ? f.stanceForeAft : null));
    }
    const lungeness = foreAft === null ? 0 : clamp01((foreAft - 0.3) / 0.25);
    scores.squat = upright * legs * (1 - lungeness);
    scores.lunge = upright * legs * lungeness;

    const overhead = clamp01((overheadShare - 0.15) / 0.3);
    const armsOnly = 1 - 0.8 * legs;
    scores.press = upright * arms * overhead * armsOnly;
    scores.curl = upright * arms * (1 - overhead) * armsOnly;
  }

  let exerciseId = null;
  let confidence = 0;
  for (const id of EXERCISE_IDS) {
    if (scores[id] > confidence) {
      confidence = scores[id];
      exerciseId = id;
    }
  }
  if (confidence < MIN_CONFIDENCE) exerciseId = null;
  return { exerciseId, confidence, scores };
}
