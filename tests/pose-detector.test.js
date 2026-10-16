import { test } from 'node:test';
import assert from 'node:assert/strict';

import { downloadWithProgress, firstWorking, loadError } from '../assets/js/app/pose-detector.js';

function streamResponse(chunks, { length = true, delayMs = 0 } = {}) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const body = new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return new Response(body, { headers: length ? { 'content-length': String(total) } : {} });
}

test('downloads in chunks and reports progress against Content-Length', async () => {
  const seen = [];
  const bytes = await downloadWithProgress('https://example.test/model', {
    fetchImpl: async () => streamResponse([new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]),
    onBytes: (loaded, total) => seen.push([loaded, total]),
  });
  assert.deepEqual([...bytes], [1, 2, 3, 4, 5]);
  assert.deepEqual(seen, [[2, 5], [5, 5]]);
});

test('works without Content-Length', async () => {
  const seen = [];
  await downloadWithProgress('https://example.test/model', {
    fetchImpl: async () => streamResponse([new Uint8Array(3)], { length: false }),
    onBytes: (loaded, total) => seen.push([loaded, total]),
  });
  assert.deepEqual(seen, [[3, null]]);
});

test('a stalled download is abandoned instead of hanging forever', async () => {
  const neverEnds = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('stalled', 'AbortError')));
  });
  await assert.rejects(downloadWithProgress('https://example.test/model', { fetchImpl: neverEnds, stallMs: 30 }), /stalled/);
});

test('a slow but steady download is not treated as stalled', async () => {
  const chunks = Array.from({ length: 5 }, () => new Uint8Array(1));
  const bytes = await downloadWithProgress('https://example.test/model', {
    fetchImpl: async () => streamResponse(chunks, { delayMs: 20 }),
    stallMs: 60,
  });
  assert.equal(bytes.length, 5);
});

test('HTTP errors are reported', async () => {
  await assert.rejects(
    downloadWithProgress('https://example.test/model', { fetchImpl: async () => new Response('nope', { status: 404 }) }),
    /HTTP 404/,
  );
});

test('firstWorking falls back to the next source and reports the last failure', async () => {
  const tried = [];
  const value = await firstWorking(['a', 'b', 'c'], async (source) => {
    tried.push(source);
    if (source !== 'b') throw new Error(`down: ${source}`);
    return source.toUpperCase();
  });
  assert.equal(value, 'B');
  assert.deepEqual(tried, ['a', 'b']);
  await assert.rejects(firstWorking(['a', 'b'], async (s) => { throw new Error(`down: ${s}`); }), /down: b/);
});

test('load errors carry a reason the app can explain', () => {
  const error = loadError('network', new Error('offline'));
  assert.equal(error.code, 'MODEL_LOAD');
  assert.equal(error.reason, 'network');
  assert.equal(loadError('init').reason, 'init');
});
