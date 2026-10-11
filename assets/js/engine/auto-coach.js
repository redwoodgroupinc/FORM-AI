// AutoCoach: hands-free coaching with automatic exercise recognition.
//
// One FormCoach per exercise runs on every frame. When any of them completes a rep, the
// frames of that rep are classified (see classifier.js) and the rep only counts if the
// movement really was that exercise. So squats are never counted as lunges, and the
// first rep of a new exercise isn't lost while the exercise is being recognised.
//
// Accepted reps are grouped into sets. A set ends when the athlete switches exercise,
// rests for SET_BREAK_MS, or the session finishes.

import { FormCoach, pointsFromPose } from './coach.js';
import { EXERCISES, EXERCISE_ORDER, TEMPO_CHECK } from './exercises.js';
import { frameFeatures, classifySpan } from './classifier.js';

/** How much pose history to keep for classifying reps (longer than any single rep). */
const HISTORY_MS = 20000;
/** A rest longer than this closes the set, so the next rep starts a new one. */
export const SET_BREAK_MS = 30000;
/**
 * Hysteresis between exercises. The exercise being coached keeps a rep unless another
 * exercise scores clearly better, so one borderline rep can't split a set.
 */
const KEEP_LIVE_MIN = 0.25;
const SWITCH_MARGIN = 0.3;
/** A rep that names or switches the exercise must take at least this share of minRepMs. */
const SWITCH_MIN_TEMPO = 0.8;
/** A mid-rep fault is only spoken once the movement is clearly the coached exercise. */
const CONFIRM_FAULT_CONFIDENCE = 0.8;
/**
 * Half reps must last this long. Pose jitter while standing still can make a coach
 * "leave and return" in a few frames; a real half rep takes most of a second.
 */
const PARTIAL_MIN_MS = 700;
/** A "rep" longer than this is someone resting (seated, standing up, out of frame), not a rep. */
const MAX_REP_MS = HISTORY_MS;
/**
 * Reps too quick to name the exercise on their own still count when two come back to back
 * like this: one quick flick can be jitter, a rhythm of them is a rushed set.
 */
const RUSHED_GAP_MS = 3000;

export const HINTS = Object.freeze({
  noPose: 'Step into the frame',
  fullBody: 'Step back so I can see your whole body',
  detecting: "Start your first rep. I'll recognise the exercise",
  waiting: 'Ready when you are',
});

function checkFor(exercise, id) {
  return id === TEMPO_CHECK.id ? TEMPO_CHECK : exercise.checks.find((c) => c.id === id);
}

const average = (list) => list.reduce((a, b) => a + b, 0) / list.length;

function median(list) {
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Time per rep, as the athlete experiences it: the spacing between rep completions. Each rep's
 * own durationMs only covers the part of the movement the tempo check times. The median keeps
 * one breather mid-set from inflating it.
 */
function repPaceMs(reps) {
  if (reps.length === 0) return null;
  if (reps.length === 1) return reps[0].durationMs;
  return median(reps.slice(1).map((rep, i) => rep.endedAt - reps[i].endedAt));
}

function summariseSet(set) {
  const { exercise, reps } = set;
  const faults = Object.entries(set.faultCounts)
    .map(([id, count]) => {
      const check = checkFor(exercise, id);
      return { id, count, label: check?.label ?? id, cue: check?.cue ?? '' };
    })
    .sort((a, b) => b.count - a.count);
  return {
    exerciseId: exercise.id,
    exerciseName: exercise.name,
    reps: reps.length,
    cleanReps: reps.filter((r) => r.faults.length === 0).length,
    partialReps: set.partialReps,
    formScore: reps.length ? Math.round(average(reps.map((r) => r.score))) : null,
    faults,
    avgRepMs: repPaceMs(reps),
    startedAt: set.startedAt,
    endedAt: set.lastActivityAt,
    durationMs: set.lastActivityAt - set.startedAt,
    repLog: reps.map((r) => ({ ...r })),
  };
}

export class AutoCoach {
  constructor({ exerciseIds = EXERCISE_ORDER } = {}) {
    this.exerciseIds = exerciseIds;
    this.reset();
  }

  reset() {
    this.coaches = new Map(this.exerciseIds.map((id) => [id, new FormCoach(EXERCISES[id])]));
    this.history = [];
    this.sets = [];
    this.current = null;
    this.liveExerciseId = null;
    this.announced = new Map();
    this.pending = [];
    this.rushed = null;
    this.firstTrackedAt = null;
    this.lastTrackedAt = null;
  }

  /** The exercise currently being coached, or null until the first rep is recognised. */
  get exercise() {
    return this.liveExerciseId ? EXERCISES[this.liveExerciseId] : null;
  }

  /**
   * @param {{landmarks: Array, worldLandmarks?: Array}|null} pose
   * @param {number} timeMs monotonic timestamp
   * @param {{aspect?: number}} [options]
   */
  update(pose, timeMs, { aspect = 1 } = {}) {
    const events = [];
    let features = null;
    if (pose?.landmarks) {
      features = frameFeatures(pointsFromPose(pose, aspect));
      if (features) {
        this.history.push({ t: timeMs, features });
        if (this.firstTrackedAt === null) this.firstTrackedAt = timeMs;
        this.lastTrackedAt = timeMs;
      }
    }
    const cutoff = timeMs - HISTORY_MS;
    while (this.history.length && this.history[0].t < cutoff) this.history.shift();
    for (const [key, t] of this.announced) if (t < cutoff) this.announced.delete(key);

    const liveRep = this.coaches.get(this.liveExerciseId)?.currentRep;
    const midRep = liveRep && timeMs - liveRep.startedAt < MAX_REP_MS;
    if (this.current && !midRep && timeMs - this.current.lastActivityAt > SET_BREAK_MS) {
      this.closeSet(events, 'rest');
    }

    const frames = new Map();
    for (const [id, coach] of this.coaches) frames.set(id, coach.update(pose, timeMs, { aspect }));
    for (const [id, frame] of frames) {
      for (const event of frame.events) this.handle(id, event, timeMs, events);
    }
    this.confirmPending(timeMs, events);

    return this.snapshot(pose, features, frames.get(this.liveExerciseId), events);
  }

  /** Close the open set (if any) and return its 'set' event. Call when the session ends. */
  finish() {
    const events = [];
    this.closeSet(events, 'finish');
    return events;
  }

  classify(fromMs, toMs) {
    const span = [];
    for (const entry of this.history) {
      if (entry.t >= fromMs && entry.t <= toMs) span.push(entry.features);
    }
    return classifySpan(span);
  }

  /** The best-scoring exercise for a span, even below the recognition threshold. */
  static best(scores) {
    let id = null;
    let score = 0;
    for (const [key, value] of Object.entries(scores)) {
      if (value > score) {
        id = key;
        score = value;
      }
    }
    return { id, score };
  }

  /** Should a rep that FormCoach `id` just completed count? See KEEP_LIVE_MIN. */
  acceptsRep(id, verdict, rep) {
    const { scores } = verdict;
    const live = this.liveExerciseId;
    const top = AutoCoach.best(scores);
    if (id === live) return scores[id] >= KEEP_LIVE_MIN && top.score - scores[id] < SWITCH_MARGIN;
    if (verdict.exerciseId !== id) return false;
    // Naming or switching exercise takes a controlled rep: a quick flick of jitter
    // (e.g. noisy elbows during squats looking like a curl) must not do it.
    if (rep.durationMs < EXERCISES[id].minRepMs * SWITCH_MIN_TEMPO) return false;
    return live === null || scores[id] - scores[live] >= SWITCH_MARGIN;
  }

  handle(id, event, timeMs, events) {
    const coach = this.coaches.get(id);
    if (event.type === 'fault') {
      // Mid-rep corrections come from the exercise being coached, once the movement so
      // far looks like that exercise (see confirmPending). Tempo is judged at the end.
      if (event.check.id === TEMPO_CHECK.id || id !== this.liveExerciseId || !coach.currentRep) return;
      this.pending.push({ id, repStartedAt: coach.currentRep.startedAt, check: event.check });
      return;
    }

    if (event.type === 'rep') {
      if (event.rep.durationMs > MAX_REP_MS) return;
      const verdict = this.classify(event.rep.startedAt, event.rep.endedAt);
      if (this.acceptsRep(id, verdict, event.rep)) {
        this.acceptRep(id, event.rep, timeMs, events);
      } else if (id !== this.liveExerciseId && this.acceptsRep(id, verdict, { durationMs: Infinity })) {
        // Recognisably this exercise, only too quick to name it (see RUSHED_GAP_MS). Both
        // reps count, and each carries the tempo flag, so she tells them to slow down.
        const previous = this.rushed;
        if (previous?.id === id && timeMs - previous.at < RUSHED_GAP_MS) {
          this.rushed = null;
          this.acceptRep(id, previous.rep, previous.at, events);
          this.acceptRep(id, event.rep, timeMs, events);
        } else {
          this.rushed = { id, at: timeMs, rep: event.rep };
        }
      }
      return;
    }

    if (event.type === 'partial') {
      // A half rep has less movement than a full one, so it rarely meets the full
      // recognition threshold. For the coached exercise it counts unless the movement
      // looks more like something else. Only full reps name or switch the exercise:
      // half-rep spans are too short to tell real movement from jitter reliably.
      if (id !== this.liveExerciseId) return;
      if (event.endedAt - event.startedAt < PARTIAL_MIN_MS) return;
      if (event.endedAt - event.startedAt > MAX_REP_MS) return;
      const top = AutoCoach.best(this.classify(event.startedAt, event.endedAt).scores);
      if (top.id !== null && top.id !== id) return;
      const set = this.openSet(id, timeMs, events);
      set.partialReps += 1;
      set.lastActivityAt = timeMs;
      // Corrections she called out during the half rep belong in the set's record too.
      for (const faultId of event.faults ?? []) {
        const key = `${id}@${event.startedAt}:${faultId}`;
        if (!this.announced.has(key)) continue;
        set.faultCounts[faultId] = (set.faultCounts[faultId] ?? 0) + 1;
        this.announced.delete(key);
      }
      events.push({ type: 'partial', cue: event.cue, exerciseId: id });
    }
  }

  /**
   * Call out pending mid-rep faults once the rep so far is recognisably the coached
   * exercise. If it looks like something else (they've switched exercise), stay quiet.
   */
  confirmPending(timeMs, events) {
    if (this.pending.length === 0) return;
    const verdicts = new Map();
    this.pending = this.pending.filter((p) => {
      if (this.coaches.get(p.id).currentRep?.startedAt !== p.repStartedAt) return false;
      const spanKey = `${p.id}@${p.repStartedAt}`;
      if (!verdicts.has(spanKey)) verdicts.set(spanKey, this.classify(p.repStartedAt, timeMs));
      const verdict = verdicts.get(spanKey);
      if (verdict.exerciseId === p.id && verdict.confidence >= CONFIRM_FAULT_CONFIDENCE) {
        this.announced.set(`${spanKey}:${p.check.id}`, timeMs);
        events.push({ type: 'fault', check: p.check, exerciseId: p.id });
        return false;
      }
      // Keep waiting while it's this exercise but not yet certain; drop it if it's another.
      return verdict.exerciseId === null || verdict.exerciseId === p.id;
    });
  }

  openSet(id, timeMs, events) {
    if (this.current?.exercise.id === id) return this.current;
    const previous = this.liveExerciseId;
    if (this.current) this.closeSet(events, 'switch');
    this.current = {
      exercise: EXERCISES[id],
      reps: [],
      partialReps: 0,
      faultCounts: {},
      startedAt: timeMs,
      lastActivityAt: timeMs,
    };
    if (previous !== id) {
      this.liveExerciseId = id;
      events.push({ type: 'exercise', exerciseId: id, exercise: EXERCISES[id], previous });
    }
    return this.current;
  }

  acceptRep(id, rep, timeMs, events) {
    const set = this.openSet(id, timeMs, events);
    if (set.reps.length === 0) set.startedAt = rep.startedAt;
    set.reps.push(rep);
    set.lastActivityAt = timeMs;
    const exercise = EXERCISES[id];
    for (const faultId of rep.faults) {
      set.faultCounts[faultId] = (set.faultCounts[faultId] ?? 0) + 1;
      const key = `${id}@${rep.startedAt}:${faultId}`;
      // Faults on a rep we couldn't attribute yet (e.g. the first rep) are called now.
      if (!this.announced.has(key)) {
        events.push({ type: 'fault', check: checkFor(exercise, faultId), exerciseId: id, afterRep: true });
      }
      this.announced.delete(key);
    }
    events.push({ type: 'rep', exerciseId: id, count: set.reps.length, rep });
  }

  closeSet(events, reason) {
    if (!this.current) return;
    const set = summariseSet(this.current);
    this.sets.push(set);
    this.current = null;
    events.push({ type: 'set', set, reason });
  }

  snapshot(pose, features, liveFrame, events) {
    const set = this.current;
    const base = {
      exerciseId: this.liveExerciseId,
      exercise: this.exercise,
      reps: set?.reps.length ?? 0,
      cleanReps: set?.reps.filter((r) => r.faults.length === 0).length ?? 0,
      partialReps: set?.partialReps ?? 0,
      formScore: set?.reps.length ? Math.round(average(set.reps.map((r) => r.score))) : null,
      faultCounts: { ...(set?.faultCounts ?? {}) },
      state: 'rest',
      progress: 0,
      activeFaults: [],
      arc: null,
      events,
    };
    if (!pose?.landmarks) return { ...base, status: 'no_pose', hint: HINTS.noPose };
    if (!features) return { ...base, status: 'not_visible', hint: HINTS.fullBody };
    if (!liveFrame) return { ...base, status: 'detecting', hint: HINTS.detecting };
    if (liveFrame.status === 'not_visible') {
      return { ...base, status: 'not_visible', hint: liveFrame.hint };
    }
    if (liveFrame.status !== 'tracking') {
      // e.g. standing up after push-ups: maybe they're about to switch exercise.
      return { ...base, status: 'idle', hint: HINTS.waiting };
    }
    // Only highlight faults that have been confirmed (and called out) for this rep.
    const repStart = this.coaches.get(this.liveExerciseId).currentRep?.startedAt;
    const activeFaults = liveFrame.activeFaults.filter((check) => (
      this.announced.has(`${this.liveExerciseId}@${repStart}:${check.id}`)
    ));
    return {
      ...base,
      status: 'tracking',
      hint: null,
      value: liveFrame.value,
      rawValue: liveFrame.rawValue,
      progress: liveFrame.progress,
      state: liveFrame.state,
      arc: liveFrame.arc,
      activeFaults,
      metrics: liveFrame.metrics,
    };
  }

  /** Everything coached so far: closed sets plus the one in progress. */
  summary() {
    const sets = [...this.sets];
    if (this.current) sets.push(summariseSet(this.current));
    const reps = sets.flatMap((s) => s.repLog);
    const faults = sets
      .flatMap((s) => s.faults.map((f) => ({ ...f, exerciseId: s.exerciseId, exerciseName: s.exerciseName })))
      .sort((a, b) => b.count - a.count);
    return {
      sets,
      reps: reps.length,
      cleanReps: reps.filter((r) => r.faults.length === 0).length,
      partialReps: sets.reduce((sum, s) => sum + s.partialReps, 0),
      formScore: reps.length ? Math.round(average(reps.map((r) => r.score))) : null,
      avgRepMs: reps.length ? sets.reduce((sum, s) => sum + (s.avgRepMs ?? 0) * s.reps, 0) / reps.length : null,
      faults,
      durationMs: this.firstTrackedAt === null ? 0 : this.lastTrackedAt - this.firstTrackedAt,
    };
  }
}
