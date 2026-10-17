import test from 'node:test';
import assert from 'node:assert/strict';
import { createComputeTimer, timestampSpanMs } from '../src/rendering/three-interop.js';

globalThis.GPUBufferUsage ??= { QUERY_RESOLVE: 0x200, COPY_SRC: 4, COPY_DST: 8, MAP_READ: 1 };
globalThis.GPUMapMode ??= { READ: 1 };

test('timestamp spans are null when the end is not after the start', () => {
  assert.equal(timestampSpanMs(1_000_000n, 3_500_000n), 2.5);
  assert.equal(timestampSpanMs(3_500_000n, 1_000_000n), null, 'reordered pair is not a negative time');
  assert.equal(timestampSpanMs(2_000_000n, 2_000_000n), null);
});

test('compute timer drops reordered timestamps and stays ready for the next reading', async () => {
  let resolved = [0n, 0n];
  const buffer = (size) => ({ size, mapAsync: async () => {}, getMappedRange: () => new BigUint64Array(resolved).buffer, unmap() {} });
  const interop = { device: { features: new Set(['timestamp-query']), createQuerySet: () => ({ destroy() {} }) }, buffer, release() {} };
  const encoder = { resolveQuerySet() {}, copyBufferToBuffer() {} };
  const timer = createComputeTimer(interop);
  const results = [];
  resolved = [5_000_000n, 2_000_000n];
  let stamps = timer.begin();
  await timer.end(encoder, stamps, (ms) => results.push(ms))();
  assert.deepEqual(results, [], 'end before start is discarded');
  resolved = [2_000_000n, 32_000_000n];
  stamps = timer.begin();
  assert.ok(stamps, 'a discarded reading does not leave the timer pending');
  await timer.end(encoder, stamps, (ms) => results.push(ms))();
  assert.deepEqual(results, [30]);
});
