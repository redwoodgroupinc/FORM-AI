// Live coach controller: camera / video file / demo → pose model → AutoCoach → HUD + voice.
// There is no exercise picker: the AutoCoach recognises what the athlete is doing.

import { AutoCoach, EXERCISES, EXERCISE_ORDER, TEMPO_CHECK } from '../engine/index.js';
import { programFrame, DEMO_PROGRAM } from '../demo/synthetic.js';
import { drawSkeleton, faultJointsFor } from '../render/skeleton.js';
import { createPoseDetector } from './pose-detector.js';
import { VoiceCoach, PRIORITY } from './voice.js';
import { storage } from './storage.js';

const SETTINGS_KEY = 'formai.settings.v1';
const HISTORY_KEY = 'formai.history.v1';
const HISTORY_LIMIT = 30;
const LOST_TRACKING_MS = 1500;
const RING_CIRCUMFERENCE = 2 * Math.PI * 52;
// Keeps the demo athlete clear of the rep counter and controls at the bottom of the stage.
const DEMO_FRAMING = { frameScale: 0.36, floor: 0.8 };

const $ = (id) => document.getElementById(id);
const els = {
  stage: $('stage'),
  video: $('video'),
  canvas: $('overlay'),
  intro: $('intro'),
  introExercises: $('intro-exercises'),
  introError: $('intro-error'),
  loading: $('loading'),
  loadingText: $('loading-text'),
  statusDot: $('status-dot'),
  statusText: $('status-text'),
  hudExercise: $('hud-exercise'),
  angleLabel: $('angle-label'),
  angleValue: $('angle-value'),
  cue: $('cue'),
  cueText: $('cue-text'),
  repCount: $('rep-count'),
  depthFill: $('depth-fill'),
  btnPause: $('btn-pause'),
  setExercise: $('set-exercise'),
  statScore: $('stat-score'),
  statClean: $('stat-clean'),
  statPartial: $('stat-partial'),
  flagList: $('flag-list'),
  checkTitle: $('check-title'),
  checkList: $('check-list'),
  workoutSets: $('workout-sets'),
  history: $('history'),
  voiceToggle: $('voice-toggle'),
  voiceSelect: $('set-voice-name'),
  voiceNote: $('voice-note'),
  summaryDialog: $('summary-dialog'),
  settingsDialog: $('settings-dialog'),
};
const ctx = els.canvas.getContext('2d');

const DEFAULT_SETTINGS = {
  voice: true, countReps: true, haptics: true, showAngle: true, model: 'lite', voiceURI: 'auto',
};
const settings = { ...DEFAULT_SETTINGS, ...storage.get(SETTINGS_KEY, {}) };
const voice = new VoiceCoach({
  enabled: settings.voice, countReps: settings.countReps, voiceURI: settings.voiceURI,
});
const coach = new AutoCoach();
const params = new URLSearchParams(window.location.search);

const session = {
  mode: 'idle', // idle | camera | file | demo
  running: false,
  paused: false,
  stream: null,
  facingMode: 'user',
  mirrored: false,
  detector: null,
  rafId: 0,
  demoClock: 0,
  lastTickAt: null,
  lastVideoTime: -1,
  lostSince: null,
  cueHideAt: 0,
  cleanStreak: 0,
  fps: { frames: 0, since: 0, value: 0 },
  wakeLock: null,
  fileUrl: null,
  lastFile: null,
  shownExerciseId: undefined,
};

const plural = (n, exercise) => `${n} ${(n === 1 ? exercise.name : exercise.plural).toLowerCase()}`;

function checkFor(exerciseId, id) {
  if (id === TEMPO_CHECK.id) return TEMPO_CHECK;
  return EXERCISES[exerciseId]?.checks.find((c) => c.id === id);
}

// ---------------------------------------------------------------------------
// Static panels

function listItem(title, detail) {
  const li = document.createElement('li');
  const strong = document.createElement('strong');
  strong.textContent = title;
  const span = document.createElement('span');
  span.textContent = detail;
  li.append(strong, span);
  return li;
}

function renderIntro() {
  els.introExercises.replaceChildren(...EXERCISE_ORDER.map((id) => {
    const li = document.createElement('li');
    li.textContent = EXERCISES[id].name;
    return li;
  }));
}

/** Panel card: what she checks for the current exercise, or what she can recognise. */
function renderChecks() {
  const exercise = coach.exercise;
  if (!exercise) {
    els.checkTitle.textContent = 'What she recognises';
    els.checkList.replaceChildren(...EXERCISE_ORDER.map((id) => listItem(EXERCISES[id].name, EXERCISES[id].camera)));
    return;
  }
  els.checkTitle.textContent = `What she checks: ${exercise.name.toLowerCase()}`;
  const checks = [...exercise.checks, { label: 'Partial reps', cue: exercise.partialCue }, TEMPO_CHECK];
  els.checkList.replaceChildren(...checks.map((check) => listItem(check.label, `“${check.cue}”`)));
}

// ---------------------------------------------------------------------------
// Sources

function showError(message) {
  els.introError.textContent = message;
  els.introError.hidden = false;
  els.intro.hidden = false;
}

function hideError() {
  els.introError.hidden = true;
}

function showLoading(text) {
  els.loadingText.textContent = text;
  els.loading.hidden = false;
}

function hideLoading() {
  els.loading.hidden = true;
}

function describeError(error) {
  const name = error?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera access was blocked. Allow camera access for this site in your browser settings, or watch the demo instead.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No camera was found. Connect a camera, analyse a video file, or watch the demo.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'Your camera is busy in another app. Close it there and try again.';
  }
  if (error?.code === 'MODEL_LOAD') {
    return "Couldn't load the pose model. Check your internet connection and try again. It only downloads once.";
  }
  return `Something went wrong: ${error?.message ?? error}`;
}

async function ensureDetector() {
  if (session.detector && session.detector.model === settings.model) return session.detector;
  session.detector?.close();
  session.detector = null;
  try {
    session.detector = await createPoseDetector({ model: settings.model });
  } catch (cause) {
    console.error(cause);
    const error = new Error('Pose model failed to load');
    error.code = 'MODEL_LOAD';
    throw error;
  }
  return session.detector;
}

function stopStream() {
  session.stream?.getTracks().forEach((track) => track.stop());
  session.stream = null;
  if (els.video.srcObject) els.video.srcObject = null;
}

async function openCamera() {
  stopStream();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: session.facingMode,
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  });
  session.stream = stream;
  els.video.removeAttribute('src');
  els.video.srcObject = stream;
  els.video.muted = true;
  await els.video.play();
  // Desktop webcams don't report a facing mode; treat them like a selfie camera.
  const facing = stream.getVideoTracks()[0]?.getSettings?.().facingMode;
  session.mirrored = facing ? facing === 'user' : true;
}

async function startCamera() {
  hideError();
  voice.unlock();
  if (!navigator.mediaDevices?.getUserMedia) {
    showError(window.isSecureContext
      ? "This browser can't access the camera. Try the latest Chrome, Safari or Edge."
      : 'The camera needs a secure connection. Open this page over https:// or on localhost.');
    return;
  }
  try {
    showLoading('Loading on-device pose model…');
    await ensureDetector();
    showLoading('Waiting for camera permission…');
    await openCamera();
    hideLoading();
    beginSession('camera');
  } catch (error) {
    hideLoading();
    stopStream();
    showError(describeError(error));
  }
}

function startDemo() {
  hideError();
  voice.unlock();
  stopStream();
  session.mirrored = false;
  beginSession('demo');
}

async function startFile(file) {
  if (!file) return;
  hideError();
  voice.unlock();
  try {
    showLoading('Loading on-device pose model…');
    await ensureDetector();
    stopStream();
    if (session.fileUrl) URL.revokeObjectURL(session.fileUrl);
    session.fileUrl = URL.createObjectURL(file);
    session.lastFile = file;
    els.video.srcObject = null;
    els.video.loop = false;
    els.video.muted = true;
    els.video.src = session.fileUrl;
    await els.video.play();
    session.mirrored = false;
    hideLoading();
    beginSession('file');
  } catch (error) {
    hideLoading();
    showError(error?.code === 'MODEL_LOAD' ? describeError(error) : "That video couldn't be played. Try an MP4 or MOV file.");
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle

function beginSession(mode) {
  session.mode = mode;
  session.running = true;
  session.paused = false;
  session.demoClock = 0;
  session.lastTickAt = null;
  session.lastVideoTime = -1;
  session.lostSince = null;
  session.cleanStreak = 0;
  session.fps = { frames: 0, since: performance.now(), value: 0 };

  els.stage.dataset.mode = mode;
  els.stage.classList.toggle('is-mirrored', session.mirrored);
  els.stage.classList.add('is-running');
  els.intro.hidden = true;
  setPauseButton(false);

  coach.reset();
  resetWorkoutUI();
  sizeCanvas();
  requestWakeLock();
  voice.say(mode === 'demo'
    ? "Here's a demo. Watch how I recognise each exercise."
    : "I'm watching. Start any exercise when you're ready.", {
    key: 'start', priority: PRIORITY.info, cooldownMs: 0,
  });

  cancelAnimationFrame(session.rafId);
  session.rafId = requestAnimationFrame(tick);
}

function stopSession() {
  session.running = false;
  session.paused = false;
  cancelAnimationFrame(session.rafId);
  stopStream();
  if (session.mode === 'file') {
    els.video.pause();
    els.video.removeAttribute('src');
    els.video.load();
  }
  if (session.fileUrl) {
    URL.revokeObjectURL(session.fileUrl);
    session.fileUrl = null;
  }
  releaseWakeLock();
  session.mode = 'idle';
  els.stage.dataset.mode = 'idle';
  els.stage.classList.remove('is-running', 'is-mirrored');
  els.intro.hidden = false;
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  hideCue();
}

function finishWorkout() {
  if (!session.running) return;
  for (const event of coach.finish()) saveHistory(event.set);
  const summary = coach.summary();
  const mode = session.mode;
  stopSession();
  renderWorkoutSets();
  voice.say(summary.reps > 0 ? `Workout complete. ${summary.reps} reps. Great work.` : 'Workout ended.', {
    key: 'end', priority: PRIORITY.fault, cooldownMs: 0,
  });
  showSummary(summary, mode);
}

function togglePause() {
  if (!session.running) return;
  session.paused = !session.paused;
  setPauseButton(session.paused);
  if (session.paused) {
    if (session.mode === 'file') els.video.pause();
    voice.cancel();
    setStatus('idle', 'Paused');
  } else {
    session.lastTickAt = null;
    if (session.mode === 'file') els.video.play();
  }
}

function setPauseButton(paused) {
  els.btnPause.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
  els.btnPause.querySelector('use').setAttribute('href', paused ? '#i-play' : '#i-pause');
}

async function flipCamera() {
  if (session.mode !== 'camera') return;
  session.facingMode = session.facingMode === 'user' ? 'environment' : 'user';
  try {
    await openCamera();
    els.stage.classList.toggle('is-mirrored', session.mirrored);
    session.lastVideoTime = -1;
    sizeCanvas();
  } catch (error) {
    session.facingMode = session.facingMode === 'user' ? 'environment' : 'user';
    showCue("Couldn't switch camera", 'warn', performance.now(), 1800);
    try {
      await openCamera();
    } catch {
      stopSession();
      showError(describeError(error));
    }
  }
}

async function requestWakeLock() {
  try {
    session.wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    session.wakeLock = null;
  }
}

function releaseWakeLock() {
  session.wakeLock?.release?.().catch(() => {});
  session.wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && session.running && session.mode !== 'demo') requestWakeLock();
});

// ---------------------------------------------------------------------------
// Frame loop

function sizeCanvas() {
  if (session.mode === 'demo' || session.mode === 'idle') {
    const rect = els.stage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    els.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    els.canvas.height = Math.max(1, Math.round(rect.height * dpr));
  } else {
    els.canvas.width = els.video.videoWidth || 1280;
    els.canvas.height = els.video.videoHeight || 720;
  }
}

window.addEventListener('resize', () => {
  if (session.mode === 'demo') sizeCanvas();
});

function tick(now) {
  if (!session.running) return;
  session.rafId = requestAnimationFrame(tick);
  if (session.paused) return;

  let pose;
  let time = now;
  const aspect = els.canvas.width / els.canvas.height;
  if (session.mode === 'demo') {
    // The demo runs on its own clock so a stalled frame never skips part of a rep.
    session.demoClock += session.lastTickAt === null ? 0 : Math.min(now - session.lastTickAt, 50);
    session.lastTickAt = now;
    time = session.demoClock;
    pose = programFrame(time, DEMO_PROGRAM, { aspect, ...DEMO_FRAMING }).pose;
  } else {
    const video = els.video;
    if (video.readyState < 2 || video.currentTime === session.lastVideoTime) return;
    session.lastVideoTime = video.currentTime;
    if (els.canvas.width !== video.videoWidth || els.canvas.height !== video.videoHeight) sizeCanvas();
    try {
      pose = session.detector.detect(video, now);
    } catch (error) {
      console.error(error);
      return;
    }
  }

  const result = coach.update(pose, time, { aspect: els.canvas.width / els.canvas.height });
  draw(pose, result, now);
  handleEvents(result.events, now);
  updateHud(result, now);
  countFps(now);
}

function draw(pose, result, now) {
  const { width, height } = els.canvas;
  ctx.clearRect(0, 0, width, height);
  if (!pose) return;
  drawSkeleton(ctx, pose.landmarks, {
    width,
    height,
    mirror: session.mirrored,
    faultJoints: faultJointsFor(result.activeFaults),
    arc: settings.showAngle ? result.arc : null,
    angle: result.value ?? null,
    time: now,
  });
}

function countFps(now) {
  const fps = session.fps;
  fps.frames += 1;
  if (now - fps.since >= 1000) {
    fps.value = Math.round((fps.frames * 1000) / (now - fps.since));
    fps.frames = 0;
    fps.since = now;
  }
}

/**
 * Turn one frame's coaching events into on-screen cues and a single spoken line, in the
 * order a coach would say them: the exercise, then corrections, then the count.
 */
function handleEvents(events, now) {
  if (events.length === 0) return;
  const speech = [];
  const faultThisFrame = events.some((e) => e.type === 'fault');
  const newExercise = events.find((e) => e.type === 'exercise');

  for (const event of events) {
    if (event.type === 'set') {
      saveHistory(event.set);
      renderWorkoutSets();
      if (event.reason === 'rest') {
        const exercise = EXERCISES[event.set.exerciseId];
        showCue(`Set saved: ${plural(event.set.reps, exercise)}`, 'good', now, 2200);
        speech.push({ text: `Nice set. ${plural(event.set.reps, exercise)}. Rest up`, key: 'set', priority: PRIORITY.info, cooldownMs: 0 });
      }
    } else if (event.type === 'exercise') {
      showCue(`${event.exercise.name} detected`, 'good', now, 1800);
      speech.push({ text: event.exercise.plural, key: 'exercise', priority: PRIORITY.fault, cooldownMs: 0 });
      session.cleanStreak = 0;
      renderChecks();
    } else if (event.type === 'fault') {
      const { check } = event;
      showCue(check.cue, 'bad', now, 2200);
      speech.push({ text: check.cue, key: check.id, priority: PRIORITY.fault, cooldownMs: 5000 });
      // Browsers reject vibration before the first tap (e.g. an auto-started demo).
      if (settings.haptics && navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.(150);
    } else if (event.type === 'partial') {
      showCue(event.cue, 'warn', now, 2000);
      speech.push({ text: event.cue, key: 'partial', priority: PRIORITY.partial, cooldownMs: 5000 });
    } else if (event.type === 'rep') {
      bumpRepCount(event.count);
      const clean = event.rep.faults.length === 0;
      session.cleanStreak = clean ? session.cleanStreak + 1 : 0;
      // A correction is more useful than the number, so it takes the count's place.
      if (!faultThisFrame && settings.countReps) {
        speech.push({ text: String(event.count), key: 'count', priority: PRIORITY.count, cooldownMs: 0 });
      }
      if (clean && session.cleanStreak > 0 && session.cleanStreak % 5 === 0 && !newExercise) {
        showCue(`${session.cleanStreak} clean reps in a row`, 'good', now, 1600);
        speech.push({ text: 'Great form. Keep it up', key: 'streak', priority: PRIORITY.info, cooldownMs: 10000 });
      }
    }
  }

  if (speech.length) voice.sayAll(speech);
  renderSetPanel();
  renderWorkoutSets();
}

function updateHud(result, now) {
  const exercise = coach.exercise;
  if (session.shownExerciseId !== result.exerciseId) {
    session.shownExerciseId = result.exerciseId;
    els.hudExercise.textContent = exercise ? exercise.name : 'Detecting exercise';
    els.hudExercise.classList.toggle('is-detecting', !exercise);
    els.angleLabel.textContent = exercise?.primaryLabel ?? 'Joint angle';
    els.setExercise.textContent = exercise ? exercise.name : 'Waiting for your first rep';
    renderChecks();
  }

  const fps = session.mode === 'demo' || !session.fps.value ? '' : ` · ${session.fps.value} fps`;
  if (result.status === 'tracking' || result.status === 'idle' || result.status === 'detecting') {
    session.lostSince = null;
    if (result.status === 'detecting') {
      setStatus('ok', `Watching${fps}`);
    } else {
      setStatus('ok', `${result.state === 'rest' ? 'Ready' : 'Tracking'}${fps}`);
    }
    els.angleValue.textContent = result.value === undefined ? '--' : `${Math.round(result.value)}°`;
  } else {
    setStatus('warn', result.hint ?? 'Step into the frame');
    els.angleValue.textContent = '--';
    if (session.lostSince === null) session.lostSince = now;
    if (now - session.lostSince > LOST_TRACKING_MS && result.hint) {
      if (now > session.cueHideAt || els.cue.classList.contains('is-warn')) {
        showCue(result.hint, 'warn', now, 600);
      }
      voice.say(result.hint, { key: 'frame', priority: PRIORITY.info, cooldownMs: 9000 });
    }
  }
  els.depthFill.style.height = `${Math.round((result.progress ?? 0) * 100)}%`;
  if (now > session.cueHideAt) hideCue();
}

function setStatus(kind, text) {
  els.statusDot.className = `dot ${kind === 'ok' ? '' : kind === 'warn' ? 'is-warn' : 'is-idle'}`;
  if (els.statusText.textContent !== text) els.statusText.textContent = text;
}

function showCue(text, tone, now, ms) {
  els.cueText.textContent = text;
  els.cue.classList.remove('is-warn', 'is-good');
  if (tone === 'warn') els.cue.classList.add('is-warn');
  if (tone === 'good') els.cue.classList.add('is-good');
  els.cue.querySelector('use').setAttribute('href', tone === 'good' ? '#i-check' : '#i-alert');
  els.cue.classList.add('is-visible');
  session.cueHideAt = now + ms;
}

function hideCue() {
  els.cue.classList.remove('is-visible');
}

function bumpRepCount(count) {
  els.repCount.textContent = String(count);
  els.repCount.classList.remove('bump');
  void els.repCount.offsetWidth; // restart the CSS animation
  els.repCount.classList.add('bump');
}

// ---------------------------------------------------------------------------
// Panel

function resetWorkoutUI() {
  session.shownExerciseId = undefined;
  els.repCount.textContent = '0';
  els.depthFill.style.height = '0%';
  els.angleValue.textContent = '--';
  els.hudExercise.textContent = 'Detecting exercise';
  els.hudExercise.classList.add('is-detecting');
  els.setExercise.textContent = 'Waiting for your first rep';
  renderChecks();
  renderSetPanel();
  renderWorkoutSets();
}

function renderSetPanel() {
  const set = coach.current;
  const reps = set?.reps ?? [];
  const score = reps.length ? Math.round(reps.reduce((sum, r) => sum + r.score, 0) / reps.length) : null;
  els.statScore.textContent = score === null ? '--' : String(score);
  els.statClean.textContent = String(reps.filter((r) => r.faults.length === 0).length);
  els.statPartial.textContent = String(set?.partialReps ?? 0);
  if (!set) els.repCount.textContent = '0';

  const entries = Object.entries(set?.faultCounts ?? {}).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = reps.length > 0 ? 'No flags. Clean set so far.' : 'No flags yet.';
    els.flagList.replaceChildren(li);
    return;
  }
  els.flagList.replaceChildren(...entries.map(([id, count]) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'flag-name';
    name.textContent = checkFor(set.exercise.id, id)?.label ?? id;
    const badge = document.createElement('span');
    badge.className = 'flag-count';
    badge.textContent = `×${count}`;
    li.append(name, badge);
    return li;
  }));
}

function setRow(name, detail, stats, score) {
  const li = document.createElement('li');
  const left = document.createElement('div');
  const title = document.createElement('span');
  title.className = 'h-name';
  title.textContent = name;
  const sub = document.createElement('span');
  sub.className = 'h-date';
  sub.textContent = detail;
  left.append(title, sub);
  const right = document.createElement('div');
  right.className = 'h-stats';
  right.append(stats);
  if (score !== null && score !== undefined) {
    const s = document.createElement('span');
    s.className = 'h-score';
    s.textContent = ` · ${score}`;
    right.append(s);
  }
  li.append(left, right);
  return li;
}

/** Sets recognised in this workout, including the one in progress. */
function renderWorkoutSets() {
  const { sets } = coach.summary();
  if (sets.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Each exercise she recognises becomes a set here.';
    els.workoutSets.replaceChildren(li);
    return;
  }
  const open = coach.current ? sets.length - 1 : -1;
  els.workoutSets.replaceChildren(...sets.map((set, i) => setRow(
    set.exerciseName,
    i === open ? 'In progress' : (set.faults[0] ? set.faults[0].label : 'Clean set'),
    `${set.reps} reps`,
    set.formScore,
  )));
}

function saveHistory(set) {
  if (!set || (set.reps === 0 && set.partialReps === 0)) return;
  const history = storage.get(HISTORY_KEY, []);
  const list = Array.isArray(history) ? history : [];
  list.unshift({
    at: Date.now(),
    exerciseId: set.exerciseId,
    exerciseName: set.exerciseName,
    reps: set.reps,
    cleanReps: set.cleanReps,
    formScore: set.formScore,
  });
  storage.set(HISTORY_KEY, list.slice(0, HISTORY_LIMIT));
  renderHistory();
}

const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

function renderHistory() {
  const history = storage.get(HISTORY_KEY, []);
  const list = Array.isArray(history) ? history.slice(0, 6) : [];
  if (list.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No sets yet. Finish a set to see it here.';
    els.history.replaceChildren(li);
    return;
  }
  els.history.replaceChildren(...list.map((item) => setRow(
    String(item.exerciseName ?? 'Set'),
    dateFormat.format(new Date(item.at)),
    `${Number(item.reps) || 0} reps`,
    item.formScore,
  )));
}

// ---------------------------------------------------------------------------
// Summary dialog

function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function showSummary(summary, mode) {
  const { sets } = summary;
  const exerciseCount = new Set(sets.map((s) => s.exerciseId)).size;
  $('summary-eyebrow').textContent = sets.length === 0
    ? 'Workout'
    : sets.length === 1
      ? sets[0].exerciseName
      : `${sets.length} sets · ${exerciseCount} exercise${exerciseCount === 1 ? '' : 's'}`;
  $('summary-reps').textContent = String(summary.reps);
  $('summary-score').textContent = summary.formScore === null ? '--' : String(summary.formScore);
  $('summary-clean').textContent = String(summary.cleanReps);
  $('summary-partial').textContent = String(summary.partialReps);
  $('summary-tempo').textContent = summary.avgRepMs ? `${(summary.avgRepMs / 1000).toFixed(1)}s` : '--';
  $('summary-duration').textContent = formatDuration(summary.durationMs);

  const setList = $('summary-sets');
  setList.hidden = sets.length === 0;
  setList.replaceChildren(...sets.map((set) => setRow(
    set.exerciseName,
    set.faults[0] ? `${set.faults[0].label} ×${set.faults[0].count}` : 'Clean set',
    `${set.reps} reps`,
    set.formScore,
  )));

  const ring = $('score-ring');
  const score = summary.formScore ?? 0;
  ring.classList.toggle('is-mid', score < 80 && score >= 60);
  ring.classList.toggle('is-low', score < 60);
  const fill = $('ring-fill');
  fill.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
  requestAnimationFrame(() => {
    fill.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - score / 100));
  });

  const focus = $('summary-focus');
  const top = summary.faults[0];
  const title = document.createElement('strong');
  const body = document.createElement('span');
  focus.classList.toggle('is-fault', Boolean(top));
  if (summary.reps === 0) {
    const partialSet = sets.find((s) => s.partialReps > 0);
    title.textContent = 'No full reps detected';
    body.textContent = partialSet
      ? `Some reps didn't reach full range. ${EXERCISES[partialSet.exerciseId].partialCue}.`
      : 'Make sure your whole body is in frame, then move through the full range of motion.';
  } else if (top) {
    title.textContent = `Next time, focus on: “${top.cue}”`;
    body.textContent = `${top.label} on ${plural(top.count, EXERCISES[top.exerciseId])}.`;
  } else if (summary.partialReps > 0) {
    const partialSet = sets.find((s) => s.partialReps > 0);
    title.textContent = `Next time: “${EXERCISES[partialSet.exerciseId].partialCue}”`;
    body.textContent = `${summary.partialReps} partial rep${summary.partialReps === 1 ? '' : 's'} didn't count.`;
  } else {
    title.textContent = 'Every rep was clean';
    body.textContent = 'Great control. Add a few reps or a little weight next time.';
  }
  focus.replaceChildren(title, body);

  els.summaryDialog.dataset.mode = mode;
  els.summaryDialog.returnValue = '';
  els.summaryDialog.showModal();
}

els.summaryDialog.addEventListener('close', () => {
  if (els.summaryDialog.returnValue !== 'again') return;
  const mode = els.summaryDialog.dataset.mode;
  if (mode === 'camera') startCamera();
  else if (mode === 'demo') startDemo();
  else if (mode === 'file' && session.lastFile) startFile(session.lastFile);
});

// ---------------------------------------------------------------------------
// Settings

function saveSettings() {
  storage.set(SETTINGS_KEY, settings);
}

function syncVoiceToggle() {
  els.voiceToggle.setAttribute('aria-pressed', String(settings.voice));
  els.voiceToggle.setAttribute('aria-label', settings.voice ? 'Voice cues on' : 'Voice cues off');
  els.voiceToggle.querySelector('use').setAttribute('href', settings.voice ? '#i-voice' : '#i-mute');
  $('set-voice').checked = settings.voice;
}

/** Fill the coach-voice picker with the female voices available on this device. */
function renderVoiceOptions() {
  const select = els.voiceSelect;
  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = 'Automatic (best female voice)';
  const options = voice.femaleVoices.map((v) => {
    const option = document.createElement('option');
    option.value = v.voiceURI;
    option.textContent = `${v.name} (${v.lang})`;
    return option;
  });
  select.replaceChildren(auto, ...options);
  const chosen = voice.femaleVoices.some((v) => v.voiceURI === settings.voiceURI) ? settings.voiceURI : 'auto';
  select.value = chosen;
  if (!voice.supported) {
    els.voiceNote.textContent = "This browser can't speak, so cues are shown on screen only.";
  } else if (voice.femaleVoices.length === 0) {
    els.voiceNote.textContent = voice.voice
      ? 'No female voice is installed on this device, so she uses the closest available voice.'
      : 'Voices are still loading.';
  } else {
    els.voiceNote.textContent = `Speaking as ${voice.voice?.name ?? 'the default voice'}`;
  }
}

function bindSettings() {
  const bindings = [
    ['set-voice', 'voice'],
    ['set-count', 'countReps'],
    ['set-haptics', 'haptics'],
    ['set-angle', 'showAngle'],
  ];
  for (const [id, key] of bindings) {
    const input = $(id);
    input.checked = Boolean(settings[key]);
    input.addEventListener('change', () => {
      settings[key] = input.checked;
      voice.enabled = settings.voice;
      voice.countReps = settings.countReps;
      if (!settings.voice) voice.cancel();
      syncVoiceToggle();
      saveSettings();
    });
  }

  els.voiceSelect.addEventListener('change', () => {
    settings.voiceURI = els.voiceSelect.value;
    voice.setVoice(settings.voiceURI);
    saveSettings();
  });
  $('voice-preview').addEventListener('click', () => {
    voice.cancel();
    voice.say("Hi, I'm your coach. Squats. One. Two. Push your knees out.", {
      key: 'preview', priority: PRIORITY.fault, cooldownMs: 0,
    });
  });
  voice.onvoiceschange = renderVoiceOptions;
  renderVoiceOptions();

  for (const radio of document.querySelectorAll('input[name="model"]')) {
    radio.checked = radio.value === settings.model;
    radio.addEventListener('change', async () => {
      if (!radio.checked) return;
      settings.model = radio.value;
      saveSettings();
      if (!session.running || session.mode === 'demo') return;
      showLoading('Switching tracking model…');
      try {
        await ensureDetector();
      } catch (error) {
        stopSession();
        showError(describeError(error));
      } finally {
        hideLoading();
      }
    });
  }

  els.voiceToggle.addEventListener('click', () => {
    settings.voice = !settings.voice;
    voice.enabled = settings.voice;
    if (!settings.voice) voice.cancel();
    else voice.unlock();
    syncVoiceToggle();
    saveSettings();
  });
  syncVoiceToggle();
}

// ---------------------------------------------------------------------------
// Wire up

$('start-camera').addEventListener('click', startCamera);
$('start-demo').addEventListener('click', startDemo);
$('video-file').addEventListener('change', (event) => {
  startFile(event.target.files?.[0]);
  event.target.value = '';
});
$('btn-end').addEventListener('click', finishWorkout);
$('btn-pause').addEventListener('click', togglePause);
$('btn-flip').addEventListener('click', flipCamera);
$('btn-reset').addEventListener('click', () => {
  coach.reset();
  session.cleanStreak = 0;
  resetWorkoutUI();
  showCue('Starting over', 'good', performance.now(), 1000);
});
$('open-settings').addEventListener('click', () => {
  renderVoiceOptions();
  els.settingsDialog.showModal();
});
$('clear-history').addEventListener('click', () => {
  storage.remove(HISTORY_KEY);
  renderHistory();
});
els.video.addEventListener('ended', () => {
  if (session.mode === 'file') finishWorkout();
});
els.video.addEventListener('resize', () => {
  if (session.mode === 'camera' || session.mode === 'file') sizeCanvas();
});

renderIntro();
resetWorkoutUI();
renderHistory();
bindSettings();

if (params.has('demo')) startDemo();
