import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { extractScene, classifyMaterial, INSTANCE_FLAGS } from '../src/scene/scene-extract.js';
import { buildSceneBuffers, buildBVH, LEAF_BIT, STACK_SIZE, f32Down, f32Up } from '../src/scene/bvh-builder.js';
import { bruteForceIntersect, traversePacked, invertAffine, applyAffine } from '../src/scene/scene-reference.js';

import { rng, diagnosticScene } from './scene-fixtures.js';
import isoChart from '../src/scene/iso-chart-geometry.json' with {type:'json'};
const mat = (side = THREE.FrontSide, extra = {}) => new THREE.MeshStandardNodeMaterial({ color: 0xffffff, side, ...extra });

test('f32 outward rounding is conservative', () => {
  for (const x of [0.1, -0.1, 1 / 3, -1e-8, 123.456, 0]) { assert.ok(f32Down(x) <= x); assert.ok(f32Up(x) >= x); assert.equal(Math.fround(f32Down(x)), f32Down(x)); }
});

test('binned SAH: every primitive in exactly one leaf; boxes contain children', () => {
  const r = rng(3), n = 2000, b = new Float64Array(n * 6);
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { const c = (r() - .5) * 100, s = r() * 2; b[i * 6 + a] = c - s; b[i * 6 + 3 + a] = c + s; }
  const bvh = buildBVH(b, { maxLeaf: 4 });
  const seen = new Uint8Array(n);
  const visit = (i, parent) => {
    const nd = bvh.nodes.subarray(i * 8, i * 8 + 8);
    if (parent) for (let a = 0; a < 3; a++) assert.ok(nd[a] >= parent[a] && nd[4 + a] <= parent[4 + a]);
    if (nd[7] >= LEAF_BIT) { for (let k = nd[3]; k < nd[3] + nd[7] - LEAF_BIT; k++) seen[bvh.order[k]]++; }
    else { visit(nd[3], nd); visit(nd[7], nd); }
  };
  visit(0, null);
  assert.ok(seen.every(v => v === 1));
  assert.ok(bvh.largestLeaf <= 8 && bvh.depth < STACK_SIZE);
});

test('coincident instances still split into single-instance TLAS leaves', () => {
  const n = 300, b = new Float64Array(n * 6);
  for (let i = 0; i < n; i++) b.set([0, 0, 0, 1, 1, 1], i * 6);
  const bvh = buildBVH(b, { maxLeaf: 1 });
  assert.equal(bvh.largestLeaf, 1); assert.ok(bvh.depth <= 11);
});

test('extraction: environment roles, invisibility, groups, drawRange, negative determinant', () => {
  const ex = extractScene(diagnosticScene());
  assert.equal(ex.report.environment.length, 1);
  assert.equal(ex.report.multiMaterial, 1);
  assert.ok(ex.report.negativeDeterminant >= 2);
  assert.ok(ex.report.nonIndexed >= 1);
  const wallBlas = ex.blas.find(b => b.range[0] === 6);
  assert.equal(wallBlas.indices.length, 30);
  assert.deepEqual(Array.from(wallBlas.primitiveIds.slice(0, 2)), [2, 3]);
  assert.equal(ex.report.unsupported.length, 0);
});

test('packed two-level BVH == f64 brute force: nearest t, instance, primitive, barycentrics, facing', () => {
  const ex = extractScene(diagnosticScene()), packed = buildSceneBuffers({ blasSources: ex.blas, instances: ex.instances });
  const r = rng(11);
  let hits = 0, maxStack = 0;
  for (let i = 0; i < 3000; i++) {
    const origin = [(r() - .5) * 2, (r() - .5) * 2, (r() - .5) * 2];
    let direction = [(r() - .5) * 1.6, (r() - .5) * 1.2, -1];
    if (i % 10 === 0) direction = [1, 1e-9, -1e-9];            // near-parallel/axis-aligned components
    if (i % 17 === 0) direction = [0, 0, -1];
    const ref = bruteForceIntersect(ex, origin, direction);
    const bvh = traversePacked(packed, origin, direction);
    maxStack = Math.max(maxStack, bvh.maxStack);
    if (!ref) { assert.equal(bvh.hit, null); continue; }
    hits++;
    assert.ok(bvh.hit, `missed ray ${i}`);
    assert.ok(Math.abs(bvh.hit.t - ref.t) <= 1e-9 * Math.max(1, ref.t), `t ${bvh.hit.t} vs ${ref.t}`);
    assert.equal(bvh.hit.instance, ref.instance); assert.equal(bvh.hit.primitive, ref.primitive);
    assert.equal(bvh.hit.material, ref.material); assert.equal(bvh.hit.front, ref.front);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(bvh.hit.bary[k] - ref.bary[k]) < 1e-9);
  }
  assert.ok(hits > 400, `only ${hits} hits`);
  assert.ok(maxStack <= packed.stats.stackBound + 1);
});

test('hidden surfaces behind an occluder are found with a larger tMin, never discarded', () => {
  const ex = extractScene(diagnosticScene());
  const first = bruteForceIntersect(ex, [0, 0, 0], [0, 0, -1]);
  const behind = bruteForceIntersect(ex, [0, 0, 0], [0, 0, -1], first.t + 1e-6);
  assert.ok(behind && behind.t > first.t);
  const packed = buildSceneBuffers({ blasSources: ex.blas, instances: ex.instances });
  assert.ok(Math.abs(traversePacked(packed, [0, 0, 0], [0, 0, -1], first.t + 1e-6).hit.t - behind.t) < 1e-9);
});

test('FrontSide culling and BackSide shell: inside rays see the BackSide shell, outside rays pass', () => {
  const scene = new THREE.Scene();
  const shell = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8), mat(THREE.BackSide)); scene.add(shell);
  const ex = extractScene(scene);
  assert.ok(bruteForceIntersect(ex, [0, 0, 0], [0, 0, -1]));
  const outside = bruteForceIntersect(ex, [0, 0, 5], [0, 0, -1]);
  assert.ok(outside && outside.t > 5); // front faces at z=1 culled; back face at far side z=-1 accepted
  assert.ok(Math.abs(outside.t - 6) < .05);
});

test('instance transform preserves the world t parameter (unnormalized local direction)', () => {
  const scene = new THREE.Scene();
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat()); m.position.z = -3; m.scale.set(5, .2, 7); scene.add(m);
  const hit = bruteForceIntersect(extractScene(scene), [0, 0, 0], [0, 0, -2]);
  assert.ok(Math.abs(hit.t - 1.5) < 1e-6); // f32-stored world→object rows
});

test('parallel BVH slabs include exact boundary faces, reject outside origins and preserve tiny nonzero directions', () => {
  const scene = new THREE.Scene();
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat(THREE.DoubleSide));
  plane.position.z = -4; scene.add(plane);
  const ex = extractScene(scene), packed = buildSceneBuffers({ blasSources: ex.blas, instances: ex.instances });
  const cases = [
    [[1, 1, 0], [0, 0, -1], true, 'upper corner'],
    [[1, 0, 0], [-0, 0, -1], true, 'upper x face and negative zero'],
    [[0, 1, 0], [0, -0, -1], true, 'upper y face and negative zero'],
    [[-1, -1, 0], [0, 0, -2], true, 'lower corner and nonunit direction'],
    [[1 + 2 ** -20, 0, 0], [0, 0, -1], false, 'outside upper face'],
    [[-1 - 2 ** -20, 0, 0], [0, 0, -1], false, 'outside lower face'],
    [[1, 0, 0], [1e-12, 0, -1], false, 'tiny direction leaves upper face'],
    [[1, 0, 0], [-1e-12, 0, -1], true, 'tiny direction enters upper face'],
    [[-1, 0, 0], [-1e-12, 0, -1], false, 'tiny direction leaves lower face'],
    [[-1, 0, 0], [1e-12, 0, -1], true, 'tiny direction enters lower face'],
  ];
  for (const [origin, direction, expected, label] of cases) {
    const ref = bruteForceIntersect(ex, origin, direction), hit = traversePacked(packed, origin, direction).hit;
    assert.equal(Boolean(ref), expected, `reference: ${label}`);
    assert.equal(Boolean(hit), expected, `packed BVH: ${label}`);
    if (hit) assert.ok(Math.abs(hit.t - ref.t) < 1e-12, label);
  }
});

test('material classification reports unsupported node graphs instead of a grey fallback', () => {
  const m = mat(); m.colorNode = new THREE.MeshBasicNodeMaterial().colorNode ?? { isNode: true };
  m.colorNode = { isNode: true };
  assert.equal(classifyMaterial(m).reason, 2);
  assert.equal(classifyMaterial(new THREE.MeshBasicNodeMaterial()).reason, 1);
  const textured = mat(); textured.map = new THREE.Texture();
  assert.equal(classifyMaterial(textured).reason, 3);
});

test('affine helpers round-trip', () => {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(1, 2, 3), new THREE.Quaternion().setFromEuler(new THREE.Euler(.3, .2, .1)), new THREE.Vector3(2, -1, .5)).invert();
  const e = m.elements, rows = [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]];
  const back = invertAffine(rows), p = [.3, -1, 2];
  const q = applyAffine(back, applyAffine(rows, p));
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(q[k] - p[k]) < 1e-12);
});

test('instance flags carry side, shadow receiving and transparency', () => {
  const scene = new THREE.Scene();
  const a = new THREE.Mesh(new THREE.PlaneGeometry(), mat(THREE.DoubleSide, { transparent: true, opacity: .4 })); a.receiveShadow = true; scene.add(a);
  const ex = extractScene(scene), f = ex.instances.flags[0];
  assert.equal(f & INSTANCE_FLAGS.SIDE_MASK, 2); assert.ok(f & INSTANCE_FLAGS.RECEIVE_SHADOW); assert.ok(f & INSTANCE_FLAGS.TRANSPARENT);
});

test('full villa/forest scene: extraction + BVH build within stack bound, real counts', async () => {
  const { buildSanteiScene } = await import('../src/scene/santei-scene.js');
  const { scene } = buildSanteiScene();
  const ex = extractScene(scene);
  const packed = buildSceneBuffers({ blasSources: ex.blas, instances: ex.instances });
  const s = packed.stats;
  assert.ok(ex.report.instances > 200000);
  // Static batching reduces BLAS count; retain the exact expanded-triangle
  // invariant below rather than requiring redundant source meshes.
  assert.equal(ex.report.blas,ex.blas.length);
  assert.ok(ex.report.blas>0&&ex.report.blas<ex.report.meshes);
  assert.ok(s.stackBound <= STACK_SIZE);
  assert.equal(s.tlasLargestLeaf, 1);
  assert.equal(ex.report.unsupported.length, 0, JSON.stringify(ex.report.unsupported));
  assert.equal(ex.report.negativeDeterminant, 0);
  console.log(JSON.stringify({ report: { ...ex.report, unsupported: ex.report.unsupported.length }, stats: s }));
  // Same instance count as raster draw: expanded triangles must match the raster inventory.
  assert.equal(ex.report.expandedTriangles, 3399513 + 246 + isoChart.indices.length/3);
});
