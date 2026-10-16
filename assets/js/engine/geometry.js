// Vector helpers and MediaPipe/ML Kit landmark indices.
// Everything here is pure math so it runs the same in the browser and in Node tests.

/** BlazePose 33-point topology (shared by MediaPipe Pose and Google ML Kit). */
export const LM = Object.freeze({
  NOSE: 0,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_THUMB: 21,
  RIGHT_THUMB: 22,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
});

export const LANDMARK_COUNT = 33;

/** Body connections used for drawing (face mesh points are intentionally skipped). */
export const BODY_CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [15, 19], [16, 20],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32],
];

/** Per-side joint lookup so exercises can be written once for both sides. */
export const SIDES = Object.freeze({
  left: {
    shoulder: LM.LEFT_SHOULDER, elbow: LM.LEFT_ELBOW, wrist: LM.LEFT_WRIST,
    hip: LM.LEFT_HIP, knee: LM.LEFT_KNEE, ankle: LM.LEFT_ANKLE,
    heel: LM.LEFT_HEEL, toe: LM.LEFT_FOOT_INDEX,
  },
  right: {
    shoulder: LM.RIGHT_SHOULDER, elbow: LM.RIGHT_ELBOW, wrist: LM.RIGHT_WRIST,
    hip: LM.RIGHT_HIP, knee: LM.RIGHT_KNEE, ankle: LM.RIGHT_ANKLE,
    heel: LM.RIGHT_HEEL, toe: LM.RIGHT_FOOT_INDEX,
  },
});

const RAD_TO_DEG = 180 / Math.PI;

export function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) };
}

export function dot(a, b) {
  return a.x * b.x + a.y * b.y + (a.z ?? 0) * (b.z ?? 0);
}

export function length(v) {
  return Math.hypot(v.x, v.y, v.z ?? 0);
}

export function distance(a, b) {
  return length(sub(a, b));
}

export function midpoint(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: ((a.z ?? 0) + (b.z ?? 0)) / 2,
    visibility: Math.min(a.visibility ?? 1, b.visibility ?? 1),
  };
}

/** Angle between two vectors in degrees (0–180). */
export function vectorAngle(u, v) {
  const denom = length(u) * length(v);
  if (denom === 0) return 0;
  const cos = Math.max(-1, Math.min(1, dot(u, v) / denom));
  return Math.acos(cos) * RAD_TO_DEG;
}

/** Interior angle at joint `b` formed by a–b–c, in degrees. */
export function jointAngle(a, b, c) {
  return vectorAngle(sub(a, b), sub(c, b));
}

/**
 * Angle of the segment from `bottom` to `top` away from straight up, in degrees.
 * Landmark space has +y pointing down, so "up" is (0, -1, 0).
 */
export function angleFromVertical(top, bottom) {
  return vectorAngle(sub(top, bottom), { x: 0, y: -1, z: 0 });
}

export function visibility(point) {
  return point?.visibility ?? 1;
}

export function isVisible(points, indices, min = 0.5) {
  return indices.every((i) => points[i] && visibility(points[i]) >= min);
}

export function sideVisibility(points, side) {
  const s = SIDES[side];
  return [s.shoulder, s.hip, s.knee, s.ankle, s.elbow, s.wrist]
    .reduce((sum, i) => sum + visibility(points[i]), 0);
}

/** Pick the side of the body that the camera sees best. */
export function bestSide(points) {
  return sideVisibility(points, 'left') >= sideVisibility(points, 'right') ? 'left' : 'right';
}

/**
 * Convert normalized image landmarks (0–1 on each axis) into an isotropic space so
 * angles are not distorted by the frame's aspect ratio.
 */
export function toIsotropic(landmarks, aspect = 1) {
  return landmarks.map((p) => ({
    x: p.x * aspect,
    y: p.y,
    z: (p.z ?? 0) * aspect,
    visibility: p.visibility,
  }));
}

/**
 * Signed distance of `p` below the line through `a` and `b` (2D, image-style +y down).
 * Positive means `p` hangs lower than the line, e.g. hips sagging in a push-up.
 */
export function offsetBelowLine(p, a, b) {
  const dx = b.x - a.x;
  if (Math.abs(dx) < 1e-6) return 0;
  const t = (p.x - a.x) / dx;
  const lineY = a.y + t * (b.y - a.y);
  return p.y - lineY;
}
