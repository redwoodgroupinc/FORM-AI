// Live coach controller: camera / video file / demo → pose model → AutoCoach → HUD + voice.
// There is no exercise picker: the AutoCoach recognises what the athlete is doing.

import { AutoCoach, EXERCISES, EXERCISE_ORDER, TEMPO_CHECK } from '../engine/index.js';
import { programFrame, DEMO_PROGRAM } from '../demo/synthetic.js';
import { drawSkeleton, faultJointsFor } from '../render/skeleton.js';
import { createPoseDetector } from './pose-detector.js';
import { VoiceCoach, PRIORITY } from './voice.js';
import { storage } from './storage.js';
import {
  inAndroidApp, premiumStatus, subscribe, acknowledgeOwned, MANAGE_URL, LIST_PRICE,
} from './billing.js';
import { probeEnvironment, evaluate, renderCheck } from '../compat.js';

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
  loadingBar: $('loading-bar'),
  loadingFill: $('loading-fill'),
  loadingCancel: $('loading-cancel'),
  tapPlay: $('tap-play'),
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
const ENV = probeEnvironment(window);

const DEFAULT_SETTINGS = {
  voice: true, countReps: true, haptics: true, showAngle: true, model: 'lite', voiceURI: 'auto', compat: false,
};
// If the GPU engine keeps failing mid-session, switch to Compatibility (CPU) mode.
const GPU_FAILURES_BEFORE_FALLBACK = 10;
const CPU_FAILURES_BEFORE_STOP = 30;
// Some GPU drivers run the model without errors but never find a person. If the GPU sees
// nobody for this long, try the CPU engine once.
const NO_POSE_GPU_FALLBACK_MS = 12000;
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
  detectFailures: 0,
  forceCpu: false,
  loading: null, // { key, promise } while a detector is being created
  loadProgress: 0,
  startToken: 0, // bumped whenever a new source starts, so stale async starts give up
  poseSeen: false,
  noPoseSince: null,
};

const trackingEngine = () => (settings.compat || session.forceCpu ? 'cpu' : 'auto');

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

  // Tell people up front if this device can't run the live coach (the demo always works).
  const result = evaluate(ENV);
  const box = $('intro-compat');
  box.hidden = result.verdict === 'ready';
  if (box.hidden) return;
  box.classList.toggle('is-unsupported', result.verdict === 'unsupported');
  $('intro-compat-summary').textContent = result.verdict === 'unsupported'
    ? "This device can't run the live coach yet. You can still watch the demo."
    : result.summary;
  renderCheck($('intro-compat-list'), { ...result, items: result.items.filter((i) => i.status !== 'pass') });
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

/**
 * Full-stage overlay. `progress` shows the download bar; `overVideo` keeps the live camera
 * visible behind it so people can see the camera is working while the model loads.
 */
function showLoading(text, { progress = false, overVideo = false } = {}) {
  els.loadingText.textContent = text;
  els.loading.classList.toggle('is-over-video', overVideo);
  els.loadingBar.hidden = !progress;
  els.loadingCancel.hidden = !overVideo;
  if (progress) renderLoadProgress();
  els.loading.hidden = false;
}

function hideLoading() {
  els.loading.hidden = true;
}

function renderLoadProgress() {
  const percent = Math.round(session.loadProgress * 100);
  els.loadingFill.style.width = `${percent}%`;
  els.loadingBar.setAttribute('aria-valuenow', String(percent));
  if (!els.loadingBar.hidden) {
    els.loadingText.textContent = percent >= 100 ? 'Starting the AI coach…' : `Loading the AI coach… ${percent}%`;
  }
}

const IN_APP_MESSAGE = ENV.platform === 'ios'
  ? 'This app\'s built-in browser can\'t use the camera. Tap the ⋯ or share menu, choose "Open in Safari" (or Chrome), and start again there.'
  : 'This app\'s built-in browser can\'t use the camera. Tap the ⋮ menu, choose "Open in Chrome" (or your browser), and start again there.';

function cameraPermissionHelp() {
  if (ENV.platform === 'ios') {
    return 'On iPhone or iPad, tap "aA" in the address bar, then Website Settings › Camera › Allow. Or open Settings › Apps › Safari › Camera (Settings › Safari on iOS 17) and choose Allow. Then reload this page.';
  }
  if (ENV.platform === 'android') {
    return 'In Chrome, tap the icon left of the web address, then Permissions › Camera › Allow. If it is still blocked, open Android Settings › Apps › Chrome › Permissions › Camera. Then reload this page.';
  }
  return 'Click the camera or lock icon in the address bar and allow the camera, then reload this page. Also check Windows Settings › Privacy › Camera, or on a Mac, System Settings › Privacy & Security › Camera.';
}

function describeError(error) {
  const name = error?.name ?? '';
  if (error?.code === 'MODEL_LOAD') {
    return error.reason === 'network'
      ? "Couldn't download the AI coach. It is about 17 MB the first time, then it is saved on this device. Check your internet connection and tap Start coaching to try again."
      : "This device couldn't start the AI coach. Open Settings, turn on Compatibility mode and try again. If it still fails, use the latest Chrome or Safari.";
  }
  if (ENV.inApp) return IN_APP_MESSAGE;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return `Camera access is blocked. ${cameraPermissionHelp()}`;
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return 'No camera was found. Connect a camera, analyse a video file, or watch the demo.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return 'Your camera is busy in another app or browser tab. Close it there and try again. If that doesn\'t help, restart the browser.';
  }
  return `Something went wrong (${name || 'error'}: ${error?.message ?? error}). Reload the page and try again.`;
}

/**
 * Create the pose detector for the current settings. Concurrent calls share one download,
 * and the old detector keeps running until the new one is ready.
 */
function ensureDetector() {
  const engine = trackingEngine();
  const key = `${settings.model}/${engine}`;
  if (session.detector?.key === key) return Promise.resolve(session.detector);
  if (session.loading?.key === key) return session.loading.promise;

  const load = { key, promise: null };
  session.loading = load;
  session.loadProgress = 0;
  load.promise = createPoseDetector({
    model: settings.model,
    engine,
    onProgress: (fraction) => {
      if (session.loading !== load) return;
      session.loadProgress = fraction;
      renderLoadProgress();
    },
  }).then((detector) => {
    if (session.loading !== load) {
      // Settings changed while this one was loading; use the newer request instead.
      detector.close();
      return ensureDetector();
    }
    session.loading = null;
    session.detector?.close();
    detector.key = key;
    session.detector = detector;
    session.detectFailures = 0;
    return detector;
  }, (error) => {
    if (session.loading === load) session.loading = null;
    console.error(error);
    if (error?.code === 'MODEL_LOAD') throw error;
    const wrapped = new Error('Pose engine failed to start');
    wrapped.code = 'MODEL_LOAD';
    wrapped.reason = 'init';
    throw wrapped;
  });
  return load.promise;
}

function stopStream() {
  session.stream?.getTracks().forEach((track) => track.stop());
  session.stream = null;
  if (els.video.srcObject) els.video.srcObject = null;
}

/** Ask for the camera, relaxing the request if the device can't meet it. */
async function getCameraStream() {
  const requests = [
    { facingMode: session.facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
    { facingMode: session.facingMode },
    true,
  ];
  let lastError;
  for (const video of requests) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: false, video });
    } catch (error) {
      lastError = error;
      // A different resolution won't fix a permission problem.
      if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') throw error;
    }
  }
  throw lastError;
}

/** Play the video; if the browser wants a tap first (e.g. iOS Low Power Mode), ask for one. */
function playVideo() {
  const attempt = els.video.play();
  if (!attempt?.then) return;
  attempt.then(() => {
    els.tapPlay.hidden = true;
  }, (error) => {
    if (error?.name === 'NotAllowedError' && session.running) els.tapPlay.hidden = false;
  });
}

async function openCamera() {
  stopStream();
  const stream = await getCameraStream();
  session.stream = stream;
  const [track] = stream.getVideoTracks();
  track?.addEventListener('ended', () => {
    if (session.stream !== stream || !session.running) return;
    stopSession();
    showError('The camera stopped. Another app may have taken it, or it was disconnected. Tap Start coaching to reconnect.');
  });
  els.video.removeAttribute('src');
  els.video.srcObject = stream;
  els.video.muted = true;
  playVideo();
  // Desktop webcams don't report a facing mode; treat them like a selfie camera.
  const facing = track?.getSettings?.().facingMode;
  session.mirrored = facing ? facing === 'user' : true;
}

async function startCamera() {
  hideError();
  voice.unlock();
  if (!(await hasPremium())) {
    openPaywall('camera');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    showError(ENV.inApp
      ? IN_APP_MESSAGE
      : window.isSecureContext
        ? "This browser can't access the camera. Try the latest Chrome, Safari or Edge."
        : 'The camera needs a secure connection. Open this page with https:// at the start of the address.');
    return;
  }
  const token = ++session.startToken;
  // Download the model while the permission prompt is open; it is about 17 MB the first time.
  const detectorReady = ensureDetector();
  detectorReady.catch(() => {});
  showLoading('Waiting for camera permission…');
  try {
    await openCamera();
  } catch (error) {
    if (token !== session.startToken) return;
    hideLoading();
    stopStream();
    showError(describeError(error));
    return;
  }
  if (token !== session.startToken) {
    stopStream();
    return;
  }
  // Show the camera straight away, with the download progress on top until tracking starts.
  beginSession('camera');
  if (!session.detector) {
    showLoading('Loading the AI coach…', { progress: true, overVideo: true });
    try {
      await detectorReady;
    } catch (error) {
      if (token !== session.startToken) return;
      stopSession();
      hideLoading();
      showError(describeError(error));
      return;
    }
    if (token !== session.startToken || session.mode !== 'camera') return;
  }
  hideLoading();
  greet('camera');
}

function cancelStart() {
  session.startToken += 1;
  hideLoading();
  stopSession();
}

function startDemo() {
  session.startToken += 1;
  hideError();
  hideLoading();
  voice.unlock();
  stopStream();
  session.mirrored = false;
  beginSession('demo');
  greet('demo');
}

async function startFile(file) {
  if (!file) return;
  const token = ++session.startToken;
  hideError();
  voice.unlock();
  try {
    showLoading('Loading the AI coach…', { progress: !session.detector });
    await ensureDetector();
    if (token !== session.startToken) return;
    stopStream();
    if (session.fileUrl) URL.revokeObjectURL(session.fileUrl);
    session.fileUrl = URL.createObjectURL(file);
    session.lastFile = file;
    els.video.srcObject = null;
    els.video.loop = false;
    els.video.muted = true;
    els.video.src = session.fileUrl;
    await els.video.play();
    if (token !== session.startToken) return;
    session.mirrored = false;
    hideLoading();
    beginSession('file');
    greet('file');
  } catch (error) {
    if (token !== session.startToken) return;
    hideLoading();
    showError(error?.code === 'MODEL_LOAD' ? describeError(error) : "That video couldn't be played. Try an MP4 or MOV file.");
  }
}

function greet(mode) {
  voice.say(mode === 'demo'
    ? "Here's a demo. Watch how I recognise each exercise."
    : "I'm watching. Start any exercise when you're ready.", {
    key: 'start', priority: PRIORITY.info, cooldownMs: 0,
  });
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
  session.poseSeen = false;
  session.noPoseSince = null;
  session.fps = { frames: 0, since: performance.now(), value: 0 };
  els.tapPlay.hidden = true;

  els.stage.dataset.mode = mode;
  els.stage.classList.toggle('is-mirrored', session.mirrored);
  els.stage.classList.add('is-running');
  els.intro.hidden = true;
  setPauseButton(false);

  coach.reset();
  resetWorkoutUI();
  sizeCanvas();
  requestWakeLock();

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
  els.tapPlay.hidden = true;
  hideLoading();
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
  if (session.mode !== 'camera' || session.flipping) return;
  session.flipping = true;
  try {
    await switchCamera();
  } finally {
    session.flipping = false;
  }
}

async function switchCamera() {
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
    // iOS can pause the camera feed when speech starts; keep it running.
    if (session.mode === 'camera' && video.paused && els.tapPlay.hidden && now - (session.playTriedAt ?? 0) > 500) {
      session.playTriedAt = now;
      playVideo();
    }
    if (!session.detector) {
      // The model is still downloading, or the engine is being switched.
      setStatus('idle', 'Loading the AI coach…');
      return;
    }
    if (video.readyState < 2 || video.currentTime === session.lastVideoTime) return;
    session.lastVideoTime = video.currentTime;
    if (els.canvas.width !== video.videoWidth || els.canvas.height !== video.videoHeight) sizeCanvas();
    try {
      pose = session.detector.detect(video, now);
      session.detectFailures = 0;
    } catch (error) {
      console.error(error);
      handleDetectFailure();
      return;
    }
    watchForSilentGpu(pose, now);
  }

  const result = coach.update(pose, time, { aspect: els.canvas.width / els.canvas.height });
  draw(pose, result, now);
  handleEvents(result.events, now);
  updateHud(result, now);
  countFps(now);
}

/** Switch from the GPU to the CPU engine for the rest of this visit. */
async function fallBackToCpu(message) {
  session.forceCpu = true;
  session.detectFailures = 0;
  session.detector?.close();
  session.detector = null;
  showCue(message, 'warn', performance.now(), 2600);
  try {
    await ensureDetector();
  } catch (error) {
    stopSession();
    showError(describeError(error));
  }
}

/** If the GPU engine runs but never finds anyone, its driver is probably broken: try the CPU. */
function watchForSilentGpu(pose, now) {
  if (pose) {
    session.poseSeen = true;
    return;
  }
  if (session.poseSeen || session.mode !== 'camera' || session.detector?.delegate !== 'GPU') return;
  if (session.noPoseSince === null) session.noPoseSince = now;
  if (now - session.noPoseSince > NO_POSE_GPU_FALLBACK_MS) {
    session.noPoseSince = null;
    fallBackToCpu('No one detected yet. Trying Compatibility mode');
  }
}

/** Recover from a failing pose engine: GPU → Compatibility mode → ask for a reload. */
async function handleDetectFailure() {
  session.detectFailures += 1;
  const onGpu = session.detector?.delegate === 'GPU';
  if (onGpu && session.detectFailures >= GPU_FAILURES_BEFORE_FALLBACK) {
    await fallBackToCpu('Switching to Compatibility mode');
  } else if (!onGpu && session.detectFailures >= CPU_FAILURES_BEFORE_STOP) {
    stopSession();
    showError('Tracking stopped unexpectedly. Reload the page and try again. If it keeps happening, turn on Compatibility mode in Settings.');
  }
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
  const list = readHistory();
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

/** Stored sets that can be shown; anything malformed (old versions, manual edits) is skipped. */
function readHistory() {
  const history = storage.get(HISTORY_KEY, []);
  return (Array.isArray(history) ? history : [])
    .filter((item) => item && typeof item === 'object' && Number.isFinite(new Date(item.at).getTime()));
}

function renderHistory() {
  const list = readHistory().slice(0, 6);
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
    if (voice.voice) {
      els.voiceNote.textContent = 'No female voice is installed on this device, so she uses the closest available voice.';
    } else {
      els.voiceNote.textContent = voice.loadingVoices
        ? 'Voices are still loading.'
        : 'This browser has no speech voices, so cues are shown on screen only.';
    }
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
    ['set-compat', 'compat'],
  ];
  for (const [id, key] of bindings) {
    const input = $(id);
    input.checked = Boolean(settings[key]);
    input.addEventListener('change', () => {
      settings[key] = input.checked;
      if (key === 'compat') switchEngine();
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

  /** Load the detector for the new settings; the current one keeps tracking until it is ready. */
  async function switchDetector(text) {
    if (!session.running || session.mode === 'demo') return;
    const token = session.startToken;
    showLoading(text, { progress: true });
    try {
      await ensureDetector();
    } catch (error) {
      if (token !== session.startToken) return;
      stopSession();
      showError(describeError(error));
      return;
    }
    if (token === session.startToken && session.running) hideLoading();
  }
  const switchEngine = () => switchDetector('Switching tracking engine…');

  for (const radio of document.querySelectorAll('input[name="model"]')) {
    radio.checked = radio.value === settings.model;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      settings.model = radio.value;
      saveSettings();
      switchDetector('Loading the tracking model…');
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
// ShapeCoach Premium (sold through Google Play inside the Android app; see billing.js)

const premium = {
  required: inAndroidApp(window),
  active: false,
  billing: false,
  price: LIST_PRICE,
  checking: null,
  afterPurchase: null,
};
const paywall = {
  dialog: $('paywall-dialog'),
  price: $('paywall-price'),
  error: $('paywall-error'),
  subscribe: $('paywall-subscribe'),
  restore: $('paywall-restore'),
};

/** Ask Google Play for the current subscription state (once at a time). */
function refreshPremium() {
  if (!premium.required) return Promise.resolve(premium);
  premium.checking ??= premiumStatus(window).then((status) => {
    Object.assign(premium, status);
    if (status.purchases.length) acknowledgeOwned(status.purchases, { storage });
    renderPremium();
    return premium;
  }).finally(() => { premium.checking = null; });
  return premium.checking;
}

async function hasPremium() {
  if (!premium.required || premium.active) return true;
  await refreshPremium();
  return premium.active;
}

function renderPremium() {
  paywall.price.textContent = premium.price;
  const row = $('sub-row');
  row.hidden = !premium.required;
  if (!premium.required) return;
  row.classList.toggle('is-active', premium.active);
  $('sub-status').textContent = premium.active
    ? 'Active. Thanks for training with ShapeCoach.'
    : `Not subscribed · ${premium.price}`;
  $('sub-manage').href = MANAGE_URL;
  $('sub-manage').hidden = !premium.active;
  $('sub-subscribe').hidden = premium.active;
}

function showPaywallError(message) {
  paywall.error.textContent = message;
  paywall.error.hidden = !message;
}

function setPaywallBusy(busy) {
  for (const button of [paywall.subscribe, paywall.restore]) {
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
  }
}

function openPaywall(afterPurchase = null) {
  premium.afterPurchase = afterPurchase;
  showPaywallError('');
  renderPremium();
  if (!paywall.dialog.open) paywall.dialog.showModal();
}

function unlocked() {
  paywall.dialog.close('unlocked');
  showCue('ShapeCoach Premium is active', 'good', performance.now(), 2200);
  const next = premium.afterPurchase;
  premium.afterPurchase = null;
  if (next === 'camera') startCamera();
}

async function onSubscribe() {
  showPaywallError('');
  if (!premium.billing) {
    await refreshPremium();
    if (!premium.billing) {
      showPaywallError("Google Play billing isn't available right now. Update the Google Play Store and Chrome, then reopen ShapeCoach.");
      return;
    }
  }
  setPaywallBusy(true);
  try {
    const result = await subscribe(window);
    if (result.cancelled) return;
    await refreshPremium();
    if (premium.active) unlocked();
    else showPaywallError("Your payment went through, but Google Play hasn't confirmed it yet. Wait a moment, then tap Restore purchase.");
  } catch (error) {
    console.error(error);
    showPaywallError("Google Play couldn't start the purchase. Check that you're signed in to the Play Store, then try again.");
  } finally {
    setPaywallBusy(false);
  }
}

async function onRestore() {
  showPaywallError('');
  setPaywallBusy(true);
  try {
    await refreshPremium();
    if (premium.active) unlocked();
    else if (!premium.billing) showPaywallError("Google Play billing isn't available right now. Update the Google Play Store and Chrome, then reopen ShapeCoach.");
    else showPaywallError('No ShapeCoach Premium subscription was found for the Google account on this phone.');
  } finally {
    setPaywallBusy(false);
  }
}

paywall.subscribe.addEventListener('click', onSubscribe);
paywall.restore.addEventListener('click', onRestore);
paywall.dialog.addEventListener('close', () => {
  if (paywall.dialog.returnValue === 'demo') startDemo();
});
$('sub-subscribe').addEventListener('click', () => {
  els.settingsDialog.close();
  openPaywall();
});
// Video analysis is part of Premium too: stop the file picker and show the offer instead.
$('video-file').addEventListener('click', (event) => {
  if (premium.required && !premium.active) {
    event.preventDefault();
    openPaywall();
  }
});

// ---------------------------------------------------------------------------
// Wire up

$('start-camera').addEventListener('click', startCamera);
$('start-demo').addEventListener('click', startDemo);
els.loadingCancel.addEventListener('click', cancelStart);
els.tapPlay.addEventListener('click', playVideo);
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
// Settings first: they must work even if stored history turns out to be unreadable.
bindSettings();
renderHistory();
renderPremium();
// In the Android app the download is free and the coach is paid: show the Premium offer as soon
// as the app opens, unless this person already subscribes.
refreshPremium().then(() => {
  if (premium.required && !premium.active && !params.has('demo')) openPaywall('camera');
});

if (params.has('demo')) startDemo();
