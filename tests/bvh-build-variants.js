/** Benchmark-only BLAS leaf-size experiments; production packing is unchanged. */
import {
  BLAS_MAX_LEAF, LEAF_BIT, STACK_SIZE, buildBVH, buildBlas, buildTlas, packScene,
} from '../src/scene/bvh-builder.js';

// Extracted input is immutable for a benchmark run. Reuse its exact TLAS so
// changing the BLAS experiment cannot also change instance ordering/topology.
const builds = new WeakMap();
const MAX_SHADER_LEAF = 16; // SCENE_MAX_LEAF in scene-intersector.wgsl

function buildBlasWithLeafSize(source, maxLeaf) {
  if (maxLeaf === BLAS_MAX_LEAF) return buildBlas(source);
  const started = performance.now();
  const { positions, indices } = source;
  const triangles = indices.length / 3;
  const bounds = new Float64Array(triangles * 6);
  // Same source-precision bounds as production buildBlas. buildBVH chooses the
  // topology; packScene still rounds bounds outward and preserves source IDs.
  for (let t = 0; t < triangles; t++) {
    for (let a = 0; a < 3; a++) {
      const v0 = positions[indices[t * 3] * 3 + a];
      const v1 = positions[indices[t * 3 + 1] * 3 + a];
      const v2 = positions[indices[t * 3 + 2] * 3 + a];
      bounds[t * 6 + a] = Math.min(v0, v1, v2);
      bounds[t * 6 + 3 + a] = Math.max(v0, v1, v2);
    }
  }
  const bvh = buildBVH(bounds, { maxLeaf });
  return { ...bvh, triangles, ms: performance.now() - started };
}

/**
 * Return production-layout buffers for the same immutable extracted scene.
 * maxLeaf is the builder's target, not a strict limit: its SAH may produce up
 * to 2*maxLeaf triangles. Check the actual largest leaf against the shader.
 */
export function buildLeafSizeVariant(extracted, { maxLeaf = 8 } = {}) {
  if (!extracted || !Array.isArray(extracted.blas) || !extracted.instances) {
    throw new TypeError('Expected an extracted scene with blas and instances');
  }
  if (!Number.isInteger(maxLeaf) || maxLeaf < 1 || maxLeaf > MAX_SHADER_LEAF) {
    throw new RangeError(`maxLeaf must be an integer in [1, ${MAX_SHADER_LEAF}]`);
  }
  const started = performance.now();
  let cached = builds.get(extracted);
  const tlasReused = !!cached;
  if (!cached) {
    cached = {
      tlas: buildTlas(extracted.instances.bounds, extracted.instances.count),
      blasByLeafSize: new Map(),
    };
    builds.set(extracted, cached);
  }
  let blasBuilt = cached.blasByLeafSize.get(maxLeaf);
  const blasReused = !!blasBuilt;
  const blasStarted = performance.now();
  if (!blasBuilt) {
    blasBuilt = extracted.blas.map(source => buildBlasWithLeafSize(source, maxLeaf));
    cached.blasByLeafSize.set(maxLeaf, blasBuilt);
  }
  const blasMs = performance.now() - blasStarted;
  const largestBLASLeaf = blasBuilt.reduce((n, b) => Math.max(n, b.largestLeaf), 0);
  const maxBlasDepth = blasBuilt.reduce((n, b) => Math.max(n, b.depth), 0);
  if (largestBLASLeaf > MAX_SHADER_LEAF) {
    throw new Error(`Actual BLAS leaf ${largestBLASLeaf} exceeds shader maximum ${MAX_SHADER_LEAF}`);
  }
  if (cached.tlas.depth + maxBlasDepth > STACK_SIZE) {
    throw new Error(`BVH depth ${cached.tlas.depth}+${maxBlasDepth} exceeds traversal stack ${STACK_SIZE}`);
  }
  let rootLeafInstanceCount = 0;
  for (let i = 0; i < extracted.instances.count; i++) {
    if (blasBuilt[extracted.instances.blas[i]].nodes[7] >= LEAF_BIT) rootLeafInstanceCount++;
  }
  const packStarted = performance.now();
  const packed = packScene({
    blasSources: extracted.blas, blasBuilt, tlas: cached.tlas, instances: extracted.instances,
  });
  const packMs = performance.now() - packStarted;
  Object.assign(packed.stats, {
    requestedMaxLeaf: maxLeaf,
    largestBLASLeaf,
    rootLeafInstanceCount,
    rootLeafInstanceRatio: rootLeafInstanceCount / Math.max(1, extracted.instances.count),
    buildMs: performance.now() - started,
    timing: {
      blasMs,
      tlasMs: tlasReused ? 0 : cached.tlas.ms,
      packMs,
      tlasReused,
      blasRebuilt: blasReused ? 0 : blasBuilt.length,
      blasReused: blasReused ? blasBuilt.length : 0,
    },
  });
  return packed;
}

/**
 * Prove a conservative capacity from the actual paired TLAS/BLAS paths.
 * A deepest TLAS path and deepest BLAS may belong to different instances;
 * sum only depths that can occur on the same ray traversal. Keep both root
 * levels in this bound instead of using the tighter deferred-sibling count.
 * This validates traversal structure, not geometric bounds or numeric hits.
 */
export function provePackedStackCapacity(packed) {
  const stats = packed?.stats;
  if (!stats || !packed.nodes || !packed.instances || !packed.triangles) {
    throw new TypeError('Expected production-layout packed scene buffers and stats');
  }
  const nodeCount = packed.nodes.byteLength / 32;
  const instanceCount = stats.instances, triangleCount = stats.triangles;
  const tlasNodeCount = stats.tlasNodes, globalBound = stats.stackBound;
  if (!Number.isInteger(nodeCount) || nodeCount < 1 || stats.nodes !== nodeCount ||
      !Number.isInteger(tlasNodeCount) || tlasNodeCount < 1 || tlasNodeCount > nodeCount ||
      !Number.isInteger(instanceCount) || instanceCount < 1 || packed.instances.byteLength !== instanceCount * 128 ||
      !Number.isInteger(triangleCount) || triangleCount < 1 || packed.triangles.byteLength !== triangleCount * 64 ||
      !Number.isInteger(globalBound) || globalBound < 1 || globalBound > STACK_SIZE) {
    throw new Error('Packed BVH sizes or declared global stack bound are invalid');
  }
  const nodes = new Uint32Array(packed.nodes), instances = new Uint32Array(packed.instances);
  const state = new Uint8Array(nodeCount), depths = new Uint32Array(nodeCount);
  const instanceSeen = new Uint8Array(instanceCount), rootDepth = new Map();

  function blasDepth(root) {
    if (rootDepth.has(root)) return rootDepth.get(root);
    const pending = [[root, false]];
    while (pending.length) {
      const [node, exiting] = pending.pop();
      if (node < tlasNodeCount || node >= nodeCount) throw new Error('BLAS child/root index is out of range');
      const a = nodes[node * 8 + 3], b = nodes[node * 8 + 7];
      if (exiting) {
        depths[node] = 1 + Math.max(depths[a], depths[b]);
        if (depths[node] > globalBound) throw new Error('BLAS depth exceeds the declared global bound');
        state[node] = 2;
        continue;
      }
      // Repeated roots are legal instance sharing and are cached above.
      // Repeated internal nodes would be a cycle, DAG or overlapping BLAS.
      if (state[node] !== 0) throw new Error('BLAS is not a disjoint tree (cycle or shared child)');
      state[node] = 1;
      if (b >= LEAF_BIT) {
        const count = b - LEAF_BIT;
        if (count < 1 || count > MAX_SHADER_LEAF || a >= triangleCount || count > triangleCount - a) {
          throw new Error('BLAS triangle leaf is out of range');
        }
        depths[node] = 1; state[node] = 2;
      } else {
        if (a < tlasNodeCount || a >= nodeCount || b < tlasNodeCount || b >= nodeCount) {
          throw new Error('BLAS child index is out of range');
        }
        pending.push([node, true], [b, false], [a, false]);
      }
    }
    rootDepth.set(root, depths[root]);
    return depths[root];
  }

  let combined = 0, visitedTlas = 0, referencedInstances = 0;
  const pending = [[0, 1]];
  while (pending.length) {
    const [node, depth] = pending.pop();
    if (node >= tlasNodeCount || state[node] !== 0) throw new Error('TLAS is not a valid tree');
    if (depth > globalBound) throw new Error('TLAS depth exceeds the declared global bound');
    state[node] = 2; visitedTlas++;
    const a = nodes[node * 8 + 3], b = nodes[node * 8 + 7];
    if (b >= LEAF_BIT) {
      if (b - LEAF_BIT !== 1 || a >= instanceCount || instanceSeen[a]) {
        throw new Error('TLAS leaf does not uniquely reference one valid instance');
      }
      instanceSeen[a] = 1; referencedInstances++;
      combined = Math.max(combined, depth + blasDepth(instances[a * 32 + 24]));
    } else {
      if (a >= tlasNodeCount || b >= tlasNodeCount) throw new Error('TLAS child index is out of range');
      pending.push([b, depth + 1], [a, depth + 1]);
    }
  }
  if (visitedTlas !== tlasNodeCount || referencedInstances !== instanceCount) {
    throw new Error('TLAS node/instance coverage is incomplete');
  }
  if (combined > globalBound) throw new Error('Paired TLAS/BLAS depth exceeds the declared global bound');
  return combined;
}
