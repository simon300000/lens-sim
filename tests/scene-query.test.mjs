import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, WebGPUCoordinateSystem, Vector3 } from 'three';
import { readFileSync } from 'node:fs';
import { packLens, paraxialSensorZ } from '../src/optics/lens-state.js';
import { traceLens } from '../src/optics/optical-reference.js';
import { sampleDimension, concentricDisk } from '../src/spectral/sampler.js';
import { querySceneReference, projectWorld, SCENE_HIT, SCENE_BACKGROUND, SCENE_CACHE_MISS } from '../src/rendering/scene-query-reference.js';

function fixture(depthAt = () => 5, options = {}) {
  const width = 120, height = 80;
  const camera = new PerspectiveCamera(60, width / height, .1, 100);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  const worldToClip = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse);
  const clipToWorld = worldToClip.clone().invert();
  const depth = new Float64Array(width * height), color = new Float64Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, d = depthAt(x, y);
    depth[i] = d === Infinity ? 1 : projectWorld([0, 0, -d], worldToClip.elements).depth;
    color.set([x < width / 2 ? 4 : 0, y < height / 2 ? 2 : 0, .5, 1], i * 4);
  }
  return { width, height, worldToClip: worldToClip.elements, clipToWorld: clipToWorld.elements,
    worldToView: camera.matrixWorldInverse.elements, depth, color, maxDistance: 120, thickness: .005, ...options };
}
test('WebGPU projection: near 0, far 1; positive x right and positive y texture top', () => {
  const c = fixture();
  assert.ok(Math.abs(projectWorld([0, 0, -.1], c.worldToClip).depth) < 1e-12);
  assert.ok(Math.abs(projectWorld([0, 0, -100], c.worldToClip).depth - 1) < 1e-12);
  const p = projectWorld([1, 1, -5], c.worldToClip);
  assert.ok(p.uv[0] > .5 && p.uv[1] < .5);
});
test('asymmetric HDR chart preserves orientation, radiance and actual world hit distance', () => {
  const c = fixture();
  const topLeft = querySceneReference([0, 0, 0], [-.1, .1, -1], c);
  assert.equal(topLeft.status, SCENE_HIT);
  assert.deepEqual(topLeft.rgb, [4, 2, .5]);
  assert.ok(Math.abs(topLeft.position[2] + 5) < 1e-10);
  const bottomRight = querySceneReference([0, 0, 0], [.1, -.1, -1], c);
  assert.equal(bottomRight.status, SCENE_HIT);
  assert.deepEqual(bottomRight.rgb, [0, 0, .5]);
});
test('origin displacement changes projected sample, rather than direction-only environment lookup', () => {
  const c = fixture();
  const left = querySceneReference([-.04, 0, 0], [0, 0, -1], c);
  const right = querySceneReference([.04, 0, 0], [0, 0, -1], c);
  assert.equal(left.status, SCENE_HIT); assert.equal(right.status, SCENE_HIT);
  assert.equal(left.rgb[0], 4); assert.equal(right.rgb[0], 0);
  assert.ok(left.position[0] < 0 && right.position[0] > 0);
});
test('same-ray inset enters the open capture boundary without inventing out-of-guard hits', () => {
  const c = fixture(() => 10);
  // At the near plane these pupil-displaced rays are outside the cache;
  // their later entry is exactly a texture boundary, while the 10m hit is inside.
  for (const [o, d] of [ [[.03, 0, .003], [.1, 0, -1]], [[-.03, 0, .003], [-.1, 0, -1]],
    [[0, .03, .003], [0, .1, -1]], [[0, -.03, .003], [0, -.1, -1]] ]) {
    const hit = querySceneReference(o, d, c);
    assert.equal(hit.status, SCENE_HIT);
    assert.ok(Math.abs(hit.position[2] + 10) < 1e-10);
  }
  assert.equal(querySceneReference([.03, 0, .003], [4, 0, -1], c).status, SCENE_CACHE_MISS);
});
test('real Canon FL reverse pupil rays enter guard band and hit a finite plane without boundary misses', () => {
  const lens = JSON.parse(readFileSync(new URL('../public/lenses/canon-fl-50mm-f1-8.json', import.meta.url))).configurations[0];
  const packed = packLens(lens, { fNumber: 4, sensorZMm: paraxialSensorZ(lens, 15) });
  const c = fixture(() => 10);
  const camera = new PerspectiveCamera(50, 1.5, .02, 450);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  const nominal = 2 * Math.atan(36 / (2 * packed.limits.focalLengthMm)) * 180 / Math.PI;
  camera.fov = 2 * Math.atan(Math.tan(Math.max(50, nominal * 1.6 + 10) * Math.PI / 360) / 1.5) * 180 / Math.PI;
  camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  c.worldToClip = camera.projectionMatrix.elements;
  c.clipToWorld = camera.projectionMatrix.clone().invert().elements;
  c.worldToView = camera.matrixWorldInverse.elements; c.maxDistance = 450;
  c.depth.fill(projectWorld([0, 0, -10], c.worldToClip).depth);
  let passed = 0;
  for (let pixel = 0; pixel < 240 * 160; pixel += 83) for (let n = 0; n < 8; n++) {
    const u = (pixel % 240 + sampleDimension(pixel, n, 0, 1)) / 240;
    const v = (Math.floor(pixel / 240) + sampleDimension(pixel, n, 1, 1)) / 160;
    const sensor = [-(u - .5) * 36, (v - .5) * 24, packed.sensorZMm];
    const disk = concentricDisk(sampleDimension(pixel, n, 2, 1), sampleDimension(pixel, n, 3, 1));
    const reference = [disk[0] * packed.region.radiusMm, disk[1] * packed.region.radiusMm, packed.region.zMm];
    const ray = traceLens(lens, sensor, reference.map((x, i) => x - sensor[i]), { stopRadiusMm: packed.stopRadiusMm });
    if (ray.status !== 0) continue;
    passed++;
    const hit = querySceneReference(ray.point.map(x => x * .001), ray.direction, c);
    assert.equal(hit.status, SCENE_HIT, `pixel ${pixel}, sample ${n}: valid pupil ray missed finite plane`);
    assert.ok(Math.abs(hit.position[2] + 10) < 1e-8);
  }
  assert.ok(passed > 400, 'regression must include substantial physically passing lens rays');
});
test('returned AF target stays on actual query ray, independently of depth texel centre', () => {
  const c = fixture();
  for (const [origin, direction] of [ [[0, 0, 0], [0, 0, -1]], [[.017, -.013, .004], [.083, .047, -1]] ]) {
    const hit = querySceneReference(origin, direction, c);
    assert.equal(hit.status, SCENE_HIT);
    const t = (hit.position[2] - origin[2]) / direction[2];
    assert.ok(t > 0);
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(Math.abs(hit.position[axis] - origin[axis] - t * direction[axis]) < 1e-11);
    }
    assert.ok(Math.abs(hit.position[2] + 5) < 1e-10);
  }
});
test('two depth layers hit different finite distances with bounded work', () => {
  const c = fixture(x => x < 60 ? 3 : 12);
  for (const [x, distance] of [[-.2, 3], [.2, 12]]) {
    const result = querySceneReference([0, 0, 0], [x, .05, -1], c);
    assert.equal(result.status, SCENE_HIT);
    assert.ok(Math.abs(result.position[2] + distance) < 1e-9);
    assert.ok(result.visited <= 128);
  }
});
test('background and missing guard band have distinct states and deterministic directional fallback', () => {
  const c = fixture(() => Infinity);
  const background = querySceneReference([0, 0, 0], [0, .1, -1], c);
  const outside = querySceneReference([0, 0, 0], [4, .1, -1], c);
  assert.equal(background.status, SCENE_BACKGROUND);
  assert.equal(outside.status, SCENE_CACHE_MISS);
  assert.deepEqual(outside, querySceneReference([0, 0, 0], [4, .1, -1], c));
  assert.ok(outside.rgb.every(Number.isFinite));
});
test('cannot recover a surface hidden behind the centre-view depth layer', () => {
  const c = fixture();
  const result = querySceneReference([0, 0, -6], [0, 0, -1], c);
  assert.equal(result.status, SCENE_CACHE_MISS);
});
test('foreground discontinuity reports cache miss rather than a fabricated hit or stretched edge', () => {
  const c = fixture(x => x < 60 ? 2 : 15, { maxSteps: 1 });
  const result = querySceneReference([-.2, 0, 0], [.1, 0, -1], c);
  assert.equal(result.status, SCENE_CACHE_MISS);
});
test('near/far, backward and degenerate rays terminate with finite status data', () => {
  const c = fixture();
  for (const [origin, direction] of [ [[0, 0, 0], [0, 0, 1]], [[0, 0, 0], [0, 0, 0]], [[0, 0, 0], [NaN, 0, -1]], [[500, 0, 0], [0, 0, -1]] ]) {
    const result = querySceneReference(origin, direction, c);
    assert.equal(result.status, SCENE_CACHE_MISS);
    assert.ok(result.rgb.every(Number.isFinite));
    assert.ok(result.visited <= 128);
  }
});
test('capture camera rotation and translation remain column-major world transforms', () => {
  const c = fixture();
  const camera = new PerspectiveCamera(60, 1.5, .1, 100);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  camera.position.set(11, 4, -7); camera.lookAt(0, 2, -10); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
  const m = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse);
  c.worldToClip = m.elements; c.clipToWorld = m.clone().invert().elements;
  c.worldToView = camera.matrixWorldInverse.elements;
  const direction = camera.getWorldDirection(new Vector3());
  const result = querySceneReference(camera.position.toArray(), direction.toArray(), c);
  assert.equal(result.status, SCENE_HIT);
  const view = new Vector3(...result.position).applyMatrix4(camera.matrixWorldInverse);
  assert.ok(Math.abs(view.z + 5) < 1e-9);
});
