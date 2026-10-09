// Canvas renderer for the tracked skeleton, fault highlights and the live joint angle.

import { BODY_CONNECTIONS, LM, jointAngle } from '../engine/geometry.js';

export const SKELETON_COLORS = {
  bone: '#c8ff3d',
  boneGlow: 'rgba(200, 255, 61, 0.55)',
  joint: '#f5f7fa',
  fault: '#ff5a52',
  faultGlow: 'rgba(255, 90, 82, 0.65)',
  arc: '#46e3ff',
  label: '#06080a',
};

const MIN_VISIBILITY = 0.45;

function toCanvas(p, width, height, mirror) {
  return { x: (mirror ? 1 - p.x : p.x) * width, y: p.y * height };
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x:number,y:number,visibility?:number}>} landmarks normalized 0–1
 * @param {object} opts
 */
export function drawSkeleton(ctx, landmarks, {
  width,
  height,
  mirror = false,
  faultJoints = new Set(),
  arc = null,
  angle = null,
  showAngle = true,
  time = 0,
} = {}) {
  if (!landmarks) return;
  const unit = Math.max(2, Math.min(width, height) / 160);
  const pts = landmarks.map((p) => toCanvas(p, width, height, mirror));
  const visible = (i) => (landmarks[i]?.visibility ?? 1) >= MIN_VISIBILITY;
  const pulse = 0.5 + 0.5 * Math.sin(time / 120);

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Bones
  for (const [a, b] of BODY_CONNECTIONS) {
    if (!visible(a) || !visible(b)) continue;
    const bad = faultJoints.has(a) || faultJoints.has(b);
    ctx.strokeStyle = bad ? SKELETON_COLORS.fault : SKELETON_COLORS.bone;
    ctx.shadowColor = bad ? SKELETON_COLORS.faultGlow : SKELETON_COLORS.boneGlow;
    ctx.shadowBlur = unit * (bad ? 6 : 4);
    ctx.lineWidth = unit * 1.6;
    ctx.beginPath();
    ctx.moveTo(pts[a].x, pts[a].y);
    ctx.lineTo(pts[b].x, pts[b].y);
    ctx.stroke();
  }

  // Head
  if (visible(LM.NOSE) && visible(LM.LEFT_SHOULDER) && visible(LM.RIGHT_SHOULDER)) {
    const shoulderSpan = Math.hypot(
      pts[LM.LEFT_SHOULDER].x - pts[LM.RIGHT_SHOULDER].x,
      pts[LM.LEFT_SHOULDER].y - pts[LM.RIGHT_SHOULDER].y,
    );
    const radius = Math.max(unit * 5, shoulderSpan * 0.32);
    ctx.shadowBlur = unit * 3;
    ctx.shadowColor = SKELETON_COLORS.boneGlow;
    ctx.strokeStyle = SKELETON_COLORS.bone;
    ctx.lineWidth = unit * 1.2;
    ctx.beginPath();
    ctx.arc(pts[LM.NOSE].x, pts[LM.NOSE].y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Joints
  const jointSet = new Set(BODY_CONNECTIONS.flat());
  for (const i of jointSet) {
    if (!visible(i)) continue;
    const bad = faultJoints.has(i);
    const r = unit * (bad ? 2.4 : 1.7);
    ctx.shadowBlur = bad ? unit * 8 : unit * 2;
    ctx.shadowColor = bad ? SKELETON_COLORS.faultGlow : 'rgba(0,0,0,0.4)';
    ctx.fillStyle = bad ? SKELETON_COLORS.fault : SKELETON_COLORS.joint;
    ctx.beginPath();
    ctx.arc(pts[i].x, pts[i].y, r, 0, Math.PI * 2);
    ctx.fill();
    if (bad) {
      ctx.shadowBlur = 0;
      ctx.strokeStyle = SKELETON_COLORS.fault;
      ctx.globalAlpha = 0.35 + 0.4 * (1 - pulse);
      ctx.lineWidth = unit * 0.8;
      ctx.beginPath();
      ctx.arc(pts[i].x, pts[i].y, r + unit * (3 + 4 * pulse), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  if (arc && showAngle && arc.every(visible)) drawAngle(ctx, landmarks, pts, arc, unit, angle);
  ctx.restore();
}

// `angle` lets the label show the coach's smoothed reading so it matches the HUD.
function drawAngle(ctx, landmarks, pts, [a, b, c], unit, angle) {
  const degrees = angle ?? jointAngle(landmarks[a], landmarks[b], landmarks[c]);
  const center = pts[b];
  const start = Math.atan2(pts[a].y - center.y, pts[a].x - center.x);
  const end = Math.atan2(pts[c].y - center.y, pts[c].x - center.x);
  let sweep = end - start;
  while (sweep > Math.PI) sweep -= Math.PI * 2;
  while (sweep < -Math.PI) sweep += Math.PI * 2;
  const radius = unit * 9;

  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(70, 227, 255, 0.16)';
  ctx.beginPath();
  ctx.moveTo(center.x, center.y);
  ctx.arc(center.x, center.y, radius, start, start + sweep, sweep < 0);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = SKELETON_COLORS.arc;
  ctx.lineWidth = unit * 0.9;
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, start, start + sweep, sweep < 0);
  ctx.stroke();

  // Label sits on the outside of the angle, away from the limbs.
  const mid = start + sweep / 2 + Math.PI;
  const lx = center.x + Math.cos(mid) * radius * 1.9;
  const ly = center.y + Math.sin(mid) * radius * 1.9;
  const text = `${Math.round(degrees)}°`;
  ctx.font = `700 ${Math.round(unit * 6)}px "Space Grotesk", system-ui, sans-serif`;
  const w = ctx.measureText(text).width + unit * 5;
  const h = unit * 9;
  ctx.fillStyle = SKELETON_COLORS.arc;
  roundRect(ctx, lx - w / 2, ly - h / 2, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = SKELETON_COLORS.label;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, lx, ly + unit * 0.3);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Collect the landmark indices to highlight for the faults active on this frame. */
export function faultJointsFor(activeFaults = []) {
  const set = new Set();
  for (const check of activeFaults) for (const j of check.joints ?? []) set.add(j);
  return set;
}
