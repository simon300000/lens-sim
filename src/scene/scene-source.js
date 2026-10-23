import { TIGHT_BOUNDS_MAX_VERTICES } from './instance-expand.js';

/** Scene source: the tracer's framework-independent scene input, what any host
 * (three.js extraction, Ghost's native streams) hands to tracer.setScene().
 *
 *   {
 *     blas: [{                       // one bottom-level BVH per geometry (range)
 *       key: string,                 // stable identity; an entry with only { key } reuses
 *                                    // the arrays sent earlier under that key (no copy)
 *       positions: Float32Array,     // xyz per vertex, geometry space, metres
 *       indices?: Uint32Array | Uint16Array,   // 3 per triangle; absent = non-indexed
 *       normals?: Float32Array,      // xyz per vertex (absent: +y)
 *       uvs?: Float32Array,          // uv per vertex (absent: 0)
 *       colors?: Float32Array,       // rgb or rgba per vertex (absent: 1)
 *       primitiveIds?: Uint32Array,  // per triangle, reported in hits (absent: triangle index)
 *       // alphaMask: reserved for alpha-tested foliage (any-hit); not implemented yet
 *     }],
 *     instances: [{
 *       blas: number,                // index into blas[]
 *       matrixWorld: ArrayLike<number>,        // column-major 4x4 object -> world
 *       count?: number,              // instances of this record (default 1)
 *       instanceMatrices?: Float32Array,       // count column-major 4x4, applied before matrixWorld
 *       colors?: Float32Array,       // rgb per instance (absent: 1)
 *       material: number,            // provider-defined material/table id (info.y)
 *       flags: number,               // INSTANCE_FLAGS below (side, shadow, transparent, ...)
 *     }],
 *   }
 *
 * World coordinates may be recentred: the tracer subtracts its origin (f64)
 * from every instance transform and from the pose, so far-from-origin worlds
 * keep f32 precision near the camera. */
export const SIDE = Object.freeze({ FRONT: 0, BACK: 1, DOUBLE: 2 });
export const INSTANCE_FLAGS = Object.freeze({
  SIDE_MASK: 3, RECEIVE_SHADOW: 4, TRANSPARENT: 8, UNSUPPORTED: 16, VERTEX_COLOR: 32, INSTANCE_COLOR: 64,
});

/** Builder-ready BLAS source: indices, bounds and (small meshes) the referenced
 * vertices for exact instance bounds. Arrays are used as given, never copied. */
export function normalizeBlasSource(source) {
  if (source.alphaMask) throw new Error(`BLAS ${source.key}: alpha masks are not implemented yet`);
  const positions = source.positions;
  if (!positions || positions.length % 3) throw new TypeError(`BLAS ${source.key}: positions must hold xyz triples`);
  const vertexCount = positions.length / 3;
  let indices = source.indices;
  if (!indices) {
    if (vertexCount % 3) throw new RangeError(`BLAS ${source.key}: non-indexed geometry needs whole triangles`);
    indices = new Uint32Array(vertexCount); for (let i = 0; i < vertexCount; i++) indices[i] = i;
  }
  if (indices.length % 3) throw new RangeError(`BLAS ${source.key}: indices must hold whole triangles`);
  const triangleCount = indices.length / 3;
  const colorSize = source.colors ? source.colors.length / vertexCount : 0;
  if (source.colors && colorSize !== 3 && colorSize !== 4) throw new RangeError(`BLAS ${source.key}: colors must be rgb or rgba per vertex`);
  let bounds = source.bounds ?? null, points = source.points ?? null;
  if (!bounds) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const used = new Uint8Array(vertexCount); let referenced = 0;
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      if (!(i < vertexCount)) throw new RangeError(`BLAS ${source.key}: index ${i} outside ${vertexCount} vertices`);
      if (!used[i]) { used[i] = 1; referenced++; }
      for (let a = 0; a < 3; a++) { const v = positions[i * 3 + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
    }
    bounds = triangleCount ? [...lo, ...hi] : null;
    // Small meshes (vegetation) hand their referenced vertices to the instance
    // expansion for exact world bounds; large meshes keep the box-corner bounds.
    if (referenced && referenced <= TIGHT_BOUNDS_MAX_VERTICES) {
      points = new Float32Array(referenced * 3); let k = 0;
      for (let i = 0; i < vertexCount; i++) if (used[i]) { points[k++] = positions[i * 3]; points[k++] = positions[i * 3 + 1]; points[k++] = positions[i * 3 + 2]; }
    }
  }
  return { ...source, indices, triangleCount, vertexCount, colorSize, bounds, points,
    hasNormal: source.hasNormal ?? !!source.normals, hasUV: source.hasUV ?? !!source.uvs, hasColor: source.hasColor ?? !!source.colors };
}

/** Instance records with their defaults, in the expansion's input form. */
export function normalizeInstances(instances) {
  return instances.map((record, objectIndex) => ({ objectIndex, ...record,
    count: record.count ?? (record.instanceMatrices ? record.instanceMatrices.length / 16 : 1),
    instanceMatrices: record.instanceMatrices ?? null, colors: record.colors ?? null, material: record.material ?? 0, flags: record.flags ?? 0 }));
}
