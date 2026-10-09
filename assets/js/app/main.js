// Live coach controller: camera / video file / demo source → pose model → FormCoach → HUD + voice.

import { FormCoach, EXERCISES, EXERCISE_ORDER, TEMPO_CHECK } from '../engine/index.js';
import { demoFrame } from '../demo/synthetic.js';
import { drawSkeleton, faultJointsFor } from '../render/skeleton.js';
import { createPoseDetector } from './pose-detector.js';
import { VoiceCoach, PRIORITY } from './voice.js';
import { storage } from './storage.js';

const SETTINGS_KEY = 'formai.settings.v1';
const HISTORY_KEY = 'formai.history.v1';
const EXERCISE_KEY = 'formai.exercise.v1';
const HISTORY_LIMIT = 20;
const LOST_TRACKING_MS = 1500;
const RING_CIRCUMFERENCE = 2 * Math.PI * 52;
// Keeps the demo squatter clear of the rep counter and controls at the bottom of the stage.
const DEMO_FRAMING = { frameScale: 0.36, floor: 0.8 };

const $ = (id) => document.getElementById(id);
const els = {
  stage: $('stage'),
  video: $('video'),
  canvas: $('overlay'),
  tabs: $('exercise-tabs'),
  intro: $('intro'),
  introEyebrow: $('intro-eyebrow'),
  introCamera: $('intro-camera'),
  introChecks: $('intro-checks'),
  introError: $('intro-error'),
  loading: $('loading'),
  loadingText: $('loading-text'),
  statusDot: $('status-dot'),
  statusText: $('status-text'),
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
  checkList: $('check-list'),
  history: $('history'),
  voiceToggle: $('voice-toggle'),
  summaryDialog: $('summary-dialog'),
  settingsDialog: $('settings-dialog'),
};
const ctx = els.canvas.getContext('2d');

const DEFAULT_SETTINGS = { voice: true, countReps: true, haptics: true, showAngle: true, model: 'lite' };
const settings = { ...DEFAULT_SETTINGS, ...storage.get(SETTINGS_KEY, {}) };
const voice = new VoiceCoach({ enabled: settings.voice, countReps: settings.countReps });

const params = new URLSearchParams(window.location.search);
let exerciseId = [params.get('exercise'), storage.get(EXERCISE_KEY)]
  .find((id) => id && EXERCISES[id]) ?? 'squat';
let coach = new FormCoach(EXERCISES[exerciseId]);

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
  lastMode: null,
};

const exercise = () => EXERCISES[exerciseId];

// ---------------------------------------------------------------------------
// Exercise selection

function renderTabs() {
  els.tabs.replaceChildren(...EXERCISE_ORDER.map((id) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'tab';
    tab.setAttribute('role', 'tab');
    tab.dataset.id = id;
    tab.textContent = EXERCISES[id].name;
    tab.addEventListener('click', () => selectExercise(id));
    return tab;
  }));
  syncTabs();
}

function syncTabs() {
  for (const tab of els.tabs.children) {
    const selected = tab.dataset.id === exerciseId;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
}

els.tabs.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
  const index = EXERCISE_ORDER.indexOf(exerciseId);
  const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + EXERCISE_ORDER.length) % EXERCISE_ORDER.length;
  selectExercise(EXERCISE_ORDER[next]);
  els.tabs.children[next].focus();
});

function selectExercise(id) {
  if (id === exerciseId || !EXERCISES[id]) return;
  exerciseId = id;
  storage.set(EXERCISE_KEY, id);
  const url = new URL(window.location.href);
  url.searchParams.set('exercise', id);
  url.searchParams.delete('demo');
  window.history.replaceState(null, '', url);

  // The demo set is a squat, so switching away from it ends the demo.
  if (session.mode === 'demo' && session.running) stopSession();

  coach = new FormCoach(exercise());
  session.cleanStreak = 0;
  syncTabs();
  renderExerciseInfo();
  resetSetUI();
  if (session.running) showCue(`Switched to ${exercise().name}`, 'good', performance.now(), 1400);
}

function renderExerciseInfo() {
  const ex = exercise();
  els.introEyebrow.textContent = ex.name;
  els.introCamera.textContent = ex.camera;
  els.setExercise.textContent = ex.name;
  els.angleLabel.textContent = ex.primaryLabel;

  const chips = ['Rep counting', 'Full range of motion', ...ex.checks.map((c) => c.label), 'Tempo'];
  els.introChecks.replaceChildren(...chips.map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));

  const checks = [
    ...ex.checks,
    { label: 'Partial reps', cue: ex.partialCue },
    TEMPO_CHECK,
  ];
  els.checkList.replaceChildren(...checks.map((check) => {
    const li = document.createElement('li');
    const strong = document.createElement('strong');
    strong.textContent = check.label;
    const span = document.createElement('span');
    span.textContent = `“${check.cue}”`;
    li.append(strong, span);
    return li;
  }));
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
    return 'Camera access was blocked. Allow camera access for this site in your browser settings, or watch the demo set instead.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No camera was found. Connect a camera, analyse a video file, or watch the demo set.';
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
  if (exerciseId !== 'squat') selectExercise('squat');
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
  session.lastMode = mode;
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
  resetSetUI();
  sizeCanvas();
  requestWakeLock();
  voice.say(mode === 'demo' ? 'Demo set. Watch the cues.' : 'Ready. Start when you are.', {
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

function endSet() {
  if (!session.running) return;
  const summary = coach.summary();
  const mode = session.mode;
  stopSession();
  if (summary.reps > 0 || summary.partialReps > 0) saveHistory(summary);
  voice.say(summary.reps > 0 ? `Set complete. ${summary.reps} reps.` : 'Set ended.', {
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
  if (session.mode === 'demo') {
    // The demo runs on its own clock so a stalled frame never skips part of a rep.
    session.demoClock += session.lastTickAt === null ? 0 : Math.min(now - session.lastTickAt, 50);
    session.lastTickAt = now;
    time = session.demoClock;
    pose = demoFrame(time, { aspect: els.canvas.width / els.canvas.height, ...DEMO_FRAMING }).pose;
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

function handleEvents(events, now) {
  const faultThisFrame = events.some((e) => e.type === 'fault');
  for (const event of events) {
    if (event.type === 'fault') {
      const { check } = event;
      showCue(check.cue, 'bad', now, 2200);
      voice.say(check.cue, { key: check.id, priority: PRIORITY.fault, cooldownMs: 5000 });
      // Browsers reject vibration before the first tap (e.g. an auto-started demo).
      if (settings.haptics && navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.(150);
      renderFlags();
    } else if (event.type === 'partial') {
      showCue(event.cue, 'warn', now, 2000);
      voice.say(event.cue, { key: 'partial', priority: PRIORITY.partial, cooldownMs: 5000 });
      renderStats();
    } else if (event.type === 'rep') {
      bumpRepCount(event.count);
      const clean = event.rep.faults.length === 0;
      session.cleanStreak = clean ? session.cleanStreak + 1 : 0;
      // A form correction on the same frame is more useful than the number.
      if (!faultThisFrame) voice.count(event.count);
      if (clean && session.cleanStreak % 5 === 0) {
        showCue(`${session.cleanStreak} clean reps in a row`, 'good', now, 1600);
        window.setTimeout(() => {
          voice.say('Great form. Keep it up.', { key: 'streak', priority: PRIORITY.info, cooldownMs: 10000 });
        }, 700);
      }
      renderStats();
    }
  }
}

function updateHud(result, now) {
  const ex = exercise();
  if (result.status === 'tracking') {
    session.lostSince = null;
    const phase = result.state === 'rest' ? 'Ready' : 'Tracking';
    const fps = session.mode === 'demo' || !session.fps.value ? '' : ` · ${session.fps.value} fps`;
    setStatus('ok', `${ex.name} · ${phase}${fps}`);
    els.angleValue.textContent = `${Math.round(result.value)}°`;
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

function resetSetUI() {
  els.repCount.textContent = '0';
  els.depthFill.style.height = '0%';
  els.angleValue.textContent = '--';
  renderStats();
  renderFlags();
}

function renderStats() {
  const score = coach.formScore();
  els.statScore.textContent = score === null ? '--' : String(score);
  els.statClean.textContent = String(coach.repLog.filter((r) => r.faults.length === 0).length);
  els.statPartial.textContent = String(coach.partialReps);
}

function renderFlags() {
  const entries = coach.summary().faults;
  if (entries.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = coach.reps > 0 ? 'No flags. Clean set so far.' : 'No flags yet.';
    els.flagList.replaceChildren(li);
    return;
  }
  els.flagList.replaceChildren(...entries.map((fault) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'flag-name';
    name.textContent = fault.label;
    const count = document.createElement('span');
    count.className = 'flag-count';
    count.textContent = `×${fault.count}`;
    li.append(name, count);
    return li;
  }));
}

function saveHistory(summary) {
  const history = storage.get(HISTORY_KEY, []);
  const list = Array.isArray(history) ? history : [];
  list.unshift({
    at: Date.now(),
    exerciseId: summary.exerciseId,
    exerciseName: summary.exerciseName,
    reps: summary.reps,
    cleanReps: summary.cleanReps,
    formScore: summary.formScore,
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
  els.history.replaceChildren(...list.map((item) => {
    const li = document.createElement('li');
    const left = document.createElement('div');
    const name = document.createElement('span');
    name.className = 'h-name';
    name.textContent = String(item.exerciseName ?? 'Set');
    const date = document.createElement('span');
    date.className = 'h-date';
    date.textContent = dateFormat.format(new Date(item.at));
    left.append(name, date);

    const right = document.createElement('div');
    right.className = 'h-stats';
    right.append(`${Number(item.reps) || 0} reps`);
    if (item.formScore !== null && item.formScore !== undefined) {
      const score = document.createElement('span');
      score.className = 'h-score';
      score.textContent = ` · ${item.formScore}`;
      right.append(score);
    }
    li.append(left, right);
    return li;
  }));
}

// ---------------------------------------------------------------------------
// Summary dialog

function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function showSummary(summary, mode) {
  $('summary-exercise').textContent = summary.exerciseName;
  $('summary-reps').textContent = String(summary.reps);
  $('summary-score').textContent = summary.formScore === null ? '--' : String(summary.formScore);
  $('summary-clean').textContent = String(summary.cleanReps);
  $('summary-partial').textContent = String(summary.partialReps);
  $('summary-tempo').textContent = summary.avgRepMs ? `${(summary.avgRepMs / 1000).toFixed(1)}s` : '--';
  $('summary-duration').textContent = formatDuration(summary.durationMs);

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
    title.textContent = 'No full reps detected';
    body.textContent = summary.partialReps > 0
      ? `${summary.partialReps} rep${summary.partialReps === 1 ? '' : 's'} didn't reach full range. ${exercise().partialCue}.`
      : `Make sure your whole body is in frame. ${exercise().camera}`;
  } else if (top) {
    title.textContent = `Next set, focus on: “${top.cue}”`;
    body.textContent = `${top.label} on ${top.count} of ${summary.reps} rep${summary.reps === 1 ? '' : 's'}.`;
  } else if (summary.partialReps > 0) {
    title.textContent = `Next set: “${exercise().partialCue}”`;
    body.textContent = `${summary.partialReps} partial rep${summary.partialReps === 1 ? '' : 's'} didn't count.`;
  } else {
    title.textContent = 'Every rep was clean';
    body.textContent = 'Great control. Add a few reps or a little weight next set.';
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
$('btn-end').addEventListener('click', endSet);
$('btn-pause').addEventListener('click', togglePause);
$('btn-flip').addEventListener('click', flipCamera);
$('btn-reset').addEventListener('click', () => {
  coach.reset();
  session.cleanStreak = 0;
  resetSetUI();
  showCue('Count reset', 'good', performance.now(), 1000);
});
$('open-settings').addEventListener('click', () => els.settingsDialog.showModal());
$('clear-history').addEventListener('click', () => {
  storage.remove(HISTORY_KEY);
  renderHistory();
});
els.video.addEventListener('ended', () => {
  if (session.mode === 'file') endSet();
});
els.video.addEventListener('resize', () => {
  if (session.mode === 'camera' || session.mode === 'file') sizeCanvas();
});

renderTabs();
renderExerciseInfo();
resetSetUI();
renderHistory();
bindSettings();

if (params.has('demo')) startDemo();
