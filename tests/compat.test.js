import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, probeEnvironment, gpuNeedsCompatibility } from '../assets/js/compat.js';

const READY = {
  secureContext: true, camera: true, wasm: true, wasmSimd: true, webgl: true, webgl2: true, gpuIssue: false, speech: true,
  modern: true, cores: 8, memoryGb: 8, inApp: false, platform: 'ios',
};
const statusOf = (result, id) => result.items.find((i) => i.id === id).status;

test('a modern phone or laptop is ready', () => {
  const result = evaluate(READY);
  assert.equal(result.verdict, 'ready');
  assert.ok(result.items.every((i) => i.status === 'pass'));
});

test('missing GPU, SIMD or speech still works, with warnings', () => {
  for (const missing of ['webgl2', 'wasmSimd', 'speech']) {
    const result = evaluate({ ...READY, [missing]: false });
    assert.equal(result.verdict, 'limited', missing);
  }
  assert.equal(statusOf(evaluate({ ...READY, webgl2: false }), 'gpu'), 'warn');
});

test('graphics: none blocks, WebGL 1 or a known GPU bug only warns', () => {
  const none = evaluate({ ...READY, webgl: false, webgl2: false });
  assert.equal(none.verdict, 'unsupported');
  assert.match(none.items.find((i) => i.id === 'gpu').detail, /Lockdown Mode/);
  assert.match(evaluate({ ...READY, webgl: false, webgl2: false, platform: 'desktop' }).items.find((i) => i.id === 'gpu').detail, /acceleration/);
  assert.equal(evaluate({ ...READY, webgl2: false }).verdict, 'limited');
  const buggy = evaluate({ ...READY, gpuIssue: true, platform: 'android' });
  assert.equal(buggy.verdict, 'limited');
  assert.match(buggy.items.find((i) => i.id === 'gpu').detail, /Compatibility mode/);
});

test('recognises the GPUs with the known MediaPipe bug', () => {
  assert.equal(gpuNeedsCompatibility('Adreno (TM) 830'), true);
  assert.equal(gpuNeedsCompatibility('ANGLE (Qualcomm, Adreno (TM) 840, OpenGL ES 3.2)'), true);
  assert.equal(gpuNeedsCompatibility('Adreno (TM) 735'), true);
  assert.equal(gpuNeedsCompatibility('Adreno (TM) 750'), false);
  assert.equal(gpuNeedsCompatibility('Mali-G78'), false);
  assert.equal(gpuNeedsCompatibility('Apple GPU'), false);
  assert.equal(gpuNeedsCompatibility(null), false);
});

test('no camera API or no WebAssembly means the live coach cannot run', () => {
  assert.equal(evaluate({ ...READY, camera: false }).verdict, 'unsupported');
  assert.equal(evaluate({ ...READY, wasm: false }).verdict, 'unsupported');
  const insecure = evaluate({ ...READY, camera: false, secureContext: false });
  assert.match(insecure.items.find((i) => i.id === 'camera').detail, /https/);
});

test('in-app browsers are told to open the page in a real browser', () => {
  const result = evaluate({ ...READY, inApp: true, platform: 'android' });
  assert.equal(result.verdict, 'unsupported');
  assert.match(result.items.find((i) => i.id === 'browser').detail, /Open this page in Chrome/);
});

test('low-power devices get a performance hint', () => {
  assert.equal(statusOf(evaluate({ ...READY, cores: 2 }), 'power'), 'warn');
  assert.equal(statusOf(evaluate({ ...READY, memoryGb: 2 }), 'power'), 'warn');
  // Unknown memory (Safari doesn't report it) is not held against the device.
  assert.equal(statusOf(evaluate({ ...READY, memoryGb: null }), 'power'), 'pass');
});

test('probeEnvironment reads capabilities without a DOM and spots in-app browsers', () => {
  const win = {
    isSecureContext: true,
    navigator: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Instagram 300.0',
      mediaDevices: { getUserMedia() {} },
      hardwareConcurrency: 6,
    },
    speechSynthesis: {},
  };
  const env = probeEnvironment(win);
  assert.equal(env.camera, true);
  assert.equal(env.wasm, true);
  assert.equal(env.inApp, true);
  assert.equal(env.platform, 'ios');
  assert.equal(env.webgl2, false);
  assert.equal(env.memoryGb, null);
});
