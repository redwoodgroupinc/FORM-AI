// Device check: can this phone, tablet or laptop run the coach?
// probeEnvironment() reads what the browser supports (no permission prompts);
// evaluate() turns that into a verdict. evaluate() is pure, so it's unit-tested in Node.

// Smallest valid WebAssembly module, and one that uses a SIMD instruction.
const WASM_EMPTY = [0, 97, 115, 109, 1, 0, 0, 0];
const WASM_SIMD = [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11];

// In-app browsers (social apps) often block the camera even when the API exists.
const IN_APP = /FBAN|FBAV|FB_IAB|Instagram|Line\/|TikTok|musical_ly|Snapchat|Twitter|LinkedInApp|Pinterest|WhatsApp|GSA\//i;

// MediaPipe's web GPU path stalls after a few frames on these Adreno GPUs (Snapdragon
// 8 Elite, 8 Elite Gen 5, 8s Gen 3: e.g. Galaxy S25, OnePlus 13, Xiaomi 15). Open upstream:
// google-ai-edge/mediapipe#5908 and #5867. The CPU delegate works.
const GPU_ISSUE = /Adreno \(TM\) (830|840|735)\b/;

/** The GPU's renderer string, when the browser exposes it (e.g. "Adreno (TM) 830"). */
export function gpuRenderer(doc = typeof document === 'undefined' ? null : document) {
  try {
    const gl = doc?.createElement('canvas').getContext('webgl2') ?? doc?.createElement('canvas').getContext('webgl');
    if (!gl) return null;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '') || null;
  } catch {
    return null;
  }
}

/** True on GPUs where the pose engine must run in Compatibility (CPU) mode. */
export function gpuNeedsCompatibility(renderer = gpuRenderer()) {
  return Boolean(renderer && GPU_ISSUE.test(renderer));
}

function validWasm(bytes) {
  try {
    return typeof WebAssembly === 'object' && WebAssembly.validate(new Uint8Array(bytes));
  } catch {
    return false;
  }
}

/** Read the browser's capabilities. Safe to call on page load: nothing is requested. */
export function probeEnvironment(win = window) {
  const nav = win.navigator ?? {};
  const ua = String(nav.userAgent ?? '');
  let webgl2 = false;
  let webgl = false;
  try {
    webgl2 = Boolean(win.document?.createElement('canvas').getContext('webgl2'));
    webgl = webgl2 || Boolean(win.document?.createElement('canvas').getContext('webgl'));
  } catch {
    webgl2 = false;
  }
  const renderer = webgl ? gpuRenderer(win.document) : null;
  return {
    secureContext: Boolean(win.isSecureContext),
    camera: typeof nav.mediaDevices?.getUserMedia === 'function',
    wasm: validWasm(WASM_EMPTY),
    wasmSimd: validWasm(WASM_SIMD),
    webgl,
    webgl2,
    gpuIssue: gpuNeedsCompatibility(renderer),
    speech: 'speechSynthesis' in win,
    modern: typeof win.HTMLDialogElement === 'function' && Boolean(win.CSS?.supports?.('height', '100svh')),
    cores: Number.isFinite(nav.hardwareConcurrency) ? nav.hardwareConcurrency : null,
    memoryGb: Number.isFinite(nav.deviceMemory) ? nav.deviceMemory : null,
    inApp: IN_APP.test(ua),
    platform: /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1)
      ? 'ios'
      : /Android/.test(ua) ? 'android' : 'desktop',
  };
}

const OPEN_IN_BROWSER = {
  ios: 'Open this page in Safari or Chrome',
  android: 'Open this page in Chrome',
  desktop: 'Open this page in Chrome, Edge, Safari or Firefox',
};

/**
 * @returns {{verdict: 'ready'|'limited'|'unsupported', summary: string,
 *   items: Array<{id: string, label: string, status: 'pass'|'warn'|'fail', detail: string}>}}
 */
export function evaluate(env) {
  const items = [];
  const add = (id, label, status, detail) => items.push({ id, label, status, detail });
  const browser = OPEN_IN_BROWSER[env.platform] ?? OPEN_IN_BROWSER.desktop;

  if (env.inApp) {
    add('browser', 'Browser', 'fail', `In-app browsers usually block the camera. ${browser}.`);
  } else if (!env.modern) {
    add('browser', 'Browser', 'warn', 'This browser is out of date. Update it for the best experience.');
  } else {
    add('browser', 'Browser', 'pass', 'Up to date');
  }

  if (!env.camera) {
    add('camera', 'Camera access', 'fail', env.secureContext
      ? `This browser can't use the camera. ${browser}.`
      : 'The camera needs a secure (https://) connection.');
  } else {
    add('camera', 'Camera access', 'pass', 'Available (you\'ll be asked when you start)');
  }

  if (!env.wasm) {
    add('ai', 'On-device AI', 'fail', 'WebAssembly is missing, so the pose model can\'t run here.');
  } else if (!env.wasmSimd) {
    add('ai', 'On-device AI', 'warn', 'Runs, but this engine lacks SIMD, so tracking will be slower.');
  } else {
    add('ai', 'On-device AI', 'pass', 'Supported');
  }

  // The pose engine needs WebGL even in Compatibility mode (it preprocesses frames on the GPU).
  if (env.webgl === false || (env.webgl === undefined && !env.webgl2)) {
    add('gpu', 'Graphics', 'fail', env.platform === 'ios'
      ? 'Graphics (WebGL) is off. If Lockdown Mode is on, add this site as an exception.'
      : 'Graphics (WebGL) is off. Turn on hardware or graphics acceleration in your browser settings.');
  } else if (!env.webgl2) {
    add('gpu', 'Graphics', 'warn', 'Only basic graphics support. Tracking may be slow or may not start.');
  } else if (env.gpuIssue) {
    add('gpu', 'Graphics', 'warn', "This phone's chip has a known GPU bug in the pose engine, so the coach runs in Compatibility mode. It's slower, but reliable.");
  } else {
    add('gpu', 'Graphics', 'pass', 'GPU acceleration available');
  }

  add('voice', 'Her voice', env.speech ? 'pass' : 'warn', env.speech
    ? 'Spoken cues supported'
    : 'No speech in this browser. Cues are shown on screen only.');

  const lowCores = env.cores !== null && env.cores < 4;
  const lowMemory = env.memoryGb !== null && env.memoryGb < 4;
  if (lowCores || lowMemory) {
    add('power', 'Performance', 'warn', 'This looks like a low-power device. Tracking may be slow; try the Fast model in Settings.');
  } else {
    add('power', 'Performance', 'pass', env.cores ? `${env.cores} processor cores` : 'No issues detected');
  }

  const failed = items.some((i) => i.status === 'fail');
  const warned = items.some((i) => i.status === 'warn');
  const verdict = failed ? 'unsupported' : warned ? 'limited' : 'ready';
  const summary = {
    ready: 'This device is ready. Press start and move.',
    limited: 'This device works, with the limits below.',
    unsupported: "The live coach can't run here yet. See below for how to fix it.",
  }[verdict];
  return { verdict, summary, items };
}

/** Render the check into a list element (used on the landing page and in the app). */
export function renderCheck(listEl, result) {
  const doc = listEl.ownerDocument;
  listEl.replaceChildren(...result.items.map((item) => {
    const li = doc.createElement('li');
    li.className = `compat-item is-${item.status}`;
    const status = doc.createElement('span');
    status.className = 'sr-only';
    status.textContent = { pass: 'OK: ', warn: 'Warning: ', fail: 'Problem: ' }[item.status];
    const label = doc.createElement('strong');
    label.prepend(status);
    label.append(item.label);
    const detail = doc.createElement('span');
    detail.textContent = item.detail;
    li.append(label, detail);
    return li;
  }));
}
