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
  LM, SIDES, jointAngle, angleFromVertical, distance, isVisible,
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
  let hipAnkleDrop = null;
  let legLean = null;
  let stanceForeAft = null;
  let stanceLateral = null;
  const ankles = [LM.LEFT_ANKLE, LM.RIGHT_ANKLE].filter((i) => isVisible(points, [i]));
  if (legLength && ankles.length) {
    // The hip drop only needs the ankle(s) the camera sees.
    const ankleMid = avg(ankles);
    hipAnkleDrop = ankleMid.y - hipMid.y;
    hipHeight = hipAnkleDrop / legLength;
    legLean = angleFromVertical(hipMid, ankleMid);
  }
  if (legLength && ankles.length === 2) {
    const ax = points[LM.LEFT_ANKLE].x - points[LM.RIGHT_ANKLE].x;
    const az = (points[LM.LEFT_ANKLE].z ?? 0) - (points[LM.RIGHT_ANKLE].z ?? 0);
    if (hips.length === 2) {
      // Split the ankle-to-ankle vector into side-to-side (along the body's left-right
      // axis) and front-to-back components on the floor plane. The hips alone are only
      // ~20 cm apart, so depth jitter swings their axis wildly; adding the shoulder line
      // (~38 cm) steadies it.
      let hx = points[LM.LEFT_HIP].x - points[LM.RIGHT_HIP].x;
      let hz = (points[LM.LEFT_HIP].z ?? 0) - (points[LM.RIGHT_HIP].z ?? 0);
      if (shoulders.length === 2) {
        hx += points[LM.LEFT_SHOULDER].x - points[LM.RIGHT_SHOULDER].x;
        hz += (points[LM.LEFT_SHOULDER].z ?? 0) - (points[LM.RIGHT_SHOULDER].z ?? 0);
      }
      const hLen = Math.hypot(hx, hz) || 1;
      const lateral = (ax * hx + az * hz) / hLen;
      const foreAft = Math.sqrt(Math.max(0, ax * ax + az * az - lateral * lateral));
      stanceLateral = Math.abs(lateral) / legLength;
      stanceForeAft = foreAft / legLength;
    } else {
      // No left-right axis (far hip hidden, e.g. side-on): a split stance is still far
      // wider than a squat stance, so judge the total floor distance between the feet.
      stanceForeAft = Math.max(0, Math.hypot(ax, az) / legLength - 0.3);
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
    hipAnkleDrop,
    legLength,
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

/**
 * Range of motion, ignoring a few extreme frames so one bad detection can't fake a
 * movement. Trims a fixed number of frames (not a percentage), so a long pause at the
 * top or bottom of a rep doesn't hide the movement itself.
 */
function spread(list) {
  if (list.length < 3) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  const trim = Math.min(3, Math.floor(sorted.length * 0.05));
  return sorted[sorted.length - 1 - trim] - sorted[trim];
}

function median(list) {
  if (list.length === 0) return null;
  return percentile([...list].sort((a, b) => a - b), 0.5);
}

const minOf = (a, b) => (a === null ? b : b === null ? a : Math.min(a, b));

const SMOOTHED = [
  'torsoLean', 'legLean', 'kneeLeft', 'kneeRight', 'elbowLeft', 'elbowRight', 'wristLiftLeft',
  'wristLiftRight', 'hipHeight', 'hipAnkleDrop', 'stanceForeAft', 'stanceLateral',
];

/**
 * Centred moving average over `k` frames. Pose jitter (especially depth) is mostly
 * frame-to-frame, while real movement is slow, so this removes noise that would
 * otherwise look like motion: straight legs "bending", still arms "curling".
 */
function smooth(frames, k) {
  if (k <= 1) return frames;
  const half = Math.floor(k / 2);
  return frames.map((frame, i) => {
    const out = { ...frame };
    for (const key of SMOOTHED) {
      if (frame[key] === null || frame[key] === undefined) continue;
      let sum = 0;
      let n = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(frames.length - 1, i + half); j += 1) {
        const v = frames[j][key];
        if (v !== null && v !== undefined && Number.isFinite(v)) {
          sum += v;
          n += 1;
        }
      }
      out[key] = sum / n;
    }
    return out;
  });
}

/**
 * Score a span of frame features (typically one rep) against every exercise.
 * @param {Array<object|null>} frames output of frameFeatures, in time order
 * @returns {{exerciseId: string|null, confidence: number, scores: Record<string, number>}}
 */
export function classifySpan(frames) {
  const scores = Object.fromEntries(EXERCISE_IDS.map((id) => [id, 0]));
  const raw = frames.filter(Boolean);
  if (raw.length < 5) return { exerciseId: null, confidence: 0, scores };
  // ~5 frames at 30 fps; fewer at low frame rates so the movement itself isn't flattened.
  const valid = smooth(raw, Math.max(3, Math.min(7, Math.round(raw.length / 10)) | 1));

  const lying = (f) => f.torsoLean > 55 && (f.legLean === null || f.legLean > 45);
  const horizontal = valid.filter(lying).length / valid.length;

  const kneeMin = values(valid, (f) => minOf(f.kneeLeft, f.kneeRight));
  const kneeRange = spread(kneeMin);
  // Normalise by the span's median leg length: per-frame leg length is itself noisy.
  const leg = median(values(raw, (f) => f.legLength));
  const hipDrop = leg ? spread(values(valid, (f) => f.hipAnkleDrop)) / leg : 0;

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
    const legs = clamp01((kneeRange - 25) / 30) * clamp01((hipDrop - 0.06) / 0.1);
    const arms = clamp01((armRange - 25) / 40);
    // Which body part does the work? Compare each range with a typical full rep
    // (knees ~90°, elbows ~110°), so noise on the idle limbs can't outvote real movement.
    const legEffort = (kneeRange / 90) * clamp01(hipDrop / 0.2);
    const armEffort = armRange / 110;
    const legShare = legEffort + armEffort > 0 ? legEffort / (legEffort + armEffort) : 0.5;
    const legsLead = clamp01((legShare - 0.3) / 0.2);
    const armsLead = clamp01((0.7 - legShare) / 0.2);

    // Judge stance while the knees are bent, where squat and lunge differ most.
    let foreAft = null;
    if (kneeMin.length) {
      const bentBelow = Math.min(...kneeMin) + kneeRange * 0.5;
      foreAft = median(values(valid, (f) => (minOf(f.kneeLeft, f.kneeRight) ?? Infinity) <= bentBelow
        ? f.stanceForeAft : null));
    }
    const lungeness = foreAft === null ? 0 : clamp01((foreAft - 0.3) / 0.25);
    scores.squat = upright * legs * legsLead * (1 - lungeness);
    scores.lunge = upright * legs * legsLead * lungeness;

    const overhead = clamp01((overheadShare - 0.15) / 0.3);
    scores.press = upright * arms * armsLead * overhead;
    scores.curl = upright * arms * armsLead * (1 - overhead);
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
