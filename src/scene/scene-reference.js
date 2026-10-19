/** Development-only f64 references for the lens scene query. NOT a runtime
 * fallback or rendering backend; tests compare the packed BVH and the GPU
 * against these on small scenes.
 *
 * Semantics shared with scene-intersector.wgsl:
 *  - nearest t in (tMin, tMax); front face = dot(local geometric normal, local
 *    ray direction) < 0, which equals the world test for any affine map;
 *  - FrontSide accepts front faces, BackSide back faces, DoubleSide both.
 */
import { LEAF_BIT, STACK_SIZE } from './bvh-builder.js';
import { SIDE, INSTANCE_FLAGS } from './scene-extract.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Invert a 3x4 row-major affine (world→object) into object→world, f64. */
export function invertAffine(r) {
  const [a, b, c, tx, d, e, f, ty, g, h, i, tz] = r;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  const inv = [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  return [inv[0], inv[1], inv[2], -(inv[0] * tx + inv[1] * ty + inv[2] * tz),
    inv[3], inv[4], inv[5], -(inv[3] * tx + inv[4] * ty + inv[5] * tz),
    inv[6], inv[7], inv[8], -(inv[6] * tx + inv[7] * ty + inv[8] * tz)];
}
export const applyAffine = (m, p) => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];
export const applyLinear = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[4] * v[0] + m[5] * v[1] + m[6] * v[2], m[8] * v[0] + m[9] * v[1] + m[10] * v[2]];

/** Möller–Trumbore in f64. Returns {t,u,v,front} or null. */
function triangle(o, d, p0, p1, p2) {
  const e1 = sub(p1, p0), e2 = sub(p2, p0), p = cross(d, e2), det = dot(e1, p);
  if (det === 0 || !Number.isFinite(det)) return null;
  const s = sub(o, p0), u = dot(s, p) / det;
  if (u < 0 || u > 1) return null;
  const q = cross(s, e1), v = dot(d, q) / det;
  if (v < 0 || u + v > 1) return null;
  return { t: dot(e2, q) / det, u, v, front: dot(cross(e1, e2), d) < 0 };
}
const accepts = (flags, front) => { const side = flags & INSTANCE_FLAGS.SIDE_MASK; return side === SIDE.DOUBLE || (side === SIDE.FRONT) === front; };

/** Exhaustive nearest hit over extracted (unpacked) scene data. */
export function bruteForceIntersect(extracted, origin, direction, tMin = 0, tMax = Infinity) {
  const { blas, instances } = extracted;
  let best = null;
  for (let k = 0; k < instances.count; k++) {
    const w2o = Array.from(instances.w2o.subarray(k * 12, k * 12 + 12));
    const o = applyAffine(w2o, origin), d = applyLinear(w2o, direction); // t-preserving: d is not normalized
    const src = blas[instances.blas[k]], flags = instances.flags[k];
    for (let t = 0; t < src.indices.length / 3; t++) {
      const v = [0, 1, 2].map(j => { const i = src.indices[t * 3 + j]; return [src.positions[i * 3], src.positions[i * 3 + 1], src.positions[i * 3 + 2]]; });
      const hit = triangle(o, d, ...v);
      if (!hit || !(hit.t > tMin && hit.t < tMax) || !accepts(flags, hit.front)) continue;
      if (!best || hit.t < best.t) best = { ...hit, instance: k, primitive: src.primitiveIds[t], blas: instances.blas[k], material: instances.material[k], bary: [1 - hit.u - hit.v, hit.u, hit.v] };
    }
  }
  return best;
}

/** Emulates the WGSL two-level traversal on the PACKED buffers (f64 math).
 * Checks structure, leaf encoding, stack bound and instance ordering.
 * Instance record (32 u32): w2o rows 0-11, root 12, material 13, flags 14, source 15. */
export function traversePacked(packed, origin, direction, tMin = 0, tMax = Infinity) {
  const nf = new Float32Array(packed.nodes), nu = new Uint32Array(packed.nodes);
  const tf = new Float32Array(packed.triangles), tu = new Uint32Array(packed.triangles);
  const inf = new Float32Array(packed.instances), inu = new Uint32Array(packed.instances);
  const box = (i, o, d) => {
    let t0 = tMin, t1 = best ? best.t : tMax;
    for (let a = 0; a < 3; a++) {
      // Parallel rays on either closed slab face remain inside. Handle the
      // actual zero direction before division: 0 * Infinity would make the
      // accumulated interval NaN even when the origin is on a valid face.
      if (d[a] === 0) {
        if (o[a] < nf[i * 8 + a] || o[a] > nf[i * 8 + 4 + a]) return false;
        continue;
      }
      const inv = 1 / d[a], ta = (nf[i * 8 + a] - o[a]) * inv, tb = (nf[i * 8 + 4 + a] - o[a]) * inv;
      t0 = Math.max(t0, Math.min(ta, tb)); t1 = Math.min(t1, Math.max(ta, tb));
      if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
    }
    return t0 <= t1;
  };
  let best = null, visits = 0, maxStack = 0;
  const stack = [{ node: 0, inst: -1 }];
  if (!box(0, origin, direction)) return { hit: null, visits, maxStack };
  while (stack.length) {
    maxStack = Math.max(maxStack, stack.length);
    if (stack.length > STACK_SIZE) throw new Error('stack overflow');
    const { node, inst } = stack.pop(); visits++;
    const o = inst < 0 ? origin : applyAffine(Array.from(inf.subarray(inst * 32, inst * 32 + 12)), origin);
    const d = inst < 0 ? direction : applyLinear(Array.from(inf.subarray(inst * 32, inst * 32 + 12)), direction);
    if (!box(node, o, d)) continue;
    const a = nu[node * 8 + 3], b = nu[node * 8 + 7];
    if (b >= LEAF_BIT) {
      const count = b - LEAF_BIT;
      if (inst < 0) {
        if (count !== 1) throw new Error('TLAS leaf must hold one instance');
        stack.push({ node: inu[a * 32 + 12], inst: a });
      } else {
        const flags = inu[inst * 32 + 14];
        for (let t = a; t < a + count; t++) {
          const v = [0, 1, 2].map(j => [tf[t * 16 + j * 4], tf[t * 16 + j * 4 + 1], tf[t * 16 + j * 4 + 2]]);
          const hit = triangle(o, d, ...v);
          if (!hit || !(hit.t > tMin && hit.t < (best ? best.t : tMax)) || !accepts(flags, hit.front)) continue;
          best = { ...hit, instance: inu[inst * 32 + 15], primitive: tu[t * 16 + 12], material: inu[inst * 32 + 13], bary: [1 - hit.u - hit.v, hit.u, hit.v] };
        }
      }
    } else stack.push({ node: b, inst }, { node: a, inst });
  }
  return { hit: best, visits, maxStack };
}
