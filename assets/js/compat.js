// Device check: can this phone, tablet or laptop run the coach?
// probeEnvironment() reads what the browser supports (no permission prompts);
// evaluate() turns that into a verdict. evaluate() is pure, so it's unit-tested in Node.

// Smallest valid WebAssembly module, and one that uses a SIMD instruction.
const WASM_EMPTY = [0, 97, 115, 109, 1, 0, 0, 0];
const WASM_SIMD = [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11];

// In-app browsers (social apps) often block the camera even when the API exists.
const IN_APP = /FBAN|FBAV|FB_IAB|Instagram|Line\/|TikTok|musical_ly|Snapchat|Twitter|LinkedInApp|Pinterest|WhatsApp|GSA\//i;

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
  try {
    webgl2 = Boolean(win.document?.createElement('canvas').getContext('webgl2'));
  } catch {
    webgl2 = false;
  }
  return {
    secureContext: Boolean(win.isSecureContext),
    camera: typeof nav.mediaDevices?.getUserMedia === 'function',
    wasm: validWasm(WASM_EMPTY),
    wasmSimd: validWasm(WASM_SIMD),
    webgl2,
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

  add('gpu', 'GPU acceleration', env.webgl2 ? 'pass' : 'warn', env.webgl2
    ? 'Available (WebGL 2)'
    : 'Not available. Tracking falls back to the processor, at a lower frame rate.');

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
