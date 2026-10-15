import * as THREE from 'three/webgpu';
import { lensRole, lensMaterial, PROCEDURAL } from './lens-registry.js';
import { expandInstances } from './instance-expand.js';

/** Scene → plain typed arrays for the lens BVH. CPU-side preparation only;
 * it never renders or queries pixels. Typed arrays are COPIED from Three's
 * attributes, so transferring them to a Worker cannot detach live geometry.
 */
export const SIDE = Object.freeze({ FRONT: 0, BACK: 1, DOUBLE: 2 });
export const INSTANCE_FLAGS = Object.freeze({
  SIDE_MASK: 3, RECEIVE_SHADOW: 4, TRANSPARENT: 8, UNSUPPORTED: 16, VERTEX_COLOR: 32, INSTANCE_COLOR: 64,
});
export const MATERIAL_FLAGS = Object.freeze({ VERTEX_COLORS: 1, TRANSPARENT: 2, FOG: 4, LIGHTS: 8, UNSUPPORTED: 16, CLEARCOAT: 32 });
// Reasons are numeric on GPU and named in the report.
export const UNSUPPORTED_REASONS = Object.freeze([
  'none', '材质类型不在镜头着色器注册范围', '自定义节点无已注册的镜头材质描述', '使用了图片纹理贴图',
  'alphaTest/alphaHash 尚未实现', '透射/光泽/虹彩/各向异性等物理扩展', '非 Normal 混合模式', 'flatShading/wireframe',
]);
const NODE_PROPS = ['colorNode', 'normalNode', 'roughnessNode', 'metalnessNode', 'emissiveNode', 'opacityNode', 'positionNode',
  'vertexNode', 'fragmentNode', 'outputNode', 'alphaTestNode', 'maskNode', 'castShadowNode', 'receivedShadowNode', 'aoNode', 'lightsNode', 'envNode', 'backdropNode'];
const DESCRIPTOR_COVERS = {
  [PROCEDURAL.WOOD]: ['colorNode', 'roughnessNode', 'normalNode'],
  [PROCEDURAL.MEADOW]: ['colorNode'],
  [PROCEDURAL.WATER]: ['normalNode', 'emissiveNode'],
};
const TEXTURE_PROPS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap', 'bumpMap', 'aoMap', 'lightMap',
  'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'displacementMap', 'specularColorMap', 'specularIntensityMap', 'envMap'];

export function classifyMaterial(material) {
  const descriptor = lensMaterial(material);
  const kind = descriptor?.kind ?? PROCEDURAL.NONE;
  let reason = 0;
  if (!(material.isMeshStandardNodeMaterial || material.isMeshPhysicalNodeMaterial)) reason = 1;
  else if (TEXTURE_PROPS.some(k => material[k])) reason = 3;
  else if (material.alphaTest > 0 || material.alphaHash || material.alphaToCoverage) reason = 4;
  else if (material.isMeshPhysicalNodeMaterial && (material.transmission > 0 || material.sheen > 0 || material.iridescence > 0 || material.anisotropy > 0 || material.dispersion > 0)) reason = 5;
  else if (material.transparent && material.blending !== THREE.NormalBlending) reason = 6;
  else if (material.flatShading || material.wireframe) reason = 7;
  else {
    const covered = DESCRIPTOR_COVERS[kind] ?? [];
    if (NODE_PROPS.some(k => material[k] && !covered.includes(k))) reason = 2;
  }
  return { kind, reason, descriptor };
}

const _box = new THREE.Box3(), _v = new THREE.Vector3();

function visibleTo(object, camera) {
  for (let o = object; o; o = o.parent) if (!o.visible) return false;
  return camera ? object.layers.test(camera.layers) : true;
}

/** One BLAS source per (geometry, triangle range). Copies attributes. */
function blasSource(geometry, start, count) {
  const index = geometry.index, position = geometry.attributes.position;
  const total = index ? index.count : position.count;
  const first = Math.max(0, start), last = Math.min(total, start + count);
  const triCount = Math.max(0, Math.floor((last - first) / 3));
  const indices = new Uint32Array(triCount * 3), primitiveIds = new Uint32Array(triCount);
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) { const i = first + t * 3 + k; indices[t * 3 + k] = index ? index.getX(i) : i; }
    primitiveIds[t] = (first / 3 | 0) + t;
  }
  const n = position.count, positions = new Float32Array(n * 3), normals = new Float32Array(n * 3), uvs = new Float32Array(n * 2), colors = new Float32Array(n * 4);
  const normal = geometry.attributes.normal, uv = geometry.attributes.uv, color = geometry.attributes.color;
  for (let i = 0; i < n; i++) {
    positions[i * 3] = position.getX(i); positions[i * 3 + 1] = position.getY(i); positions[i * 3 + 2] = position.getZ(i);
    if (normal) { normals[i * 3] = normal.getX(i); normals[i * 3 + 1] = normal.getY(i); normals[i * 3 + 2] = normal.getZ(i); } else normals[i * 3 + 1] = 1;
    if (uv) { uvs[i * 2] = uv.getX(i); uvs[i * 2 + 1] = uv.getY(i); }
    if (color) { colors[i * 4] = color.getX(i); colors[i * 4 + 1] = color.getY(i); colors[i * 4 + 2] = color.getZ(i); colors[i * 4 + 3] = color.itemSize > 3 ? color.getW(i) : 1; }
    else colors.fill(1, i * 4, i * 4 + 4);
  }
  _box.makeEmpty();
  for (let t = 0; t < indices.length; t++) _box.expandByPoint(_v.fromArray(positions, indices[t] * 3));
  return { positions, normals, uvs, colors, indices, primitiveIds, triangleCount: triCount, hasNormal: !!normal, hasUV: !!uv, hasColor: !!color,
    bounds: _box.isEmpty() ? null : [..._box.min.toArray(), ..._box.max.toArray()], geometryUuid: geometry.uuid, range: [first, last] };
}

/** Walk the scene once. Returns the BLAS sources, flat instance arrays and
 * the material list, plus a report of everything not imaged and why. */
export function extractScene(scene, { camera = null, knownBlas = null, deferInstances = false } = {}) {
  scene.updateMatrixWorld(true);
  const started = performance.now();
  const blasKeys = new Map(), blas = [], materials = [], materialIndex = new Map(), objects = [];
  const report = { meshes: 0, instances: 0, expandedTriangles: 0, environment: [], excluded: [], degenerate: 0,
    unsupported: [], negativeDeterminant: 0, nonIndexed: 0, multiMaterial: 0, vertexColorMeshes: 0, instanceColorMeshes: 0, sides: [0, 0, 0] };
  let instanceTotal = 0;
  scene.traverse(object => {
    const role = lensRole(object);
    if (role) { (role === 'exclude' ? report.excluded : report.environment).push({ name: object.name, role }); return; }
    if (!object.isMesh) {
      if ((object.isPoints || object.isLine || object.isSprite) && visibleTo(object, camera)) report.excluded.push({ name: object.name, role: 'unregistered-non-mesh' });
      return;
    }
    if (!visibleTo(object, camera) || object.count === 0) return;
    const geometry = object.geometry;
    if (!geometry.attributes.position) return;
    report.meshes++;
    if (!geometry.index) report.nonIndexed++;
    const materialList = Array.isArray(object.material) ? object.material : [object.material];
    // Three ignores groups when a single material is used; with an array it
    // draws each group with its materialIndex, clipped to drawRange.
    const ranges = [];
    const drawStart = geometry.drawRange.start, drawEnd = drawStart + geometry.drawRange.count;
    if (Array.isArray(object.material)) {
      report.multiMaterial++;
      for (const g of geometry.groups) {
        const s = Math.max(g.start, drawStart), e = Math.min(g.start + g.count, drawEnd);
        if (e > s && materialList[g.materialIndex]) ranges.push({ start: s, count: e - s, material: materialList[g.materialIndex] });
      }
    } else ranges.push({ start: drawStart, count: drawEnd - drawStart, material: object.material });
    const count = object.isInstancedMesh ? object.count : 1;
    for (const range of ranges) {
      const material = range.material;
      if (!material.visible) continue;
      const key = `${geometry.uuid}:${range.start}:${range.count}:${geometry.index?.version ?? -1}:${geometry.attributes.position.version}:${geometry.attributes.position.count}`;
      if (!blasKeys.has(key)) {
        blasKeys.set(key, blas.length);
        // A BLAS already held by the worker is referenced by key only; its
        // attribute arrays are not copied again for transform-only rebuilds.
        const known = knownBlas?.get(key);
        blas.push(known ?? { ...blasSource(geometry, range.start, range.count), key });
      }
      const blasIndex = blasKeys.get(key);
      if (!materialIndex.has(material)) {
        const c = classifyMaterial(material);
        materialIndex.set(material, materials.length);
        materials.push({ material, ...c });
        if (c.reason) report.unsupported.push({ material: material.name || material.type, reason: UNSUPPORTED_REASONS[c.reason], mesh: object.name });
      }
      const mi = materialIndex.get(material), m = materials[mi];
      const side = material.side === THREE.BackSide ? SIDE.BACK : material.side === THREE.DoubleSide ? SIDE.DOUBLE : SIDE.FRONT;
      report.sides[side] += count;
      const hasVertexColor = material.vertexColors && blas[blasIndex].hasColor;
      if (hasVertexColor) report.vertexColorMeshes++;
      if (object.instanceColor) report.instanceColorMeshes++;
      let flags = side | (object.receiveShadow ? INSTANCE_FLAGS.RECEIVE_SHADOW : 0) | (material.transparent ? INSTANCE_FLAGS.TRANSPARENT : 0) |
        (m.reason ? INSTANCE_FLAGS.UNSUPPORTED : 0) | (hasVertexColor ? INSTANCE_FLAGS.VERTEX_COLOR : 0) | (object.instanceColor ? INSTANCE_FLAGS.INSTANCE_COLOR : 0);
      objects.push({ object, blas: blasIndex, material: mi, first: instanceTotal, count, flags });
      instanceTotal += count;
      report.expandedTriangles += blas[blasIndex].triangleCount * count;
    }
  });
  // Compact per-object sources (copied arrays); expansion into per-instance
  // world->object rows and world bounds is pure math that can run in the Worker.
  const instanceSources = objects.map((entry, objectIndex) => {
    const { object } = entry;
    return { matrixWorld: Array.from(object.matrixWorld.elements), count: entry.count, blas: entry.blas, material: entry.material, flags: entry.flags, objectIndex,
      instanceMatrices: object.isInstancedMesh ? object.instanceMatrix.array.slice(0, entry.count * 16) : null,
      colors: object.instanceColor ? object.instanceColor.array.slice(0, entry.count * 3) : null };
  });
  const blasBounds = blas.map(b => b.bounds);
  let instances = null;
  if (!deferInstances) {
    const expanded = expandInstances(instanceSources, blasBounds);
    instances = expanded.instances; report.degenerate = expanded.report.degenerate; report.negativeDeterminant = expanded.report.negativeDeterminant;
  }
  const k = instances ? instances.count : instanceTotal;
  report.instances = k;
  report.blas = blas.length;
  report.uniqueTriangles = blas.reduce((s, b) => s + b.triangleCount, 0);
  report.materials = materials.length;
  report.extractMs = performance.now() - started;
  return { blas, instances, instanceSources, blasBounds, materials, objects, report };
}

/** Cheap per-object signature for change detection without re-extracting. */
export function objectSignature(entry) {
  const { object } = entry, g = object.geometry;
  const material = Array.isArray(object.material) ? object.material.map(m => m.version).join(',') : object.material.version;
  return { geometry: `${g.uuid}:${g.index?.version ?? -1}:${g.attributes.position.version}:${g.drawRange.start}:${g.drawRange.count}`,
    transform: object.matrixWorld.elements.join(',') + (object.isInstancedMesh ? `:${object.instanceMatrix.version}:${object.count}` : ''),
    color: object.instanceColor ? object.instanceColor.version : -1, material, visible: object.visible };
}
