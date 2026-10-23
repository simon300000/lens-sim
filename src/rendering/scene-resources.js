import * as THREE from 'three/webgpu';
import { extractScene, objectSignature, MATERIAL_FLAGS, UNSUPPORTED_REASONS } from '../scene/scene-extract.js';
import { createSceneBVH } from './scene-bvh.js';
import { lensRole } from '../scene/lens-registry.js';

const STAR_AZ = 64, STAR_EL = 16;

export function packMaterialTable(materials, stars = null) {
  const materialVec4 = materials.length * 5;
  const starCount = stars ? stars.directions.length / 3 : 0;
  const starOffset = 1 + materialVec4, gridOffset = starOffset + starCount * 2;
  // Star grid: cell start offsets (STAR_AZ*STAR_EL+1 u32) then index list.
  const cells = Array.from({ length: STAR_AZ * STAR_EL }, () => []);
  if (stars) {
    const r = stars.angularRadius;
    for (let i = 0; i < starCount; i++) {
      const x = stars.directions[i * 3], y = stars.directions[i * 3 + 1], z = stars.directions[i * 3 + 2];
      const az = (Math.atan2(z, x) + Math.PI) / (2 * Math.PI), cosEl = Math.max(1e-3, Math.sqrt(Math.max(0, 1 - y * y)));
      const da = r / cosEl / (2 * Math.PI) * 1.5, dy = r * 1.5;
      const y0 = Math.max(0, Math.floor((y - dy) * STAR_EL)), y1 = Math.min(STAR_EL - 1, Math.floor((y + dy) * STAR_EL));
      const a0 = Math.floor((az - da) * STAR_AZ), a1 = Math.floor((az + da) * STAR_AZ);
      for (let yy = y0; yy <= y1; yy++) for (let aa = a0; aa <= a1; aa++) cells[((aa % STAR_AZ) + STAR_AZ) % STAR_AZ + yy * STAR_AZ].push(i);
    }
  }
  const starts = new Uint32Array(STAR_AZ * STAR_EL + 1);
  let total = 0; cells.forEach((c, i) => { starts[i] = total; total += c.length; }); starts[cells.length] = total;
  const startVec4 = Math.ceil(starts.length / 4), listVec4 = Math.ceil(Math.max(1, total) / 4);
  const vec4Count = gridOffset + startVec4 + listVec4;
  const buffer = new ArrayBuffer(vec4Count * 16), f = new Float32Array(buffer), u = new Uint32Array(buffer);
  u.set([materials.length, starOffset, starCount, gridOffset], 0);
  materials.forEach((entry, i) => {
    const m = entry.material, o = (1 + i * 5) * 4;
    const physical = !!m.isMeshPhysicalNodeMaterial, metal = m.metalness ?? 0;
    let f0 = [.04, .04, .04], f90 = 1;
    if (physical) {
      const ior = m.ior ?? 1.5, base = ((ior - 1) / (ior + 1)) ** 2, si = m.specularIntensity ?? 1, sc = m.specularColor ?? new THREE.Color(1, 1, 1);
      f0 = [sc.r, sc.g, sc.b].map(c => Math.min(base * c, 1) * si); f90 = si * (1 - metal) + metal;
    }
    const emissive = m.emissive ? [m.emissive.r * m.emissiveIntensity, m.emissive.g * m.emissiveIntensity, m.emissive.b * m.emissiveIntensity] : [0, 0, 0];
    f.set([m.color?.r ?? 1, m.color?.g ?? 1, m.color?.b ?? 1, m.opacity], o);
    f.set([...emissive, m.roughness ?? 1], o + 4);
    f.set([...f0, f90], o + 8);
    f.set([metal, physical ? m.clearcoat ?? 0 : 0, physical ? m.clearcoatRoughness ?? 0 : 0, m.envMap ? m.envMapIntensity : 1], o + 12);
    const flags = (m.vertexColors ? MATERIAL_FLAGS.VERTEX_COLORS : 0) | (m.transparent ? MATERIAL_FLAGS.TRANSPARENT : 0) | (m.fog !== false ? MATERIAL_FLAGS.FOG : 0) |
      (m.lights !== false ? MATERIAL_FLAGS.LIGHTS : 0) | (entry.reason ? MATERIAL_FLAGS.UNSUPPORTED : 0) | (physical && m.clearcoat > 0 ? MATERIAL_FLAGS.CLEARCOAT : 0);
    u.set([entry.kind, flags, entry.reason, 0], o + 16);
  });
  for (let i = 0; i < starCount; i++) {
    f.set([stars.directions[i * 3], stars.directions[i * 3 + 1], stars.directions[i * 3 + 2], 0], (starOffset + i * 2) * 4);
    f.set([stars.colors[i * 3], stars.colors[i * 3 + 1], stars.colors[i * 3 + 2], 0], (starOffset + i * 2 + 1) * 4);
  }
  u.set(starts, gridOffset * 4);
  let k = (gridOffset + startVec4) * 4;
  for (const c of cells) for (const i of c) u[k++] = i;
  return buffer;
}

function starData(scene, angularRadius) {
  let stars = null;
  scene.traverse(o => {
    if (lensRole(o) !== 'environment-stars' || stars) return;
    const p = o.geometry.attributes.position, c = o.geometry.attributes.color, n = p.count;
    const directions = new Float32Array(n * 3), colors = new Float32Array(n * 3), v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(p, i).normalize(); directions.set([v.x, v.y, v.z], i * 3);
      colors.set(c ? [c.getX(i), c.getY(i), c.getZ(i)] : [1, 1, 1], i * 3);
    }
    stars = { directions, colors, angularRadius };
  });
  return stars;
}

/** The lens-sim (three.js) scene producer: extracts the registered scene into a
 * scene source for the tracer's BVH (scene-bvh.js) and packs the garden
 * provider's material/star table. Diffing and change handling (refresh):
 *   geometry/topology -> new BLAS sources for changed keys (+ TLAS); others are reused
 *   object/instance transform, instance colour, visibility -> TLAS only
 *   material parameters only -> rewrite the table; no BVH work
 * bvh: the tracer's scene BVH (tracer.scene); a private one when omitted. */
export function createSceneResources({ interop, scene, camera = null, starAngularRadius, useWorker = true, bvh = createSceneBVH({ interop, worker: useWorker ? undefined : false }) }) {
  const { device } = interop;
  let tables = null, extracted = null, signatures = [], stats = null, materialRevision = 0;
  let building = null, disposed = false;
  const counters = { materialUploads: 0 };
  const knownBlas = new Map();
  async function build(reason = 'initial') {
    const started = performance.now();
    const ex = extractScene(scene, { camera, knownBlas, deferInstances: true });
    // Signatures describe what was extracted; edits during the async build must still read as changes.
    const extractedSignatures = ex.objects.map(objectSignature);
    const materialData = packMaterialTable(ex.materials, starData(scene, starAngularRadius));
    interop.memoryBudget?.assertAdditional(materialData.byteLength, '新旧材质表并存的分配峰值');
    const built = await bvh.setScene(ex.source, { reason });
    if (!built || disposed) return null;
    ex.instances = built.instances;
    const report = built.stats.expandReport;
    ex.report.degenerate = report.degenerate; ex.report.negativeDeterminant = report.negativeDeterminant; ex.report.instances = built.instances.count;
    const nextTables = interop.storage(materialData, 'Lens material / star tables');
    if (tables) interop.release(tables);
    tables = nextTables; counters.materialUploads++; materialRevision++;
    knownBlas.clear();
    for (const b of ex.blas) knownBlas.set(b.key, { key: b.key, bounds: b.bounds, points: b.points ?? null, triangleCount: b.triangleCount, hasColor: b.hasColor, hasNormal: b.hasNormal,
      hasUV: b.hasUV, geometryUuid: b.geometryUuid, range: b.range, stub: true });
    extracted = ex; signatures = extractedSignatures;
    stats = { ...built.stats, report: { ...ex.report, unsupported: ex.report.unsupported.map(u => `${u.material}: ${u.reason}`) },
      extractMs: ex.report.extractMs, buildWallMs: performance.now() - started, gpuBytes: built.stats.gpuBytes + tables.size, counters: { ...built.stats.counters, ...counters } };
    return stats;
  }
  function writeTables() {
    const data = packMaterialTable(extracted.materials, starData(scene, starAngularRadius));
    if (!tables || tables.size < data.byteLength) { const next=interop.storage(data,'Lens material / star tables');if(tables)interop.release(tables);tables=next; }
    else device.queue.writeBuffer(tables, 0, data);
    counters.materialUploads++; materialRevision++;
  }
  /** Diff registered objects; do the minimum GPU/BVH work. */
  async function refresh() {
    if (!extracted) return build();
    let topology = false, transform = false, material = false;
    const current = new Set();
    scene.updateMatrixWorld(true);
    extracted.objects.forEach((entry, i) => {
      current.add(entry.object);
      const s = objectSignature(entry), old = signatures[i];
      if (s.geometry !== old.geometry || s.visible !== old.visible) topology = true;
      else if (s.transform !== old.transform || s.color !== old.color) transform = true;
      if (s.material !== old.material) material = true;
    });
    let added = false;
    const attached = new Set();
    scene.traverse(o => { attached.add(o); if (o.isMesh && !lensRole(o) && o.visible && !current.has(o)) added = true; });
    // A mesh detached from the scene keeps its own signature; catch it here.
    const removed = [...current].some(o => !attached.has(o));
    if (topology || added || removed) return build('topology');
    if (transform) return build('tlas');
    if (material) { writeTables(); return { reason: 'material' }; }
    return null;
  }
  return {
    bvh, get buffers() { return bvh.buffers; }, get tables() { return tables; }, get stats() { return stats; }, get revision() { return bvh.revision; },
    get materialRevision() { return materialRevision; }, get extracted() { return extracted; }, get ready() { return bvh.ready && !!tables; },
    get counters() { return { ...bvh.counters, ...counters }; },
    unsupported: () => extracted?.report.unsupported ?? [],
    build(reason) { building = build(reason).finally(() => { building = null; }); return building; },
    refresh, writeTables,
    bindings: base => bvh.bindings(base),
    dispose() { disposed = true; bvh.dispose(); if (tables) interop.release(tables); tables = null; },
    reasons: UNSUPPORTED_REASONS,
  };
}
