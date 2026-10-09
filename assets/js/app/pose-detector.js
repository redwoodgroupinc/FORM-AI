// On-device pose estimation with MediaPipe Pose Landmarker (BlazePose, 33 landmarks).
// The model runs in WebAssembly/WebGL inside the browser: video frames are never uploaded.
//
// Self-hosting: set window.FORM_AI_CONFIG = { mediapipeBase, models: { lite, full } }
// before this module loads to serve the library and models from your own origin.

export const MEDIAPIPE_VERSION = '0.10.35';

const config = (typeof window !== 'undefined' && window.FORM_AI_CONFIG) || {};
const MEDIAPIPE_BASE = config.mediapipeBase
  ?? `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;

export const MODEL_URLS = {
  lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  ...config.models,
};

let visionModule = null;
let filesetPromise = null;

async function loadFileset() {
  if (!filesetPromise) {
    filesetPromise = (async () => {
      visionModule = await import(`${MEDIAPIPE_BASE}/vision_bundle.mjs`);
      return visionModule.FilesetResolver.forVisionTasks(`${MEDIAPIPE_BASE}/wasm`);
    })();
    filesetPromise.catch(() => { filesetPromise = null; });
  }
  return filesetPromise;
}

function landmarkerOptions(model, delegate) {
  return {
    baseOptions: { modelAssetPath: MODEL_URLS[model] ?? MODEL_URLS.lite, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };
}

/**
 * Create a detector. Tries the GPU delegate first and falls back to CPU.
 * @returns {Promise<{model: string, delegate: string, detect: Function, close: Function}>}
 */
export async function createPoseDetector({ model = 'lite' } = {}) {
  const fileset = await loadFileset();
  const { PoseLandmarker } = visionModule;
  let delegate = 'GPU';
  let landmarker;
  try {
    landmarker = await PoseLandmarker.createFromOptions(fileset, landmarkerOptions(model, 'GPU'));
  } catch (gpuError) {
    console.warn('GPU delegate unavailable, falling back to CPU', gpuError);
    delegate = 'CPU';
    landmarker = await PoseLandmarker.createFromOptions(fileset, landmarkerOptions(model, 'CPU'));
  }

  let lastTimestamp = -1;
  return {
    model,
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
