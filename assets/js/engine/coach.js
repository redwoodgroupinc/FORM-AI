// FormCoach turns a stream of pose landmarks into reps, form faults and coaching events.
//
// Feed it one pose per video frame with `update(pose, timeMs)`. It returns a frame
// snapshot for the HUD plus any events ('rep', 'partial', 'fault') that happened on that
// frame. It has no DOM or MediaPipe dependency, so it is unit-tested in Node.

import { OneEuroFilter } from './filters.js';
import { LANDMARK_COUNT, toIsotropic } from './geometry.js';
import { TEMPO_CHECK } from './exercises.js';

// Progress thresholds (0 = rest position, 1 = target position).
const LEAVE_REST = 0.2;
const RETURN_REST = 0.12;
const PEAK_PHASE = 0.6;
const PARTIAL_MIN = 0.4;
const REACHED_PEAK = 1;

// A fault has to persist this long (and for at least two frames) before it is called.
const DEFAULT_FAULT_MS = 150;
// After this long without a pose, smoothing restarts instead of blending stale data.
const TRACKING_GAP_MS = 600;

const FAULT_PENALTY = 30;
const TEMPO_PENALTY = 15;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Choose the coordinate space to measure in. World landmarks are metric and centred on
 * the hips, which makes angles independent of the camera's distance and aspect ratio.
 */
export function pointsFromPose(pose, aspect = 1) {
  const { landmarks, worldLandmarks } = pose;
  if (worldLandmarks && worldLandmarks.length >= LANDMARK_COUNT) {
    return worldLandmarks.map((p, i) => ({
      x: p.x,
      y: p.y,
      z: p.z,
      visibility: landmarks?.[i]?.visibility ?? p.visibility ?? 1,
    }));
  }
  return toIsotropic(landmarks, aspect);
}

export class FormCoach {
  constructor(exercise) {
    this.exercise = exercise;
    this.filter = new OneEuroFilter();
    this.reset();
  }

  reset() {
    this.filter.reset();
    // Scratch space an exercise's measure() can keep between frames (see standingLean).
    this.measureState = {};
    this.state = 'rest';
    this.reps = 0;
    this.partialReps = 0;
    this.repLog = [];
    this.faultCounts = {};
    this.currentRep = null;
    this.faultTimers = {};
    this.firstTrackedAt = null;
    this.lastTrackedAt = null;
    this.lastProgress = 0;
  }

  progressFor(value) {
    const { rest, peak } = this.exercise;
    return clamp01((rest - value) / (rest - peak));
  }

  /**
   * @param {{landmarks: Array, worldLandmarks?: Array}|null} pose
   * @param {number} timeMs monotonic timestamp
   * @param {{aspect?: number}} [options]
   */
  update(pose, timeMs, { aspect = 1 } = {}) {
    if (!pose || !pose.landmarks) return this.snapshot('no_pose', { hint: 'Step into the frame' });

    const points = pointsFromPose(pose, aspect);
    const measurement = this.exercise.measure(points, this.measureState);
    if (!measurement) return this.snapshot('not_visible', { hint: this.exercise.frameHint });
    if (measurement.ready === false) {
      this.clearFaultTimers();
      return this.snapshot('not_ready', { hint: measurement.hint, arc: measurement.arc });
    }
    // A corrupt frame (NaN coordinates) would poison the smoothing filter for good.
    if (!Number.isFinite(measurement.value)) return this.snapshot('not_visible', { hint: this.exercise.frameHint });

    const resumedAfterGap = this.lastTrackedAt !== null && timeMs - this.lastTrackedAt > TRACKING_GAP_MS;
    if (resumedAfterGap) {
      this.filter.reset();
      // We didn't see the whole rep, so its duration can't be judged.
      if (this.currentRep) this.currentRep.interrupted = true;
    }
    if (this.firstTrackedAt === null) this.firstTrackedAt = timeMs;
    this.lastTrackedAt = timeMs;

    const value = this.filter.filter(measurement.value, timeMs);
    const progress = this.progressFor(value);
    this.lastProgress = progress;
    const events = [];

    this.advanceState(progress, timeMs, events, resumedAfterGap);
    const activeFaults = this.evaluateChecks(measurement.metrics, progress, timeMs, events);

    return this.snapshot('tracking', {
      value,
      rawValue: measurement.value,
      progress,
      arc: measurement.arc,
      metrics: measurement.metrics,
      activeFaults,
      events,
    });
  }

  advanceState(progress, timeMs, events, resumedAfterGap = false) {
    if (this.state === 'rest') {
      if (progress >= LEAVE_REST) {
        this.state = 'moving';
        this.currentRep = {
          startedAt: timeMs,
          maxProgress: progress,
          faults: [],
          interrupted: resumedAfterGap,
        };
        if (progress >= REACHED_PEAK) this.state = 'peak';
      }
      return;
    }

    const rep = this.currentRep;
    rep.maxProgress = Math.max(rep.maxProgress, progress);
    if (progress >= REACHED_PEAK) this.state = 'peak';

    if (progress <= RETURN_REST) {
      if (this.state === 'peak') {
        this.completeRep(rep, timeMs, events);
      } else if (rep.maxProgress >= PARTIAL_MIN) {
        this.partialReps += 1;
        events.push({
          type: 'partial',
          cue: this.exercise.partialCue,
          maxProgress: rep.maxProgress,
          startedAt: rep.startedAt,
          endedAt: timeMs,
          faults: [...rep.faults],
        });
      }
      this.state = 'rest';
      this.currentRep = null;
      this.clearFaultTimers();
    }
  }

  completeRep(rep, timeMs, events) {
    const durationMs = timeMs - rep.startedAt;
    if (!rep.interrupted && durationMs < this.exercise.minRepMs) {
      rep.faults.push(TEMPO_CHECK.id);
      this.countFault(TEMPO_CHECK.id);
      events.push({ type: 'fault', check: TEMPO_CHECK });
    }
    const formFaults = rep.faults.filter((id) => id !== TEMPO_CHECK.id).length;
    const tempoFault = rep.faults.includes(TEMPO_CHECK.id) ? 1 : 0;
    const score = Math.max(0, 100 - formFaults * FAULT_PENALTY - tempoFault * TEMPO_PENALTY);

    this.reps += 1;
    const record = {
      index: this.reps,
      startedAt: rep.startedAt,
      endedAt: timeMs,
      durationMs,
      depth: rep.maxProgress,
      faults: [...rep.faults],
      score,
    };
    this.repLog.push(record);
    events.push({ type: 'rep', rep: record, count: this.reps });
  }

  evaluateChecks(metrics, progress, timeMs, events) {
    if (this.state === 'rest' || !this.currentRep) {
      this.clearFaultTimers();
      return [];
    }
    const active = [];
    for (const check of this.exercise.checks) {
      const inPhase = check.phase === 'active' || progress >= PEAK_PHASE;
      const failing = inPhase && Boolean(check.test(metrics));
      if (!failing) {
        delete this.faultTimers[check.id];
        continue;
      }
      const timer = this.faultTimers[check.id] ?? { since: timeMs, frames: 0 };
      timer.frames += 1;
      this.faultTimers[check.id] = timer;

      const confirmed = timer.frames >= 2 && timeMs - timer.since >= (check.minMs ?? DEFAULT_FAULT_MS);
      if (!confirmed) continue;
      active.push(check);
      if (!this.currentRep.faults.includes(check.id)) {
        this.currentRep.faults.push(check.id);
        this.countFault(check.id);
        events.push({ type: 'fault', check });
      }
    }
    return active;
  }

  countFault(id) {
    this.faultCounts[id] = (this.faultCounts[id] ?? 0) + 1;
  }

  clearFaultTimers() {
    this.faultTimers = {};
  }

  formScore() {
    if (this.repLog.length === 0) return null;
    const total = this.repLog.reduce((sum, rep) => sum + rep.score, 0);
    return Math.round(total / this.repLog.length);
  }

  snapshot(status, extra = {}) {
    return {
      status,
      state: this.state,
      reps: this.reps,
      partialReps: this.partialReps,
      formScore: this.formScore(),
      progress: status === 'tracking' ? extra.progress : this.lastProgress,
      activeFaults: [],
      events: [],
      ...extra,
    };
  }

  /** Summary of the set so far, used for the end-of-set report and history. */
  summary() {
    const checks = [...this.exercise.checks, TEMPO_CHECK];
    const faults = Object.entries(this.faultCounts)
      .map(([id, count]) => {
        const check = checks.find((c) => c.id === id);
        return { id, count, label: check?.label ?? id, cue: check?.cue ?? '' };
      })
      .sort((a, b) => b.count - a.count);
    const durations = this.repLog.map((r) => r.durationMs);
    return {
      exerciseId: this.exercise.id,
      exerciseName: this.exercise.name,
      reps: this.reps,
      cleanReps: this.repLog.filter((r) => r.faults.length === 0).length,
      partialReps: this.partialReps,
      formScore: this.formScore(),
      faults,
      avgRepMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
      durationMs: this.firstTrackedAt === null ? 0 : this.lastTrackedAt - this.firstTrackedAt,
      repLog: this.repLog.map((r) => ({ ...r })),
    };
  }
}
