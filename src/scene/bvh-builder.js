/** Binned-SAH BVH construction and GPU packing for the lens scene query.
 * Pure JavaScript, used identically by the Worker and by Node tests.
 *
 * Two levels: one BLAS per (geometry, triangle range), shared by all of its
 * instances, and one TLAS over instance world bounds with exactly one
 * instance per leaf (the WGSL traversal enters one BLAS per TLAS leaf).
 *
 * Node record, 32 bytes (WGSL struct BvhNode { lo: vec3f, a: u32, hi: vec3f, b: u32 }):
 *   interior: a = left child, b = right child (absolute node indices)
 *   leaf:     a = first primitive, b = LEAF_BIT | count
 * f64 bounds are rounded outward to f32 so stored boxes are conservative.
 */
export const LEAF_BIT = 0x80000000;
export const STACK_SIZE = 64;           // must equal SCENE_STACK_SIZE in scene-intersector.wgsl
const TRIANGLE_BYTES = 64, VERTEX_BYTES = 48, INSTANCE_BYTES = 128;
const BLAS_MAX_LEAF = 4, TLAS_MAX_LEAF = 1;

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function nextDown(x) { // largest f32 <= x
  f32[0] = x; if (f32[0] <= x) return f32[0];
  if (f32[0] === 0) return -1.401298464324817e-45;
  u32[0] += f32[0] > 0 ? -1 : 1; return f32[0];
}
function nextUp(x) { // smallest f32 >= x
  f32[0] = x; if (f32[0] >= x) return f32[0];
  if (f32[0] === 0) return 1.401298464324817e-45;
  u32[0] += f32[0] > 0 ? 1 : -1; return f32[0];
}
export { nextDown as f32Down, nextUp as f32Up };

/** Generic binned SAH over primitive boxes (Float64Array n*6) and centroids. */
/** Bins per node: finer binning where it is cheap relative to the node's size and
 * where the split matters most (the top of a 268k-instance TLAS). */
export function binsForCount(count, bins) { return count >= 4096 ? Math.max(bins, 32) : bins; }
export function buildBVH(bounds, { maxLeaf = 4, bins: baseBins = 16, traversalCost = 1, intersectionCost = 1 } = {}) {
  const n = bounds.length / 6;
  if (n === 0) throw new Error('BVH has no primitives');
  const order = new Uint32Array(n);
  const centroid = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    order[i] = i;
    for (let a = 0; a < 3; a++) centroid[i * 3 + a] = .5 * (bounds[i * 6 + a] + bounds[i * 6 + 3 + a]);
  }
  let capacity = Math.max(1, 2 * n), nodes = new Float64Array(capacity * 8), count = 0, maxDepth = 0, leaves = 0, largestLeaf = 0;
  const maxBins = binsForCount(n, baseBins);
  const binCount = new Uint32Array(maxBins), binBox = new Float64Array(maxBins * 6), leftArea = new Float64Array(maxBins), leftCount = new Uint32Array(maxBins);
  const area = b => { const x = b[3] - b[0], y = b[4] - b[1], z = b[5] - b[2]; return x >= 0 ? 2 * (x * y + y * z + z * x) : 0; };
  const empty = b => { b[0] = b[1] = b[2] = Infinity; b[3] = b[4] = b[5] = -Infinity; return b; };
  const tmp = new Float64Array(6), cb = new Float64Array(6), nb = new Float64Array(6);
  const stack = [{ start: 0, end: n, node: 0, depth: 1 }];
  count = 1;
  while (stack.length) {
    const { start, end, node, depth } = stack.pop();
    maxDepth = Math.max(maxDepth, depth);
    empty(nb); empty(cb);
    for (let i = start; i < end; i++) {
      const p = order[i];
      for (let a = 0; a < 3; a++) {
        nb[a] = Math.min(nb[a], bounds[p * 6 + a]); nb[a + 3] = Math.max(nb[a + 3], bounds[p * 6 + 3 + a]);
        const c = centroid[p * 3 + a]; cb[a] = Math.min(cb[a], c); cb[a + 3] = Math.max(cb[a + 3], c);
      }
    }
    const o = node * 8;
    for (let a = 0; a < 3; a++) { nodes[o + a] = nb[a]; nodes[o + 4 + a] = nb[a + 3]; }
    const m = end - start;
    const makeLeaf = () => { nodes[o + 3] = start; nodes[o + 7] = LEAF_BIT + m; leaves++; largestLeaf = Math.max(largestLeaf, m); };
    if (m <= maxLeaf) { makeLeaf(); continue; }
    // Binned SAH on all three axes.
    let bestAxis = -1, bestSplit = 0, bestCost = Infinity;
    const parentArea = area(nb), bins = binsForCount(m, baseBins);
    for (let axis = 0; axis < 3; axis++) {
      const lo = cb[axis], extent = cb[axis + 3] - lo;
      if (!(extent > 0)) continue;
      binCount.fill(0); for (let b = 0; b < bins; b++) empty(binBox.subarray(b * 6, b * 6 + 6));
      const scale = bins * (1 - 1e-9) / extent;
      for (let i = start; i < end; i++) {
        const p = order[i], b = Math.min(bins - 1, Math.floor((centroid[p * 3 + axis] - lo) * scale));
        binCount[b]++;
        const bb = b * 6;
        for (let a = 0; a < 3; a++) { binBox[bb + a] = Math.min(binBox[bb + a], bounds[p * 6 + a]); binBox[bb + 3 + a] = Math.max(binBox[bb + 3 + a], bounds[p * 6 + 3 + a]); }
      }
      empty(tmp); let c = 0;
      for (let b = 0; b < bins - 1; b++) {
        const bb = b * 6; c += binCount[b];
        for (let a = 0; a < 3; a++) { tmp[a] = Math.min(tmp[a], binBox[bb + a]); tmp[a + 3] = Math.max(tmp[a + 3], binBox[bb + 3 + a]); }
        leftArea[b] = area(tmp); leftCount[b] = c;
      }
      empty(tmp); c = 0;
      for (let b = bins - 1; b > 0; b--) {
        const bb = b * 6; c += binCount[b];
        for (let a = 0; a < 3; a++) { tmp[a] = Math.min(tmp[a], binBox[bb + a]); tmp[a + 3] = Math.max(tmp[a + 3], binBox[bb + 3 + a]); }
        const lc = leftCount[b - 1];
        if (lc === 0 || c === 0) continue;
        const cost = traversalCost + intersectionCost * (leftArea[b - 1] * lc + area(tmp) * c) / Math.max(parentArea, 1e-300);
        if (cost < bestCost) { bestCost = cost; bestAxis = axis; bestSplit = b; }
      }
    }
    let mid;
    if (bestAxis < 0) {
      // Coincident centroids: split by count. Keeps leaves bounded instead of
      // creating a single oversized leaf of overlapping instances.
      mid = start + (m >> 1);
    } else {
      if (maxLeaf > 1 && m <= maxLeaf * 2 && bestCost >= intersectionCost * m) { makeLeaf(); continue; }
      const lo = cb[bestAxis], scale = bins * (1 - 1e-9) / (cb[bestAxis + 3] - lo);
      let i = start, j = end - 1;
      while (i <= j) {
        const b = Math.min(bins - 1, Math.floor((centroid[order[i] * 3 + bestAxis] - lo) * scale));
        if (b < bestSplit) i++; else { const t = order[i]; order[i] = order[j]; order[j] = t; j--; }
      }
      mid = i;
      if (mid === start || mid === end) mid = start + (m >> 1);
    }
    if (count + 2 > capacity) { capacity *= 2; const grown = new Float64Array(capacity * 8); grown.set(nodes); nodes = grown; }
    const left = count, right = count + 1; count += 2;
    nodes[o + 3] = left; nodes[o + 7] = right;
    stack.push({ start: mid, end, node: right, depth: depth + 1 }, { start, end: mid, node: left, depth: depth + 1 });
  }
  return { nodes: nodes.subarray(0, count * 8), nodeCount: count, order, depth: maxDepth, leaves, largestLeaf };
}

/** BLAS over one geometry range, in geometry-local coordinates. */
function buildBlas(source) {
  const { positions, indices } = source, n = indices.length / 3, bounds = new Float64Array(n * 6);
  for (let t = 0; t < n; t++) {
    for (let a = 0; a < 3; a++) {
      const v0 = positions[indices[t * 3] * 3 + a], v1 = positions[indices[t * 3 + 1] * 3 + a], v2 = positions[indices[t * 3 + 2] * 3 + a];
      bounds[t * 6 + a] = Math.min(v0, v1, v2); bounds[t * 6 + 3 + a] = Math.max(v0, v1, v2);
    }
  }
  const started = Date.now();
  const bvh = buildBVH(bounds, { maxLeaf: BLAS_MAX_LEAF });
  return { ...bvh, triangles: n, ms: Date.now() - started };
}

/** TLAS over world-space instance bounds. Bounds are padded so that f32
 * world→object transforms in the shader cannot place a hit outside them. */
function buildTlas(instanceBounds, count) {
  const bounds = new Float64Array(count * 6);
  for (let i = 0; i < count; i++) {
    let scale = 1;
    for (let a = 0; a < 6; a++) scale = Math.max(scale, Math.abs(instanceBounds[i * 6 + a]));
    const pad = 4e-6 * scale;
    for (let a = 0; a < 3; a++) { bounds[i * 6 + a] = instanceBounds[i * 6 + a] - pad; bounds[i * 6 + 3 + a] = instanceBounds[i * 6 + 3 + a] + pad; }
  }
  const started = Date.now();
  const bvh = buildBVH(bounds, { maxLeaf: TLAS_MAX_LEAF });
  return { ...bvh, ms: Date.now() - started };
}

function writeNodes(target, nodes, nodeCount, nodeOffset, primitiveOffset) {
  const f = new Float32Array(target.buffer, target.byteOffset), u = new Uint32Array(target.buffer, target.byteOffset);
  for (let i = 0; i < nodeCount; i++) {
    const s = i * 8, d = (nodeOffset + i) * 8;
    for (let a = 0; a < 3; a++) { f[d + a] = nextDown(nodes[s + a]); f[d + 4 + a] = nextUp(nodes[s + 4 + a]); }
    const b = nodes[s + 7];
    if (b >= LEAF_BIT) { u[d + 3] = nodes[s + 3] + primitiveOffset; u[d + 7] = b; }
    else { u[d + 3] = nodes[s + 3] + nodeOffset; u[d + 7] = b + nodeOffset; }
  }
}

/** Pack built BLASes + TLAS + instances into the GPU buffer images. */
function packScene({ blasSources, blasBuilt, tlas, instances }) {
  const blasNodes = blasBuilt.reduce((s, b) => s + b.nodeCount, 0);
  const nodeCount = tlas.nodeCount + blasNodes;
  const triangleCount = blasBuilt.reduce((s, b) => s + b.triangles, 0);
  const vertexCount = blasSources.reduce((s, b) => s + b.positions.length / 3, 0);
  const nodes = new Uint32Array(nodeCount * 8);
  const triangles = new ArrayBuffer(Math.max(1, triangleCount) * TRIANGLE_BYTES), tf = new Float32Array(triangles), tu = new Uint32Array(triangles);
  const vertices = new ArrayBuffer(Math.max(1, vertexCount) * VERTEX_BYTES), vf = new Float32Array(vertices), vu = new Uint32Array(vertices);
  writeNodes(nodes, tlas.nodes, tlas.nodeCount, 0, 0);
  const blasRoot = new Uint32Array(blasBuilt.length);
  let nodeOffset = tlas.nodeCount, triOffset = 0, vertexOffset = 0, maxBlasDepth = 0;
  for (let b = 0; b < blasBuilt.length; b++) {
    const built = blasBuilt[b], src = blasSources[b];
    blasRoot[b] = nodeOffset;
    writeNodes(nodes, built.nodes, built.nodeCount, nodeOffset, triOffset);
    maxBlasDepth = Math.max(maxBlasDepth, built.depth);
    const vertexFlags = (src.hasNormal ? 1 : 0) | (src.hasUV ? 2 : 0) | (src.hasColor ? 4 : 0);
    for (let k = 0; k < built.triangles; k++) {
      const t = built.order[k], d = (triOffset + k) * 16;
      for (let v = 0; v < 3; v++) {
        const vi = src.indices[t * 3 + v];
        tf[d + v * 4] = src.positions[vi * 3]; tf[d + v * 4 + 1] = src.positions[vi * 3 + 1]; tf[d + v * 4 + 2] = src.positions[vi * 3 + 2];
        tu[d + v * 4 + 3] = vertexOffset + vi;
      }
      tu[d + 12] = src.primitiveIds[t]; tu[d + 13] = b;
    }
    const nv = src.positions.length / 3;
    for (let v = 0; v < nv; v++) {
      const d = (vertexOffset + v) * 12;
      vf[d] = src.normals[v * 3]; vf[d + 1] = src.normals[v * 3 + 1]; vf[d + 2] = src.normals[v * 3 + 2]; vu[d + 3] = vertexFlags;
      vf[d + 4] = src.uvs[v * 2]; vf[d + 5] = src.uvs[v * 2 + 1];
      vf[d + 8] = src.colors[v * 4]; vf[d + 9] = src.colors[v * 4 + 1]; vf[d + 10] = src.colors[v * 4 + 2]; vf[d + 11] = src.colors[v * 4 + 3];
    }
    nodeOffset += built.nodeCount; triOffset += built.triangles; vertexOffset += nv;
  }
  if (tlas.depth + maxBlasDepth > STACK_SIZE) throw new Error(`BVH depth ${tlas.depth}+${maxBlasDepth} exceeds traversal stack ${STACK_SIZE}`);
  // Instances follow TLAS leaf order, so leaf.a indexes this array directly.
  // Record (128 bytes): w2o rows + info (root, material, flags, source) in the
  // first 64 bytes for traversal; frame rows + colour in the second for shading.
  const n = instances.count, inst = new ArrayBuffer(Math.max(1, n) * INSTANCE_BYTES), f = new Float32Array(inst), u = new Uint32Array(inst);
  for (let k = 0; k < n; k++) {
    const i = tlas.order[k], d = k * 32;
    f.set(instances.w2o.subarray(i * 12, i * 12 + 12), d);
    u[d + 12] = blasRoot[instances.blas[i]]; u[d + 13] = instances.material[i]; u[d + 14] = instances.flags[i]; u[d + 15] = i;
    f.set(instances.frame.subarray(i * 12, i * 12 + 12), d + 16);
    f[d + 28] = instances.color[i * 3]; f[d + 29] = instances.color[i * 3 + 1]; f[d + 30] = instances.color[i * 3 + 2];
  }
  return {
    nodes: nodes.buffer, triangles, vertices, instances: inst, instanceOrder: tlas.order,
    stats: { nodes: nodeCount, tlasNodes: tlas.nodeCount, blasNodes, triangles: triangleCount, vertices: vertexCount, instances: n,
      tlasDepth: tlas.depth, maxBlasDepth, stackBound: tlas.depth + maxBlasDepth, tlasLargestLeaf: tlas.largestLeaf,
      bytes: { nodes: nodes.byteLength, triangles: triangles.byteLength, vertices: vertices.byteLength, instances: inst.byteLength } },
  };
}

/** Full build (BLAS cache aware). blasCache maps key -> built BLAS. */
export function buildSceneBuffers({ blasSources, blasKeys = null, instances, blasCache = null }) {
  const started = Date.now();
  let blasMs = 0, rebuilt = 0;
  const blasBuilt = blasSources.map((src, i) => {
    const key = blasKeys?.[i];
    if (blasCache && key && blasCache.has(key)) return blasCache.get(key);
    const built = buildBlas(src); blasMs += built.ms; rebuilt++;
    if (blasCache && key) blasCache.set(key, built);
    return built;
  });
  const tlas = buildTlas(instances.bounds, instances.count);
  const packStarted = Date.now();
  const packed = packScene({ blasSources, blasBuilt, tlas, instances });
  packed.stats.timing = { blasMs, tlasMs: tlas.ms, packMs: Date.now() - packStarted, totalMs: Date.now() - started, blasRebuilt: rebuilt, blasReused: blasSources.length - rebuilt };
  return packed;
}
