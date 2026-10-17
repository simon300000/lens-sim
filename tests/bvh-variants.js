/**
 * Benchmark-only mutations of the production intersector.
 *
 * Each experiment starts from the same unmodified source and keeps traversal
 * errors, conservative interior-box tests and compensated triangle edges.
 * A requested stackSize must be >= packed.stats.stackBound; the harness owns
 * that proof because this helper receives shader text, not scene buffers.
 */
const descriptors = [
  ['baseline', 'Production source', []],
  ['original', 'Original source before parallel-slab correctness repair', ['original']],
  ['static-axis', 'Constant-component triangle permutation', ['static-axis']],
  ['reciprocal', 'Shared reciprocal for triangle distance and barycentrics', ['reciprocal']],
  ['tiny-leaf', 'Direct triangle testing for a leaf BLAS root', ['tiny-leaf']],
  ['stack-size', 'Scene-proved traversal stack capacity', ['stack-size']],
  ['parallel-fast', 'Unmasked slabs for nonparallel rays, repaired parallel path', ['parallel-fast']],
  ['branchless-slabs', 'Closed parallel slabs using selected near/far intervals', ['branchless-slabs']],
  ['static-axis+reciprocal', 'Triangle permutation and reciprocal', ['static-axis', 'reciprocal']],
  ['static-axis+tiny-leaf', 'Exact permutation and leaf-root bypass', ['static-axis', 'tiny-leaf']],
  ['combined', 'Permutation, reciprocal, leaf-root bypass and proved stack', ['static-axis', 'reciprocal', 'tiny-leaf', 'stack-size']],
  ['fast-combined', 'Nonparallel fast path plus all traversal experiments', ['parallel-fast', 'static-axis', 'reciprocal', 'tiny-leaf', 'stack-size']],
];

export const VARIANTS = Object.freeze(descriptors.map(([name, label, features]) =>
  Object.freeze({ name, label, features: Object.freeze(features), usesStackSize: features.includes('stack-size') })));

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`BVH variant ${label}: expected exactly one unchanged source anchor`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

const originalBox = `fn sceneBox(n: BvhNode, o: vec3f, inv: vec3f, tMin: f32, tMax: f32) -> f32 {
  workCounters[WORK_BOX]++;
  let t0 = (n.lo - o) * inv;
  let t1 = (n.hi - o) * inv;
  let tn = min(t0, t1);
  let tf = max(t0, t1);
  let enter = max(max(tn.x, tn.y), max(tn.z, tMin));
  let exit = min(min(tf.x, tf.y), min(tf.z, tMax)) * 1.0000004;
  return select(SCENE_NO_HIT, enter, enter <= exit);
}`;

const repairedBox = `fn sceneBox(n: BvhNode, o: vec3f, d: vec3f, inv: vec3f, tMin: f32, tMax: f32) -> f32 {
  workCounters[WORK_BOX]++;
  // A ray parallel to an axis occupies that slab for its entire interval if
  // its origin is inside the CLOSED slab. In particular an origin exactly on
  // the upper face must not turn the slab exit into zero via 0 * safeInverse.
  // Test the actual direction: a tiny nonzero direction is not parallel.
  let parallel = d == vec3f(0.0);
  if ((parallel.x && (o.x < n.lo.x || o.x > n.hi.x)) ||
      (parallel.y && (o.y < n.lo.y || o.y > n.hi.y)) ||
      (parallel.z && (o.z < n.lo.z || o.z > n.hi.z))) { return SCENE_NO_HIT; }
  let t0 = select(n.lo - o, vec3f(0.0), parallel) * inv;
  let t1 = select(n.hi - o, vec3f(0.0), parallel) * inv;
  let tn = select(min(t0, t1), vec3f(-SCENE_NO_HIT), parallel);
  let tf = select(max(t0, t1), vec3f(SCENE_NO_HIT), parallel);
  let enter = max(max(tn.x, tn.y), max(tn.z, tMin));
  let exit = min(min(tf.x, tf.y), min(tf.z, tMax)) * 1.0000004;
  return select(SCENE_NO_HIT, enter, enter <= exit);
}`;

function restoreOriginal(source) {
  source = replaceOnce(source, repairedBox, originalBox, 'original slab implementation');
  for (const [before, after] of [
    ['sceneBox(sceneNodes[0], o, d, inv, tMin, hit.t)', 'sceneBox(sceneNodes[0], o, inv, tMin, hit.t)'],
    ['sceneBox(sceneNodes[root], lo, ld, linv, tMin, hit.t)', 'sceneBox(sceneNodes[root], lo, linv, tMin, hit.t)'],
    ['sceneBox(sceneNodes[n.a], o, d, inv, tMin, hit.t)', 'sceneBox(sceneNodes[n.a], o, inv, tMin, hit.t)'],
    ['sceneBox(sceneNodes[n.b], o, d, inv, tMin, hit.t)', 'sceneBox(sceneNodes[n.b], o, inv, tMin, hit.t)'],
  ]) source = replaceOnce(source, before, after, 'original slab call');
  return source;
}

function parallelFast(source) {
  const fastBox = repairedBox.replace('  workCounters[WORK_BOX]++;', `  workCounters[WORK_BOX]++;
  // Most camera rays are nonparallel. Preserve their original arithmetic;
  // exact-zero axes still take the fully repaired closed-slab path below.
  if (all(d != vec3f(0.0))) {
    let t0 = (n.lo - o) * inv;
    let t1 = (n.hi - o) * inv;
    let tn = min(t0, t1);
    let tf = max(t0, t1);
    let enter = max(max(tn.x, tn.y), max(tn.z, tMin));
    let exit = min(min(tf.x, tf.y), min(tf.z, tMax)) * 1.0000004;
    return select(SCENE_NO_HIT, enter, enter <= exit);
  }`);
  return replaceOnce(source, repairedBox, fastBox, 'parallel-fast');
}

function branchlessSlabs(source) {
  const box = `fn sceneBox(n: BvhNode, o: vec3f, d: vec3f, inv: vec3f, tMin: f32, tMax: f32) -> f32 {
  workCounters[WORK_BOX]++;
  let parallel = d == vec3f(0.0);
  // Leave every nonparallel component unchanged; zero the unused parallel
  // products before substituting their final near/far interval below.
  let activeInv = select(inv, vec3f(0.0), parallel);
  let t0 = (n.lo - o) * activeInv;
  let t1 = (n.hi - o) * activeInv;
  let parallelNear = select(vec3f(-SCENE_NO_HIT), vec3f(SCENE_NO_HIT), n.lo > o);
  let parallelFar = select(vec3f(-SCENE_NO_HIT), vec3f(SCENE_NO_HIT), n.hi >= o);
  // Select AFTER min/max so an empty parallel interval is never reordered.
  // Inside: [-M,+M]. Below lo: [+M,+M] yields the M miss sentinel or a miss.
  // Above hi: [-M,-M] has exit < tMin because sceneIntersect validates tMin>=0.
  let tn = select(min(t0, t1), parallelNear, parallel);
  let tf = select(max(t0, t1), parallelFar, parallel);
  let enter = max(max(tn.x, tn.y), max(tn.z, tMin));
  let exit = min(min(tf.x, tf.y), min(tf.z, tMax)) * 1.0000004;
  return select(SCENE_NO_HIT, enter, enter <= exit);
}`;
  return replaceOnce(source, repairedBox, box, 'branchless-slabs');
}

const originalTriangleCoordinates = `  let A = p0 - r.o; let B = p1 - r.o; let C = p2 - r.o;
  let ax = A[r.kx] - r.s.x * A[r.kz]; let ay = A[r.ky] - r.s.y * A[r.kz];
  let bx = B[r.kx] - r.s.x * B[r.kz]; let by = B[r.ky] - r.s.y * B[r.kz];
  let cx = C[r.kx] - r.s.x * C[r.kz]; let cy = C[r.ky] - r.s.y * C[r.kz];`;

const staticTriangleCoordinates = `  let A = sceneStaticPermutation(p0 - r.o, r);
  let B = sceneStaticPermutation(p1 - r.o, r);
  let C = sceneStaticPermutation(p2 - r.o, r);
  let ax = A.x - r.s.x * A.z; let ay = A.y - r.s.y * A.z;
  let bx = B.x - r.s.x * B.z; let by = B.y - r.s.y * B.z;
  let cx = C.x - r.s.x * C.z; let cy = C.y - r.s.y * C.z;`;

const originalTriangleReturn = `  let t = (u * r.s.z * A[r.kz] + v * r.s.z * B[r.kz] + w * r.s.z * C[r.kz]) / det;
  if (!(t > tMin && t < tMax)) { return miss; }
  return vec4f(t, u / det, v / det, w / det);`;

function staticAxes(source) {
  source = replaceOnce(source, '// Returns (t, w0, w1, w2) with t = SCENE_NO_HIT on a miss.',
    `// Rotate the dominant axis to z using constant swizzles. The reciprocal
// dominant direction has the same sign as d[kz] for every validated ray, so
// its sign reproduces sceneWatertight's x/y swap without dynamic indexing.
// select/swizzle only move components; edge arithmetic stays in its old order.
fn sceneStaticPermutation(v: vec3f, r: WatertightRay) -> vec3f {
  let cyclic = select(select(v, v.yzx, r.kz == 0u), v.zxy, r.kz == 1u);
  return select(cyclic, cyclic.yxz, r.s.z < 0.0);
}
// Returns (t, w0, w1, w2) with t = SCENE_NO_HIT on a miss.`, 'static-axis helper');
  source = replaceOnce(source, originalTriangleCoordinates, staticTriangleCoordinates, 'static-axis coordinates');
  source = replaceOnce(source, originalTriangleReturn,
    originalTriangleReturn.replaceAll('A[r.kz]', 'A.z').replaceAll('B[r.kz]', 'B.z').replaceAll('C[r.kz]', 'C.z'),
    'static-axis distance');
  return source;
}

function reciprocal(source, staticAxis) {
  const before = staticAxis
    ? originalTriangleReturn.replaceAll('A[r.kz]', 'A.z').replaceAll('B[r.kz]', 'B.z').replaceAll('C[r.kz]', 'C.z')
    : originalTriangleReturn;
  const depth = staticAxis
    ? '(u * r.s.z * A.z + v * r.s.z * B.z + w * r.s.z * C.z)'
    : '(u * r.s.z * A[r.kz] + v * r.s.z * B[r.kz] + w * r.s.z * C[r.kz])';
  return replaceOnce(source, before, `  let scaledT = ${depth};
  // Preserve the division path for very small determinants: computing 1/det
  // unconditionally could overflow even when scaledT/det remains finite.
  if (abs(det) < 1e-30) {
    let t = scaledT / det;
    if (!(t > tMin && t < tMax)) { return miss; }
    return vec4f(t, u / det, v / det, w / det);
  }
  let inverseDet = 1.0 / det;
  let t = scaledT * inverseDet;
  if (!(t > tMin && t < tMax)) { return miss; }
  return vec4f(t, u * inverseDet, v * inverseDet, w * inverseDet);`, 'reciprocal');
}

function tinyLeaf(source) {
  return replaceOnce(source, `        let linv = sceneSafeInverse(ld);
        if (sceneBox(sceneNodes[root], lo, ld, linv, tMin, hit.t) < SCENE_NO_HIT) {`,
    `        let linv = sceneSafeInverse(ld);
        let rootNode = sceneNodes[root];
        // A leaf's triangles still apply exact tMin/current-hit tests. The
        // root-node and leaf-count checks remain active on the normal path.
        let rootIsLeaf = (rootNode.b & SCENE_LEAF_BIT) != 0u;
        if (rootIsLeaf || sceneBox(rootNode, lo, ld, linv, tMin, hit.t) < SCENE_NO_HIT) {`, 'tiny-leaf');
}

export function buildBvhVariant(source, { name, stackSize = 64 } = {}) {
  if (typeof source !== 'string') throw new TypeError('BVH source must be a string');
  const descriptor = VARIANTS.find(v => v.name === name);
  if (!descriptor) throw new Error(`Unknown BVH variant: ${name}`);
  if (!Number.isInteger(stackSize) || stackSize < 1 || stackSize > 64) {
    throw new RangeError('BVH benchmark stackSize must be an integer in [1, 64]');
  }
  const features = descriptor.features;
  if (features.includes('original')) source = restoreOriginal(source);
  if (features.includes('parallel-fast')) source = parallelFast(source);
  if (features.includes('branchless-slabs')) source = branchlessSlabs(source);
  if (features.includes('static-axis')) source = staticAxes(source);
  if (features.includes('reciprocal')) source = reciprocal(source, features.includes('static-axis'));
  if (features.includes('tiny-leaf')) source = tinyLeaf(source);
  if (features.includes('stack-size')) {
    source = replaceOnce(source, 'const SCENE_STACK_SIZE: u32 = 64u;',
      `const SCENE_STACK_SIZE: u32 = ${stackSize}u;`, 'stack-size');
  }
  return source;
}
