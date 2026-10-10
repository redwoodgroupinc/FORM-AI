// On-device pose estimation with MediaPipe Pose Landmarker (BlazePose, 33 landmarks).
// The model runs in WebAssembly/WebGL inside the browser: video frames are never uploaded.
//
// Self-hosting: set window.FORM_AI_CONFIG = { mediapipeBase, models: { lite, full } }
// before this module loads to serve the library and models from your own origin.

import { gpuNeedsCompatibility } from '../compat.js';

export const MEDIAPIPE_VERSION = '0.10.35';

const config = (typeof window !== 'undefined' && window.FORM_AI_CONFIG) || {};
// A second CDN keeps the coach working when one is slow or blocked on the visitor's network.
const MEDIAPIPE_BASES = config.mediapipeBase ? [config.mediapipeBase] : [
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`,
  `https://unpkg.com/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`,
];

export const MODEL_URLS = {
  lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  ...config.models,
};

// Sizes used for the progress bar when a server doesn't send Content-Length.
const APPROX_BYTES = { wasm: 11_200_000, lite: 5_800_000, full: 9_400_000 };
// Give up on a source when no data has arrived for this long.
export const STALL_MS = 30_000;

/** Error the app can explain: `reason` is 'network' (download) or 'init' (engine start). */
export function loadError(reason, cause) {
  const error = new Error(reason === 'network'
    ? 'The pose model could not be downloaded'
    : 'The pose engine could not start on this device');
  error.code = 'MODEL_LOAD';
  error.reason = reason;
  error.cause = cause;
  return error;
}

/**
 * Download a file, reporting bytes as they arrive. Aborts if the connection stalls.
 * @returns {Promise<Uint8Array>}
 */
export async function downloadWithProgress(url, { onBytes = () => {}, fetchImpl = globalThis.fetch, stallMs = STALL_MS } = {}) {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), stallMs);
  const poke = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), stallMs);
  };
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const total = Number(response.headers?.get?.('content-length')) || null;
    if (!response.body?.getReader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      onBytes(bytes.length, total ?? bytes.length);
      return bytes;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      poke();
      chunks.push(value);
      loaded += value.length;
      onBytes(loaded, total);
    }
    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

/** Try each source in order and return the first that works. */
export async function firstWorking(sources, attempt) {
  let lastError;
  for (const source of sources) {
    try {
      return await attempt(source);
    } catch (error) {
      lastError = error;
      console.warn(`Pose engine source failed: ${source}`, error);
    }
  }
  throw lastError;
}

/** Combines the wasm and model downloads into one 0–1 progress value. */
function progressTracker(parts, onProgress) {
  const state = Object.fromEntries(parts.map(([name, approx]) => [name, { loaded: 0, total: approx }]));
  const report = () => {
    const values = Object.values(state);
    const loaded = values.reduce((sum, p) => sum + Math.min(p.loaded, p.total), 0);
    const total = values.reduce((sum, p) => sum + p.total, 0);
    onProgress?.(total ? loaded / total : 0);
  };
  return (name) => (loaded, total) => {
    state[name].loaded = loaded;
    if (total) state[name].total = total;
    else state[name].total = Math.max(state[name].total, loaded);
    report();
  };
}

let enginePromise = null;
const modelCache = new Map();

/** Load the MediaPipe library and its wasm binary (downloaded once, then reused). */
function loadEngine(track) {
  if (!enginePromise) {
    enginePromise = firstWorking(MEDIAPIPE_BASES, async (base) => {
      const vision = await import(`${base}/vision_bundle.mjs`);
      const fileset = await vision.FilesetResolver.forVisionTasks(`${base}/wasm`);
      const wasm = await downloadWithProgress(fileset.wasmBinaryPath, { onBytes: track('wasm') });
      const wasmUrl = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
      return { vision, fileset: { ...fileset, wasmBinaryPath: wasmUrl } };
    });
    enginePromise.catch(() => { enginePromise = null; });
  } else {
    track('wasm')(1, 1);
  }
  return enginePromise;
}

function loadModel(model, track) {
  const url = MODEL_URLS[model] ?? MODEL_URLS.lite;
  if (!modelCache.has(url)) {
    const promise = downloadWithProgress(url, { onBytes: track('model') });
    promise.catch(() => modelCache.delete(url));
    modelCache.set(url, promise);
  } else {
    track('model')(1, 1);
  }
  return modelCache.get(url);
}

function landmarkerOptions(modelBytes, delegate) {
  return {
    // MediaPipe takes ownership of the buffer it is given, so each landmarker gets a copy.
    baseOptions: { modelAssetBuffer: modelBytes.slice(), delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };
}

/**
 * Create a detector.
 * `engine: 'auto'` uses the GPU, except on chips where MediaPipe's GPU path is known to
 * break (see compat.js), and falls back to the CPU if the GPU can't start.
 * `engine: 'cpu'` is Compatibility mode: slower, but avoids GPU driver problems.
 * `onProgress(fraction)` reports the first-time download (about 17 MB).
 * @returns {Promise<{model: string, delegate: string, engine: string, detect: Function, close: Function}>}
 */
export async function createPoseDetector({ model = 'lite', engine = 'auto', onProgress } = {}) {
  const track = progressTracker([['wasm', APPROX_BYTES.wasm], ['model', APPROX_BYTES[model] ?? APPROX_BYTES.lite]], onProgress);
  let vision;
  let fileset;
  let modelBytes;
  try {
    [{ vision, fileset }, modelBytes] = await Promise.all([loadEngine(track), loadModel(model, track)]);
  } catch (error) {
    throw loadError('network', error);
  }

  const { PoseLandmarker } = vision;
  let delegate = engine === 'cpu' || gpuNeedsCompatibility() ? 'CPU' : 'GPU';
  let landmarker;
  try {
    landmarker = await PoseLandmarker.createFromOptions(fileset, landmarkerOptions(modelBytes, delegate));
  } catch (error) {
    if (delegate === 'CPU') throw loadError('init', error);
    console.warn('GPU delegate unavailable, falling back to CPU', error);
    delegate = 'CPU';
    try {
      landmarker = await PoseLandmarker.createFromOptions(fileset, landmarkerOptions(modelBytes, 'CPU'));
    } catch (cpuError) {
      throw loadError('init', cpuError);
    }
  }

  let lastTimestamp = -1;
  return {
    model,
    engine,
    delegate,
    /** Detect the pose in a video frame. Returns null when nobody is in view. */
    detect(source, timeMs) {
      // MediaPipe requires strictly increasing timestamps in VIDEO mode.
      const timestamp = Math.max(Math.round(timeMs), lastTimestamp + 1);
      lastTimestamp = timestamp;
      const result = landmarker.detectForVideo(source, timestamp);
      const landmarks = result?.landmarks?.[0];
      if (!landmarks || landmarks.length === 0) return null;
      return { landmarks, worldLandmarks: result.worldLandmarks?.[0] };
    },
    close() {
      landmarker.close();
    },
  };
}
