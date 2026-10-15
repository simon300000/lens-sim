/** Instance expansion without Three.js, so it can run in the BVH Worker:
 * object matrixWorld × instanceMatrix → world→object 3x4 rows, the TSL
 * positionLocal frame, and the world AABB of the referenced BLAS bounds.
 * All products/inverses in f64; stored as f32. Column-major 4x4 inputs. */
function mul(a, b, out) { // out = a*b, column-major 4x4
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return out;
}
function rows(m, out, o) {
  out[o] = m[0]; out[o + 1] = m[4]; out[o + 2] = m[8]; out[o + 3] = m[12];
  out[o + 4] = m[1]; out[o + 5] = m[5]; out[o + 6] = m[9]; out[o + 7] = m[13];
  out[o + 8] = m[2]; out[o + 9] = m[6]; out[o + 10] = m[10]; out[o + 11] = m[14];
}
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** objects: [{matrixWorld:number[16], instanceMatrices:Float32Array|null, colors:Float32Array|null,
 *   count, blas, material, flags, objectIndex}]; blasBounds: (number[6]|null)[] */
export function expandInstances(objects, blasBounds) {
  const n = objects.reduce((s, o) => s + o.count, 0);
  const inst = { count: 0, w2o: new Float32Array(n * 12), frame: new Float32Array(n * 12), blas: new Uint32Array(n), material: new Uint32Array(n),
    flags: new Uint32Array(n), color: new Float32Array(n * 3), object: new Uint32Array(n), instance: new Uint32Array(n), bounds: new Float32Array(n * 6) };
  const report = { degenerate: 0, negativeDeterminant: 0 };
  const im = new Float64Array(16), o2w = new Float64Array(16);
  let k = 0;
  for (const o of objects) {
    const b = blasBounds[o.blas];
    for (let i = 0; i < o.count; i++) {
      if (o.instanceMatrices) { for (let j = 0; j < 16; j++) im[j] = o.instanceMatrices[i * 16 + j]; mul(o.matrixWorld, im, o2w); }
      else { im.set(IDENTITY); o2w.set(o.matrixWorld); }
      const [a, bb, c, d, e, f, g, h, ii] = [o2w[0], o2w[4], o2w[8], o2w[1], o2w[5], o2w[9], o2w[2], o2w[6], o2w[10]];
      const A = e * ii - f * h, B = -(d * ii - f * g), C = d * h - e * g, det = a * A + bb * B + c * C;
      if (!b || !(Math.abs(det) > 1e-30) || !Number.isFinite(det)) { report.degenerate++; continue; }
      if (det < 0) report.negativeDeterminant++;
      // Inverse of the linear part, then translation.
      const inv = [A / det, -(bb * ii - c * h) / det, (bb * f - c * e) / det, B / det, (a * ii - c * g) / det, -(a * f - c * d) / det,
        C / det, -(a * h - bb * g) / det, (a * e - bb * d) / det];
      const tx = o2w[12], ty = o2w[13], tz = o2w[14], w = k * 12;
      inst.w2o[w] = inv[0]; inst.w2o[w + 1] = inv[1]; inst.w2o[w + 2] = inv[2]; inst.w2o[w + 3] = -(inv[0] * tx + inv[1] * ty + inv[2] * tz);
      inst.w2o[w + 4] = inv[3]; inst.w2o[w + 5] = inv[4]; inst.w2o[w + 6] = inv[5]; inst.w2o[w + 7] = -(inv[3] * tx + inv[4] * ty + inv[5] * tz);
      inst.w2o[w + 8] = inv[6]; inst.w2o[w + 9] = inv[7]; inst.w2o[w + 10] = inv[8]; inst.w2o[w + 11] = -(inv[6] * tx + inv[7] * ty + inv[8] * tz);
      rows(im, inst.frame, w);
      inst.blas[k] = o.blas; inst.material[k] = o.material; inst.flags[k] = o.flags; inst.object[k] = o.objectIndex; inst.instance[k] = i;
      if (o.colors) { inst.color[k * 3] = o.colors[i * 3]; inst.color[k * 3 + 1] = o.colors[i * 3 + 1]; inst.color[k * 3 + 2] = o.colors[i * 3 + 2]; }
      else inst.color.fill(1, k * 3, k * 3 + 3);
      let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let cI = 0; cI < 8; cI++) {
        const p = [cI & 1 ? b[3] : b[0], cI & 2 ? b[4] : b[1], cI & 4 ? b[5] : b[2]];
        for (let r = 0; r < 3; r++) { const v = o2w[r] * p[0] + o2w[4 + r] * p[1] + o2w[8 + r] * p[2] + o2w[12 + r]; lo[r] = Math.min(lo[r], v); hi[r] = Math.max(hi[r], v); }
      }
      inst.bounds.set([...lo, ...hi], k * 6);
      k++;
    }
  }
  inst.count = k;
  return { instances: inst, report };
}
