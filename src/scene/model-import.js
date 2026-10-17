import * as THREE from 'three/webgpu';
import { LOCAL_LAMP_SHADOW_LAYER } from './render-layers.js';

/** User glTF → objects the lens path can image. The lens shader supports only
 * Standard/Physical node materials without image textures, so loader materials
 * are rebuilt as node materials and base-colour maps are baked into vertex
 * colours (after uniform subdivision, so texture detail survives). Everything
 * that cannot be carried is listed in the report, never silently dropped.
 * Pure CPU work: `readTexture(texture)` supplies RGBA8 pixels, or null.
 */
const srgbToLinear = c => c < .04045 ? c * .0773993808 : Math.pow(c * .9478672986 + .0521327014, 2.4);
const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));
const LINEAR_TO_FLOAT = Float32Array.from({ length: 256 }, (_, i) => i / 255);
const DROPPED_MAPS = { normalMap: '法线贴图', bumpMap: '凹凸贴图', aoMap: '环境光遮蔽贴图', lightMap: '光照贴图', displacementMap: '置换贴图',
  alphaMap: '透明度贴图', clearcoatMap: '清漆贴图', clearcoatNormalMap: '清漆法线贴图', clearcoatRoughnessMap: '清漆粗糙度贴图',
  specularColorMap: '高光颜色贴图', specularIntensityMap: '高光强度贴图', sheenColorMap: '光泽贴图', transmissionMap: '透射贴图',
  iridescenceMap: '虹彩贴图', anisotropyMap: '各向异性贴图', thicknessMap: '厚度贴图' };
const TEXTURE_KEYS = ['map', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'envMap', ...Object.keys(DROPPED_MAPS)];

export const MODEL_IMPORT_DEFAULTS = Object.freeze({ triangleBudget: 1_500_000, texelsPerEdge: 4, maxSubdivision: 4, minSize: .05, maxSize: 60, fallbackSize: 2 });

/** Bilinear RGBA sampler honouring wrap modes, flipY, texture transform and colour space. */
export function createTextureSampler(texture, pixels) {
  const { width: w, height: h, data } = pixels, lut = texture.colorSpace === THREE.SRGBColorSpace ? SRGB_TO_LINEAR : LINEAR_TO_FLOAT;
  if (texture.matrixAutoUpdate) texture.updateMatrix();
  const m = texture.matrix.elements, uv = new THREE.Vector2();
  const wrap = (x, n, mode) => {
    if (mode === THREE.ClampToEdgeWrapping) return Math.min(n - 1, Math.max(0, x));
    if (mode === THREE.MirroredRepeatWrapping) { const p = ((x % (2 * n)) + 2 * n) % (2 * n); return p < n ? p : 2 * n - 1 - p; }
    return ((x % n) + n) % n;
  };
  return (u, v, out) => {
    uv.set(m[0] * u + m[3] * v + m[6], m[1] * u + m[4] * v + m[7]);
    const x = uv.x * w - .5, y = (texture.flipY ? 1 - uv.y : uv.y) * h - .5, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const xs = [wrap(x0, w, texture.wrapS), wrap(x0 + 1, w, texture.wrapS)], ys = [wrap(y0, h, texture.wrapT), wrap(y0 + 1, h, texture.wrapT)];
    for (let c = 0; c < 4; c++) {
      const at = (i, j) => (c === 3 ? LINEAR_TO_FLOAT : lut)[data[(ys[j] * w + xs[i]) * 4 + c]];
      out[c] = (at(0, 0) * (1 - fx) + at(1, 0) * fx) * (1 - fy) + (at(0, 1) * (1 - fx) + at(1, 1) * fx) * fy;
    }
    return out;
  };
}

/** Mean linear RGBA of a whole texture, for maps that only survive as factors. */
export function averageTexture(texture, pixels) {
  const lut = texture.colorSpace === THREE.SRGBColorSpace ? SRGB_TO_LINEAR : LINEAR_TO_FLOAT, sum = [0, 0, 0, 0], n = pixels.width * pixels.height;
  for (let i = 0; i < n; i++) for (let c = 0; c < 4; c++) sum[c] += (c === 3 ? LINEAR_TO_FLOAT : lut)[pixels.data[i * 4 + c]];
  return sum.map(s => s / Math.max(1, n));
}

/** Uniform 1→4 midpoint subdivision. Edge midpoints are shared, so the mesh
 * stays watertight; positions stay on the original flat triangles. */
export function subdivideGeometry(geometry, levels) {
  if (levels <= 0) return geometry;
  const names = Object.keys(geometry.attributes);
  let attrs = Object.fromEntries(names.map(name => { const a = geometry.attributes[name]; return [name, { size: a.itemSize, values: Array.from({ length: a.count * a.itemSize }, (_, i) => a.getComponent(Math.floor(i / a.itemSize), i % a.itemSize)) }]; }));
  let count = geometry.attributes.position.count;
  let index = geometry.index ? Array.from(geometry.index.array) : Array.from({ length: count }, (_, i) => i);
  for (let level = 0; level < levels; level++) {
    const edges = new Map(), next = [];
    const mid = (a, b) => {
      const key = a < b ? a * count + b : b * count + a;
      let v = edges.get(key);
      if (v === undefined) {
        v = count + edges.size; edges.set(key, v);
        for (const { size, values } of Object.values(attrs)) for (let c = 0; c < size; c++) values.push((values[a * size + c] + values[b * size + c]) / 2);
      }
      return v;
    };
    for (let t = 0; t < index.length; t += 3) {
      const a = index[t], b = index[t + 1], c = index[t + 2], ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    }
    count += edges.size; index = next;
  }
  const out = new THREE.BufferGeometry();
  for (const name of names) {
    const src = geometry.attributes[name], { size, values } = attrs[name];
    if (name === 'normal') for (let i = 0; i < values.length; i += 3) { const l = Math.hypot(values[i], values[i + 1], values[i + 2]) || 1; values[i] /= l; values[i + 1] /= l; values[i + 2] /= l; }
    out.setAttribute(name, new THREE.BufferAttribute(new Float32Array(values), size, false));
    out.attributes[name].name = src.name;
  }
  out.setIndex(count > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
  out.name = geometry.name;
  return out;
}

/** Subdivision levels so a typical (median) triangle edge spans ≈ texelsPerEdge texels. */
export function subdivisionLevels(geometry, texture, pixels, { texelsPerEdge, maxSubdivision, triangleAllowance }) {
  const uv = geometry.attributes[texture.channel ? `uv${texture.channel}` : 'uv'], index = geometry.index;
  const triangles = (index ? index.count : geometry.attributes.position.count) / 3;
  if (!uv || triangles === 0) return 0;
  if (texture.matrixAutoUpdate) texture.updateMatrix();
  const m = texture.matrix.elements, lengths = [], step = Math.max(1, Math.floor(triangles / 4096));
  const p = i => { const u = uv.getX(i), v = uv.getY(i); return [(m[0] * u + m[3] * v + m[6]) * pixels.width, (m[1] * u + m[4] * v + m[7]) * pixels.height]; };
  for (let t = 0; t < triangles; t += step) {
    const ids = [0, 1, 2].map(k => index ? index.getX(t * 3 + k) : t * 3 + k).map(p);
    lengths.push(Math.max(...[[0, 1], [1, 2], [2, 0]].map(([a, b]) => Math.hypot(ids[a][0] - ids[b][0], ids[a][1] - ids[b][1]))));
  }
  lengths.sort((a, b) => a - b);
  let levels = Math.max(0, Math.min(maxSubdivision, Math.ceil(Math.log2(lengths[lengths.length >> 1] / texelsPerEdge))));
  while (levels > 0 && triangles * 4 ** levels > triangleAllowance) levels--;
  return levels;
}

function bakeVertexColors(geometry, sample, multiplyExisting) {
  const uv = geometry.attributes[sample.channel ? `uv${sample.channel}` : 'uv'], n = geometry.attributes.position.count, old = geometry.attributes.color;
  const colors = new Float32Array(n * 3), texel = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    sample.at(uv.getX(i), uv.getY(i), texel);
    for (let c = 0; c < 3; c++) colors[i * 3 + c] = texel[c] * (multiplyExisting && old ? old.getComponent(i, c) : 1);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function copyCommon(src, dst) {
  dst.name = src.name; dst.side = src.side; dst.opacity = src.opacity; dst.transparent = src.transparent || src.opacity < 1;
  dst.depthWrite = src.depthWrite; dst.vertexColors = !!src.vertexColors; dst.visible = src.visible;
  if (src.color) dst.color.copy(src.color);
}

/** One loader material → { material, notes }. `textures(texture)` returns pixels or null. */
export function convertMaterial(src, textures) {
  const notes = [], physical = src.isMeshPhysicalMaterial && (src.clearcoat > 0 || src.ior !== 1.5 || src.specularIntensity !== 1 || !src.specularColor.equals(new THREE.Color(1, 1, 1)));
  const dst = physical ? new THREE.MeshPhysicalNodeMaterial() : new THREE.MeshStandardNodeMaterial();
  copyCommon(src, dst);
  if (src.isMeshStandardMaterial) {
    dst.roughness = src.roughness; dst.metalness = src.metalness; dst.emissive.copy(src.emissive); dst.emissiveIntensity = src.emissiveIntensity;
    if (physical) { dst.clearcoat = src.clearcoat; dst.clearcoatRoughness = src.clearcoatRoughness; dst.ior = src.ior; dst.specularIntensity = src.specularIntensity; dst.specularColor.copy(src.specularColor); }
    if (src.isMeshPhysicalMaterial) for (const [key, label] of [['transmission', '透射'], ['sheen', '光泽'], ['iridescence', '虹彩'], ['anisotropy', '各向异性'], ['dispersion', '色散']])
      if (src[key] > 0) notes.push(`${label}未支持，已忽略`);
  } else {
    dst.roughness = src.shininess !== undefined ? Math.sqrt(2 / (src.shininess + 2)) : 1; dst.metalness = 0;
    if (src.emissive) { dst.emissive.copy(src.emissive); dst.emissiveIntensity = src.emissiveIntensity ?? 1; }
    notes.push(src.isMeshBasicMaterial ? '无光照材质按受光材质显示' : `${src.type} 已近似为 PBR 材质`);
  }
  // glTF packs roughness in G and metalness in B; one texture often serves both.
  for (const [key, factor, channel, label] of [['roughnessMap', 'roughness', 1, '粗糙度'], ['metalnessMap', 'metalness', 2, '金属度']]) {
    if (!src[key]) continue;
    const pixels = textures(src[key]);
    if (pixels) { dst[factor] *= averageTexture(src[key], pixels)[channel]; notes.push(`${label}贴图取平均值`); } else notes.push(`${label}贴图无法读取，已忽略`);
  }
  if (src.emissiveMap) {
    const pixels = textures(src.emissiveMap);
    if (pixels) { const [r, g, b] = averageTexture(src.emissiveMap, pixels); dst.emissive.multiply(new THREE.Color(r, g, b)); notes.push('自发光贴图取平均值'); }
    else notes.push('自发光贴图无法读取，已忽略');
  }
  for (const [key, label] of Object.entries(DROPPED_MAPS)) if (src[key]) notes.push(`${label}未支持，已忽略`);
  if (src.alphaTest > 0 || src.alphaHash) notes.push('alpha 裁剪未支持，按不透明处理');
  if (src.blending !== undefined && src.blending !== THREE.NormalBlending) notes.push('非常规混合模式按 Normal 处理');
  return { material: dst, notes, map: src.map ?? null, flatShading: !!src.flatShading };
}

/** Geometry for one (geometry, material) pair. Returns how the colour map was
 * carried: 'baked' (vertex colours), 'averaged' (tint) or 'plain'. */
function prepareGeometry(geometry, converted, textures, budget, options, notes) {
  let g = geometry.clone();
  for (const key of Object.keys(g.morphAttributes)) delete g.morphAttributes[key];
  if (converted.flatShading) { const indexed = g; g = g.toNonIndexed(); indexed.dispose(); g.computeVertexNormals(); }
  else if (!g.attributes.normal) { g.computeVertexNormals(); notes.add('缺少法线，已自动计算'); }
  const map = converted.map, pixels = map && textures(map), uvName = map?.channel ? `uv${map.channel}` : 'uv';
  if (map && pixels && g.attributes[uvName]) {
    const triangles = (g.index ? g.index.count : g.attributes.position.count) / 3;
    const levels = subdivisionLevels(g, map, pixels, { ...options, triangleAllowance: Math.max(triangles, budget.remaining) });
    if (levels > 0) { const before = g; g = subdivideGeometry(g, levels); before.dispose(); }
    bakeVertexColors(g, { channel: map.channel, at: createTextureSampler(map, pixels) }, converted.material.vertexColors);
    return { geometry: g, mode: 'baked', levels };
  }
  if (map && pixels) { notes.add('无 UV 的颜色贴图取平均值'); return { geometry: g, mode: 'averaged', levels: 0, tint: averageTexture(map, pixels) }; }
  if (map) notes.add('颜色贴图无法读取（压缩纹理？），已忽略');
  return { geometry: g, mode: 'plain', levels: 0 };
}

function materialVariant(converted, prepared) {
  if (prepared.mode === 'plain') return converted.material;
  converted.variants ??= new Map();
  if (!converted.variants.has(prepared.mode)) {
    // NodeMaterial.clone() resets PBR factors in r183; rebuild from the source.
    const m = converted.rebuild();
    if (prepared.mode === 'baked') m.vertexColors = true;
    else m.color.multiply(new THREE.Color(...prepared.tint.slice(0, 3)));
    converted.variants.set(prepared.mode, m);
  }
  return converted.variants.get(prepared.mode);
}

/** Convert a loaded glTF scene graph in place. Returns a report. */
export function prepareImportedModel(root, { readTexture, ...overrides } = {}) {
  const options = { ...MODEL_IMPORT_DEFAULTS, ...overrides }, notes = new Set();
  const pixelCache = new Map(), textures = texture => { if (!pixelCache.has(texture)) pixelCache.set(texture, texture.isCompressedTexture ? null : readTexture?.(texture) ?? null); return pixelCache.get(texture); };
  const meshes = [], drop = [];
  root.traverse(o => {
    if (o.isMesh) meshes.push(o);
    else if (o.isPoints || o.isLine || o.isSprite) drop.push(o);
    else if (o.isCamera || o.isLight) drop.push(o);
  });
  if (drop.some(o => o.isPoints || o.isLine || o.isSprite)) notes.add('点、线与精灵对象未支持，已移除');
  if (drop.some(o => o.isLight)) notes.add('模型自带灯光已移除');
  for (const o of drop) o.removeFromParent();
  const report = { meshes: 0, sourceTriangles: 0, triangles: 0, materials: 0, bakedMeshes: 0, subdividedMeshes: 0, notes: [] };
  const triangleCount = g => (g.index ? g.index.count : g.attributes.position.count) / 3;
  const budget = { remaining: options.triangleBudget - meshes.reduce((n, m) => n + (m.geometry.attributes.position ? triangleCount(m.geometry) : 0), 0) };
  const materialCache = new Map(), geometryCache = new Map(), oldMaterials = new Set(), oldGeometries = new Set();
  for (const source of meshes) {
    let mesh = source;
    if (source.isSkinnedMesh || source.isInstancedMesh) {
      if (source.isSkinnedMesh) notes.add('骨骼动画未支持，按绑定姿态显示');
      if (source.isInstancedMesh) {
        // EXT_mesh_gpu_instancing: expand into plain meshes under one group.
        const group = new THREE.Group(); group.name = source.name; group.matrix.copy(source.matrix); group.matrix.decompose(group.position, group.quaternion, group.scale);
        for (let i = 0; i < source.count; i++) { const m = new THREE.Mesh(source.geometry, source.material); source.getMatrixAt(i, m.matrix); m.matrix.decompose(m.position, m.quaternion, m.scale); group.add(m); }
        source.parent.add(group); source.removeFromParent(); group.traverse(o => { if (o.isMesh) meshes.push(o); }); continue;
      }
      mesh = new THREE.Mesh(source.geometry, source.material);
      mesh.name = source.name; mesh.position.copy(source.position); mesh.quaternion.copy(source.quaternion); mesh.scale.copy(source.scale);
      source.parent.add(mesh); for (const child of [...source.children]) mesh.add(child); source.removeFromParent();
    }
    if (mesh.morphTargetInfluences?.some(v => v !== 0)) notes.add('形变目标未支持，按基础形状显示');
    mesh.morphTargetInfluences = undefined; mesh.morphTargetDictionary = undefined;
    const geometry = mesh.geometry;
    if (!geometry.attributes.position) { mesh.removeFromParent(); continue; }
    report.meshes++; report.sourceTriangles += triangleCount(geometry); oldGeometries.add(geometry);
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (list.length > 1) {
      // Rare in glTF (one material per primitive). Bake per group would share
      // vertices across groups, so split groups into separate meshes first.
      for (const g of geometry.groups) {
        const part = new THREE.Mesh(sliceGroup(geometry, g), list[g.materialIndex]);
        part.name = mesh.name; mesh.add(part); meshes.push(part);
      }
      mesh.geometry = new THREE.BufferGeometry(); mesh.material = new THREE.MeshStandardNodeMaterial({ visible: false });
      report.meshes--; report.sourceTriangles -= triangleCount(geometry); continue;
    }
    const src = list[0]; oldMaterials.add(src);
    if (!materialCache.has(src)) {
      const c = convertMaterial(src, textures); c.notes.forEach(n => notes.add(n)); c.rebuild = () => convertMaterial(src, textures).material;
      materialCache.set(src, c); report.materials++;
    }
    const converted = materialCache.get(src), key = `${geometry.uuid}|${src.uuid}`;
    if (!geometryCache.has(key)) {
      // Baked colours live in the geometry, so each (geometry, material) pair
      // gets its own copy; meshes that repeat the pair share it.
      const before = triangleCount(geometry), result = prepareGeometry(geometry, converted, textures, budget, options, notes);
      budget.remaining -= triangleCount(result.geometry) - before;
      geometryCache.set(key, result); if (result.mode === 'baked') report.bakedMeshes++; if (result.levels) report.subdividedMeshes++;
    }
    const prepared = geometryCache.get(key);
    mesh.geometry = prepared.geometry; mesh.material = materialVariant(converted, prepared);
    mesh.castShadow = mesh.receiveShadow = true; mesh.layers.enable(LOCAL_LAMP_SHADOW_LAYER); mesh.frustumCulled = true;
    report.triangles += triangleCount(prepared.geometry);
  }
  for (const m of oldMaterials) { for (const key of TEXTURE_KEYS) m[key]?.dispose?.(); m.dispose(); }
  for (const g of oldGeometries) if (![...geometryCache.values()].some(r => r.geometry === g)) g.dispose();
  report.notes = [...notes];
  return report;
}

function sliceGroup(geometry, group) {
  const out = new THREE.BufferGeometry(), index = geometry.index;
  for (const [name, a] of Object.entries(geometry.attributes)) out.setAttribute(name, a.clone());
  const ids = Array.from({ length: group.count }, (_, i) => index ? index.getX(group.start + i) : group.start + i);
  out.setIndex(ids); return out;
}

/** Real units when plausible; otherwise scale to a fallback size. Base sits on `ground`. */
export function fitAndPlace(root, ground, options = {}) {
  const { minSize, maxSize, fallbackSize } = { ...MODEL_IMPORT_DEFAULTS, ...options };
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root, true);
  if (box.isEmpty()) throw new Error('模型没有可见几何');
  const size = box.getSize(new THREE.Vector3()), extent = Math.max(size.x, size.y, size.z);
  const scale = extent < minSize || extent > maxSize ? fallbackSize / extent : 1;
  root.scale.multiplyScalar(scale); root.updateMatrixWorld(true);
  box.setFromObject(root, true);
  const centre = box.getCenter(new THREE.Vector3());
  root.position.x += ground.x - centre.x; root.position.z += ground.z - centre.z; root.position.y += ground.y - box.min.y;
  root.updateMatrixWorld(true);
  return { scale, originalSize: size.toArray(), size: size.multiplyScalar(scale).toArray() };
}

export function disposeModel(root) {
  const materials = new Set();
  root.traverse(o => { if (o.isMesh) { o.geometry.dispose(); (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => materials.add(m)); } });
  for (const m of materials) m.dispose();
  root.removeFromParent();
}

/** Split a dropped file set into models: each .glb alone; each .gltf with
 * every non-model file as a possible external resource. */
export function groupModelFiles(fileList) {
  const files = [...fileList], resources = files.filter(f => !/\.(glb|gltf)$/i.test(f.name));
  return files.filter(f => /\.(glb|gltf)$/i.test(f.name)).map(main => ({ main, resources: /\.gltf$/i.test(main.name) ? resources : [] }));
}

// Manipulation keeps the model's base where it is: a uniform scale about the
// base centre and a turn about the vertical axis both leave the lowest point's
// height unchanged, so no vertex walk is needed while dragging.
const _q = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);
export function scaleModelAbout(root, factor, pivot) {
  root.position.sub(pivot).multiplyScalar(factor).add(pivot); root.scale.multiplyScalar(factor);
  root.updateMatrixWorld(true);
}
export function turnModelAbout(root, angle, pivot) {
  _q.setFromAxisAngle(_up, angle);
  root.position.sub(pivot).applyQuaternion(_q).add(pivot); root.quaternion.premultiply(_q);
  root.updateMatrixWorld(true);
}
/** Shift horizontally by (dx, dz) and set the base height; `base` is the current lowest world y. */
export function moveModelBase(root, dx, dz, base, groundY) {
  root.position.x += dx; root.position.z += dz; root.position.y += groundY - base;
  root.updateMatrixWorld(true);
}
