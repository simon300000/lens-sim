/** Five fixed Sobol dimensions with a per-pixel/per-dimension digital shift.
 * Authored implementation, generator recurrence described in PBRT 4e §8.7.
 * No generator table/code is copied from PBRT. Numerical polynomial parameters
 * are the conventional first five Sobol dimensions. Digital shift preserves
 * base-two stratification; it is not claimed to be full Owen scrambling.
 */
export const SAMPLE_DIMENSIONS = Object.freeze({ pixelX: 0, pixelY: 1, pupilX: 2, pupilY: 3, wavelength: 4 });
const POLYNOMIALS = [null, { s: 1, a: 0, m: [1] }, { s: 2, a: 1, m: [1, 3] },
  { s: 3, a: 1, m: [1, 3, 1] }, { s: 3, a: 2, m: [1, 1, 1] }];

export const SOBOL_DIRECTIONS = Object.freeze(POLYNOMIALS.map((p, dimension) => {
  const v = new Uint32Array(32);
  if (dimension === 0) {
    for (let j = 0; j < 32; j++) v[j] = (1 << (31 - j)) >>> 0;
  } else {
    for (let j = 0; j < p.s; j++) v[j] = (p.m[j] << (31 - j)) >>> 0;
    for (let j = p.s; j < 32; j++) {
      let x = v[j - p.s] ^ (v[j - p.s] >>> p.s);
      for (let k = 1; k < p.s; k++) if ((p.a >>> (p.s - 1 - k)) & 1) x ^= v[j - k];
      v[j] = x >>> 0;
    }
  }
  return Object.freeze(Array.from(v));
}));

export function hash32(input) {
  let x = input >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

/** Stateless prefix: no batch size, target spp, success count or mutable RNG. */
export function sampleDimension(pixelId, sampleIndex, dimension, seed = 0) {
  if (!Number.isInteger(dimension) || dimension < 0 || dimension >= 5) throw new RangeError('Sampling dimension must be 0–4.');
  for (const value of [pixelId, sampleIndex, seed]) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError('Sampler arguments must be u32.');
  }
  let bits = (sampleIndex ^ (sampleIndex >>> 1)) >>> 0;
  let result = hash32((pixelId ^ hash32(seed ^ Math.imul(dimension + 1, 0x9e3779b9))) >>> 0);
  for (let j = 0; bits !== 0; j++, bits >>>= 1) if (bits & 1) result ^= SOBOL_DIRECTIONS[dimension][j];
  // 23-bit midpoint -> exactly representable f32, always strictly inside (0,1).
  return ((result >>> 9) + 0.5) / 8388608;
}

/** Shirley/Chiu concentric square-to-disc map, no rejection/retry loop. */
export function concentricDisk(u, v) {
  if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) throw new RangeError('Disc sample coordinates must be in [0,1].');
  const x = 2 * u - 1, y = 2 * v - 1;
  if (x === 0 && y === 0) return [0, 0];
  let r, theta;
  if (Math.abs(x) > Math.abs(y)) { r = x; theta = Math.PI / 4 * y / x; }
  else { r = y; theta = Math.PI / 2 - Math.PI / 4 * x / y; }
  return [r * Math.cos(theta), r * Math.sin(theta)];
}

export const SAMPLING_WGSL = /* wgsl */`
// Fixed dimensions: pixel xy=0,1; pupil xy=2,3; wavelength=4.
// Sobol + pixel/dimension digital shift; no retry or mutable RNG state.
const SOBOL_DIRECTIONS: array<u32,160> = array<u32,160>(
${SOBOL_DIRECTIONS.flat().map(x => `${x}u`).join(',')});
fn spectralHash32(input: u32) -> u32 {
  var x=input; x=x^(x>>16u); x=x*0x7feb352du;
  x=x^(x>>15u); x=x*0x846ca68bu; return x^(x>>16u);
}
fn sampleDimension(pixelId: u32, sampleIndex: u32, dimension: u32, seed: u32) -> f32 {
  var bits=sampleIndex^(sampleIndex>>1u);
  var result=spectralHash32(pixelId^spectralHash32(seed^((dimension+1u)*0x9e3779b9u)));
  for(var j=0u;j<32u;j=j+1u){
    if((bits&1u)!=0u){result=result^SOBOL_DIRECTIONS[dimension*32u+j];}
    bits=bits>>1u;
    if(bits==0u){break;}
  }
  return (f32(result>>9u)+0.5)/8388608.0;
}
fn sampleDisk(uv: vec2f) -> vec2f {
  let p=2.0*uv-vec2f(1.0);
  if(p.x==0.0 && p.y==0.0){return vec2f(0.0);}
  var radius: f32; var angle: f32;
  if(abs(p.x)>abs(p.y)){radius=p.x;angle=0.7853981633974483*p.y/p.x;}
  else {radius=p.y;angle=1.5707963267948966-0.7853981633974483*p.x/p.y;}
  return radius*vec2f(cos(angle),sin(angle));
}
`;
