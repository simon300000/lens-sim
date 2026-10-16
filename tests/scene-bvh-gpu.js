import * as THREE from 'three/webgpu';
import { createGPUInterop } from '../src/rendering/three-interop.js';
import { createSceneResources } from '../src/rendering/scene-resources.js';
import { SCENE_INTERSECTOR_WGSL, WORK_COUNTERS_WGSL } from '../src/rendering/scene-wgsl.js';
import { bruteForceIntersect } from '../src/scene/scene-reference.js';
import { diagnosticScene, rng } from './scene-fixtures.js';
/** Test A: GPU two-level BVH against an f64 CPU brute force on the SAME
 * extracted geometry. Development reference only, never a runtime fallback. */
const out = document.querySelector('#result'), check = (c, m) => { if (!c) throw new Error(m); };
const KERNEL = WORK_COUNTERS_WGSL + SCENE_INTERSECTOR_WGSL + `
struct RayIn { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32 }
struct HitOut { t: f32, b1: f32, b2: f32, instance: u32, triangle: u32, status: u32, error: u32, front: u32 }
@group(0) @binding(0) var<storage,read> rays: array<RayIn>;
@group(0) @binding(1) var<storage,read_write> hits: array<HitOut>;
@group(0) @binding(6) var<storage,read> sceneNodes: array<BvhNode>;
@group(0) @binding(7) var<storage,read> sceneInstances: array<SceneInstance>;
@group(0) @binding(8) var<storage,read> sceneTriangles: array<SceneTriangle>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&rays)) { return; }
  let r = rays[id.x];
  let h = sceneIntersect(r.origin, r.direction, r.tMin, r.tMax);
  hits[id.x] = HitOut(h.t, h.b1, h.b2, h.instance, h.triangle, h.status, h.error, select(0u, 1u, h.front));
}`;
export async function traceGPU(interop, resources, rays) {
  const pipeline = await interop.computePipeline(KERNEL, 'BVH test kernel');
  const input = new Float32Array(rays.length * 8);
  rays.forEach((r, i) => input.set([...r.origin, r.tMin ?? 0, ...r.direction, r.tMax ?? 1e7], i * 8));
  const rayBuffer = interop.storage(input, 'test rays'), hitBuffer = interop.storage(rays.length * 32, 'test hits');
  const b = resources.bindings(6);
  const group = interop.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: rayBuffer } }, { binding: 1, resource: { buffer: hitBuffer } }, b[0], b[1], b[2]] });
  const encoder = interop.device.createCommandEncoder(), pass = encoder.beginComputePass();
  pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(rays.length / 64)); pass.end();
  interop.device.queue.submit([encoder.finish()]);
  const raw = await interop.readBuffer(hitBuffer, rays.length * 32);
  interop.release(rayBuffer); interop.release(hitBuffer);
  const f = new Float32Array(raw), u = new Uint32Array(raw);
  return rays.map((_, i) => ({ t: f[i * 8], b1: f[i * 8 + 1], b2: f[i * 8 + 2], instance: u[i * 8 + 3], triangle: u[i * 8 + 4], status: u[i * 8 + 5], error: u[i * 8 + 6], front: !!u[i * 8 + 7] }));
}
try {
  const adapter = await navigator.gpu.requestAdapter();
  const renderer = new THREE.WebGPURenderer({ antialias: false }); await renderer.init();
  const interop = createGPUInterop(renderer), errors = [];
  interop.device.addEventListener('uncapturederror', e => errors.push(e.error.message));
  const scene = diagnosticScene();
  const resources = createSceneResources({ interop, scene, starAngularRadius: 0, useWorker: true });
  const stats = await resources.build();
  check(stats.worker, 'BVH was not built in a Worker');
  const ex = resources.extracted;
  // Map packed instance -> source record and triangle -> original primitive.
  const inst = new Uint32Array(await interop.readBuffer(resources.buffers.instances, resources.buffers.instances.size));
  const tris = new Uint32Array(await interop.readBuffer(resources.buffers.triangles, resources.buffers.triangles.size));
  const r = rng(2026), rays = [];
  for (let i = 0; i < 6000; i++) {
    const origin = [(r() - .5) * 3, (r() - .5) * 3, (r() - .5) * 3];
    // Full sphere of directions: includes rays outside any camera frustum.
    let d = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
    if (i % 3 === 0) d = [(r() - .5) * 1.4, (r() - .5) * 1.0, -1];
    if (i % 97 === 0) d = [1e-9, 0, -1];           // AABB direction component ~ 0
    if (i % 89 === 0) d = [1, 1e-7, 0];             // near-parallel to axis planes
    rays.push({ origin, direction: d });
  }
  // Aimed rays: towards random points inside random instance bounds.
  for (let i = 0; i < 6000; i++) {
    const k = Math.floor(r() * ex.instances.count), b = ex.instances.bounds.subarray(k * 6, k * 6 + 6);
    const target = [0, 1, 2].map(a => b[a] + (b[a + 3] - b[a]) * r());
    const origin = [(r() - .5) * 4, (r() - .5) * 4, (r() - .5) * 4 + 1];
    rays.push({ origin, direction: target.map((v, a) => v - origin[a]) });
  }
  // Hidden-surface queries: restart beyond the first hit along the same ray.
  const firsts = rays.slice(0, 12000).map(ray => bruteForceIntersect(ex, ray.origin, ray.direction));
  firsts.forEach((h, i) => { if (h) rays.push({ ...rays[i], tMin: h.t * (1 + 1e-5) + 1e-5, hidden: true }); });
  const gpu = await traceGPU(interop, resources, rays);
  let hits = 0, robust = 0, identity = 0, tMaxErr = 0, baryMaxErr = 0, hidden = 0, missMismatch = [], idMismatch = [], errorsGPU = 0;
  for (let i = 0; i < rays.length; i++) {
    const ref = bruteForceIntersect(ex, rays[i].origin, rays[i].direction, rays[i].tMin ?? 0), g = gpu[i];
    if (g.status === 2) { errorsGPU++; continue; }
    if (!ref) { if (g.status === 1) missMismatch.push({ i, gpu: g }); continue; }
    hits++; if (rays[i].hidden) hidden++;
    const minBary = Math.min(...ref.bary);
    const near = Math.abs(g.t - ref.t) <= 2e-5 * Math.max(1, ref.t);
    if (minBary > 1e-4) {
      robust++;
      if (g.status !== 1) { missMismatch.push({ i, ref: ref.t }); continue; }
      tMaxErr = Math.max(tMaxErr, Math.abs(g.t - ref.t) / Math.max(1, ref.t));
      const source = inst[g.instance * 32 + 27], prim = tris[g.triangle * 16 + 12];
      if (source === ref.instance && prim === ref.primitive && g.front === ref.front) {
        identity++;
        baryMaxErr = Math.max(baryMaxErr, Math.abs(g.b1 - ref.bary[1]), Math.abs(g.b2 - ref.bary[2]));
      } else if (!near) idMismatch.push({ i, ref, g, source, prim });
    }
  }
  check(errorsGPU === 0, `GPU traversal errors: ${errorsGPU}`);
  check(missMismatch.length === 0, 'GPU/reference miss mismatch: ' + JSON.stringify(missMismatch.slice(0, 5)));
  check(idMismatch.length === 0, 'Nearest surface identity mismatch: ' + JSON.stringify(idMismatch.slice(0, 3)));
  check(tMaxErr < 2e-5 && baryMaxErr < 1e-3, `precision t ${tMaxErr} bary ${baryMaxErr}`);
  check(hidden > 1000, `too few hidden-surface checks: ${hidden}`);
  check(errors.length === 0, errors.join('\n'));
  const result = { passed: true, environment: { userAgent: navigator.userAgent, adapter: adapter.info }, rays: rays.length, hits, robustHits: robust,
    identityMatches: identity, hiddenSurfaceHits: hidden, maxRelativeTError: tMaxErr, maxBarycentricError: baryMaxErr, bvh: stats, errors };
  out.textContent = JSON.stringify(result, null, 2); document.body.dataset.passed = 'true'; window.__bvhTest = result;
} catch (error) { out.textContent = error.stack || String(error); document.body.dataset.passed = 'false'; console.error(error); }
