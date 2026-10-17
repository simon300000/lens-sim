/**
 * Benchmark-only geometric ray workloads.
 *
 * Reconstructed after the 2026-10-17 runtime reset. The scene builders, camera
 * parameters and test purposes match the first experiment, but these input
 * bytes are a NEW corpus: do not label its hashes as the lost original corpus.
 * No renderer or lighting pass is created here.
 */
import * as THREE from 'three/webgpu';
import { extractScene } from '../src/scene/scene-extract.js';
import { buildSceneBuffers, STACK_SIZE } from '../src/scene/bvh-builder.js';
import { bruteForceIntersect } from '../src/scene/scene-reference.js';
import { diagnosticScene, rng } from './scene-fixtures.js';

export const BVH_WORKLOAD_NAMES = Object.freeze(['diagnostic', 'villa', 'vegetation', 'edges']);
const CORPUS_VERSION = 'reconstructed-2026-10-17-v1';
const MAX_T = 1e20, REFERENCE_LIMIT = 2048;
const sceneCache = new Map(), workloadCache = new Map();
const sub = (a, b) => a.map((v, i) => v - b[i]);
const add = (a, b) => a.map((v, i) => v + b[i]);
const scale = (a, s) => a.map(v => v * s);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => { const n = Math.hypot(...a); if (!(n > 0)) throw new Error('Zero benchmark direction'); return scale(a, 1 / n); };

function putRay(rays, i, origin, direction, tMin = 0, tMax = MAX_T) {
  // Typed-array storage rounds every value before either GPU or f64 reference
  // sees it. In particular reference origins are not hidden f64 camera values.
  rays.set([...origin, tMin, ...direction, tMax], i * 8);
}

function sphereDirection(random) {
  const z = 2 * random() - 1, phi = 2 * Math.PI * random(), r = Math.sqrt(Math.max(0, 1 - z * z));
  return [r * Math.cos(phi), r * Math.sin(phi), z];
}

function edgeScene() {
  const scene = new THREE.Scene();
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  const quad = positions => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]); geometry.computeVertexNormals();
    return geometry;
  };
  const z = quad([-1,-1,0, 1,-1,0, 1,1,0, -1,1,0]);
  const y = quad([-1,0,-1, -1,0,1, 1,0,1, 1,0,-1]);
  const x = quad([0,-1,-1, 0,1,-1, 0,1,1, 0,-1,1]);
  const mesh = (geometry, position, name, scaling = [1, 1, 1]) => {
    const object = new THREE.Mesh(geometry, material);
    object.name = name; object.position.fromArray(position); object.scale.fromArray(scaling); scene.add(object);
  };
  mesh(z, [0, 0, -4], 'Edge fixture XY');
  mesh(y, [4, -3, -4], 'Edge fixture XZ');
  mesh(x, [-3, 3, -4], 'Edge fixture YZ');
  mesh(z, [4, 3, -8], 'Edge fixture mirrored scaled XY', [-2, .5, 1]);
  return scene;
}

async function sceneData(name) {
  const key = name === 'villa' || name === 'vegetation' ? 'full' : name;
  if (!sceneCache.has(key)) sceneCache.set(key, (async () => {
    const started = performance.now();
    let scene;
    if (key === 'full') {
      // Lazy import lets diagnostic/edge checks run without the large ISO asset.
      const { buildSanteiScene } = await import('../src/scene/santei-scene.js');
      ({ scene } = buildSanteiScene());
    } else scene = key === 'diagnostic' ? diagnosticScene() : edgeScene();
    const sceneBuildMs = performance.now() - started;
    const extracted = extractScene(scene);
    const packed = buildSceneBuffers({ blasSources: extracted.blas, instances: extracted.instances });
    return { scene, extracted, packed, sceneBuildMs };
  })());
  return sceneCache.get(key);
}

function diagnosticRays(extracted, count) {
  const seed = 20261017, random = rng(seed), rays = new Float32Array(count * 8);
  const distribution = { sphere: 0, aimed: 0, axisParallel: 0, hidden: 0 };
  const hidden = [[0,0,0], [.15,.1,0], [-.2,.1,0], [0,-.2,0]].map(origin => {
    origin = origin.map(Math.fround);
    const direction = [0, 0, -1], first = bruteForceIntersect(extracted, origin, direction);
    if (!first) throw new Error('Diagnostic hidden-layer template lost its foreground hit');
    return { origin, direction, tMin: Math.fround(first.t + Math.max(1e-4, Math.abs(first.t) * 1e-5)) };
  });
  const axes = [[1,0,0], [-1,0,0], [0,1,0], [0,-1,0], [0,0,-1], [1e-9,0,-1], [0,1e-9,-1], [0,0,-2]];
  for (let i = 0; i < count; i++) {
    if (i % 16 === 0) {
      const h = hidden[(i >> 4) % hidden.length];
      putRay(rays, i, h.origin, h.direction, h.tMin); distribution.hidden++; continue;
    }
    const origin = [(random() - .5) * 4, (random() - .5) * 3, (random() - .5) * 2];
    let direction;
    if (i % 17 === 1) { direction = axes[Math.floor(i / 17) % axes.length]; distribution.axisParallel++; }
    else if (i % 2 === 0) {
      const k = Math.min(extracted.instances.count - 1, Math.floor(random() * extracted.instances.count)), b = extracted.instances.bounds;
      const target = [0, 1, 2].map(a => b[k * 6 + a] + (b[k * 6 + 3 + a] - b[k * 6 + a]) * (.1 + .8 * random()));
      direction = unit(sub(target, origin)); distribution.aimed++;
    } else { direction = sphereDirection(random); distribution.sphere++; }
    putRay(rays, i, origin, direction);
  }
  return { rays, metadata: { seed, distribution, hiddenTemplates: hidden.length, directionsNormalized: false } };
}

function edgeRays(count) {
  const e = 2 ** -20;
  // Each entry is [origin, direction, tMin?, tMax?]. The coordinate planes
  // deliberately use exact f32 endpoints and no trigonometric rotations.
  const templates = [
    [[0,0,0], [0,0,-1]],
    [[1,1,0], [0,0,-1]],
    [[1,0,0], [-0,0,-1]],
    [[-1,-1,0], [0,0,-2]],
    [[1+e,0,0], [0,0,-1]],
    [[-1-e,0,0], [0,0,-1]],
    [[0,0,-4], [1,0,0]],
    [[0,0,-3], [1,0,0]],
    [[0,0,-6], [0,0,1]],
    [[0,0,0], [0,0,-1], 4],
    [[0,0,0], [0,0,-1], 0, 4],
    [[0,0,0], [0,0,-1], 4-e],
    [[0,0,0], [0,0,-1], 0, 4+e],
    [[0,0,0], [0,0,-4]],
    [[0,3,-4], [-1,0,0]],
    [[0,4,-3], [-1,0,0]],
    [[-6,3,-4], [1,0,0]],
    [[4,0,-4], [0,-1,0]],
    [[5,0,-3], [0,-2,0]],
    [[4,-6,-4], [0,1,0]],
    [[4,3,0], [0,0,-1]],
    [[6,3.5,0], [0,0,-1]],
    [[3,3,0], [0,0,-2]],
    [[0,0,0], [1e-9,0,-1]],
  ];
  const rays = new Float32Array(count * 8);
  for (let i = 0; i < count; i++) putRay(rays, i, ...templates[i % templates.length]);
  return { rays, metadata: { purpose: 'Correctness only: shared edges/vertices, parallel/coplanar rays, strict ray intervals, negative/nonuniform transforms.',
    uniqueRayCount: templates.length, repeatedForRequestedCount: true, allowEqualDistanceEdgeTies: true } };
}

function cameraRays(name, count) {
  const camera = name === 'villa'
    ? { position: [21,13,27], target: [0,2.7,2], fovY: 40, aspect: 1.5, focusDistance: 30, apertureRadius: .0125 }
    : { position: [17,3.5,8], target: [13,2.7,-1.5], fovY: 55, aspect: 1.5, focusDistance: 10, apertureRadius: .0125 };
  const seed = name === 'villa' ? 3419781 : 3419782, random = rng(seed);
  const forward = unit(sub(camera.target, camera.position)), right = unit(cross(forward, [0, 1, 0])), up = cross(right, forward);
  const pairs = Math.ceil(count / 2), width = Math.ceil(Math.sqrt(pairs * camera.aspect)), height = Math.ceil(pairs / width);
  const tangent = Math.tan(camera.fovY * Math.PI / 360), rays = new Float32Array(count * 8);
  for (let pixel = 0; pixel < pairs; pixel++) {
    const sx = ((pixel % width + random()) / width * 2 - 1) * camera.aspect * tangent;
    const sy = (1 - (Math.floor(pixel / width) + random()) / height * 2) * tangent;
    const planeDirection = add(forward, add(scale(right, sx), scale(up, sy)));
    const focus = add(camera.position, scale(planeDirection, camera.focusDistance));
    putRay(rays, pixel * 2, camera.position, unit(planeDirection));
    if (pixel * 2 + 1 < count) {
      const radius = camera.apertureRadius * Math.sqrt(random()), angle = 2 * Math.PI * random();
      const origin = add(camera.position, add(scale(right, radius * Math.cos(angle)), scale(up, radius * Math.sin(angle))));
      putRay(rays, pixel * 2 + 1, origin, unit(sub(focus, origin)));
    }
  }
  return { rays, metadata: { seed, camera, grid: [width, height],
    distribution: { pinhole: Math.ceil(count / 2), finiteAperture: Math.floor(count / 2) },
    directionsNormalizedBeforeF32: true,
    limitation: 'Geometric camera workload with circular-aperture jitter; not captured physical-lens output and not a full render.' } };
}

function references(extracted, rays) {
  const count = Math.min(REFERENCE_LIMIT, rays.length / 8), result = [];
  for (let i = 0; i < count; i++) {
    const o = i * 8;
    result.push(bruteForceIntersect(extracted, Array.from(rays.subarray(o, o + 3)), Array.from(rays.subarray(o + 4, o + 7)), rays[o + 3], rays[o + 7]));
  }
  return result;
}

/**
 * Returns {scene, extracted, packed, rays, metadata, referenceRays}.
 * rays: Float32Array with stride 8 [origin.xyz,tMin,direction.xyz,tMax].
 * referenceRays: prefix-aligned f64 hits with source instance/primitive IDs;
 * an element null is a miss. For full scenes the entire field is null.
 */
export async function loadBvhWorkload(name, { rayCount = 8192 } = {}) {
  if (!BVH_WORKLOAD_NAMES.includes(name)) throw new Error('Unknown BVH workload: ' + name);
  if (!Number.isInteger(rayCount) || rayCount < 1 || rayCount > 262144) throw new RangeError('rayCount must be an integer in [1,262144]');
  const key = name + ':' + rayCount;
  if (!workloadCache.has(key)) workloadCache.set(key, (async () => {
    const base = await sceneData(name);
    const generated = name === 'diagnostic' ? diagnosticRays(base.extracted, rayCount)
      : name === 'edges' ? edgeRays(rayCount) : cameraRays(name, rayCount);
    if (!generated.rays.every(Number.isFinite)) throw new Error('Non-finite benchmark ray');
    const started = performance.now();
    const referenceRays = name === 'diagnostic' || name === 'edges' ? references(base.extracted, generated.rays) : null;
    const referenceMs = performance.now() - started, r = base.extracted.report;
    return { scene: base.scene, extracted: base.extracted, packed: base.packed, rays: generated.rays, referenceRays,
      metadata: { name, rayCorpusVersion: CORPUS_VERSION,
        corpusNote: 'Reconstructed after runtime reset; not asserted byte-identical to the initial corpus.',
        sceneSource: name === 'diagnostic' ? 'diagnosticScene()' : name === 'edges' ? 'benchmark edgeScene()' : 'buildSanteiScene()',
        sceneBuildMs: base.sceneBuildMs, sceneCounts: { meshes: r.meshes, instances: r.instances, blas: r.blas,
          uniqueTriangles: r.uniqueTriangles, expandedTriangles: r.expandedTriangles },
        rayCount, rayStride: 8, rayFormat: 'f32: origin.xyz,tMin,direction.xyz,tMax',
        stackBound: base.packed.stats.stackBound, stackCapacity: STACK_SIZE, bvh: base.packed.stats,
        referenceRayCount: referenceRays?.length ?? 0, referenceMs,
        referenceMapping: referenceRays ? 'Prefix-aligned f64 bruteForceIntersect on f32 input rays; source instance/primitive IDs.' : null,
        ...generated.metadata } };
  })());
  return workloadCache.get(key);
}

